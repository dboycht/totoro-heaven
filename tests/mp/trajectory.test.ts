/**
 * 轨迹生成 + 数据自洽测试
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateCorridorRoute, buildTimeline } from '../../utils/mp/generateRoute.ts'
import { calculateRouteSimilarity, pathLengthMeters } from '../../utils/mp/routeSimilarity.ts'
import {
  buildRunStats,
  buildTimeFields,
  findSpeedOutliers,
  formatDuration,
  formatPace,
  parseDuration,
  parsePace,
  estimateKcal,
  estimateSteps,
} from '../../utils/mp/runData.ts'

/** 一条约 500m 的闭合矩形路线（模拟校园跑道） */
const loopRoute = () => {
  const lat0 = 32.0
  const lng0 = 118.0
  const dLat = 100 / 111320
  const dLng = 100 / (111320 * Math.cos((lat0 * Math.PI) / 180))
  return [
    { latitude: lat0, longitude: lng0 },
    { latitude: lat0 + dLat, longitude: lng0 },
    { latitude: lat0 + dLat, longitude: lng0 + dLng },
    { latitude: lat0, longitude: lng0 + dLng },
    { latitude: lat0, longitude: lng0 },
  ]
}

test('generateCorridorRoute：里程接近目标（±5%）', () => {
  const route = loopRoute()
  for (const km of [0.2, 0.5, 1, 2]) {
    const g = generateCorridorRoute(route, { targetKm: km, seed: 42 })
    const actual = Number(g.km)
    assert.ok(Math.abs(actual - km) / km < 0.05, `target=${km} 实际 ${actual} km`)
  }
})

test('generateCorridorRoute：抖动不产生锯齿（轨迹长度≈里程）', () => {
  const route = loopRoute()
  const g = generateCorridorRoute(route, { targetKm: 1, seed: 11 })
  const pts = g.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
  const lenKm = pathLengthMeters(pts) / 1000
  assert.ok(Math.abs(lenKm - 1) / 1 < 0.05, `轨迹长度 ${lenKm.toFixed(3)} km 偏离目标过大`)
})

test('generateCorridorRoute：抖动量级符合设定（不越出走廊）', () => {
  const route = loopRoute()
  const g = generateCorridorRoute(route, { targetKm: 0.6, seed: 13, jitterSigmaM: 2.2 })
  const official = route.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
  const score = calculateRouteSimilarity(official, g.points, 5, 25)
  assert.ok(score >= 0.95, `拟合度 ${score}`)
})

test('generateCorridorRoute：拟合度 ≥ 0.95（走廊内抖动）', () => {
  const route = loopRoute()
  const g = generateCorridorRoute(route, { targetKm: 0.5, seed: 7 })
  const score = calculateRouteSimilarity(
    route,
    g.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
  )
  assert.ok(score >= 0.95, `实际 ${score}`)
  assert.equal(g.fitDegree, Number(score).toFixed(2))
})

test('generateCorridorRoute：同种子结果可复现', () => {
  const route = loopRoute()
  const a = generateCorridorRoute(route, { targetKm: 0.3, seed: 123 })
  const b = generateCorridorRoute(route, { targetKm: 0.3, seed: 123 })
  assert.deepEqual(a.points, b.points)
  assert.equal(a.km, b.km)
})

test('generateCorridorRoute：不同种子结果不同', () => {
  const route = loopRoute()
  const a = generateCorridorRoute(route, { targetKm: 0.3, seed: 1 })
  const b = generateCorridorRoute(route, { targetKm: 0.3, seed: 2 })
  assert.notDeepEqual(a.points, b.points)
})

test('generateCorridorRoute：点坐标保持 6 位小数格式', () => {
  const g = generateCorridorRoute(loopRoute(), { targetKm: 0.2, seed: 5 })
  for (const p of g.points.slice(0, 5)) {
    assert.match(p.latitude, /^-?\d+\.\d{6}$/)
    assert.match(p.longitude, /^-?\d+\.\d{6}$/)
  }
})

test('generateCorridorRoute：路线点不足时报错', () => {
  assert.throws(() => generateCorridorRoute([{ latitude: 32, longitude: 118 }], { targetKm: 1 }), /官方路线点列不足/)
})

