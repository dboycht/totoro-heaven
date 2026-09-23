/**
 * 「任务未下发线路 ⇒ 编辑器里那条**本机跑道**」的单测（2026-09-22，issue #12）
 *
 * 用户实测的 bug：任务没下发线路（`runPointList` 为空）时，跑道编辑器的下拉必然没有可选线路
 * ⇒ 描完点一保存就被拒（"需要选择一条路线"）⇒ **无几何可用、永远跑不了**。
 *
 * 判据（可执行）：
 *   · `routeRequirementOf(task).kind === 'free'` ⇒ 必须给出**固定键名** `local:free` 的本机条目；
 *   · `kind === 'line'`（服务端下发了线路）⇒ **返回 null**（有线路的任务必须零回归：
 *     下拉里只有服务端线路，保存仍按线路 `pointId` 落库）；
 *   · 名字只能说"**本机跑道 / 本任务未下发线路**"，**不许**出现"官方路线"这类冒充服务端线路的说法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FREE_ROUTE_CHOICE_KEY,
  LOCAL_FREE_LINE_ID,
  LOCAL_FREE_LINE_NAME,
  LOCAL_FREE_LINE_NAME_NO_TASK,
  entryGeometryUsable,
  freeRouteGeometryChoice,
  freeRouteLocalEntry,
  localFreeTrackLine,
  parseFreeRouteChoices,
  withFreeRouteChoice,
  type TrackRouteEntry,
} from '../../utils/mp/trackLibrary.ts'
import type { FreePathShape } from '../../utils/mp/pathShape.ts'

/** 一个几何可用的"圈型非官方路径"（给 `entryGeometryUsable` / 选择判据的用例用） */
const CURVE: FreePathShape = {
  kind: 'curve',
  points: [
    { latitude: 32, longitude: 118.8 },
    { latitude: 32.0006, longitude: 118.8 },
    { latitude: 32.0006, longitude: 118.8006 },
    { latitude: 32, longitude: 118.8006 },
  ],
}

test('localFreeTrackLine：任务未下发线路 ⇒ 固定键名的本机条目', () => {
  for (const task of [
    { taskId: 'T1', paperName: '研途健行', runPointList: [] },
    { taskId: 'T1', paperName: '研途健行' }, // 字段整个缺失
    { taskId: 'T1', runPointList: null },
  ]) {
    const line = localFreeTrackLine(task)
    assert.ok(line, `runPointList=${JSON.stringify((task as Record<string, unknown>).runPointList)} 应给出本机条目`)
    assert.equal(line.lineId, LOCAL_FREE_LINE_ID)
    assert.equal(line.lineId, 'local:free', '键名是固定约定，改它等于改已有用户的本机路线库主键')
    assert.equal(line.lineName, LOCAL_FREE_LINE_NAME)
  }
})

test('localFreeTrackLine：任务下发了线路 ⇒ null（**有线路的任务零回归**）', () => {
  assert.equal(localFreeTrackLine({ taskId: 'T1', runPointList: [{ pointId: 'L1', pointName: '西操场', pointList: [] }] }), null)
  // 哪怕只有一条线路，也**不许**再塞一条本机条目进去（否则下拉里会多出一条不是服务端线路的选项）
  assert.equal(localFreeTrackLine({ runPointList: [{ pointId: 'only' }] }), null)
})

test('localFreeTrackLine：连任务都还没读 ⇒ 仍给本机条目，但措辞如实（不说"本任务未下发线路"）', () => {
  for (const t of [undefined, null]) {
    const line = localFreeTrackLine(t)
    assert.ok(line)
    assert.equal(line.lineId, LOCAL_FREE_LINE_ID, '键名与"任务没线路"共用同一个（避免凭空多出条目）')
    assert.equal(line.lineName, LOCAL_FREE_LINE_NAME_NO_TASK)
    assert.match(line.lineName, /还没读取任务/)
  }
})

test('本机条目的名字不得冒充"官方路线"（口径守卫）', () => {
  for (const name of [LOCAL_FREE_LINE_NAME, LOCAL_FREE_LINE_NAME_NO_TASK]) {
    assert.match(name, /本机跑道/, name)
    assert.doesNotMatch(name, /官方/, `${name} 不许说成官方路线`)
    assert.doesNotMatch(name, /服务端不判/, `${name} 不许写成"服务端不判路线"（那是我们证明不了的结论）`)
  }
})

// ---------- 🆕 2026-09-22（用户反馈 + 负责人批准）：自由路线任务**用哪一条本机几何** ----------
/**
 * 背景（"串味"）：跑步引擎原先取"本机路线库第一条（= 最近保存的那条）"。
 * 用户刚在「非官方路径【测试】」画完、之后又保存了别的东西（另一条任务的跑道等）时，
 * 被采用的就不是他刚画的那条 ⇒ 他以为"我画的没用上"（反馈"无法选择"）。
 * 新判据：**自由路线任务优先认「非官方路径【测试】」那条固定键 `local:free`**；没有它才退回"最近保存的那条"，
 * 并且这种回退必须带 `fallback: true`（界面据此如实说明）。
 */
