/**
 * 轨迹点时间字段回归守卫（2026-09-17 补 —— 健壮化 A「安全网」）
 *
 * 为什么单独一个文件：`withPointTimes()` 是 **E33 那次事故的修复点** ——
 * 明细轨迹的点缺 `time` → 服务端回 `code:"1" GPS位置为空！` → 整条明细被拒 →
 * 云端 `pointList=null` → 详情页地图没有轨迹（真跑那条有 1121 个点）。
 *
 * 之前只有 `submitPayload.test.ts` 从"报文层面"间接覆盖（3 个键 + 格式 + 首末点），
 * 而**函数本身的边界**（空数组 / 单点 / 点数与时长不匹配 / 单调性 / 跨零点回绕）没有守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatClock, withPointTimes } from '../../utils/mp/runData.ts'

const point = (i: number) => ({ latitude: 31.9 + i * 0.00001, longitude: 118.78 + i * 0.00001 })
const DAY = new Date(2026, 8, 16, 6, 30, 0).getTime() // 2026-09-16 06:30:00 本地

test('withPointTimes：空数组返回空数组（不抛、不产生 NaN 时间）', () => {
  assert.deepEqual(withPointTimes([], DAY, 600), [])
})

test('withPointTimes：单点也能拿到合法时间（= 起跑时刻，不是 NaN/Invalid）', () => {
  const [only] = withPointTimes([{ latitude: 31.9, longitude: 118.78 }], DAY, 600)
  assert.equal(only?.time, '06:30:00')
  assert.match(only!.time, /^\d{2}:\d{2}:\d{2}$/)
})

test('withPointTimes：首点=起跑时刻、末点=起跑+时长（与报文口径一致）', () => {
  const duration = 960
  const pts = Array.from({ length: 4 }, (_, i) => point(i))
  const out = withPointTimes(pts, DAY, duration)
  assert.equal(out.length, 4)
  assert.equal(out[0]!.time, '06:30:00')
  assert.equal(out[out.length - 1]!.time, '06:46:00') // 06:30 + 16 分钟
})

test('withPointTimes：点数 = 时长+1 时严格 1 秒 1 点（~1Hz，与真机采样一致）', () => {
  const duration = 30
  const pts = Array.from({ length: duration + 1 }, (_, i) => point(i))
  const out = withPointTimes(pts, DAY, duration)
  const seconds = out.map((p) => Number(p.time.slice(6, 8)))
  for (let i = 1; i < seconds.length; i++) {
    assert.equal(seconds[i]! - seconds[i - 1]!, 1, `第 ${i} 段不是 1 秒：${out[i - 1]!.time} → ${out[i]!.time}`)
  }
})

test('withPointTimes：每点都带 HH:mm:ss，且当天内时间单调不减（服务端要的就是这个格式）', () => {
  const pts = Array.from({ length: 121 }, (_, i) => point(i))
  const out = withPointTimes(pts, DAY, 120)
  for (const p of out) assert.match(p.time, /^\d{2}:\d{2}:\d{2}$/)
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i]!.time >= out[i - 1]!.time, `时间回退：${out[i - 1]!.time} → ${out[i]!.time}`)
  }
})

test('withPointTimes：原坐标字段原样保留，且不修改传入数组（纯函数）', () => {
  const pts = [point(0), point(1)]
  const snapshot = JSON.stringify(pts)
  const out = withPointTimes(pts, DAY, 10)
  assert.equal(JSON.stringify(pts), snapshot, '入参被修改了')
  assert.equal(out[0]!.latitude, pts[0]!.latitude)
  assert.equal(out[0]!.longitude, pts[0]!.longitude)
})

test('已知口径（显式固定）：time 只有 HH:mm:ss、不带日期 —— 跨零点时字符串会回绕', () => {
  // ⚠️ 这是**刻意接受**的行为：明细报文里另有 evaluateDate/startTime/endTime 表达日期，
  //    点上的 time 与小程序真包同格式（`HH:mm:ss`）。所以 23:59 之后是 00:00（字符串变小）。
  const start = new Date(2026, 8, 16, 23, 59, 30).getTime()
  const out = withPointTimes([point(0), point(1), point(2)], start, 120)
  assert.equal(out[0]!.time, '23:59:30')
  assert.equal(out[2]!.time, '00:01:30') // 跨到次日，字符串比首点小
  assert.ok(out[2]!.time < out[0]!.time)
})

test('formatClock：补零到 HH:mm:ss（0 点 / 个位数分钟都补）', () => {
  assert.equal(formatClock(new Date(2026, 8, 16, 0, 5, 7).getTime()), '00:05:07')
  assert.equal(formatClock(new Date(2026, 8, 16, 23, 59, 59).getTime()), '23:59:59')
})
