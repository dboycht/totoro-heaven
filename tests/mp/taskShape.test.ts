/**
 * 「任务要求什么」的探测单测（2026-09-21）
 *
 * 这两条判据的由来（issue #12）：
 *  · 拟合度：以前 `Number(task.fitDegree ?? 0.6)` 把"服务端没下发"读成了"要求 0.6" ⇒ 自检表报红甚至拦提交；
 *  · 线路：`runPointList` 为空（任务不指定路线）被归因成"你还没描跑道" ⇒ 门禁卡死。
 * 所以这里把"**没下发 ≠ 有要求**"逐条钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitRequirementOf, routeRequirementOf, taskShapeLine } from '../../utils/mp/taskShape.ts'

test('fitRequirementOf：服务端没下发 ⇒ 不要求（不再默认 0.6）', () => {
  for (const v of [undefined, null, '', '   ']) {
    const r = fitRequirementOf({ fitDegree: v })
    assert.equal(r.required, false, `fitDegree=${JSON.stringify(v)} 应当"不要求"`)
    assert.equal(r.threshold, null)
    assert.match(r.reason, /未下发|不判/, r.reason)
  }
  // 整个任务对象都缺失也一样（读任务失败时不能凭空造要求）
  assert.equal(fitRequirementOf(undefined).required, false)
  assert.equal(fitRequirementOf({}).required, false)
})

test('fitRequirementOf：非数字 / 0 / 负数 ⇒ 不要求（0 等于不设要求）', () => {
  assert.equal(fitRequirementOf({ fitDegree: 'abc' }).required, false)
  assert.equal(fitRequirementOf({ fitDegree: 'abc' }).reason.includes('不是有效数字'), true)
  assert.equal(fitRequirementOf({ fitDegree: 0 }).required, false)
  assert.equal(fitRequirementOf({ fitDegree: '0' }).required, false)
  assert.equal(fitRequirementOf({ fitDegree: -1 }).required, false)
})

test('fitRequirementOf：下发了有效阈值 ⇒ 要求，且原值照用（不做量纲换算）', () => {
  const a = fitRequirementOf({ fitDegree: 0.6 })
  assert.deepEqual({ required: a.required, threshold: a.threshold }, { required: true, threshold: 0.6 })
  const b = fitRequirementOf({ fitDegree: '0.65' })
  assert.deepEqual({ required: b.required, threshold: b.threshold }, { required: true, threshold: 0.65 }, '字符串数字要能读')
  const c = fitRequirementOf({ fitDegree: 80 })
  assert.equal(c.threshold, 80, '百分制原样保留，不擅自 /100')
  assert.match(a.reason, /0\.6/)
})

test('routeRequirementOf：runPointList 为空 / 缺失 / 非数组 ⇒ free（任务不指定路线）', () => {
  for (const v of [undefined, null, [], 'x', {}]) {
    const r = routeRequirementOf({ runPointList: v })
    assert.equal(r.kind, 'free', `runPointList=${JSON.stringify(v)} 应判 free`)
    assert.equal(r.lineCount, 0)
    assert.match(r.reason, /未下发线路/, r.reason)
  }
  assert.equal(routeRequirementOf(undefined).kind, 'free')
})

test('routeRequirementOf：有线路 ⇒ line 且条数正确（此时才该提示"去描跑道"）', () => {
  const r = routeRequirementOf({ runPointList: [{ pointId: 'a' }, { pointId: 'b' }] })
  assert.equal(r.kind, 'line')
  assert.equal(r.lineCount, 2)
  assert.match(r.reason, /2 条线路/)
})

test('taskShapeLine：给日志/诊断导出的一行摘要稳定可读', () => {
  assert.equal(taskShapeLine({ runPointList: [{ pointId: 'a' }], fitDegree: 0.6 }), 'route=line(1) fit=required(0.6)')
  assert.equal(taskShapeLine({ runPointList: [], fitDegree: '' }), 'route=free(0) fit=none')
  assert.equal(taskShapeLine(null), 'route=free(0) fit=none')
})
