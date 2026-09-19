/**
 * 日志轮转/容量上限回归测试（2026-09-19 审计 M6）
 *
 * 病因回顾：`pruneLogs()` 先用**同一份 `meta` 快照**按"超期"删掉一批文件，
 * 紧接着又用这份快照做"容量上限"回收 —— 对已被删掉的文件再 `unlinkSync` 必然抛 **ENOENT**，
 * 而当时的 `catch { break }` 会**直接跳出整轮容量回收** ⇒ 只要本次删过超期文件，
 * **20MB 上限就完全不生效**（日志会无限增长）。
 *
 * 判据（可执行）：目录里已有 **> 上限** 的近期日志时，触发一次写日志后
 * **总字节数必须降到上限以内**，且最旧的被删、保留最新的。
 *
 * ⚠️ 为什么用**子进程**跑而不是同进程动态 import：
 *    `logger.ts` 的 `LOG_DIR` 是**模块级常量**（import 时读 `TOTORO_LOG_DIR`），
 *    同进程里"先设 env 再 import"要依赖模块缓存作废/查询串技巧，且与测试框架的并发执行相互干扰
 *    （实测出现过"沙箱目录在某些步骤后消失"的诡异现象，排查成本高）。
 *    子进程方案：**env 在进程启动时就位**，导入路径也由测试构建脚本改写好了，确定性最强。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 上限常量（与 `server/utils/logger.ts` 保持一致；改那里时要同步这里） */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

const mkSandbox = () => mkdtempSync(join(tmpdir(), 'th-log-test-'))

const logFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('app-') && f.endsWith('.log')) : []

const totalBytes = (dir) => logFiles(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0)

/** 在子进程里 import 构建副本的 logger 并写一条日志（env 由参数注入，进程启动即生效） */
const runLoggerInChild = (dir, script) => {
  // ⚠️ 必须带 `--experimental-strip-types`（Node 24 下跑 .ts 需要它；测试主进程由
  //    `scripts/run-mp-tests.mjs` 以同样方式启动）与 `--input-type=module`（-e 当 ESM 跑）。
  //    导入路径用**相对 cwd** 的写法，子进程继承 `.mp-test-build` 作为 cwd（与测试主进程一致）。
  const code = `import('./server/utils/logger.ts').then((m) => { m.logInfo('test', ${JSON.stringify(script)}) })`
  const res = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    env: { ...process.env, TOTORO_LOG_DIR: dir },
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `子进程写日志失败：${res.stderr || res.stdout}`)
}

test('日志：**同时**有超期文件与超限总量时，容量回收仍必须生效（审计 M6 的确切病因）', () => {
  const dir = mkSandbox()
  try {
    /**
     * ⚠️ 场景必须**同时**满足两条，否则测不出这个 bug（我前两版都栽在这里，做了反向验证才发现）：
     *   ① 含**超期文件** ⇒ 触发第一段（超期删除），让第二段去碰"已被删掉的文件"；
     *   ② 超期文件删掉之后，**剩余总量仍然超限**（4×6MB=24MB > 20MB）
     *      ⇒ 这样"第二段被 break 掉"才会真的留下一个 > 上限的目录。
     *   只满足①（剩余 18MB）时，即使 bug 存在断言也察觉不到 —— 这就是前两版"测试全绿但其实无效"的原因。
     */
    const oldName = 'app-2026-01-01.log' // 10 天前 ⇒ 必被"超期"分支删掉
    const newNames = ['app-2026-09-02.log', 'app-2026-09-03.log', 'app-2026-09-04.log', 'app-2026-09-05.log']
    writeFileSync(join(dir, oldName), Buffer.alloc(6 * 1024 * 1024, 0x61))
    for (const n of newNames) writeFileSync(join(dir, n), Buffer.alloc(6 * 1024 * 1024, 0x62))
    const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000
    utimesSync(join(dir, oldName), tenDaysAgo, tenDaysAgo)
    assert.ok(totalBytes(dir) === 5 * 6 * 1024 * 1024, '前置条件：5×6MB=30MB')
    assert.ok(totalBytes(dir) - 6 * 1024 * 1024 > MAX_TOTAL_BYTES, '前置条件：删掉超期文件后**仍然超限**')

    runLoggerInChild(dir, '触发超期清理 + 容量回收')

    assert.ok(!existsSync(join(dir, oldName)), '超期文件应被删掉')
    const after = totalBytes(dir)
    assert.ok(after <= MAX_TOTAL_BYTES, `回收后总字节 ${after} 应 ≤ ${MAX_TOTAL_BYTES}（旧实现在这里会失效）`)
    assert.ok(logFiles(dir).length >= 1, '至少要留下当天日志')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('日志：按 7 天超期清理仍然生效（顺带确认沙箱 env 注入生效）', () => {
  const dir = mkSandbox()
  try {
    mkdirSync(dir, { recursive: true })
    // 造一个"10 天前"的日志（用 utimes 改 mtime）与一个当天日志
    const oldFile = join(dir, 'app-2026-01-01.log')
    writeFileSync(oldFile, 'old\n')
    const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo)
    assert.ok(existsSync(oldFile))

    runLoggerInChild(dir, '触发超期清理')

    assert.ok(!existsSync(oldFile), '10 天前的日志应被超期清理删掉')
    assert.ok(logFiles(dir).length >= 1, '当天的日志应保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
