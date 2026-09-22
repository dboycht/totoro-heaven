/**
 * 「上次读取的会话」缓存解析测试（2026-09-18）
 *
 * 缓存**只放任务 + 选线**（账号/开关不存：恢复语义是"用 token 重新读取"，存了也不会被读）。
 * 这里盯住三件事：老缓存兼容、垃圾数据安全降级、序列化只写最小集合。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskFromCachePayload, looksLikeTask, maskToken, normalizeCachePayload, resolveCacheTask, restorePatchOf, serializeCachePayload, shouldAutoRestoreFromCache } from '../../utils/mp/realCache.ts'
import { taskShapeLine } from '../../utils/mp/taskShape.ts'
import type { MpSunrunTask } from '../../src/mp/types.ts'

const TASK: MpSunrunTask = {
  paperName: '阳光跑',
  taskId: 'task-1',
  mileage: 3.2,
  runPointList: [{ pointId: 'L1', pointName: '西操场', pointList: [] }],
}

test('realCache：正常缓存能解析出任务、选线与 token', () => {
  const p = normalizeCachePayload({ at: 123, task: TASK, lineId: 'L1', token: 'gho_abcdefghijklmnop' })
  assert.ok(p)
  assert.equal(p!.at, 123)
  assert.equal(p!.lineId, 'L1')
  assert.equal(p!.token, 'gho_abcdefghijklmnop')
  assert.equal(p!.task.paperName, '阳光跑')
})

test('realCache：**老缓存（没有 token 字段）**能解析，token 归空串（界面据此提示去取 token）', () => {
  const p = normalizeCachePayload({ at: 1, task: TASK, lineId: 'L1' })
  assert.ok(p, '老缓存必须仍可解析（否则升级后用户的恢复入口全废）')
  assert.equal(p!.token, '', '没有 token ⇒ 空串，绝不能编造')
})

test('realCache：老/未知缓存里多余字段（如曾存过的 profile/switches）被忽略、不报错', () => {
  const p = normalizeCachePayload({
    at: 1,
    task: TASK,
    lineId: 'L1',
    token: 'gho_x',
    profile: { snCode: 'x', studentName: '旧字段' },
    switches: { sunrunStartFace: '0' },
    cameraFlag: false,
  })
  assert.ok(p, '多余字段不得导致解析失败')
  assert.deepEqual(Object.keys(p!).sort(), ['at', 'lineId', 'task', 'token'], '解析结果只保留四个字段')
})

test('realCache：垃圾数据安全降级（没有 task / 不是对象 → null）', () => {
  assert.equal(normalizeCachePayload(null), null)
  assert.equal(normalizeCachePayload(undefined), null)
  assert.equal(normalizeCachePayload('nonsense'), null)
  assert.equal(normalizeCachePayload([]), null)
  assert.equal(normalizeCachePayload({}), null)
  assert.equal(normalizeCachePayload({ at: 1, lineId: 'L1' }), null, '没有 task 就不算可用缓存')
  assert.equal(normalizeCachePayload({ task: 'not-an-object' }), null)
})

test('realCache：字段类型不对时归默认值，不污染界面状态', () => {
  const p = normalizeCachePayload({ at: 'not-a-number', task: TASK, lineId: 42, token: { bad: true } })
  assert.ok(p)
  assert.equal(p!.at, 0, '非法时间戳归零')
  assert.equal(p!.lineId, '', '非字符串 lineId 归空')
  assert.equal(p!.token, '', '非字符串 token 归空（绝不能把对象当 token 用）')
})

test('realCache：序列化只写四个字段，且往返一致', () => {
  const json = serializeCachePayload({ at: 789, task: TASK, lineId: 'L3', token: 'gho_tok' })
  assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ['at', 'lineId', 'task', 'token'], `实际写入：${json.slice(0, 120)}`)
  const back = normalizeCachePayload(JSON.parse(json))
  assert.equal(back!.at, 789)
  assert.equal(back!.lineId, 'L3')
  assert.equal(back!.token, 'gho_tok')
  assert.equal(back!.task.taskId, 'task-1')
})

test('realCache：maskToken 只露头尾，绝不在界面上暴露完整 token', () => {
  const full = 'gho_abcdefghijklmnopqrst'
  const masked = maskToken(full)
  assert.notEqual(masked, full)
  assert.ok(!masked.includes(full), '掩码里不得含完整 token')
  assert.equal(masked, 'gho_ab…opqrst', `实际：${masked}`)
  assert.equal(maskToken(''), '')
  // ⚠️ 短串一律固定掩码（审计 L1）：此前会原样显示（'abc' → 'abc…abc'）
  for (const short of ['a', 'abc', 'abcdef', 'abcdefg', 'abcdefghijklmn']) {
    const m = maskToken(short)
    assert.ok(!m.includes(short), `短串 ${short} 不得原样上屏（得到 ${m}）`)
    assert.match(m, /^\*+$/, `短串应给固定掩码，实际 ${m}`)
  }
  // 15 位起才走"头 6 + 尾 6"
  assert.equal(maskToken('a'.repeat(15)), 'aaaaaa…aaaaaa')
})

/**
 * 🔴 2026-09-22（真实用户诊断包暴露的**我们自己的** bug）：任务本体可能被"缓存包装 / API 信封"包了几层。
 *
 * 现场（研究生院「研途健行」用户发来的诊断包）：
 * ```
 * snapshot.task.raw.runPointList        = 0 条      ← 当时读到的（错）
 * snapshot.task.raw.data.runPointList   = 1 条      ← 真正的线路
 * snapshot.task.summary.shapeLine       = "route=free(0) fit=required(0.6)"  ← 错误结论
 * snapshot.task.lines                   = 0 条
 * ```
 * 这一组用例把"包装对象 / 响应信封 / 任务数组 / 真·无线路"四种形态全部钉死，防回退。
 */
