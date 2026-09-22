/**
 * 「`getSunrunPaper` 响应 → 任务本体」的解包兜底单测（2026-09-22，issue #12 的正解）
 *
 * 夹具全部来自**研究生院「研途健行」用户的真实诊断包**（`totoro-diagnostics-20260922-1840.zip`）：
 *   · 响应顶层键：`status,msg,data,obj,body,obj1,resultMap,total,wxLoginStatus,msgList,message,code,id,
 *     paperId,faceFlag,startDate,endDate,startTime,endTime,offsetRange,mileage,fitDegree,minSpeed,maxSpeed,
 *     minTime,maxTime,ifHasRun,minWalkTotal,maxWalkTotal,paperName,runPointList,sunrunTaskList,
 *     getSunrunPaperResponseList,runTimeRuleList`
 *     —— 供应商的"平铺大杂烩"信封：**无关字段一律填 `null`**；
 *   · 规格字段 `getSunrunPaperResponseList` 缺失/为 null，而**真正的线路在别的层**（`data` / `sunrunTaskList[0]`）
 *     ⇒ 旧的"规格没命中就把响应当任务"会把 "1 条线路" 读成 "0 条"，害得用户以为任务没线路。
 *
 * 这组用例盯四件事：① 真实形态必须读出 1 条线路；② 真·无线路仍是 0 条（`route=free`）；
 * ③ 规格正常命中时**零回归**；④ 明确失败 / 另一份试卷绝不能被"兜底"张冠李戴。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineCountOf, resolvePaperTask } from '../../utils/mp/taskUnpack.ts'
import { looksLikeEnvelope, looksLikeTask } from '../../utils/mp/realCache.ts'
import { taskShapeLine } from '../../utils/mp/taskShape.ts'

const LINE = {
  pointId: 'sunrunLine-20260416000001',
  pointName: '研究生院操场',
  taskId: 'sunrunTaskPaper-20260416000001',
  pointList: [{ latitude: '32.0', longitude: '118.8' }, { latitude: '32.0005', longitude: '118.8005' }],
}

/** 任务本体（**供应商真实字段名**：taskId/paperId/paperName/mileage/fitDegree/runPointList/runTimeRuleList） */
const TASK = {
  taskId: 'sunrunTaskPaper-20260416000001',
  paperId: 'sunrunTaskPaper-20260416000001',
  paperName: '研途健行',
  mileage: 2.4,
  fitDegree: 0.6,
  minSpeed: 1,
  maxSpeed: 12,
  minTime: 10,
  maxTime: 60,
  faceFlag: '0',
  startDate: '2026-09-04 00:00:00',
  endDate: '2027-02-01 23:59:59',
  runTimeRuleList: [{ startTime: '06:00:00', endTime: '23:00:00' }],
  runPointList: [LINE],
}

/** 供应商的"平铺大杂烩"信封：无关字段全是 null（照诊断包逐字） */
const envelopeOf = (over: Record<string, unknown> = {}) => ({
  status: '00',
  msg: null,
  data: null,
  obj: null,
  body: null,
  obj1: null,
  resultMap: null,
  total: 0,
  wxLoginStatus: 0,
  msgList: [],
  message: null,
  code: '0',
  token: null,
  faceFlag: null,
  startDate: null,
  endDate: null,
  startTime: null,
  endTime: null,
  offsetRange: null,
  mileage: null,
  fitDegree: null,
  minSpeed: null,
  maxSpeed: null,
  minTime: null,
  maxTime: null,
  ifHasRun: '0',
  minWalkTotal: null,
  maxWalkTotal: null,
  paperName: null,
  runPointList: null,
  sunrunTaskList: null,
  getSunrunPaperResponseList: null,
  runTimeRuleList: null,
  ...over,
})

test('🔴 真实形态（规格字段缺失、线路在 data 里）⇒ 必须读出 **1 条线路**（issue #12 的正解）', () => {
  // 诊断包现场：顶层 runPointList 0 条、data.runPointList 1 条、sunrunTaskList[0].runPointList 1 条
  const raw = envelopeOf({
    paperName: '研途健行',
    runPointList: [],
    data: { ...TASK },
    sunrunTaskList: [{ ...TASK }],
  })
  const r = resolvePaperTask(raw)
  assert.ok(r.task, '必须取到任务本体（否则线路永远读成 0 条）')
  assert.equal(r.lineCount, 1, `线路条数必须是 1，实际 ${r.lineCount}`)
  assert.equal(r.task.runPointList.length, 1)
  assert.equal(taskShapeLine(r.task), 'route=line(1) fit=required(0.6)', '形状摘要必须报"有 1 条线路"')
  assert.equal(r.degraded, true, '走了规格以外的路径 ⇒ 必须标记为"解包退化"（调用方要留痕）')
  assert.ok(r.candidates.includes('data'), `候选层里要有 data：${r.candidates.join('>')}`)
})

test('🔴 规格字段缺失、只有 `sunrunTaskList[0]` ⇒ 也从那里取（并如实报 1 条）', () => {
  const raw = envelopeOf({ paperName: '研途健行', runPointList: [], sunrunTaskList: [{ ...TASK }] })
  const r = resolvePaperTask(raw)
  assert.equal(r.source, 'sunrunTaskList[0]')
  assert.equal(r.lineCount, 1)
  assert.equal(taskShapeLine(r.task), 'route=line(1) fit=required(0.6)')
})

