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

test('buildScoreDetailRequest：轨迹明细 6 字段（含空传感器数组与 cheatCode）', () => {
  const req = buildScoreDetailRequest(makeContext())
  assert.deepEqual(req, {
    pointList: points,
    gyroscope: [],
    accelerometer: [],
    cheatCode: '正常跑步',
    scantronId: 'sunrunId202609142335',
    token: 'TESTTOKEN',
  })
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
