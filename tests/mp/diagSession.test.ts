/**
 * `server/utils/diagSession.ts`（诊断**记录窗口**的服务端主存）的单测 —— 2026-09-22 新增
 *
 * 为什么必须单独测（issue #12 两次返工的教训）：
 *   · 第一版窗口在组件 `ref` 里 ⇒ 切页就丢；
 *   · 第二版在 `useState` 里 ⇒ **刷新就丢**（用户原话："刷新为什么会丢？我们要做的是软件层面上的所有服务进行记录"）；
 *   · 现在窗口在**服务端进程内存**为主 + `diagnostics/session.json` 为辅，并带**进程实例标识**。
 * 这三条性质（内存为主 / 跨请求仍在 / **换实例一律当没有窗口**）都不是"跑一次看看"能保证的，
 * 尤其是**第 3 条**：一旦判据写松，用户"关掉 EXE 再启动"就会**继承上一次的窗口**（他明确要求不要这样）。
 *
 * ⚠️ 手法与 `tests/mp/diagLogs.test.ts` 一致：**全部用临时目录**（各函数都接受 `dir` 参数，
 * 生产不传 ⇒ 用 `%TEMP%\totoro-heaven-runtime\diagnostics`）。本文件**绝不碰**真实运行目录。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'totoro-diagsession-'))

const {
  DIAG_INSTANCE_ID,
  DIAG_SESSION_NAME,
  __resetSessionMemoryForTest,
  clearDiagSession,
  coerceWindow,
  ignoredPrevInstanceInfo,
  readSession,
  readSessionFile,
  sessionElapsedSeconds,
  startSession,
  stopSession,
  patchSessionIncludeGeometry,
  // 🆕 这两个是**转发**出口（实现与单测在契约层）：`server/api/local/diagnostics/record/**`
  //    只能从 `server/utils/*` 引（本机 moduleResolution=bundler 下引 `<root>/utils/mp/*` 解析不到），
  //    所以必须断言它们**确实被转出来了** —— 否则端点会 TS2307。
  diagWindowMatch,
  readIncludeGeometryFlag,
} = await import('../../server/utils/diagSession.ts')
const { assertNoCredentials, diagWindowMatch: contractDiagWindowMatch, readIncludeGeometryFlag: contractReadIncludeGeometryFlag } = await import('../../utils/mp/diagnostics.ts')

after(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 测试收尾清理：失败不影响结论（sandbox 在系统临时目录里） */
  }
})

beforeEach(() => {
  /**
   * 每个用例前**清干净沙箱目录**（而不只是清内存主存）：
   * 否则上一个用例写下的 `session.json` 会被下一个用例当成"已经存在的窗口"读到
   * （实测踩到：`readSession()` 的"没点过开始 ⇒ 没有窗口"断言读到上一个用例留下的窗口）。
   */
  __resetSessionMemoryForTest()
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论：下面的 mkdirSync 会重建（sandbox 在系统临时目录里） */
  }
  mkdirSync(sandbox, { recursive: true })
})

/** 造一个"上一个实例"的窗口（时间随便给，只求字段齐全、instanceId 明显不是当前的） */
function staleWindow(instanceId = '1111111111111-deadbeefdeadbeef'): Record<string, unknown> {
  return {
    id: 'w-20260101-000000-aaaaaa',
    instanceId,
    recording: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    startedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    endedAt: '2026-01-01T00:10:00.000Z',
    endedAtMs: Date.parse('2026-01-01T00:10:00.000Z'),
    includeGeometry: false,
  }
}

test('diagSession：开始记录 ⇒ 写进运行目录下的 session.json，且**带本进程实例标识**', () => {
  const win = startSession({ includeGeometry: false, dir: sandbox })
  assert.match(win.id, /^w-\d{8}-\d{6}-[0-9a-f]{6}$/, '窗口 id 形如 w-<yyyymmdd>-<hhmmss>-<rand>')
  assert.equal(win.instanceId, DIAG_INSTANCE_ID, '窗口必须带**本进程**的实例标识')
  assert.equal(win.recording, true)
  assert.equal(win.includeGeometry, false, '坐标开关随窗口一起保存')
  assert.ok(win.startedAtMs > 0 && win.endedAt === '' && win.endedAtMs === 0, '刚开始时没有结束时间')

  const onDisk = JSON.parse(readFileSync(join(sandbox, DIAG_SESSION_NAME), 'utf8')) as Record<string, unknown>
  assert.deepEqual(onDisk, win, '文件内容应当与内存里那份逐字段一致（它是同实例内的持久化依据）')
})

