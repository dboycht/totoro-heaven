/**
 * 真实提交报文构造测试
 *
 * 这些断言是"防止报文写错"的最后一道闸门 —— 字段名/格式错一个，服务端就会拒收或者判异常。
 * 全部数值口径来自 2026-09-14 的真实提交实测（该笔已判「有效」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRunBeginRequest,
  buildScoreDetailRequest,
  buildScoreRequest,
  toSubmitPoints,
  MP_CLIENT_VERSION,
  MP_PHONE_INFO_BEGIN,
  MP_PHONE_INFO_SCORE,
  type RealSubmitContext,
} from '../../utils/mp/submitPayload.ts'
import type { MpRunLine, MpSunrunTask } from '../../src/mp/types.ts'

const line: MpRunLine = {
  pointId: 'sunrunLine-20210918000001',
  taskId: 'sunrunTaskPaper-20210917000004',
  pointName: '天目湖-西操场',
  pointList: [
    { latitude: '31.9', longitude: '119.1' },
    { latitude: '31.9001', longitude: '119.1001' },
  ],
}

const task: MpSunrunTask = {
  paperName: '天目湖阳光跑',
  taskId: 'sunrunTaskPaper-20210917000004',
  mileage: 3.2,
  fitDegree: 0.6,
  runPointList: [line],
}

const points = [
  { latitude: 31.9, longitude: 119.1 },
  { latitude: 31.9001, longitude: 119.1001 },
]

const makeContext = (overrides: Partial<RealSubmitContext> = {}): RealSubmitContext => ({
  snCode: 'TEST0001',
  schoolCode: '98765',
  task,
  line,
  km: 3.2,
  durationSeconds: 960,
  fitDegree: 1,
  points,
  token: 'TESTTOKEN',
  scantronId: 'sunrunId202609142335',
  startMs: new Date(2026, 8, 14, 21, 33, 43).getTime(),
  endMs: new Date(2026, 8, 14, 21, 49, 43).getTime(),
  ...overrides,
})

test('buildRunBeginRequest：paperId 取线路 taskId、lineId 取 pointId、faceBase64 留空、不带 token', () => {
  const req = buildRunBeginRequest({ line, runType: 0 })
  assert.deepEqual(req, {
    runType: 0,
    version: MP_CLIENT_VERSION,
    phoneInfo: MP_PHONE_INFO_BEGIN,
    paperId: 'sunrunTaskPaper-20210917000004',
    lineId: 'sunrunLine-20210918000001',
    faceBase64: '',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(req, 'token'), false, 'getRunBegin 不带 token（照源码）')
  assert.equal(req.phoneInfo, 'microsoft&microsoft&Windows 11 x64', '三段式')
})

test('buildRunBeginRequest：自由跑 runType=1 原样透传', () => {
  assert.equal(buildRunBeginRequest({ line, runType: 1 }).runType, 1)
})

/**
 * ⚠️ 2026-09-18 补（自由跑落地）：厂商源码在自由跑时**根本不取线路**
 * （`0==runType && (o=columnsLine[...])`），`paperId`/`lineId` 都是空串。
 * 所以 `line` 传 `null` 或干脆不传，都必须安全地给出空串 —— 这是自由跑能跑起来的前提。
 */
test('buildRunBeginRequest：自由跑不传线路 ⇒ paperId/lineId 都是空串（照厂商源码）', () => {
  const req = buildRunBeginRequest({ runType: 1 })
  assert.equal(req.runType, 1)
  assert.equal(req.paperId, '')
  assert.equal(req.lineId, '')
  // 传了线路也一样要清空（自由跑口径优先）
  const withLine = buildRunBeginRequest({ line, runType: 1 })
  assert.equal(withLine.paperId, '')
  assert.equal(withLine.lineId, '')
})

test('buildScoreRequest：自由跑 line=null ⇒ taskId 空串、路径点列为空数组（厂商口径）', () => {
  const ctx = makeContext()
  const req = buildScoreRequest({ ...ctx, line: null, task: null }, { runType: 1 })
  assert.equal(req.runType, 1)
  assert.equal(req.taskId, '')
  assert.deepEqual(req.sunrunPathPointList, [])
})

