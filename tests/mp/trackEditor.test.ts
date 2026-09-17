/**
 * 跑道内外圈 → 车道线 的算法测试（2026-09-17）
 *
 * 夹具：两个同心圆当内外圈（外 r=100 m、内 r=90 m，环宽 10 m）——
 * 同心圆的好处是"到圆心的距离"就是判据，能精确验证插值是否落在两圈之间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laneLoop, laneRatioFor, laneRatioProfile, ringLengthM, ringWidthM, smoothClosedRing, type TrackRings } from '../../utils/mp/trackEditor.ts'

const CENTER = { latitude: 31.37, longitude: 119.48 }
const mLat = 111320
const mLng = 111320 * Math.cos((CENTER.latitude * Math.PI) / 180)

/** 造一个半径 r 米的圆（n 个点） */
const circle = (r: number, n = 120) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return {
      latitude: CENTER.latitude + (r * Math.sin(a)) / mLat,
      longitude: CENTER.longitude + (r * Math.cos(a)) / mLng,
    }
  })

const rings: TrackRings = { outer: circle(100), inner: circle(90) }
/** 点到圆心的距离（米） */
const radiusOf = (p: { latitude: number; longitude: number }) =>
  Math.hypot((p.latitude - CENTER.latitude) * mLat, (p.longitude - CENTER.longitude) * mLng)

test('laneRatioFor：第 1 道贴内圈、第 N 道贴外圈、居中的道在中间', () => {
  assert.ok(Math.abs(laneRatioFor(1, 6) - 0.5 / 6) < 1e-9)
  assert.ok(Math.abs(laneRatioFor(6, 6) - 5.5 / 6) < 1e-9)
  assert.ok(Math.abs(laneRatioFor(3, 6) - 2.5 / 6) < 1e-9)
  // 越界要夹紧
  assert.equal(laneRatioFor(0, 6), laneRatioFor(1, 6))
  assert.equal(laneRatioFor(99, 6), laneRatioFor(6, 6))
})

test('ringWidthM：同心圆夹具应量出 10 m 环宽', () => {
  const width = ringWidthM(rings)
  assert.ok(Math.abs(width - 10) < 0.6, `实测环宽 ${width.toFixed(2)} m`)
})

test('★ laneLoop：车道线必须严格落在内外圈之间（ratio=0.5 时半径≈95 m）', () => {
  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const lane = laneLoop(rings, ratio)
    assert.ok(lane.length >= 24, `ratio=${ratio} 生成点数太少`)
    const rs = lane.map((p) => radiusOf(p as { latitude: number; longitude: number }))
    const expect = 90 + 10 * ratio
    const worst = Math.max(...rs.map((r) => Math.abs(r - expect)))
    assert.ok(worst < 0.8, `ratio=${ratio} 期望半径 ${expect} m，实测偏离最大 ${worst.toFixed(2)} m`)
  }
})

test('★ laneLoop：车道周长必须落在内外圈周长之间（不许穿墙）', () => {
  const lo = ringLengthM(rings.inner)
  const hi = ringLengthM(rings.outer)
  for (const ratio of [0, 0.3, 0.5, 0.8, 1]) {
    const per = ringLengthM(laneLoop(rings, ratio))
    assert.ok(per >= lo - 1 && per <= hi + 1, `ratio=${ratio} 周长 ${per.toFixed(1)} m 不在 [${lo.toFixed(1)}, ${hi.toFixed(1)}] 内`)
  }
})

test('smoothClosedRing：手工描的圈平滑后仍是同一个圈（圆→圆），点数按轮数翻倍', () => {
  const src = circle(100, 60)
  const out = smoothClosedRing(src, 2)
  assert.equal(out.length, src.length * 4)
  const rs = out.map((p) => radiusOf(p as { latitude: number; longitude: number }))
  const worst = Math.max(...rs.map((r) => Math.abs(r - 100)))
  assert.ok(worst < 1, `平滑后半径偏离 ${worst.toFixed(2)} m（应仍是同心圆）`)
  const perBefore = ringLengthM(src)
  const perAfter = ringLengthM(out)
  assert.ok(Math.abs(perAfter - perBefore) / perBefore < 0.02, `周长变化 ${(((perAfter - perBefore) / perBefore) * 100).toFixed(2)}%`)
  // 少于 3 个点时不动（避免把两点"平滑"成一条线）
  assert.deepEqual(smoothClosedRing(circle(100, 2), 2).length, 2)
})

test('laneRatioProfile：随机道次 + 偶尔换道，比例恒在 [0,1] 且能复现', () => {
  const mkRng = (seed: number) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  for (const seed of [1, 7, 42, 20260917]) {
    const f = laneRatioProfile(mkRng(seed), 6, 400, { maxChanges: 2, changeLenM: 30 })
    const vals = Array.from({ length: 400 }, (_, i) => f(i))
    assert.ok(vals.every((v) => v >= 0 && v <= 1), `seed=${seed} 出现越界比例`)
    // 相邻 1 m 的变化必须很小（换道是"缓慢"的，不是跳变）
    const jumps = vals.slice(1).map((v, i) => Math.abs(v - vals[i]!))
    assert.ok(Math.max(...jumps) < 0.05, `seed=${seed} 出现突变 ${Math.max(...jumps).toFixed(3)}（换道应平滑）`)
    // 同种子可复现
    const g = laneRatioProfile(mkRng(seed), 6, 400, { maxChanges: 2, changeLenM: 30 })
    assert.deepEqual(Array.from({ length: 20 }, (_, i) => g(i)), vals.slice(0, 20))
  }
})
