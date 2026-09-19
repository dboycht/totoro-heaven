/**
 * 早操签到（`mornSign/*`）归一化测试（2026-09-18）
 *
 * ⚠️ 关键口径：**"本学校无需签到"是正常返回**（`status:'00'` + `message:'本学校无需签到！'`
 * + `code:'1'` + `signPointList:null`）—— 必须归成 `unavailable` 而**不是报错**，
 * 否则界面会把"没这功能"显示成"读取失败"。第一条用例就是用我们探针抓到的真实响应。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distanceMeters, mornSignProgressText, normalizeMornSignPaper } from '../../utils/mp/morningSign.ts'

/** 我们探针抓到的**真实**响应（我校南航） */
const REAL_UNAVAILABLE = {
  status: '00',
  msg: '',
  data: null,
  body: null,
  total: 0,
  message: '本学校无需签到！',
  code: '1',
  token: null,
  signType: null,
  startDate: null,
  endDate: null,
  startTime: null,
  endTime: null,
  offsetRange: null,
  dayNeedSignCount: null,
  dayCompSignCount: null,
  minTimeInterval: null,
  signPointList: null,
}

test('morningSign：我校真实响应（无需签到）⇒ unavailable，且保留服务端原文', () => {
  const r = normalizeMornSignPaper(REAL_UNAVAILABLE)
  assert.equal(r.kind, 'unavailable')
  if (r.kind === 'unavailable') assert.equal(r.message, '本学校无需签到！')
})

test('morningSign：status 非 00 ⇒ unavailable（带上服务端消息）', () => {
  const r = normalizeMornSignPaper({ status: '01', message: 'token失效，注册失败' })
  assert.equal(r.kind, 'unavailable')
  if (r.kind === 'unavailable') assert.match(r.message, /token失效/)
})

test('morningSign：有签到任务 ⇒ ok，字段逐项归一化（缺字段给空串，不编造）', () => {
  const r = normalizeMornSignPaper({
    status: '00',
    signType: '1',
    startDate: '2026-09-01',
    endDate: '2026-01-15',
    startTime: '06:30:00',
    endTime: '07:30:00',
    offsetRange: '300',
    dayNeedSignCount: '1',
    dayCompSignCount: '0',
    minTimeInterval: '30',
    signPointList: [
      { taskId: 't1', pointId: 'p1', pointName: '东操场北门', latitude: '31.9', longitude: '118.7', qrCode: 'QR-AAA' },
      { taskId: 't1', pointId: 'p2' }, // 缺名/缺坐标 ⇒ 给默认值，不崩
    ],
  })
  assert.equal(r.kind, 'ok')
  if (r.kind !== 'ok') return
  assert.equal(r.task.signType, '1')
  assert.equal(r.task.startTime, '06:30:00')
  assert.equal(r.task.offsetRange, '300')
  assert.equal(r.task.signPointList.length, 2)
  assert.equal(r.task.signPointList[0]!.pointName, '东操场北门')
  assert.equal(r.task.signPointList[0]!.qrCode, 'QR-AAA')
  assert.equal(r.task.signPointList[1]!.pointName, '未命名点位')
  assert.equal(r.task.signPointList[1]!.latitude, '')
})

test('morningSign：垃圾数据不崩（null / 字符串 / 空对象）', () => {
  for (const bad of [null, undefined, 'nonsense', 42, {}, { signPointList: 'x' }]) {
    const r = normalizeMornSignPaper(bad)
    assert.equal(r.kind, 'unavailable', `${JSON.stringify(bad)} 应归为 unavailable`)
  }
})

test('morningSign：进度文案按"需签次数"渲染，缺值时不硬凑', () => {
  const base = {
    signType: '',
    startDate: '',
    endDate: '',
    startTime: '',
    endTime: '',
    offsetRange: '',
    dayNeedSignCount: '2',
    dayCompSignCount: '1',
    minTimeInterval: '',
    signPointList: [],
  }
  assert.equal(mornSignProgressText(base), '今日已签 1 / 2 次')
  assert.equal(mornSignProgressText({ ...base, dayNeedSignCount: '0' }), '今日已签 1 次')
})

test('morningSign：distanceMeters 量级正确（同点=0，1e-3 纬度≈111 m）', () => {
  assert.equal(Math.round(distanceMeters(31.9, 118.7, 31.9, 118.7)), 0)
  const d = distanceMeters(31.9, 118.7, 31.901, 118.7)
  assert.ok(Math.abs(d - 111.32) < 2, `实际 ${d.toFixed(1)} m`)
})
