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
  COORD_JITTER_RADIUS_M,
  buildMornSignPayload,
  coordOffsetMeters,
  evaluateMornSignWindow,
  formatShanghaiDateTime,
  jitterCoord,
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

test('mornSignSubmit：跨日/跨月/跨年边界（UTC+8 最容易错的地方）', () => {
  // 实现是"先加 8 小时再取 UTC 字段"，所以 16:00Z 正好是次日 00:00 —— 跨日必须正确
  assert.equal(formatShanghaiDateTime(Date.UTC(2026, 8, 18, 15, 59, 0)), '2026-09-18 23:59:00')
  assert.equal(formatShanghaiDateTime(Date.UTC(2026, 8, 18, 16, 0, 0)), '2026-09-19 00:00:00')
  assert.equal(formatShanghaiDateTime(Date.UTC(2026, 8, 30, 16, 0, 0)), '2026-10-01 00:00:00', '跨月')
  assert.equal(formatShanghaiDateTime(Date.UTC(2026, 11, 31, 16, 0, 0)), '2027-01-01 00:00:00', '跨年')
  // 窗口判定用的是同一套换算：午夜与窗口首尾都要对
  const task = { startTime: '06:00', endTime: '08:30' } as never
  assert.equal(evaluateMornSignWindow(task, Date.UTC(2026, 8, 18, 16, 0, 0)).inside, false, '上海 00:00 在窗口外')
  assert.equal(evaluateMornSignWindow(task, Date.UTC(2026, 8, 18, 22, 0, 0)).inside, true, '上海 06:00 在窗口内')
  assert.equal(evaluateMornSignWindow(task, Date.UTC(2026, 8, 19, 0, 30, 0)).inside, true, '上海 08:30 在窗口内')
  assert.equal(evaluateMornSignWindow(task, Date.UTC(2026, 8, 19, 0, 31, 0)).inside, false, '上海 08:31 在窗口外')
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
    snCode: '032530213',
    token: 'tk',
    nowMs: at(7, 15),
    // 关掉抖动，才能逐字段断言"组装口径"（抖动本身另有专门用例）
    jitterRadiusM: 0,
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

test('mornSignSubmit：坐标抖动 —— 必须落在半径内、有抖动、且不产生 NaN', () => {
  assert.equal(COORD_JITTER_RADIUS_M, 5, '默认抖动半径就是 5 m（用户 2026-09-20 要求）')
  const lat = 31.372635455164314
  const lng = 119.48083083271979
  // 固定随机序列（0.25/0.5 ⇒ r = 5·√0.25 = 2.5 m，θ = π ⇒ 正南偏 2.5 m）
  const seq = [0.25, 0.5, 0.25, 0.5]
  let i = 0
  const rand = () => seq[i++ % seq.length]!
  const out = jitterCoord(lat, lng, 5, rand)
  assert.equal(out.offsetM.toFixed(3), '2.500')
  assert.notEqual(out.latitude, String(lat), '必须与原值不同（否则等于没抖动）')
  assert.ok(!/NaN/.test(out.latitude + out.longitude), '不得出现 NaN')

  // 距离校验：改用被测模块自己的 coordOffsetMeters（避免测试里再手写一份换算）
  const dist = coordOffsetMeters(lat, lng, out.latitude, out.longitude)
  assert.ok(dist <= 5.0001, `实际偏移 ${dist.toFixed(3)} m 应 ≤ 5 m`)

  // 多次采样：全部落在 5 m 内，且**不会每次都等于 0**（圆盘采样不是恒 0）
  let maxSeen = 0
  let nonzero = 0
  for (let k = 0; k < 500; k++) {
    const j = jitterCoord(lat, lng, 5)
    const d = coordOffsetMeters(lat, lng, j.latitude, j.longitude)
    maxSeen = Math.max(maxSeen, d)
    if (d > 0.001) nonzero++
  }
  assert.ok(maxSeen <= 5.0001, `500 次采样的最大偏移 ${maxSeen.toFixed(3)} m 应 ≤ 5 m`)
  assert.ok(nonzero > 490, '绝大多数采样应有实际偏移（不是恒 0）')
})

test('mornSignSubmit：抖动可关闭、非法坐标不产出 NaN（健壮性）', () => {
  assert.equal(jitterCoord('31.9', '118.7', 0).latitude, '31.9', '半径 0 ⇒ 原样返回')
  assert.equal(jitterCoord('31.9', '118.7', -1).longitude, '118.7', '负半径 ⇒ 原样返回')
  // ⚠️ 判据是"**解析不出数字就原样透传，绝不猜**"。
  //    注意：传字符串 'abc' ⇒ 返回 'abc'（原样）；传数值 NaN ⇒ 返回字符串 'NaN'（原样）。
  //    我第一版在这里断言"结果不含 NaN"，那是**断言写错了** —— 原样透传本就可能带 NaN。
  const bad = jitterCoord('abc', '118.7', 5)
  assert.equal(bad.latitude, 'abc', '非法纬度 ⇒ 原样返回（不猜）')
  assert.equal(bad.longitude, '118.7')
  assert.equal(bad.offsetM, 0, '未抖动 ⇒ 偏移量记 0')
  // 关键：**合法坐标绝不能因为抖动而变成 NaN**
  for (const [la, ln] of [
    ['31.370415772884936', '119.48904656767843'],
    [0, 0],
    ['-33.8688', '151.2093'], // 南半球/东经
  ]) {
    const out = jitterCoord(la!, ln!, 5)
    assert.ok(/^-?\d+(\.\d+)?$/.test(out.latitude), `纬度应是数字串，实际 ${out.latitude}`)
    assert.ok(/^-?\d+(\.\d+)?$/.test(out.longitude), `经度应是数字串，实际 ${out.longitude}`)
  }
})

test('mornSignSubmit：抖动**不影响**任何点位标识字段（taskId/pointId/qrCode 原样）', () => {
  const point = {
    taskId: 'mornsignTaskPaper-20230307000001',
    pointId: '06',
    pointName: '东操场',
    latitude: '31.370415772884936',
    longitude: '119.48904656767843',
    qrCode: 'mornsignPlace-2021091700000706',
  }
  const p = buildMornSignPayload({ point: point as never, snCode: '032530213', token: 'tk', jitterRadiusM: 5 })
  assert.equal(p.taskId, point.taskId)
  assert.equal(p.pointId, point.pointId)
  assert.equal(p.qrCode, point.qrCode)
  assert.notEqual(p.latitude, point.latitude, '坐标应当被抖动')
})

test('mornSignSubmit：四要素不全时**抛错**（不发残缺请求）', () => {
  const base = { taskId: 't', pointId: 'p', latitude: '1', longitude: '2', qrCode: 'q' }
  for (const missing of ['taskId', 'latitude', 'longitude', 'qrCode']) {
    const point = { ...base, [missing]: '' }
    assert.throws(
      () => buildMornSignPayload({ point: point as never, snCode: 'x', token: 'y' }),
      /资料不完整/,
      `缺 ${missing} 应抛错`,
    )
  }
  assert.throws(
    () => buildMornSignPayload({ point: base as never, snCode: '', token: 'y' }),
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
