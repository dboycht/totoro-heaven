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

const { recentLogFiles, partitionLogsByRedline, diagLogsLinesInWindow, summarizeDiagLineAccount } = await import('../../server/utils/diagLogs.ts')
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

/**
 * 🆕 2026-09-22：**按记录窗口筛日志行**（`diagLogsLinesInWindow`）。
 *
 * 这是"导出只取这一次记录那一段"的**唯一取数判据**，也是唯一会**逐行 JSON.parse** 的地方 ——
 * 它的失败方式是"静默少给/整包挂掉"，所以两个方向都要钉住：
 *   · 窗口外的行必须被剔除并**计数**（不能悄悄少给）；
 *   · 坏行（半截写入 / 被字节截断切在中间 / 老日志没有 `t`）**只跳这一行**，绝不让整个导出失败。
 */
test('diagLogsLinesInWindow：只留 `t` 落在窗口内的行，窗口外与无时间戳的分开计数', () => {
  const start = Date.parse('2026-09-22T10:00:00.000Z')
  const end = Date.parse('2026-09-22T10:05:00.000Z')
  const line = (t: string, msg: string) => JSON.stringify({ t, level: 'info', cat: 'proxy', msg })
  const text = [
    line('2026-09-22T09:59:59.000Z', '窗口前'),
    line('2026-09-22T10:00:00.000Z', '正好开始'),
    '{"msg":"这一行被字节截断切坏了', // 半截 JSON：必须只跳它
    JSON.stringify({ level: 'info', cat: 'proxy', msg: '没有 t 字段（老日志）' }),
    line('2026-09-22T10:04:59.000Z', '窗口内'),
    line('2026-09-22T10:05:00.001Z', '窗口后'),
  ].join('\n')
  const r = diagLogsLinesInWindow(text, { startedAtMs: start, endedAtMs: end })
  assert.equal(r.total, 6, '非空行共 6 条：窗口前 / 正好开始 / 半截 JSON / 没有 t 字段 / 窗口内 / 窗口后')
  assert.equal(r.kept, 2, '只有正好开始与 10:04:59 两条在窗口内')
  assert.equal(r.outOfWindow, 2, '窗口前那条与窗口后那条都算"明确在窗口外"')
  assert.equal(r.unparsable, 2, '半截 JSON + 没有 t 字段 ⇒ 都算"解析不出时间"（无法证明它在窗口内）')
  assert.equal(r.kept + r.outOfWindow + r.unparsable, r.total, '三类的和必须等于总数（账要对得上，不能有"既没留也没计数"的行）')
  assert.match(r.text, /正好开始/)
  assert.match(r.text, /窗口内/)
  assert.ok(!r.text.includes('窗口前') && !r.text.includes('窗口后'), '窗口外的行一个字都不能进包')
  // 保留的行**原样拼回**（不重新序列化）：导出包里的日志要与磁盘上一字不差
  assert.equal(r.text.split('\n')[0], line('2026-09-22T10:00:00.000Z', '正好开始'))
})

test('diagLogsLinesInWindow：window=null ⇒ 原样全收（退回"最近 N 天全量"的兜底路径）', () => {
  const text = '{"t":"2026-01-01T00:00:00.000Z","msg":"a"}\n坏行\n{"msg":"没有时间戳"}\n\n'
  const r = diagLogsLinesInWindow(text, null)
  assert.equal(r.total, 3, '只按"非空行"计数')
  assert.equal(r.kept, 3, '不过滤 ⇒ 一行都不丢（连坏行也照给，那是用户的原始日志）')
  assert.equal(r.outOfWindow, 0)
  assert.equal(r.unparsable, 0, '不过滤时不去解析，也就不该报"解析不出"')
  assert.ok(r.text.includes('坏行'))
  assert.deepEqual(diagLogsLinesInWindow('', null), { text: '', total: 0, kept: 0, outOfWindow: 0, unparsable: 0 })
})

test('diagLogsLinesInWindow：未结束的窗口（endedAtMs=0）⇒ 右边界取"无穷"（此刻之后的行也先留着）', () => {
  const start = Date.parse('2026-09-22T10:00:00.000Z')
  const text = [
    JSON.stringify({ t: '2026-09-22T09:00:00.000Z', msg: '窗口前' }),
    JSON.stringify({ t: '2099-01-01T00:00:00.000Z', msg: '很晚（仍在记录时不该被右边界挡掉）' }),
  ].join('\n')
  const r = diagLogsLinesInWindow(text, { startedAtMs: start, endedAtMs: 0 })
  assert.equal(r.kept, 1)
  assert.match(r.text, /很晚/)
  assert.equal(r.outOfWindow, 1)
})