const ONE_LINE = { pointId: 'L1', pointName: '西操场', pointList: [{ latitude: '30.1', longitude: '120.2' }] }

test('resolveCacheTask 🔴 缓存包装对象 `{…, task}` ⇒ 必须取到 cache.task（审计现场）', () => {
  const cache = { at: 1, lineId: 'L1', token: 'gho_x', task: { paperName: '研途健行', runPointList: [ONE_LINE] } }
  const r = resolveCacheTask(cache)
  assert.equal(r.task?.paperName, '研途健行')
  assert.equal((r.task?.runPointList as unknown[]).length, 1)
  assert.match(r.source, /^task/)
  const e = extractTaskFromCachePayload(cache)
  assert.equal(e.source, 'cache.task', '来源要能写进 manifest（便于排查"取自哪一层"）')
})

test('resolveCacheTask 🔴 API 响应信封 `{code, data:{runPointList}}` ⇒ 必须钻进 data（这次的 bug）', () => {
  const envelope = {
    code: '0',
    msg: 'ok',
    data: { paperName: '研途健行', taskId: 't-1', mileage: 2, fitDegree: 0.6, runPointList: [ONE_LINE] },
    sunrunTaskList: [{ paperName: '研途健行', runPointList: [ONE_LINE] }],
  }
  const r = resolveCacheTask(envelope)
  assert.equal(r.task?.paperName, '研途健行')
  assert.equal((r.task?.runPointList as unknown[]).length, 1, '顶层 runPointList 缺失时必须钻 data，而不是当成"0 条线路"')
  assert.match(r.source, /data/)
  // 摘要三件套必须**自洽**（这就是被读反的那个结论）
  assert.equal(taskShapeLine(r.task), 'route=line(1) fit=required(0.6)')
  assert.notEqual(taskShapeLine(r.task), 'route=free(0) fit=required(0.6)')
})

test('resolveCacheTask 🔴 包装 + 信封叠在一起 ⇒ 仍要取到任务本体（并报出完整路径）', () => {
  const both = {
    at: 7,
    lineId: '',
    token: '',
    task: { status: '00', code: '0', data: { paperName: '研途健行', runPointList: [ONE_LINE] }, sunrunTaskList: [] },
  }
  const r = resolveCacheTask(both)
  assert.equal((r.task?.runPointList as unknown[]).length, 1)
  assert.equal(r.source, 'task.data', '路径要精确到层（task.data）')
  assert.equal(taskShapeLine(r.task), 'route=line(1) fit=none')
})

test('resolveCacheTask：任务塞在顶层数组里（`sunrunTaskList[0]`）⇒ 也能取到', () => {
  const r = resolveCacheTask({ code: '0', sunrunTaskList: [{ paperName: '研途健行', runPointList: [ONE_LINE] }] })
  assert.equal(r.source, 'sunrunTaskList[0]')
  assert.equal((r.task?.runPointList as unknown[]).length, 1)
})

test('resolveCacheTask：🔴 真·无线路任务（`runPointList: []`）仍要如实报 route=free(0)（别把两种"0"混为一谈）', () => {
  // 任务本体在缓存包装里，且线路**确实**为空 ⇒ 这是有效事实，不能被当成"取错了层"
  const r = resolveCacheTask({ at: 1, task: { paperName: '自由跑', taskId: 't-2', runPointList: [] } })
  assert.ok(r.task, '空线路的任务**仍然是任务本体**（有 runPointList 字段就算）')
  assert.equal((r.task?.runPointList as unknown[]).length, 0)
  assert.equal(taskShapeLine(r.task), 'route=free(0) fit=none')
  // 信封里 data.runPointList 为空 ⇒ 同样如实报 free(0)
  const env = resolveCacheTask({ code: '0', data: { paperName: '自由跑', runPointList: [] } })
  assert.equal(taskShapeLine(env.task), 'route=free(0) fit=none')
})

