/**
 * 启动「内存扫描器」（PowerShell + Add-Type P/Invoke，源码内嵌见 `tokenScanScript.ts`）
 *
 * 为什么这样起：
 *   - 发布物是 **Node SEA 单文件 EXE**，外部 .ps1 不会被打进去 → 运行时把内嵌源码写到临时目录再执行；
 *   - **纯 ASCII 写入、无 BOM**（本机 PS 5.1 读无 BOM 非 ASCII 会按 ANSI 误解码，见 ERROR.md E14）；
 *   - `windowsHide` 不弹窗；stdout 忽略（结果通过它 POST 回本地端点，不靠解析输出）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_SCAN_PS1 } from './tokenScanScript'
import { getScan, patchScan } from './tokenScanState'

/** 内嵌脚本在临时目录里的落点（固定名，便于排错；内容每次覆盖写） */
function scriptPath(): string {
  const dir = join(tmpdir(), 'totoro-heaven-token')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'scan-memory.ps1')
  writeFileSync(p, TOKEN_SCAN_PS1, 'utf8') // 内容为纯 ASCII → 无 BOM 也安全
  return p
}

/**
 * 启动扫描器。**不等待**其完成（结果由扫描器 POST 回 `/api/local/token-import`）。
 * 若它异常退出且状态仍是 scanning，则把状态置为 error（避免前端一直转圈）。
 */
export function launchTokenScanner(endpoint: string, nonce: string): void {
  const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath(),
    '-Endpoint',
    endpoint,
    '-Nonce',
    nonce,
  ]

  const child = spawn(ps, args, { windowsHide: true, stdio: 'ignore' })

  child.on('error', (err) => {
    const cur = getScan()
    if (cur && cur.phase === 'scanning') {
      patchScan({ phase: 'error', message: `无法启动扫描器：${err.message}（本机需有 PowerShell）` })
    }
  })

  child.on('exit', (code) => {
    // 给它 3 秒把 POST 发出来；仍停在 scanning 就认为失败
    setTimeout(() => {
      const cur = getScan()
      if (cur && cur.nonce === nonce && cur.phase === 'scanning') {
        patchScan({
          phase: 'error',
          message: `扫描器未回传结果（退出码 ${code}）——可能是杀软拦截了跨进程读内存；可改用抓包路线`,
        })
      }
    }, 3000)
  })
}
