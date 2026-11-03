/**
 * **本地拟合度质量闸**的纯逻辑测试（2026-11-03，用户要求）
 *
 * 用户原话："添加相关本地判定，当拟合度小于 0.6 时提示本地校验不通过，要求重新生成"。
 *
 * 这里钉住四条**最容易做错**的：
 *   ① 未下发线路（研途健行这类）**绝不能拦** —— 没有可对照的路线，自算必然接近 0；
 *   ② 服务端阈值**比本地地板更严时以服务端为准**（0.8 的阈值不能被 0.6 的地板放松）；
 *   ③ 拟合度**读不出时不做否定判断**（证据不足 ⇒ 不拦）；
 *   ④ 文案必须写成"本地校验不通过"，且**明说不是替服务端判分**（issue #12 的反例还在）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_FIT_FLOOR, evaluateLocalFitGate, localFitServerNote } from '../../utils/mp/localFitGate.ts'

/** 常规任务：下发了线路 + 阈值 0.60（与实测的南航任务同口径） */
const LINE_TASK = {
  taskId: 'sunrunTaskPaper-1',
  paperId: 'sunrunTaskPaper-1',
  paperName: '天目湖阳光跑',
  mileage: 3.2,
  fitDegree: 0.6,
  minSpeed: 3,
  maxSpeed: 15,
  minTime: 10,
  maxTime: 25,
  runPointList: [{ pointId: 'L1', pointName: '东操场', pointList: [{ latitude: 31.9, longitude: 118.8 }, { latitude: 31.91, longitude: 118.81 }] }],
}

test('本地地板就是 0.6（用户指定），且低于它必须判"不通过"', () => {
  assert.equal(LOCAL_FIT_FLOOR, 0.6)
  const bad = evaluateLocalFitGate({ fitDegree: 0.45, task: LINE_TASK })
  assert.equal(bad.applies, true)
  assert.equal(bad.ok, false)
  assert.equal(bad.threshold, 0.6)
  assert.equal(bad.source, 'local')
  assert.match(bad.message, /本地校验不通过/)
  assert.match(bad.message, /0\.45 < 0\.60/)
  assert.match(bad.message, /重新生成/)
})

test('刚好等于门槛 ⇒ 通过（判据是 `>=`，不是 `>`）', () => {
  const edge = evaluateLocalFitGate({ fitDegree: 0.6, task: LINE_TASK })
  assert.equal(edge.ok, true)
  assert.match(edge.message, /本地校验通过/)
  const ok = evaluateLocalFitGate({ fitDegree: 0.97, task: LINE_TASK })
  assert.equal(ok.ok, true)
  assert.equal(ok.source, 'local', '服务端阈值 0.6 不高于本地地板 ⇒ 来源仍是本地地板')
})

test('🔴 未下发线路（研途健行这类）⇒ **整项不适用**，绝不拦（否则那类任务永远提交不了）', () => {
  const freeTask = { ...LINE_TASK, runPointList: [] }
  const r = evaluateLocalFitGate({ fitDegree: 0, task: freeTask })
  assert.equal(r.applies, false)
  assert.equal(r.ok, true)
  assert.equal(r.threshold, null)
  assert.equal(r.source, 'none')
  assert.match(r.skipReason, /未下发线路/)
  assert.equal(r.message, '', '不适用时不该给"通过/不通过"的话术')
})

test('服务端阈值更严时**以服务端为准**（0.8 不能被 0.6 的地板放松）', () => {
  const strict = { ...LINE_TASK, fitDegree: 0.8 }
  const r = evaluateLocalFitGate({ fitDegree: 0.7, task: strict })
  assert.equal(r.threshold, 0.8)
  assert.equal(r.source, 'task')
  assert.equal(r.ok, false, '0.70 < 0.80 ⇒ 不通过')
  assert.match(r.message, /服务端阈值 0\.80/)
  /** 服务端阈值比地板松（0.5）时，仍用本地地板 0.6 */
  const loose = evaluateLocalFitGate({ fitDegree: 0.55, task: { ...LINE_TASK, fitDegree: 0.5 } })
  assert.equal(loose.threshold, 0.6)
  assert.equal(loose.source, 'local')
  assert.equal(loose.ok, false)
})

test('拟合度读不出 / 任务没下发阈值字段 ⇒ 不适用（证据不足不否定）', () => {
  assert.equal(evaluateLocalFitGate({ fitDegree: null, task: LINE_TASK }).applies, false)
  assert.equal(evaluateLocalFitGate({ fitDegree: Number.NaN, task: LINE_TASK }).applies, false)
  assert.equal(evaluateLocalFitGate({ fitDegree: undefined, task: LINE_TASK }).applies, false)
  /** 任务**没下发** fitDegree 字段 ⇒ 门槛退回本地地板 0.6（用户要的"本地判定"照旧成立） */
  const noThreshold = evaluateLocalFitGate({ fitDegree: 0.5, task: { ...LINE_TASK, fitDegree: null } })
  assert.equal(noThreshold.applies, true)
  assert.equal(noThreshold.threshold, 0.6)
  assert.equal(noThreshold.ok, false)
})

test('文案：说清是"本地"、并明说不是替服务端判分（issue #12 的反例还在）', () => {
  assert.match(localFitServerNote(), /不是.*替服务端判定/)
  assert.match(localFitServerNote(), /服务端是否判合格/)
  const r = evaluateLocalFitGate({ fitDegree: 0.2, task: LINE_TASK })
  assert.ok(!/无效|不合格/.test(r.message), `不许写成"成绩无效/不合格"（那是替服务端下结论）：${r.message}`)
})