/**
 * 🆕 2026-09-22（独立审计 B1）：manifest 的行数账必须**只算真正进包的文件**。
 *
 * 故障：`export.post.ts` 原先在**全部** scoped 文件上聚合 kept/dropped，而"命中凭证样式被剔除"
 * 发生在聚合**之后** ⇒ manifest 写"保留 12 行"，包里其实少了被剔那个文件的若干行。
 * 诊断包最忌讳的就是"账与内容不自洽"（维护者据此判断日志齐不齐）。
 * 判据：把"3 个文件、其中 1 个被红线剔除"这组喂给 `summarizeDiagLineAccount()`，逐项对账。
 */
test('summarizeDiagLineAccount：账只算进包文件，被红线剔除的那份单独计数（审计 B1）', () => {
  const win = { startedAtMs: Date.parse('2026-09-22T10:00:00.000Z'), endedAtMs: Date.parse('2026-09-22T10:05:00.000Z') }
  const line = (t: string, msg: string) => JSON.stringify({ t, level: 'info', cat: 'proxy', msg })
  const mk = (name: string, inWindow: number, outWindow: number, bytes: number, truncated = false) => {
    const text = [
      ...Array.from({ length: inWindow }, (_, i) => line(new Date(win.startedAtMs + i * 1000).toISOString(), `${name}-in${i}`)),
      ...Array.from({ length: outWindow }, (_, i) => line(new Date(win.endedAtMs + 60_000 + i * 1000).toISOString(), `${name}-out${i}`)),
    ].join('\n')
    return { name, bytes, truncated, scope: diagLogsLinesInWindow(text, win) }
  }
  const all = [mk('app-2026-09-20.log', 2, 3, 500), mk('app-2026-09-21.log', 5, 1, 9000, true), mk('app-2026-09-22.log', 4, 0, 700)]
  // 红线只剔掉中间那个（它的 5 行**不能**出现在账里）
  const safeNames = ['app-2026-09-20.log', 'app-2026-09-22.log']
  const acc = summarizeDiagLineAccount(all, safeNames)
  assert.equal(acc.files, 2)
  assert.equal(acc.originalBytes, 1200, '进包文件的**原始**大小 = 500 + 700（不含被剔那份的 9000）')
  assert.equal(acc.keptLines, 6, '保留行数 = 2 + 4（不含被剔那份的 5）')
  assert.equal(acc.droppedLines, 3, '只有进包文件里"窗口外"的那些')
  assert.equal(acc.unparsableLines, 0)
  assert.equal(acc.truncatedFiles, 0, '被截断的正是被剔那份 ⇒ 不该算进去')
  assert.deepEqual(acc.excluded, { files: 1, lines: 5 })
  /**
   * 🆕（终检审计 B3）**"原始字节"与"包内字节"必须分开**：
   * 窗口过滤后包里往往只剩几行，而原始大小是几十 KB —— 只报一个数会让维护者误判包的大小。
   */
  assert.ok(acc.inPackageBytes > 0 && acc.inPackageBytes < acc.originalBytes, `包内字节(${acc.inPackageBytes}) 必须 < 原始字节(${acc.originalBytes})`)
  assert.equal(
    acc.inPackageBytes,
    Buffer.byteLength(all[0]!.scope.text, 'utf8') + Buffer.byteLength(all[2]!.scope.text, 'utf8'),
    '包内字节 = 进包文件**过滤后**文本的真实字节数',
  )

  // 没有文件被剔时：账 = 全部
  const accAll = summarizeDiagLineAccount(all, all.map((f) => f.name))
  assert.equal(accAll.files, 3)
  assert.equal(accAll.originalBytes, 10200)
  assert.equal(accAll.keptLines, 11)
  assert.equal(accAll.droppedLines, 4)
  assert.equal(accAll.truncatedFiles, 1)
  assert.deepEqual(accAll.excluded, { files: 0, lines: 0 })
  assert.ok(accAll.inPackageBytes > 0 && accAll.inPackageBytes < accAll.originalBytes)

  // 全部被剔时：账必须清零（zip 里只有 manifest + snapshot），被剔行数仍要看得出来
  const accNone = summarizeDiagLineAccount(all, [])
  assert.equal(accNone.files, 0)
  assert.equal(accNone.originalBytes, 0)
  assert.equal(accNone.inPackageBytes, 0, '一个文件都没进包 ⇒ 包内字节必须是 0（不能报原始大小）')
  assert.equal(accNone.keptLines, 0)
  assert.deepEqual(accNone.excluded, { files: 3, lines: 11 })
})
