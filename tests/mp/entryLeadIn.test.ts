/**
 * 「进场段只走一次」回归测试（1.3.3，2026-10-30）
 *
 * 用户指正原话：**"用户从进场点开始跑，跑到起跑点后开始沿着跑道进行奔跑；现在并不是这个样子的"**。
 *
 * 第一版的错法：把进场点拼进几何数组 → 生成器把整条几何当成"一圈" ⇒ **每圈都绕回进场点**。
 * 正确行为（本测试钉住）：
 *   · 轨迹**第 0 点 = 进场点**；
 *   · 轨迹在开局阶段**离开进场点、走到起跑点**，此后**不再回到进场点**（只在跑道附近循环）；
 *   · 未传 `leadIn` ⇒ 与旧版逐点一致（回归保证）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateCorridorRoute } from '../../utils/mp/generateRoute.ts'
import { distanceMeters } from '../../utils/mp/routeSimilarity.ts'

/** 约 200 m 的闭合方形跑道（起跑点 = 第 0 点） */
const SQUARE = (() => {
  const lat0 = 32.0
  const lng0 = 118.0
  const dLat = 50 / 111320
  const dLng = 50 / (111320 * Math.cos((lat0 * Math.PI) / 180))
  return [
    { latitude: lat0, longitude: lng0 },
    { latitude: lat0 + dLat, longitude: lng0 },
    { latitude: lat0 + dLat, longitude: lng0 + dLng },
    { latitude: lat0, longitude: lng0 + dLng },
  ]
})()

/** 起跑点正北 offsetM 米处（= 跑道外侧的进场点） */
const entryNorthOf = (offsetM: number) => ({
  latitude: SQUARE[0]!.latitude + offsetM / 111320,
  longitude: SQUARE[0]!.longitude,
})

/**
 * ⚠️ 进场点必须放在**离跑道足够远**的地方（跑道是 50 m 见方的方形，北边那条边离起跑点只有 50 m）。
 * 第一次写测试时用了 30 m —— 那个点离跑道北边只有 20 m，跑道本身就跑过去，
 * 于是"走完进场段后不应再回到进场点附近"被误判成"没修好"（实际是**测试选错了点**）。
 * 现在用 80 m：进场段从正方形外部一路走到西南角，全程都在跑道包围盒之外。
 */
const ENTRY_OFFSET_M = 80

test('进场段只走一次：首点 = 进场点，之后不再回到进场点', () => {
  const entry = entryNorthOf(ENTRY_OFFSET_M)
  const g = generateCorridorRoute(SQUARE, { targetKm: 1.5, stepM: 2, seed: 42, leadIn: [entry] })

  // ① 首点就是进场点（人从这里开始跑）
  //    阈值 0.2 m：进场点原本精确写入，但生成器会把经纬度换算成度存储，
  //    在 32°N 附近 1e-6 度 ≈ 0.11 m ⇒ 亚米级偏差是数值精度，不是位置错。
  const first = g.points[0]!
  const dFirst = distanceMeters(Number(first.latitude), Number(first.longitude), entry.latitude, entry.longitude)
  assert.ok(dFirst < 0.2, `首点应是进场点，实际偏了 ${dFirst.toFixed(3)} m`)

  // ② 开局确实走向起跑点：前几个点的纬度应向跑道收拢
  const dStart0 = distanceMeters(Number(first.latitude), Number(first.longitude), SQUARE[0]!.latitude, SQUARE[0]!.longitude)
  const mid = g.points[10]!
  const dStartMid = distanceMeters(Number(mid.latitude), Number(mid.longitude), SQUARE[0]!.latitude, SQUARE[0]!.longitude)
  assert.ok(dStartMid < dStart0, `开局应在向起跑点靠拢（前 ${dStart0.toFixed(1)} m → ${dStartMid.toFixed(1)} m）`)

  // ③ ⭐ 核心判据：走完进场段之后，**不应该再回到进场点附近**
  //    （第一版错法：每圈都会绕回进场点 ⇒ 尾部会反复出现离进场点 ~0 的点）
  const tail = g.points.slice(40) // 前 40 点（≈80 m）留作进场段
  const back = tail.filter(
    (p) => distanceMeters(Number(p.latitude), Number(p.longitude), entry.latitude, entry.longitude) < 8,
  )
  assert.equal(back.length, 0, `走完进场段后不应再回到进场点，实际有 ${back.length} 个点在它附近`)
})

test('进场段只走一次：总里程仍达到目标（进场段计入里程）', () => {
  const entry = entryNorthOf(ENTRY_OFFSET_M)
  const g = generateCorridorRoute(SQUARE, { targetKm: 1.2, stepM: 2, seed: 42, leadIn: [entry] })
  assert.ok(Number(g.km) >= 1.2 * 0.98, `总里程应达到目标，实际 ${g.km}`)
})

test('不传 leadIn ⇒ 与旧版逐点一致（回归保证）', () => {
  const a = generateCorridorRoute(SQUARE, { targetKm: 1, stepM: 2, seed: 7 })
  const b = generateCorridorRoute(SQUARE, { targetKm: 1, stepM: 2, seed: 7, leadIn: [] })
  assert.equal(a.points.length, b.points.length)
  for (let i = 0; i < a.points.length; i++) {
    assert.equal(a.points[i]!.latitude, b.points[i]!.latitude, `第 ${i} 点纬度不该变`)
    assert.equal(a.points[i]!.longitude, b.points[i]!.longitude, `第 ${i} 点经度不该变`)
  }
})

test('几何里不含进场点：轨迹首点≠跑道首点，但跑道本身没被改', () => {
  const entry = entryNorthOf(ENTRY_OFFSET_M)
  const g = generateCorridorRoute(SQUARE, { targetKm: 0.8, stepM: 2, seed: 11, leadIn: [entry] })
  const first = g.points[0]!
  const dToStart = distanceMeters(Number(first.latitude), Number(first.longitude), SQUARE[0]!.latitude, SQUARE[0]!.longitude)
  assert.ok(dToStart > 70, `首点应是进场点（离起跑点约 ${ENTRY_OFFSET_M} m），实际 ${dToStart.toFixed(1)} m`)
})