test('resolveCacheTask：垃圾输入一律安全降级为 null / none（绝不抛错、绝不编造任务）', () => {
  for (const bad of [null, undefined, 42, 'str', [], {}, { code: '0' }, { a: { b: { c: { d: { e: 1 } } } } }]) {
    const r = resolveCacheTask(bad)
    assert.equal(r.task, null, `输入 ${JSON.stringify(bad)} 不该取出任务`)
    assert.equal(r.source, 'none')
  }
  // 自引用对象不得死循环（深度/去重双保险）
  const cyc: Record<string, unknown> = { code: '0' }
  cyc.data = cyc
  assert.equal(resolveCacheTask(cyc).task, null)
})

test('looksLikeTask：判据是"有没有任务字段"（空线路也算任务；纯信封不算）', () => {
  assert.equal(looksLikeTask({ runPointList: [] }), true, 'runPointList:[] 是有效任务（自由路线）')
  assert.equal(looksLikeTask({ paperName: 'x' }), true)
  assert.equal(looksLikeTask({ taskId: 't' }), true)
  assert.equal(looksLikeTask({ code: '0', msg: 'ok' }), false, '纯信封没有任务字段 ⇒ 不算任务本体')
  assert.equal(looksLikeTask(null), false)
  assert.equal(looksLikeTask([]), false)
})

// ---------- 🆕 2026-09-22（真实用户实测）：刷新后**自动从本机缓存恢复任务** ----------
/**
 * 现场：用户 17:10 两次「读取真实数据」都成功、门禁也通过；之后刷新/重开页面 ⇒ 内存里的 task 全丢
 * ⇒ 跑步页只剩一句"请先读取真实账号和任务"（他以为程序坏了、反复撞上）。修法 = 页面挂载时自动从缓存恢复。
 * 「有缓存时挂载后 `realStatus === 'ready'` 且 task 非空」这条断言，等价于这里的
 * `shouldAutoRestoreFromCache(...) === true` + `restorePatchOf(...).task` 非空（落盘状态由浏览器探针再验一遍）。
 */
test('autoRestore：三条判据缺一不可（内存已有任务 / 演示模式 / 没有缓存 ⇒ 都不恢复）', () => {
  assert.equal(shouldAutoRestoreFromCache({ hasTaskInMemory: false, demoMode: false, hasCache: true }), true, '只有"内存空 + 非演示 + 有缓存"才恢复')
  assert.equal(shouldAutoRestoreFromCache({ hasTaskInMemory: true, demoMode: false, hasCache: true }), false, '内存里已有任务 ⇒ 不覆盖、不打扰')
  assert.equal(shouldAutoRestoreFromCache({ hasTaskInMemory: false, demoMode: true, hasCache: true }), false, '演示数据是用户的显式选择，不许被顶掉')
  assert.equal(shouldAutoRestoreFromCache({ hasTaskInMemory: false, demoMode: false, hasCache: false }), false, '没有缓存 ⇒ 无从恢复')
})

test('restorePatch：正常缓存 ⇒ 任务/读取时刻/选线/token 原样搬（一个值都不编造）', () => {
  const patch = restorePatchOf({ at: 1700000000000, task: TASK, lineId: 'L1', token: 'gho_tok' })
  assert.ok(patch)
  assert.equal(patch!.task.paperName, '阳光跑', 'task 必须非空 —— 这是"挂载后 task 非空"那条断言的根据')
  assert.equal(patch!.loadedAt, 1700000000000, '界面要显示"最近一次读取于 …"')
  assert.equal(patch!.lineId, 'L1')
  assert.equal(patch!.token, 'gho_tok')
  // 老缓存（没有 token）⇒ 空串：界面据此提示"只做本地模拟可以，真实提交要重新读取"
  const old = restorePatchOf({ task: TASK, lineId: 'L1' })
  assert.ok(old)
  assert.equal(old!.token, '')
  assert.equal(old!.loadedAt, 0, 'at 非法/缺失归 0（界面不显示假时刻）')
})

test('restorePatch：任务本体被包在**信封**里时先拆开（否则会把"有线路"恢复成"没线路"）', () => {
  const envelope = { code: '0', msg: 'ok', data: { ...TASK, runPointList: [TASK.runPointList[0]!] } }
  const patch = restorePatchOf({ at: 5, task: envelope, lineId: 'L1', token: '' })
  assert.ok(patch, '信封必须能被拆开（这是 2026-09-22 诊断包暴露的坑）')
  assert.equal(patch!.task.paperName, '阳光跑', '取的必须是 data 里的任务本体，而不是把信封当任务')
  assert.equal(patch!.task.runPointList.length, 1, '"任务到底有没有线路"必须是本体里的真值')
})

test('restorePatch：形状不严 / 连本体都解析不出来 ⇒ 一律**不恢复**（绝不往内存里塞垃圾）', () => {
  assert.equal(restorePatchOf({ at: 5, task: { foo: 1, bar: 2 }, lineId: '', token: '' }), null)
  assert.equal(restorePatchOf('nonsense'), null)
  assert.equal(restorePatchOf(null), null)
  assert.equal(restorePatchOf(undefined), null)
  assert.equal(restorePatchOf({ at: 1, lineId: 'L1' }), null, '没有 task 字段 ⇒ 不算可用缓存')
})
