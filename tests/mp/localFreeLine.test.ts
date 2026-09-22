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
  LOCAL_FREE_LINE_ID,
  LOCAL_FREE_LINE_NAME,
  LOCAL_FREE_LINE_NAME_NO_TASK,
  localFreeTrackLine,
} from '../../utils/mp/trackLibrary.ts'

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
