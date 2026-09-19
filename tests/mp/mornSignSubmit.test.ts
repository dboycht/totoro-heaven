/**
 * 早操签到「提交」纯逻辑测试（2026-09-19）
 *
 * 重点是三件容易错的事：
 *  ① **`signDate` 必须是上海时区**（机器在别的时区也不能错 —— 它是服务端判窗口的依据之一）；
 *  ② **窗口判定完全取自服务端返回**，且边界（开始/结束那一分钟）要正确；
 *  ③ **16 字段口径**与厂商真包一致（尤其 `signType` 恒为 `'0'`、`qrCode` 用下发值）；
 *  ④ 结果判定**只看 `code === '0'`**（实测窗口外是 `code:'1'` + "签到时间不在规则时间内"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMornSignPayload,
  evaluateMornSignWindow,
  formatShanghaiDateTime,
  judgeMornSignSubmit,
  parseClockMinutes,
} from '../../utils/mp/mornSignSubmit.ts'

/** 构造一个"某天 上海时间 HH:mm"对应的毫秒（便于窗口边界测试） */
const at = (h, m) => Date.UTC(2026, 8, 19, h - 8, m, 0)

test('mornSignSubmit：signDate 固定上海时区（UTC 时间戳 → +8 小时）', () => {
  // 2026-09-19T00:00:00Z ⇒ 上海 08:00:00
  assert.equal(formatShanghaiDateTime(Date.UTC(2026, 8, 19, 0, 0, 0)), '2026-09-19 08:00:00')
  // 跨日：2026-09-18T20:30:00Z ⇒ 上海 2026-09-19 04:30:00
  assert.equal(formatShanghaiDateTime(Date.UTC(2026, 8, 18, 20, 30, 0)), '2026-09-19 04:30:00')
})

test('mornSignSubmit：parseClockMinutes 容错（HH:mm / HH:mm:ss / 非法）', () => {
  assert.equal(parseClockMinutes('06:00'), 360)
  assert.equal(parseClockMinutes('08:30'), 510)
  assert.equal(parseClockMinutes('06:00:00'), 360)
  assert.equal(parseClockMinutes('6:5'), null) // 分钟必须两位
  assert.equal(parseClockMinutes('24:00'), null)
  assert.equal(parseClockMinutes(''), null)
  assert.equal(parseClockMinutes(null), null)
})

test('mornSignSubmit：窗口判定用**服务端下发的时段**，边界含首含尾', () => {
  const task = { startTime: '06:00', endTime: '08:30' } as never
  assert.equal(evaluateMornSignWindow(task, at(5, 59)).inside, false)
  assert.equal(evaluateMornSignWindow(task, at(5, 59)).minutesUntilStart, 1)
  assert.equal(evaluateMornSignWindow(task, at(6, 0)).inside, true, '开始那一刻算在窗口内')
  assert.equal(evaluateMornSignWindow(task, at(8, 30)).inside, true, '结束那一刻算在窗口内')
  assert.equal(evaluateMornSignWindow(task, at(8, 31)).inside, false)
  assert.equal(evaluateMornSignWindow(task, at(12, 0)).minutesUntilEnd, 0)
  // 未下发时段 ⇒ known=false（不要瞎猜一个默认窗口）
  const unknown = evaluateMornSignWindow({ startTime: '', endTime: '' } as never, at(7, 0))
  assert.equal(unknown.known, false)
  assert.equal(unknown.inside, false)
})

test('mornSignSubmit：时段来自当天，与"日期"无关（07:00 在任何一天都算窗口内）', () => {
  const task = { startTime: '06:00', endTime: '08:30' } as never
  for (const day of [1, 15, 28]) {
    assert.equal(evaluateMornSignWindow(task, Date.UTC(2026, 8, day, 7 - 8, 0, 0)).inside, true)
  }
})

test('mornSignSubmit：16 字段组装 —— signType 恒为 "0"、qrCode 用下发值、坐标转字符串', () => {
  const point = {
    taskId: 'task-1',
    pointId: '06',
    pointName: '东操场',
    latitude: '31.9395',
    longitude: '118.789',
    qrCode: 'mornsignPlace-2021091700000706',
  }
  const payload = buildMornSignPayload({
    point: point as never,
    task: { signType: '9' } as never, // 故意给个不同的 signType ⇒ 必须是 '0'
    snCode: '032530213',
    token: 'tk',
    nowMs: at(7, 15),
  })
  assert.equal(Object.keys(payload).length, 16, '字段数必须是 16')
  assert.equal(payload.signType, '0')
  assert.equal(payload.iLocalSubmit, '0')
  assert.equal(payload.appVersion, '1.0.0')
  assert.equal(payload.taskId, 'task-1')
  assert.equal(payload.pointId, '06')
  assert.equal(payload.qrCode, 'mornsignPlace-2021091700000706')
  assert.equal(payload.latitude, '31.9395')
  assert.equal(payload.longitude, '118.789')
  assert.equal(payload.signDate, '2026-09-19 07:15:00')
  assert.equal(payload.phoneNumber, '')
  assert.equal(payload.mac, '')
})

test('mornSignSubmit：四要素不全时**抛错**（不发残缺请求）', () => {
  const base = { taskId: 't', pointId: 'p', latitude: '1', longitude: '2', qrCode: 'q' }
  for (const missing of ['taskId', 'latitude', 'longitude', 'qrCode']) {
    const point = { ...base, [missing]: '' }
    assert.throws(
      () => buildMornSignPayload({ point: point as never, task: null, snCode: 'x', token: 'y' }),
      /资料不完整/,
      `缺 ${missing} 应抛错`,
    )
  }
  assert.throws(
    () => buildMornSignPayload({ point: base as never, task: null, snCode: '', token: 'y' }),
    /缺少学号/,
  )
})

test('mornSignSubmit：结果判定只看 code === "0"（含实测的窗口外响应）', () => {
  // 真实拒绝样本（2026-09-19 14:20 实测）
  const rejected = judgeMornSignSubmit(
    JSON.stringify({ status: '01', message: '签到时间不在规则时间内，提交异常', code: '1' }),
  )
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.message, '签到时间不在规则时间内，提交异常')

  assert.equal(judgeMornSignSubmit(JSON.stringify({ code: '0', message: '' })).accepted, true)
  assert.equal(judgeMornSignSubmit(JSON.stringify({ code: 0 })).accepted, true, '数字 0 也要算成功')
  assert.equal(judgeMornSignSubmit('not json').accepted, false)
  assert.equal(judgeMornSignSubmit('{"code":"2","msg":"重复签到"}').message, '重复签到')
})
