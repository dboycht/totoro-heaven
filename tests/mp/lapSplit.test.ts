/**
 * **按圈切段**的纯逻辑测试（2026-11-03）
 *
 * 钉住用户要求的那条判据："轨迹第 1 圈必须从起跑点开始（进场段移出第 1 圈）"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitLapsByLength } from '../../utils/mp/lapSplit.ts'

/** 一个半径 r 的圆（n 点，闭合：首末点相同），周长 ≈ 2πr */
const circle = (r: number, n: number, cLat = 31.99, cLng = 118.84) => {
  const R = 6378137
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return {
      latitude: cLat + ((r * Math.sin(a)) / R) * (180 / Math.PI),
      longitude: cLng + ((r * Math.cos(a)) / (R * Math.cos((cLat * Math.PI) / 180))) * (180 / Math.PI),
    }
  })
  pts.push({ ...pts[0]! })
  return pts
}

test('没有进场段（startIndex=0）⇒ 与旧行为一致：第 1 圈从第 0 点开始', () => {
  const one = circle(100, 48)
  const pts = [...one, ...one.slice(1)]
  const lapM = 2 * Math.PI * 100
  const r = splitLapsByLength(pts, lapM)
  assert.equal(r.startIndex, 0)
  assert.deepEqual(r.leadIn, [])
  assert.equal(r.laps.length, 2, `应切成 2 圈，实际 ${r.laps.length}`)
  assert.deepEqual(r.laps[0]!.pts[0], pts[0], '第 1 圈必须从第 0 点开始')
})

test('🔴 有进场段 ⇒ 第 1 圈从**起跑点**（startIndex）开始，进场段单独返回且不计圈', () => {
  const one = circle(100, 48)
  /** 进场段：从圆外 60 m 走到圆的第 0 点，共 6 个点 */
  const cLat = 31.99
  const entry = Array.from({ length: 6 }, (_, i) => ({
    latitude: cLat - 0.0005 + (i * 0.0001),
    longitude: 118.84 + 0.0009,
  }))
  const pts = [...entry, ...one, ...one.slice(1)]
  const lapM = 2 * Math.PI * 100
  const r = splitLapsByLength(pts, lapM, entry.length)
  assert.equal(r.startIndex, 6)
  assert.equal(r.leadIn.length, 6, '进场段 6 个点应原样返回（不参与圈数）')
  assert.deepEqual(r.leadIn[0], entry[0], '进场段保留原始点（起点是进场点）')
  /** 关键判据：第 1 圈的第一个点 = 起跑点 = pts[startIndex] */
  assert.deepEqual(r.laps[0]!.pts[0], pts[entry.length], '第 1 圈必须从起跑点开始')
  assert.equal(r.laps.length, 2, `进场段不能多算出一圈（应 2 圈，实际 ${r.laps.length}）`)
  /** 进场段不能出现在任何一圈里 */
  for (const lap of r.laps) {
    for (const p of lap.pts) {
      assert.ok(!entry.some((e) => Math.abs(e.latitude - p.latitude) < 1e-12 && Math.abs(e.longitude - p.longitude) < 1e-12), '进场段的点不该出现在圈里')
    }
  }
})

test('startIndex 越界会被夹到合法范围（不抛、不越界取点）', () => {
  const one = circle(100, 8)
  const r1 = splitLapsByLength(one, 300, 999)
  assert.equal(r1.startIndex, one.length)
  assert.deepEqual(r1.laps[0]!.pts, [], '越界后没有可切的内容 ⇒ 空段（调用方自己判）')
  const r2 = splitLapsByLength(one, 300, -5)
  assert.equal(r2.startIndex, 0)
})

test('lapLengthM <= 0 / 点太少 ⇒ 退化成"整条一色"（与旧行为逐点一致）', () => {
  const one = circle(100, 12)
  const a = splitLapsByLength(one, 0)
  assert.equal(a.laps.length, 1)
  assert.equal(a.laps[0]!.lap, 0)
  assert.equal(a.laps[0]!.pts.length, one.length, '整条返回，不丢点')
  assert.equal(a.lapLengthM, 0)
  const b = splitLapsByLength([{ latitude: 31.99, longitude: 118.84 }], 300)
  assert.equal(b.laps.length, 1)
  assert.equal(b.laps[0]!.pts.length, 1)
  const c = splitLapsByLength([], 300)
  assert.equal(c.laps.length, 1)
  assert.deepEqual(c.laps[0]!.pts, [])
})

test('跨圈的点两边都有（不然每圈之间会裂开一道缝）', () => {
  const one = circle(100, 48)
  const pts = [...one, ...one.slice(1)]
  const r = splitLapsByLength(pts, 2 * Math.PI * 100)
  assert.equal(r.laps.length, 2)
  /** 第 1 圈的最后一个点 === 第 2 圈的第一个点 */
  const tail = r.laps[0]!.pts[r.laps[0]!.pts.length - 1]!
  assert.deepEqual(tail, r.laps[1]!.pts[0], '交界点必须同时属于相邻两圈')
})

test('非法坐标的点被丢弃（不参与切圈、也不制造空洞）', () => {
  const good = circle(100, 12)
  const dirty = [...good.slice(0, 5), { latitude: Number.NaN, longitude: 118.84 }, ...good.slice(5)]
  /** 用足够大的一圈长度 ⇒ 只切出一段，方便数点数（否则 laps[0] 只是第一圈） */
  const r = splitLapsByLength(dirty as never, 10000)
  assert.ok(r.laps[0]!.pts.every((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)), '切出来的段里不许有 NaN 点')
  assert.equal(r.laps[0]!.pts.length, good.length, '坏点被丢掉，好点一个不少')
})