test('buildScoreRequest：18 字段齐全且格式正确', () => {
  const req = buildScoreRequest(makeContext())
  assert.deepEqual(Object.keys(req).sort(), [
    'avgSpeed',
    'endTime',
    'evaluateDate',
    'fitDegree',
    'flag',
    'km',
    'phoneInfo',
    'runType',
    'scantronId',
    'schoolCode',
    'startTime',
    'steps',
    'stuNumber',
    'sunrunPathPointList',
    'taskId',
    'token',
    'usedTime',
    'version',
  ])
  assert.equal(req.km, '3.20') // 两位小数
  assert.equal(req.usedTime, '00:16:00') // HH:mm:ss
  assert.equal(req.fitDegree, '1.00') // 0~1 两位小数
  assert.equal(req.avgSpeed, `5'00"`) // M'SS"
  assert.equal(req.steps, '') // 实测真包恒空串
  assert.equal(req.flag, '1')
  assert.equal(req.runType, 0)
  assert.equal(req.taskId, 'sunrunTaskPaper-20210917000004')
  assert.deepEqual(req.sunrunPathPointList, line.pointList, '官方线路点列原样带上')
  assert.equal(req.token, 'TESTTOKEN', '请求体里也带一份 token')
  assert.equal(req.phoneInfo, MP_PHONE_INFO_SCORE)
  assert.equal(req.version, MP_CLIENT_VERSION)
  assert.equal(req.evaluateDate, '2026-09-14')
  assert.equal(req.startTime, '21:33:43')
  assert.equal(req.endTime, '21:49:43')
  assert.equal(req.scantronId, 'sunrunId202609142335')
  assert.equal(req.stuNumber, 'TEST0001')
  assert.equal(req.schoolCode, '98765')
})

test('buildScoreRequest：拟合度按两位小数提交（0.976 → "0.98"）', () => {
  assert.equal(buildScoreRequest(makeContext({ fitDegree: 0.976 })).fitDegree, '0.98')
})

// ---------- B 轮（2026-09-17）：成绩报文统一为单一构造出口 ----------

test('buildScoreRequest：默认是阳光跑（runType=0），taskId/路径点列都取自线路 —— 与旧行为逐字一致', () => {
  const req = buildScoreRequest(makeContext())
  assert.equal(req.runType, 0)
  assert.equal(req.taskId, line.taskId)
  assert.deepEqual(req.sunrunPathPointList, line.pointList)
  assert.equal(req.steps, '', '真包 steps 恒为空串')
  assert.equal(req.flag, '1')
})

test('buildScoreRequest：自由跑（runType=1）不带任务号、路径点列为空数组（真包口径）', () => {
  const req = buildScoreRequest(makeContext(), { runType: 1 })
  assert.equal(req.runType, 1)
  assert.equal(req.taskId, '', '自由跑不带 taskId')
  assert.deepEqual(req.sunrunPathPointList, [], '自由跑路径点列为 []')
  // 其余口径不受 runType 影响
  assert.equal(req.steps, '')
  assert.equal(req.flag, '1')
  assert.equal(req.km, '3.20')
})

test('buildScoreRequest：同一 context 两种 runType 的键集合完全相同（18 字段口径不因 runType 变化）', () => {
  const sun = buildScoreRequest(makeContext())
  const free = buildScoreRequest(makeContext(), { runType: 1 })
  assert.deepEqual(Object.keys(free).sort(), Object.keys(sun).sort())
  assert.equal(Object.keys(sun).length, 18, '实测真包就是 18 个字段')
})

test('buildScoreRequest：纯函数 —— 同参数两次调用结果一致（演示预览与实发同源的前提）', () => {
  const a = buildScoreRequest(makeContext())
  const b = buildScoreRequest(makeContext())
  assert.deepEqual(a, b)
})

test('buildScoreDetailRequest：只有 3 个字段，且每个点都带 time（HH:mm:ss）', () => {
  const req = buildScoreDetailRequest(makeContext())
  // 依据：小程序源码 `data:{pointList:h.data.polyline[0].points, scantronId:w, token}`（v65/v67 逐字一致）
  assert.deepEqual(Object.keys(req).sort(), ['pointList', 'scantronId', 'token'])
  assert.equal(req.scantronId, 'sunrunId202609142335')
  assert.equal(req.token, 'TESTTOKEN')
  assert.equal(req.pointList.length, points.length)
  // ⚠️ 服务端要求点里有 time（缺了会回 `code:"1" GPS位置为空！` 整条拒收，见 ERROR.md E33）
  for (const p of req.pointList) {
    assert.match(p.time, /^\d{2}:\d{2}:\d{2}$/, `点的时间格式不对：${p.time}`)
  }
  assert.equal(req.pointList[0]!.latitude, points[0]!.latitude)
  assert.equal(req.pointList[0]!.time, '21:33:43', '首点=起跑时刻')
  assert.equal(req.pointList[req.pointList.length - 1]!.time, '21:49:43', '末点=结束时刻（durationSeconds=960）')
})

test('toSubmitPoints：字符串坐标转数字（接口习惯 6 位小数）', () => {
  const converted = toSubmitPoints([
    { latitude: '31.900000', longitude: '119.100000' },
    { latitude: 31.5, longitude: 119 }, // 数字也接受
  ])
  assert.deepEqual(converted, [
    { latitude: 31.9, longitude: 119.1 },
    { latitude: 31.5, longitude: 119 },
  ])
})