test('🔴 规格**命中**但那一层 0 条线路、而信封里的同一条任务有 1 条 ⇒ 采用有线路的那一层', () => {
  // 另一种可能形态：getSunrunPaperResponseList[0] 是"缺线路"的副本，真正的线路在 data 里
  const raw = envelopeOf({
    paperName: '研途健行',
    runPointList: [],
    getSunrunPaperResponseList: [{ ...TASK, runPointList: [] }],
    data: { ...TASK },
  })
  const r = resolvePaperTask(raw)
  assert.equal(r.source, 'data', `应换到有线路的那一层，实际 ${r.source}`)
  assert.equal(r.adoptedFrom, 'data')
  assert.equal(r.lineCount, 1)
  assert.equal(r.degraded, true)
})

test('真·无线路（`runPointList: []`）⇒ 仍是 0 条、`route=free`（别把两种"0"混为一谈）', () => {
  // 任务本体就在顶层（供应商的平铺元素形态），且它**确实**没有线路
  const raw = envelopeOf({ ...TASK, runPointList: [] })
  const r = resolvePaperTask(raw)
  assert.equal(r.lineCount, 0)
  assert.equal(r.source, 'self')
  assert.equal(taskShapeLine(r.task), 'route=free(0) fit=required(0.6)')
  // 信封里 data.runPointList 也是空数组 ⇒ 同样如实报 free(0)
  const viaData = resolvePaperTask(envelopeOf({ paperName: '研途健行', runPointList: [], data: { ...TASK, runPointList: [] } }))
  assert.equal(viaData.lineCount, 0)
  assert.equal(taskShapeLine(viaData.task), 'route=free(0) fit=required(0.6)')
})

test('规格正常命中 ⇒ **零回归**（同一对象、source 就是规格路径、degraded=false）', () => {
  const task = { ...TASK }
  const raw = envelopeOf({ getSunrunPaperResponseList: [task], sunrunTaskList: [{ ...TASK }] })
  const r = resolvePaperTask(raw)
  assert.equal(r.task, task, '必须原样返回规格那一层的对象（不做拷贝、不改写）')
  assert.equal(r.source, 'getSunrunPaperResponseList[0]')
  assert.equal(r.degraded, false, '规格命中不算退化 ⇒ 不写"解包退化"日志')
  assert.equal(r.adoptedFrom, '')
  assert.equal(r.lineCount, 1)
})

test('🔴 明确失败（`status:"01"`、字段全 null）⇒ **不许**被兜底当成任务（失败不能被掩盖）', () => {
  const raw = envelopeOf({ status: '01', code: '1', message: '该校区阳光跑任务未设置或无匹配任务，异常！' })
  const r = resolvePaperTask(raw)
  assert.equal(r.task, null, '全是 null 的失败响应里没有任务本体')
  assert.equal(r.source, 'none')
  assert.deepEqual(r.candidates, [])
})

test('🔴 `sunrunTaskList[0]` 是**另一份试卷**（id/名称都不同）⇒ 绝不张冠李戴', () => {
  const raw = envelopeOf({
    paperName: '研途健行',
    taskId: 'paper-A',
    runPointList: [], // 本任务确实 0 条
    sunrunTaskList: [{ ...TASK, taskId: 'paper-B', paperId: 'paper-B', paperName: '另一个任务' }],
  })
  const r = resolvePaperTask(raw)
  assert.equal(r.lineCount, 0, '不是同一条任务 ⇒ 不许把别人的线路拿过来')
  assert.equal(r.source, 'self')
})

test('缓存里存的"平铺任务元素"（`data: null` + 顶层 1 条线路）⇒ 取顶层自己', () => {
  // 诊断包里 16:36 那份就是这个形态（顶层 runPointList 8 条）
  const raw = envelopeOf({ ...TASK })
  const r = resolvePaperTask(raw)
  assert.equal(r.source, 'self')
  assert.equal(r.lineCount, 1)
  assert.equal(taskShapeLine(r.task), 'route=line(1) fit=required(0.6)')
})

test('垃圾输入 / 不是任务的东西 ⇒ `task: null`（**绝不编造**）', () => {
  for (const bad of [null, undefined, 42, 'str', [], {}, { code: '0', msg: 'ok' }]) {
    const r = resolvePaperTask(bad)
    assert.equal(r.task, null, `输入 ${JSON.stringify(bad)} 不该取出任务`)
    assert.equal(r.source, 'none')
    assert.equal(r.lineCount, -1)
  }
})

test('lineCountOf：`-1`（没有 runPointList 字段）与 `0`（有字段但为空）必须分开', () => {
  assert.equal(lineCountOf({}), -1)
  assert.equal(lineCountOf({ runPointList: [] }), 0)
  assert.equal(lineCountOf({ runPointList: [LINE] }), 1)
  assert.equal(lineCountOf(null), -1)
})

test('looksLikeTask：**`null` 不算"有这个字段"**（供应商的平铺信封靠这条挡住）', () => {
  assert.equal(looksLikeTask({ paperName: null, runPointList: null }), false, '全 null 的失败响应不是任务本体')
  assert.equal(looksLikeTask({ runPointList: [] }), true, '空数组是有效信息（自由路线任务）')
  assert.equal(looksLikeTask({ paperName: 'x' }), true)
  // 信封识别：有负载字段 + 信封特征（这一条与 `resolveCacheTask` 同源，别的地方也靠它）
  assert.equal(looksLikeEnvelope(envelopeOf({ data: { ...TASK } })), true)
  assert.equal(looksLikeEnvelope({ paperName: 'x', runPointList: [] }), false)
})
