/**
 * `server/utils/diagLogs.ts` 的单测 —— 2026-09-21 新增
 *
 * 为什么单独测：日志读取是「一键诊断导出」里**唯一有分支的取数逻辑**
 * （挑哪几天、超上限怎么截、目录不存在怎么办），而它的失败方式是**静默降级**
 * （导出包照样能生成，只是没有日志）—— 这种只有断言"文件确实被选中/内容确实是尾部"才拦得住。
 *
 * ⚠️ 手法与 `tests/mp/logger.test.ts` 一致：先把 `TOTORO_LOG_DIR` 指到临时沙箱**再**动态 import，
 * 避免碰用户真实日志目录。（`recentLogFiles()` 也接受显式目录参数，单测两条路都走。）
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'totoro-diaglogs-'))
process.env.TOTORO_LOG_DIR = sandbox

const { recentLogFiles, partitionLogsByRedline } = await import('../../server/utils/diagLogs.ts')
const { LOG_DIR, logDateTag } = await import('../../server/utils/logger.ts')

/** 造一个日期标签（本地时间的 N 天前） */
function dayTag(back: number): string {
  const d = new Date()
  return logDateTag(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back))
}

mkdirSync(sandbox, { recursive: true })
const OLD_DAY = dayTag(9) // 超出 DIAG_LOG_DAYS（3 天）的范围
writeFileSync(join(sandbox, `app-${OLD_DAY}.log`), '{"msg":"十天前的老日志"}\n', 'utf8')
writeFileSync(join(sandbox, 'not-a-log.txt'), '不该被读到\n', 'utf8')

after(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 测试收尾清理：失败不影响结论（sandbox 在系统临时目录里） */
  }
})

test('diagLogs：目录口径来自 logger（TOTORO_LOG_DIR 覆盖生效，不另写一份）', () => {
  assert.equal(LOG_DIR, sandbox, 'logger 的 LOG_DIR 应被环境变量覆盖到沙箱')
  assert.match(sandbox, /totoro-diaglogs-/)
})

test('diagLogs：只收最近 N 天且**实际存在**的 app-*.log，按日期升序', () => {
  writeFileSync(join(sandbox, `app-${dayTag(0)}.log`), '今天\n', 'utf8')
  writeFileSync(join(sandbox, `app-${dayTag(1)}.log`), '昨天\n', 'utf8')
  const files = recentLogFiles(3, 1024 * 1024, sandbox)
  assert.deepEqual(files.map((f) => f.name), [`app-${dayTag(1)}.log`, `app-${dayTag(0)}.log`])
  assert.ok(!files.some((f) => f.name.includes(OLD_DAY)), '超出天数的老日志不能被收进来')
  assert.ok(!files.some((f) => f.name.endsWith('.txt')), '非 app-*.log 的文件不能被收到')
  assert.ok(files.every((f) => f.truncated === false), '小文件不该被标记截断')
})

test('diagLogs：超过单文件上限 ⇒ 截断到上限并标记 truncated，原始字节数照实上报', () => {
  const big = ('X'.repeat(99) + '\n').repeat(60) // 6000 字节
  writeFileSync(join(sandbox, `app-${dayTag(2)}.log`), big, 'utf8')
  const [f] = recentLogFiles(3, 1000, sandbox).filter((x) => x.name === `app-${dayTag(2)}.log`)
  assert.ok(f, '超限的日志文件仍要进包（只截断，不丢弃）')
  assert.equal(f.truncated, true, '超过上限必须标记为已截断（manifest 要据此写 note）')
  assert.equal(f.bytes, 6000, 'bytes 报的是**原始**大小')
  assert.equal(Buffer.byteLength(f.text), 1000, '文本内容应正好是上限字节数')
  assert.equal(f.text, big.slice(0, 1000), '截断口径 = 从文件头取前 maxBytes 字节（测试把口径钉死）')
})

test('diagLogs：目录不存在 / 没有日志 ⇒ 返回空数组（"没有日志"是合法情况，不能让导出失败）', () => {
  assert.deepEqual(recentLogFiles(3, 1024, join(sandbox, 'not-exist-dir')), [])
  const emptyDir = join(sandbox, 'empty')
  mkdirSync(emptyDir, { recursive: true })
  assert.deepEqual(recentLogFiles(3, 1024, emptyDir), [])
  // 非法参数（0 天 / 非正上限）也应当是"什么都没有"，而不是抛错或收到全部
  assert.deepEqual(recentLogFiles(0, 1024, sandbox), [])
  assert.deepEqual(recentLogFiles(3, 0, sandbox), [])
})

/**
 * 🔴 红线分流（2026-09-21，父代理定）：命中凭证样式的日志**剔除出包**、其余照出。
 * 判据必须是纯函数、有断言 —— 这条是**安全路径**，不许只靠"跑一次看看"。
 */
test('partitionLogsByRedline：干净日志全留、命中凭证的只剔那一个，并给出命中类别', () => {
  const logs = [
    { name: 'app-2026-09-19.log', text: '{"endpoint":"/a","auth":"[masked len=16]"}' },
    {
      name: 'app-2026-09-20.log',
      text: '{"endpoint":"/b","note":"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9AAAAAAAAAAAAAAAAAAAA"}',
    },
    { name: 'app-2026-09-21.log', text: '{"endpoint":"/c","body":{"keys":["runType"]}}' },
  ]
  const { safe, excluded, reasons } = partitionLogsByRedline(logs)
  assert.deepEqual(
    safe.map((f) => f.name),
    ['app-2026-09-19.log', 'app-2026-09-21.log'],
    '只剔命中那一个，其余照出（不是整包拒绝）',
  )
  assert.deepEqual(
    excluded.map((f) => f.name),
    ['app-2026-09-20.log'],
  )
  assert.ok(reasons['app-2026-09-20.log']!.length > 0, '要说明命中了哪一类，便于告知开发者')
})

test('partitionLogsByRedline：全部干净 ⇒ 不排除任何文件（正常用户的常见路径）', () => {
  const logs = [
    { name: 'a.log', text: 'token length=101 head=abcd tail=wxyz' },
    { name: 'b.log', text: '{"auth":"[masked len=16]","upstream":{"status":"00"}}' },
  ]
  const { safe, excluded } = partitionLogsByRedline(logs)
  assert.equal(safe.length, 2)
  assert.equal(excluded.length, 0, '掩码后的长度/头尾字样不得被误判成凭证')
})