test('generateCorridorRoute：目标里程非法时报错', () => {
  assert.throws(() => generateCorridorRoute(loopRoute(), { targetKm: 0 }), /目标里程必须大于 0/)
})

test('buildTimeline：等间隔且首尾对齐', () => {
  const t = buildTimeline(5, 100)
  assert.equal(t.length, 5)
  assert.equal(t[0], 0)
  assert.equal(t[4], 100000)
  assert.equal(t[2], 50000)
})

test('findSpeedOutliers：正常速度无异常点', () => {
  const route = loopRoute()
  const g = generateCorridorRoute(route, { targetKm: 0.5, seed: 9 })
  const pts = g.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
  const total = (Number(g.km) * 1000) / (3 * 1000 / 3600) // 配速 5'00"/km
  const timeline = buildTimeline(pts.length, total)
  assert.deepEqual(findSpeedOutliers(pts, timeline), [])
})

test('findSpeedOutliers：人为瞬移会被检出', () => {
  const pts = [
    { latitude: 32.0, longitude: 118.0 },
    { latitude: 32.01, longitude: 118.0 }, // 约 1.1km
  ]
  const bad = findSpeedOutliers(pts, [0, 1000], 12)
  assert.deepEqual(bad, [1])
})

test('formatDuration / parseDuration 往返一致', () => {
  for (const s of [0, 59, 60, 3599, 3600, 3725]) {
    assert.equal(parseDuration(formatDuration(s)), s)
  }
  assert.equal(formatDuration(3725), '01:02:05')
})

test('formatPace / parsePace 往返一致', () => {
  assert.equal(formatPace(330), `5'30"`)
  assert.equal(parsePace(`5'30"`), 330)
  assert.equal(parsePace(formatPace(245)), 245)
})

test('buildRunStats：3km / 18min 数据自洽', () => {
  const s = buildRunStats({ distanceKm: 3, durationSeconds: 1080, weightKg: 65 })
  assert.equal(s.km, '3.00')
  assert.equal(s.usedTime, '00:18:00')
  assert.equal(s.avgSpeed, `6'00"`)
  assert.equal(s.ok, true, JSON.stringify(s.problems))
  assert.ok(Number(s.steps) > 0)
  assert.ok(Number(s.kcal) > 0)
})

test('buildRunStats：飞点速度被标记', () => {
  const s = buildRunStats({ distanceKm: 5, durationSeconds: 60 })
  assert.equal(s.ok, false)
  assert.ok(s.problems.some((p) => p.includes('12 m/s')))
})

test('buildRunStats：零里程/零时长被标记', () => {
  const s = buildRunStats({ distanceKm: 0, durationSeconds: 0 })
  assert.equal(s.ok, false)
  assert.equal(s.problems.length >= 2, true)
})

test('estimateSteps / estimateKcal 基本合理性', () => {
  const steps = estimateSteps(3)
  assert.ok(steps > 3 * 1200 * 0.9 && steps < 3 * 1200 * 1.1, `实际 ${steps}`)
  assert.equal(estimateKcal(60, 3600, 8), 480)
})

test('buildTimeFields：拆分与格式化符合源码口径', () => {
  const start = new Date(2026, 8, 14, 7, 5, 3).getTime() // 2026-09-14 07:05:03
  const end = start + 30 * 60 * 1000
  const t = buildTimeFields(start, end)
  assert.equal(t.evaluateDate, '2026-09-14')
  assert.equal(t.startTime, '07:05:03')
  assert.equal(t.endTime, '07:35:03')
  assert.equal(t.createTimeISO, '2026-09-14T07:05:03')
})

test('端到端：生成轨迹 → 构造成绩 → 速度无异常', () => {
  const route = loopRoute()
  const g = generateCorridorRoute(route, { targetKm: 1.5, seed: 2026 })
  const pts = g.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
  const pathLen = pathLengthMeters(pts)
  const durationSeconds = (pathLen / 1000) * 360 // 配速 6'00"/km
  const stats = buildRunStats({ distanceKm: pathLen / 1000, durationSeconds, weightKg: 65 })
  assert.equal(stats.ok, true, JSON.stringify(stats.problems))
  const timeline = buildTimeline(pts.length, durationSeconds)
  assert.deepEqual(findSpeedOutliers(pts, timeline), [])
  assert.ok(Number(g.fitDegree) >= 0.95)
})