const entry = (lineId: string, updatedAt: string, extra: Record<string, unknown> = {}) =>
  ({
    lineId,
    lineName: lineId,
    outer: [
      { latitude: 32, longitude: 118.8 },
      { latitude: 32.0006, longitude: 118.8 },
      { latitude: 32.0006, longitude: 118.8006 },
    ],
    inner: [
      { latitude: 32.0001, longitude: 118.8001 },
      { latitude: 32.0005, longitude: 118.8001 },
      { latitude: 32.0005, longitude: 118.8005 },
    ],
    createdAt: '2026-09-20T02:00:00.000Z',
    updatedAt,
    appVersion: '1.2.5',
    ...extra,
  }) as unknown as TrackRouteEntry

const FREE_TASK = { taskId: 'T1', paperName: '研途健行', runPointList: [] }
const LINE_TASK = { taskId: 'T1', paperName: '阳光跑', runPointList: [{ pointId: 'L1', pointName: '西操场', pointList: [] }] }

test('🔴 freeRouteGeometryChoice：老双圈条目**更晚保存**、`local:free` **更早保存** ⇒ 必须选 `local:free`', () => {
  // 库是"最新在前"（`useTrackLibrary.upsert` 前插）⇒ 这条夹具就是"用户画完非官方路径后又存了别的"那现场
  const entries = [entry('sunrunLine-old', '2026-09-22T14:50:00.000Z'), entry(LOCAL_FREE_LINE_ID, '2026-09-22T14:31:00.000Z')]
  const choice = freeRouteGeometryChoice(entries, FREE_TASK)
  assert.equal(choice.entry?.lineId, LOCAL_FREE_LINE_ID, '自由路线任务必须认「非官方路径」保存的那条，而不是"最近保存"')
  assert.equal(choice.fallback, false, '优先命中不算回退 ⇒ 界面不该说"暂用最近保存的跑道"')
  assert.match(choice.reason, /非官方路径/)
  // 便捷包装（跑步引擎用）必须给出同一条
  assert.equal(freeRouteLocalEntry(entries, FREE_TASK)?.lineId, LOCAL_FREE_LINE_ID)
})

test('freeRouteGeometryChoice：没有 `local:free`（老用户没画过）⇒ 退回"最近保存的那条"，并标 `fallback`', () => {
  const entries = [entry('sunrunLine-old', '2026-09-22T14:50:00.000Z'), entry('sunrunLine-older', '2026-09-20T02:00:00.000Z')]
  const choice = freeRouteGeometryChoice(entries, FREE_TASK)
  assert.equal(choice.entry?.lineId, 'sunrunLine-old', '退回最近保存的那条')
  assert.equal(choice.fallback, true, '回退必须如实标记（界面据此说明"本机还没有非官方路径形状"）')
  assert.match(choice.reason, /还没有「非官方路径」形状|暂用最近保存/)
  // 库为空 ⇒ 没有几何（调用方按"还没有几何"提示，绝不假装有一条）
  const empty = freeRouteGeometryChoice([], FREE_TASK)
  assert.equal(empty.entry, undefined)
  assert.equal(empty.fallback, false)
})

test('freeRouteGeometryChoice：**有线路的任务零变化**（永远不选本机条目）', () => {
  const entries = [entry(LOCAL_FREE_LINE_ID, '2026-09-22T14:31:00.000Z')]
  const choice = freeRouteGeometryChoice(entries, LINE_TASK)
  assert.equal(choice.entry, undefined, '服务端下发了线路 ⇒ 几何来自任务线路，与本机库无关')
  assert.equal(choice.fallback, false)
  assert.equal(choice.reason, '')
  assert.equal(freeRouteLocalEntry(entries, LINE_TASK), undefined)
})

// ---------- 🆕 2026-09-22（用户批准）：跑步页「本机路径」下拉 —— 用户自己选的那条优先 ----------
test('🔴 freeRouteGeometryChoice：**用户选的那条**（几何可用）优先于 `local:free` 与"最近保存"', () => {
  const entries = [entry('sunrunLine-other', '2026-09-22T14:50:00.000Z'), entry(LOCAL_FREE_LINE_ID, '2026-09-22T14:31:00.000Z')]
  const choice = freeRouteGeometryChoice(entries, FREE_TASK, 'sunrunLine-other')
  assert.equal(choice.entry?.lineId, 'sunrunLine-other', '用户选的必须生效（否则又是"界面说用 A、实际用 B"）')
  assert.equal(choice.fallback, false)
  assert.equal(choice.preferredUnavailable, false)
  assert.match(choice.reason, /本机路径/)
  // 便捷包装（跑步引擎用）也要给出同一条
  assert.equal(freeRouteLocalEntry(entries, FREE_TASK, 'sunrunLine-other')?.lineId, 'sunrunLine-other')
  // 没选过（空串/undefined）⇒ 仍按原口径回落到 local:free
  assert.equal(freeRouteGeometryChoice(entries, FREE_TASK, '').entry?.lineId, LOCAL_FREE_LINE_ID)
  assert.equal(freeRouteGeometryChoice(entries, FREE_TASK, undefined).entry?.lineId, LOCAL_FREE_LINE_ID)
})