test('diagSession：跨请求仍在（模块级主存）；结束后**封存为最近一次**而不是消失', () => {
  assert.equal(readSession(sandbox), null, '没点过开始 ⇒ 没有窗口')
  const started = startSession({ dir: sandbox, now: new Date('2026-09-22T10:00:00.000Z') })
  const again = readSession(sandbox)
  assert.ok(again, '同一实例内再问一次，窗口仍在（这就是"刷新/切页不中断"的服务端依据）')
  assert.equal(again?.id, started.id)

  const sealed = stopSession({ dir: sandbox, now: new Date('2026-09-22T10:02:00.000Z') })
  assert.equal(sealed?.recording, false, '结束后 recording 必须为 false')
  assert.equal(sealed?.endedAt, '2026-09-22T10:02:00.000Z')
  assert.equal(readSession(sandbox)?.recording, false, '封存后的窗口**仍然读得到**（导出要用"最近一次"）')
  assert.equal(sessionElapsedSeconds(readSession(sandbox)), 120, '封存后时长固定为实际记录时长')

  // 幂等：再点一次结束不会把 endedAt 冲掉
  const again2 = stopSession({ dir: sandbox, now: new Date('2026-09-22T10:30:00.000Z') })
  assert.equal(again2?.endedAt, '2026-09-22T10:02:00.000Z', '重复结束必须幂等（否则窗口区间会被越推越后）')
})

test('diagSession 🔴 实例判据：磁盘上是**上一个实例**的窗口 ⇒ 一律当"没有窗口"，并记下被忽略的是谁', () => {
  writeFileSync(join(sandbox, DIAG_SESSION_NAME), JSON.stringify(staleWindow(), null, 2), 'utf8')
  const loaded = readSessionFile(sandbox)
  assert.equal(loaded.reason, 'stale-instance', '必须识别为"上一个实例的残留"')
  assert.equal(loaded.window, null)
  const ignored = ignoredPrevInstanceInfo()
  assert.ok(ignored, '要能说明"忽略了哪个实例的哪个窗口"（export 会写进 manifest）')
  assert.equal(ignored?.instanceId, '1111111111111-deadbeefdeadbeef')
  assert.equal(ignored?.id, 'w-20260101-000000-aaaaaa')
  // 界面的 GET 走 readSession：它必须给出"未记录"
  assert.equal(readSession(sandbox), null, '上一个实例的窗口绝不能变成"正在记录"')
  // 而"开始记录"会干脆覆盖掉那个残留
  const fresh = startSession({ dir: sandbox })
  assert.equal(fresh.instanceId, DIAG_INSTANCE_ID)
  assert.equal(fresh.recording, true)
})

