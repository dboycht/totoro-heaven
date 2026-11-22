/**
 * 「一键获取 token」扫描器的**启动参数**与**失败自诊断**测试（2026-10-14，`ERROR.md` E80）
 *
 * 为什么值得单测（三条都是本轮实测出来的）：
 *   ① **内嵌 .ps1 必须纯 ASCII**：模板里漏过一行中文注释，运行期写盘的就不是 ASCII 了
 *      （E14 的坑边：PS 5.1 按系统 ANSI 读无 BOM 文件）；
 *   ② **开关顺序会决定成败**：`-NonInteractive` 必须放在 `-File` **之前** ——
 *      放到后面会被宿主当成"脚本自己的参数"，脚本不认 ⇒ 当场报错退出（实测 exit 1）；
 *   ③ **失败必须自己报出来**：脚本加了 `trap`，未捕获错误要先把 `SCRIPT_FAILED` 回传。
 *      起因就是"26H2 用户只看到一个退出码 4294967295，谁也不知道发生了什么"。
 *
 * ⚠️ 后两条要真起 PowerShell（**Windows 限定**，其它平台跳过）；`Get-Process` 一律被替换成桩，
 *    **绝不碰真实微信内存**（本测试只验证"能不能起来、崩了会不会自己说"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_SCAN_PS1, tokenScanSupportedOn, tokenScannerArgs } from '../../server/utils/tokenScanScript.ts'
import {
  SCAN_OUTPUT_LIMIT,
  condenseScanOutput,
  decodeScannerOutput,
  describeScanFailure,
} from '../../server/utils/tokenScanRunner.ts'

const isWin = process.platform === 'win32'

/** 本机有没有可用的 Windows PowerShell（没有就**跳过** spawn 类用例，而不是红） */
function hasPowerShell(): boolean {
  if (!isWin) return false
  try {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true })
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
}
const skipNoPs = { skip: !hasPowerShell(), timeout: 40000 }

/* ---------- 纯逻辑（任何平台都跑） ---------- */

test('平台硬闸：tokenScanSupportedOn 只有 win32 支持（Mac/Linux fail-closed，2026-11-22 Mac 门控）', () => {
  assert.equal(tokenScanSupportedOn('win32'), true)
  assert.equal(tokenScanSupportedOn('darwin'), false)
  assert.equal(tokenScanSupportedOn('linux'), false)
  // 缺省参数 = 当前进程平台（本测试三平台都跑，这里只断言"类型是布尔"，平台值交给上面三条）
  assert.equal(typeof tokenScanSupportedOn(), 'boolean')
})

test('内嵌扫描脚本保持纯 ASCII（PS 5.1 按系统 ANSI 读无 BOM 文件，见 E14/E80）', () => {
  assert.match(TOKEN_SCAN_PS1, /^[\x00-\x7f]*$/)
  // TS 模板字面量里出现 `${` 会被当插值 ⇒ 脚本会被悄悄改形（ASCII 断言抓不到这种）
  assert.ok(!TOKEN_SCAN_PS1.includes('${'), '模板里不能出现 TS 插值起始符')
})

test('扫描器参数表：-NonInteractive 在 -File 之前，位置参数守在 -File 之后', () => {
  const script = 'C:\\tmp dir\\scan-memory.ps1'
  const url = 'http://127.0.0.1:3000/api/local/token-import'
  const args = tokenScannerArgs(script, url, 'n1')
  const at = (flag: string) => args.indexOf(flag)

  assert.ok(at('-NonInteractive') >= 0, '缺 -NonInteractive（必填参数缺失时会挂起，实测）')
  assert.ok(at('-NonInteractive') < at('-File'), '-NonInteractive 必须在 -File 之前，否则会被当成脚本参数')
  assert.equal(args[at('-ExecutionPolicy') + 1], 'Bypass')
  assert.equal(args[at('-File') + 1], script)
  assert.equal(args[at('-CallbackUrl') + 1], url)
  assert.equal(args[at('-Nonce') + 1], 'n1')
  assert.equal(at('-Nonce'), args.length - 2, '-Nonce 必须是最后一对')
  // 所有形似开关的 token 都必须是我们认得的那几个（防止"值"被误当成开关、或漏传值）
  assert.deepEqual(
    args.filter((a) => a.startsWith('-')),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', '-File', '-CallbackUrl', '-Nonce'],
  )
})

test('失败文案：有输出就报输出；没有输出就如实说"没有输出"，不替用户猜单一原因', () => {
  const withOut = describeScanFailure(1, 'Add-Type : 编译失败\r\n  第 2 行', 'C:\\t\\last-scan.log')
  assert.ok(withOut.includes('退出码 1'))
  assert.ok(withOut.includes('Add-Type : 编译失败'), '要把 PowerShell 的原话带给用户')
  assert.ok(withOut.includes('last-scan.log'), '要告诉用户现场文件在哪')

  const noOut = describeScanFailure(4294967295, '   \n\n  ', 'C:\\t\\last-scan.log')
  assert.ok(noOut.includes('4294967295'))
  assert.ok(noOut.includes('没有留下任何输出'))
  assert.ok(noOut.includes('Fiddler'), '兜底路线（抓包粘贴）不能丢')
  assert.ok(noOut.includes('last-scan.log'))

  assert.ok(describeScanFailure(null, '', 'p').includes('没有正常退出'), 'code=null = 被强制结束')
})