test('🔴 freeRouteGeometryChoice：用户选的那条**已被删除** ⇒ 落回 `local:free` 并标记 `preferredUnavailable`', () => {
  const entries = [entry(LOCAL_FREE_LINE_ID, '2026-09-22T14:31:00.000Z')]
  const choice = freeRouteGeometryChoice(entries, FREE_TASK, 'sunrunLine-已删除')
  assert.equal(choice.entry?.lineId, LOCAL_FREE_LINE_ID, '被删了要落回现有可用的那条')
  assert.equal(choice.preferredUnavailable, true, '界面据此如实提示"你上次选的那条已不可用"')
  assert.match(choice.reason, /已不可用/)
  // 连 local:free 也没有 ⇒ 落回"最近保存"并仍是 preferredUnavailable
  const onlyRecent = [entry('sunrunLine-recent', '2026-09-22T14:50:00.000Z')]
  const fallback = freeRouteGeometryChoice(onlyRecent, FREE_TASK, 'sunrunLine-已删除')
  assert.equal(fallback.entry?.lineId, 'sunrunLine-recent')
  assert.equal(fallback.fallback, true)
  assert.equal(fallback.preferredUnavailable, true)
  assert.match(fallback.reason, /已不可用/)
})

test('entryGeometryUsable：有形状 / 双圈够点 ⇒ 可用；双圈点数不够 ⇒ 不可用（与引擎同判据）', () => {
  assert.equal(entryGeometryUsable({ lineId: 'a', lineName: 'a', outer: [], inner: [], createdAt: '', appVersion: '', freeShape: CURVE } as TrackRouteEntry), true)
  assert.equal(entryGeometryUsable(entry('ring', '2026-09-22T14:00:00.000Z')), true)
  const broken = { lineId: 'b', lineName: 'b', outer: [{ latitude: 1, longitude: 2 }], inner: [], createdAt: '', appVersion: '' } as TrackRouteEntry
  assert.equal(entryGeometryUsable(broken), false)
  assert.equal(entryGeometryUsable(null), false)
  // 选了一条"几何坏了"的 ⇒ 与"被删"同样处理（落回 + 提示），不选它
  const entries = [broken, entry(LOCAL_FREE_LINE_ID, '2026-09-22T14:31:00.000Z')]
  const choice = freeRouteGeometryChoice(entries, FREE_TASK, 'b')
  assert.equal(choice.entry?.lineId, LOCAL_FREE_LINE_ID)
  assert.equal(choice.preferredUnavailable, true)
})

test('🔴 持久化（纯函数）：解析坏数据安全降级；写入按 taskId 各记各的、清空用空串', () => {
  assert.deepEqual(parseFreeRouteChoices(null), {})
  assert.deepEqual(parseFreeRouteChoices('nonsense'), {})
  assert.deepEqual(parseFreeRouteChoices([]), {}, '数组不算映射')
  assert.deepEqual(parseFreeRouteChoices({ T1: 'local:free', T2: '  ', '': 'x', T3: 42 }), { T1: 'local:free' }, '空白/非字符串/空键一律丢掉')
  assert.equal(FREE_ROUTE_CHOICE_KEY, 'mp_free_route_choice_v1', '键名是持久化契约，改它等于让所有人的选择失效')

  const a = withFreeRouteChoice({}, 'T1', 'local:free')
  assert.deepEqual(a, { T1: 'local:free' })
  const b = withFreeRouteChoice(a, 'T2', 'sunrunLine-x')
  assert.deepEqual(b, { T1: 'local:free', T2: 'sunrunLine-x' }, '**换任务各记各的**（互不影响）')
  assert.deepEqual(a, { T1: 'local:free' }, '返回新对象，绝不改原对象')
  assert.deepEqual(withFreeRouteChoice(b, 'T1', 'other'), { T1: 'other', T2: 'sunrunLine-x' }, '同任务覆盖')
  assert.deepEqual(withFreeRouteChoice(b, 'T1', ''), { T2: 'sunrunLine-x' }, '空串 = 清掉该任务的选择')
  assert.deepEqual(withFreeRouteChoice(b, '', 'x'), { T1: 'local:free', T2: 'sunrunLine-x' }, '没有 taskId ⇒ 不写')
})