test('diagSession：文件损坏 / 字段不全 ⇒ 按"没有窗口"处理（窗口是辅助信息，不能把导出带崩）', () => {
  const dir = join(sandbox, 'broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, DIAG_SESSION_NAME), '{ 这不是 JSON', 'utf8')
  assert.deepEqual(readSessionFile(dir), { window: null, reason: 'malformed' })
  assert.equal(readSession(dir), null)

  writeFileSync(join(dir, DIAG_SESSION_NAME), JSON.stringify({ id: 'w-x' }), 'utf8')
  assert.equal(readSessionFile(dir).reason, 'malformed', '缺 startedAtMs/instanceId ⇒ 读不出窗口（不猜、不修补）')
  assert.equal(readSessionFile(join(sandbox, 'not-exist')).reason, 'missing')
  assert.equal(readSessionFile(join(sandbox, 'not-exist')).window, null)
})

test('diagSession 🔴 窗口里只许有 id/时间/开关：反序列化走白名单，多出来的字段进不来', () => {
  const dirty = { ...staleWindow(DIAG_INSTANCE_ID), token: 'WXXCX_FAKE_ABCDEFGHIJKLMNOPQRSTUVWXYZ', snCode: '2021001234', studentName: '张三' }
  const win = coerceWindow(dirty)
  assert.ok(win)
  assert.deepEqual(Object.keys(win!).sort(), ['endedAt', 'endedAtMs', 'id', 'includeGeometry', 'instanceId', 'recording', 'startedAt', 'startedAtMs'], '只保留窗口该有的字段')
  assert.deepEqual(assertNoCredentials([JSON.stringify(win)]).hits, [], '窗口对象里不得出现任何凭证样式')
  // 落盘那份也必须干净（即便磁盘上原文件是脏的，我们**重写**时只写白名单字段）
  writeFileSync(join(sandbox, DIAG_SESSION_NAME), JSON.stringify(dirty), 'utf8')
  const loaded = readSessionFile(sandbox).window!
  assert.deepEqual(Object.keys(loaded).sort(), ['endedAt', 'endedAtMs', 'id', 'includeGeometry', 'instanceId', 'recording', 'startedAt', 'startedAtMs'])
  assert.deepEqual(assertNoCredentials([JSON.stringify(loaded)]).hits, [])
})

test('diagSession：记录中可改坐标开关（PATCH 口径）；没有窗口时返回 null 而不是抛错', () => {
  assert.equal(patchSessionIncludeGeometry(false, { dir: sandbox }), null, '没有窗口 ⇒ null（界面据此提示先开始记录）')
  startSession({ includeGeometry: true, dir: sandbox })
  const patched = patchSessionIncludeGeometry(false, { dir: sandbox })
  assert.equal(patched?.includeGeometry, false)
  assert.equal(readSession(sandbox)?.includeGeometry, false, '改动要落到主存（刷新后 GET 读回来的就是它）')
  assert.equal(patched?.recording, true, '只改开关，不动"是否在记录"')
  const onDisk = JSON.parse(readFileSync(join(sandbox, DIAG_SESSION_NAME), 'utf8')) as { includeGeometry: boolean }
  assert.equal(onDisk.includeGeometry, false, '也要落盘（同实例内的持久化依据）')
})

test('diagSession：clearDiagSession 把窗口从内存与文件里都清掉（单测与将来的「清除记录」按钮共用）', () => {
  startSession({ dir: sandbox })
  clearDiagSession(sandbox)
  assert.equal(readSession(sandbox), null)
  assert.equal(existsSync(join(sandbox, DIAG_SESSION_NAME)), false)
})

test('diagSession：sessionElapsedSeconds —— 记录中按"此刻"算、封存后按 endedAt 算（界面走秒的唯一口径）', () => {
  const started = startSession({ dir: sandbox, now: new Date('2026-09-22T10:00:00.000Z') })
  assert.equal(sessionElapsedSeconds(started, Date.parse('2026-09-22T10:00:45.000Z')), 45, '正在记录 ⇒ 用传入的"此刻"')
  const sealed = stopSession({ dir: sandbox, now: new Date('2026-09-22T10:01:00.000Z') })
  // 封存后再传入更晚的"此刻"也不该继续涨（否则界面会显示一个永远在走的假时长）
  assert.equal(sessionElapsedSeconds(sealed, Date.parse('2026-09-22T11:00:00.000Z')), 60)
  assert.equal(sessionElapsedSeconds(null), 0)
})

/**
 * 🆕 2026-09-22（审计 B2/B6）：两条端点判据是**转发出口**，必须真的可用。
 * 为什么在这里测：`record/**` 端点只能从 `server/utils/*` 引（本机 bundler 解析限制），
 * 所以"转发有没有断"必须由这条断言守住 —— 断了就是端点 500/TS2307。
 * （判据本身的完整用例在 `tests/mp/diagnostics.test.ts`。）
 */
test('diagSession 转发出口：diagWindowMatch / readIncludeGeometryFlag 可用且与契约层同一实现', () => {
  assert.equal(typeof diagWindowMatch, 'function')
  assert.equal(typeof readIncludeGeometryFlag, 'function')
  // 与契约层同一个函数（同一份实现，不是复制粘贴的第二份）
  assert.equal(diagWindowMatch, contractDiagWindowMatch, '必须与契约层是**同一个函数对象**（转发而非副本）')
  assert.equal(readIncludeGeometryFlag, contractReadIncludeGeometryFlag)
  // 抽查行为：默认关坐标的写法必须被拒（fail-closed），而不是被当成 true
  assert.equal(readIncludeGeometryFlag({ includeGeometry: 'false' }).kind, 'invalid')
  assert.equal(readIncludeGeometryFlag({}).kind, 'missing')
  assert.equal(diagWindowMatch({ clientWindowId: 'w-1', respondedWindowId: 'w-2', serverInstanceId: 'i1', reportedInstanceId: 'i1' })?.reason, 'overwritten')
})
