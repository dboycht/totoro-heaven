/**
 * 拟合度算法测试（对齐小程序端参数：5m 采样 / 25m 容差）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateRouteSimilarity,
  distanceMeters,
  pathLengthMeters,
  pointToSegmentDistance,
} from '../../utils/mp/routeSimilarity.ts'

/** 构造一条正南北向的直线路线（纬度递增约 1km） */
const lineRoute = (points = 11, stepM = 100) =>
  Array.from({ length: points }, (_, i) => ({
    latitude: 32.0 + i * (stepM / 111320),
    longitude: 118.0,
  }))

test('distanceMeters：1 度纬度约 111.19km（误差 <1%）', () => {
  const d = distanceMeters(32, 118, 33, 118)
  assert.ok(Math.abs(d - 111195) / 111195 < 0.01, `实际 ${d}`)
})

test('distanceMeters：同一点距离为 0', () => {
  assert.equal(distanceMeters(32, 118, 32, 118), 0)
})

test('pointToSegmentDistance：投影落在段内', () => {
  // 线段沿经度方向，点在其正北 10m 左右
  const d = pointToSegmentDistance(32.0 + 10 / 111320, 118.0, 32.0, 118.0, 32.0, 118.001)
  assert.ok(Math.abs(d - 10) < 0.5, `实际 ${d}`)
})

test('pointToSegmentDistance：投影落在端点外（取端点距离）', () => {
  const d = pointToSegmentDistance(32.001, 118.001, 32.0, 118.0, 32.0, 118.0005)
  assert.ok(d > 0)
})

test('拟合度：同一路线自身 = 1', () => {
  const r = lineRoute()
  assert.equal(calculateRouteSimilarity(r, r), 1)
})

test('拟合度：走廊内抖动（σ=2.2m）仍为 1', () => {
  const r = lineRoute()
  // 每点向北偏移 2 米（远小于 25m 容差）
  const jittered = r.map((p) => ({ ...p, latitude: p.latitude + 2 / 111320 }))
  assert.equal(calculateRouteSimilarity(r, jittered), 1)
})

test('拟合度：整体偏移超过容差 → 命中率下降', () => {
  const r = lineRoute()
  // 每点向东偏移 200 米（远超 25m 容差）
  const far = r.map((p) => ({ ...p, longitude: p.longitude + 200 / (111320 * Math.cos((32 * Math.PI) / 180)) }))
  const score = calculateRouteSimilarity(r, far)
  assert.ok(score < 0.1, `实际 ${score}`)
})

test('拟合度：点不足时返回 0', () => {
  assert.equal(calculateRouteSimilarity(lineRoute(), [{ latitude: 32, longitude: 118 }]), 0)
  assert.equal(calculateRouteSimilarity([], lineRoute()), 0)
})

test('拟合度：半程轨迹 → 约 0.5 上下（不高于 1）', () => {
  const r = lineRoute()
  const half = r.slice(0, 6)
  const score = calculateRouteSimilarity(r, half)
  assert.ok(score > 0.3 && score <= 1, `实际 ${score}`)
})

test('pathLengthMeters：1km 直线误差 <1%', () => {
  const r = lineRoute(11, 100) // 10 段 × 100m
  const len = pathLengthMeters(r)
  assert.ok(Math.abs(len - 1000) / 1000 < 0.01, `实际 ${len}`)
})

test('pathLengthMeters：单点/空数组为 0', () => {
  assert.equal(pathLengthMeters([]), 0)
  assert.equal(pathLengthMeters([{ latitude: 32, longitude: 118 }]), 0)
})