test('输出收敛：去空行、超长截断并留标记', () => {
  assert.equal(condenseScanOutput('  a  \r\n\r\n b \n'), '  a\n b')
  assert.equal(condenseScanOutput(''), '')
  const long = 'x'.repeat(SCAN_OUTPUT_LIMIT + 50)
  const out = condenseScanOutput(long)
  assert.ok(out.includes('已截断'))
  assert.ok(out.length < long.length + 60)
})

test('输出解码：GBK 控制台的中文错误信息要能读出来（按 utf8 解会变成替换字符）', () => {
  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // GBK 的"中文"
  assert.equal(gbkBytes.toString('utf8').includes('\uFFFD'), true, '前提：utf8 解 GBK 字节必出替换字符')
  assert.equal(decodeScannerOutput(gbkBytes), '中文')
  assert.equal(decodeScannerOutput(Buffer.from('正常 utf8 文本', 'utf8')), '正常 utf8 文本')
})

/* ---------- 真起 PowerShell（Windows only） ---------- */

test('启动参数能被真实 PowerShell 接受（脚本路径含空格）', skipNoPs, () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan launch '))
  try {
    const script = join(dir, 'probe.ps1')
    // 复用真实参数声明（含 trap 与 OutputEncoding），但**不编译、不扫描任何进程**
    const head = TOKEN_SCAN_PS1.split("$cs = @'")[0]
    assert.match(head, /^[\x00-\x7f]*$/, '截出来的前半段也必须是 ASCII')
    writeFileSync(script, `${head}\nWrite-Output ($CallbackUrl + "|" + $Nonce)\n`, 'ascii')
    const url = 'http://127.0.0.1:3000/api/local/token-import'
    const r = spawnSync('powershell.exe', tokenScannerArgs(script, url, 'test-nonce'), {
      windowsHide: true, encoding: 'utf8', timeout: 20000,
    })
    assert.ifError(r.error)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(String(r.stdout).trim(), `${url}|test-nonce`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 起一次"真脚本"（只把进程枚举换成桩），拿回它 POST 到本机端点的载荷。
 * ⚠️ 写盘用 `utf8`（**无 BOM**）—— 与 `tokenScanRunner.scriptPath()` 完全一致。
 */
async function runScanner(mutate: (src: string) => string): Promise<{ code: number | null; payload: Record<string, unknown> | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'scan cb '))
  let resolvePayload: (v: Record<string, unknown>) => void = () => {}
  const got = new Promise<Record<string, unknown>>((res) => { resolvePayload = res })
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
    try { resolvePayload(JSON.parse(body)) } catch { /* 载荷坏了就当没收到 */ }
  })
  try {
    await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res()) })
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    const script = join(dir, 'scan-memory.ps1')
    writeFileSync(script, mutate(TOKEN_SCAN_PS1), 'utf8')
    const url = `http://127.0.0.1:${addr.port}/api/local/token-import`
    const child = spawn('powershell.exe', tokenScannerArgs(script, url, 'callback-test'), { windowsHide: true, stdio: 'ignore' })
    const code = await new Promise<number | null>((res, rej) => {
      child.once('error', rej)
      child.once('close', (c) => res(c))
    })
    const payload = await Promise.race([
      got,
      new Promise<Record<string, unknown> | null>((res) => setTimeout(() => res(null), 3000)),
    ])
    return { code, payload }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((res) => server.close(() => res()))
    rmSync(dir, { recursive: true, force: true })
  }
}

const stubNoProcess = "$ErrorActionPreference = 'Stop'\nfunction Get-Process { param($Name, $ErrorAction) @() }"

test('真脚本能编译 + 向本机回传（枚举换桩，不碰真实微信内存）', skipNoPs, async () => {
  const { code, payload } = await runScanner((src) => src.replace("$ErrorActionPreference = 'Stop'", stubNoProcess))
  assert.equal(code, 0)
  assert.equal(payload?.error, 'NO_PROCESS')
  assert.equal(payload?.nonce, 'callback-test')
  assert.deepEqual(payload?.tokens, [])
  assert.equal(payload?.processes, 0)
  assert.equal(payload?.phase, 'enumerate', '新增字段：死/活到哪一步要能看出来')
})

test('枚举到一个假进程时走完扫描链路（OpenProcess 失败 ⇒ NO_TOKEN，不读任何内存）', skipNoPs, async () => {
  const stub = "$ErrorActionPreference = 'Stop'\nfunction Get-Process { param($Name, $ErrorAction) @([pscustomobject]@{ Id = 999999; MainWindowTitle = '' }) }"
  const { code, payload } = await runScanner((src) => src.replace("$ErrorActionPreference = 'Stop'", stub))
  assert.equal(code, 0)
  assert.equal(payload?.error, 'NO_TOKEN')
  assert.equal(payload?.processes, 1)
  assert.equal(payload?.phase, 'scan')
})

test('脚本自己崩了也要先把原因回传（trap：不再只剩一个退出码）', skipNoPs, async () => {
  const boom = "$ErrorActionPreference = 'Stop'\nfunction Get-Process { param($Name, $ErrorAction) throw 'boom-from-test' }"
  const { code, payload } = await runScanner((src) => src.replace("$ErrorActionPreference = 'Stop'", boom))
  assert.equal(code, 1)
  assert.equal(payload?.error, 'SCRIPT_FAILED')
  assert.equal(payload?.phase, 'enumerate')
  assert.equal(payload?.nonce, 'callback-test')
  assert.match(String(payload?.detail ?? ''), /boom-from-test/)
  assert.deepEqual(payload?.tokens, [])
  assert.equal(payload?.processes, -1)
})
