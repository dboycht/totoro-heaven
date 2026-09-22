/**
 * 「非官方路径（自由路径）」纯算法层单测（2026-09-22 新功能）
 *
 * 覆盖规格里点名的五类情形：
 *   ① 闭合（首尾是否连上）；② 趟数取整方向（**宁可多跑、不许少跑**）；
 *   ③ 总长 ≥ 目标；④ 单点/两点退化；⑤ 非法输入不抛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FREE_PATH_MAX_TRIPS,
  curveLengthM,
  expandFreePathTrajectory,
  freePathPointCount,
  freePathShapeText,
  lineLengthM,
  normalizeFreePathTrips,
  parseFreePathShape,
  planFreePathTrips,
  polylineLengthM,
  usableFreePathShape,
  type FreePathShape,
} from '../../utils/mp/pathShape.ts'
import { distanceMeters } from '../../utils/mp/routeSimilarity.ts'

/**
 * 米 → 经纬度（按纬度做局部投影，用来**摆点**）。
 * ⚠️ 不能拿"常数米/度"直接加：经度方向的米/度随纬度收缩，直接用会把东西向的边长算错几十厘米。
 * ⚠️ 更要紧的是：本工程的 `distanceMeters` 用**平均地球半径 6371 km**，它算出来的 100 m 会显示成
 *    99.89 m（约 0.11% 的系统偏差）⇒ 测试里的期望值**必须用 `dist()` 现算**，不能写"正好 100"。
 */
const M_PER_DEG_LAT = 111320
const ORIGIN = { latitude: 31.37, longitude: 119.48 }
/** 以 ORIGIN 为原点、往东 `east` 米 / 往北 `north` 米处的坐标 */
const atM = (east: number, north: number) => ({
  latitude: ORIGIN.latitude + north / M_PER_DEG_LAT,
  longitude: ORIGIN.longitude + east / (M_PER_DEG_LAT * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
})
/** 两点距离（米，与生产代码同一个函数） */
const dist = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
  distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude)

/** 以天目湖校区为原点的一条直路（往北，标称 100 m） */
const A = atM(0, 0)
const B = atM(0, 100)
const SIDE = dist(A, B)

/** 正方形（首尾**不重复**，验证"函数自己补收尾段"）—— 边长 = `SIDE`（≈99.89 m） */
const square: FreePathShape = {
  kind: 'curve',
  points: [atM(0, 0), atM(0, 100), atM(100, 100), atM(100, 0)],
}
const lineShape: FreePathShape = { kind: 'line', from: A, to: B }

const near = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}（${a} vs ${b}，容差 ${tol}）`)

/** 正方形周长（= 4 × 边长，边长由 `dist` 现算） */
const SQUARE_M = SIDE * 4

// ---------------------------------------------------------------- ① 长度与闭合

test('curveLengthM：闭合时把"最后一点 → 第一点"那一段算进去（= 4 条边）', () => {
  const closed = curveLengthM(square, true)
  const open = curveLengthM(square, false)
  near(closed, SQUARE_M, 0.5, '闭合周长 = 4 条边')
  near(open, SIDE * 3, 0.5, '不闭合只有 3 段')
  assert.ok(closed > open, '闭合必须比不闭合长（差的正是收尾那一段）')
})

test('polylineLengthM：相邻重复点不重复计数（手抖双击同一点不虚增长度）', () => {
  const withDup = [{ ...A }, { ...A }, { ...B }]
  near(polylineLengthM(withDup, false), SIDE, 0.5, '重复点被去掉后 = 一段')
})

test('lineLengthM：一趟 = A→B 的单程（折返"一来一回"由 planFreePathTrips 按 2×算）', () => {
  near(lineLengthM(lineShape), SIDE, 0.5, '单程 = 一段')
})

// ---------------------------------------------------------------- ② 趟数取整方向（宁可多跑）

test('planFreePathTrips：curve 取整**向上**（宁可多跑，不许少跑）', () => {
  // 一圈 = SQUARE_M（≈399.5 m）；目标 1.0 km ⇒ 需要 3 圈（2 圈只有 ~799 m，不够）
  const p = planFreePathTrips(square, 1.0)
  assert.equal(p.trips, 3, '1 km / 一圈 ⇒ 向上取整 = 3 圈')
  assert.ok(p.totalM >= 1000, `总长必须 ≥ 目标：${p.totalM} ≥ 1000`)
  near(p.perTripM, SQUARE_M, 0.5, '一趟 = 一圈')
  near(p.totalM, p.perTripM * p.trips, 1e-6, 'totalM = perTripM × trips')
  assert.match(p.note, /共 3 圈/)
  assert.match(p.note, /合计约 1\.20 km/)
})

test('planFreePathTrips：line 一趟 = 一来一回（A→B→A），趟数按 2×单程算', () => {
  // 单程 SIDE（≈99.89 m）⇒ 一趟 ≈199.8 m；目标 0.5 km ⇒ 3 趟（2 趟 ~399.5 m 不够）
  const p = planFreePathTrips(lineShape, 0.5)
  assert.equal(p.trips, 3, '0.5 km / 一趟 ⇒ 3 趟')
  near(p.perTripM, SIDE * 2, 1, '一趟 = 一来一回')
  assert.ok(p.totalM >= 500, `总长必须 ≥ 目标：${p.totalM}`)
  assert.match(p.note, /共 3 趟/)
})

test('planFreePathTrips：整除时不多跑，差一点点则照旧多跑一趟（ceil 的真正分界）', () => {
  // 目标**正好等于**一圈 ⇒ 1 圈（浮点误差不许把 1.0000000000000002 变成 2 圈）
  const exact = planFreePathTrips(square, SQUARE_M / 1000)
  assert.equal(exact.trips, 1, `目标正好一圈 ⇒ 1 圈（实际 ${exact.trips}）`)
  near(exact.totalM, SQUARE_M, 0.5, '合计 = 一圈')
  // 目标比一圈多 **1 米** ⇒ 必须 2 圈（宁可多跑，不许少跑）
  const over = planFreePathTrips(square, SQUARE_M / 1000 + 0.001)
  assert.equal(over.trips, 2, '超出一点点也必须多跑一趟')
  assert.ok(over.totalM >= SQUARE_M + 1)
})

test('planFreePathTrips：目标比一趟还短 ⇒ 仍然至少 1 趟（不会算出 0 趟）', () => {
  assert.equal(planFreePathTrips(square, 0.05).trips, 1)
  assert.equal(planFreePathTrips(lineShape, 0.01).trips, 1)
})

test('planFreePathTrips：趟数有上限（防坏数据把轨迹撑爆）', () => {
  const tiny: FreePathShape = { kind: 'line', from: A, to: atM(0, 0.5) }
  const p = planFreePathTrips(tiny, 100)
  assert.equal(p.trips, FREE_PATH_MAX_TRIPS, '被夹到上限')
  assert.ok(Number.isFinite(p.totalM))
})

// ---------------------------------------------------------------- ③ 总长 ≥ 目标（扫一遍所有目标）

test('planFreePathTrips：任意目标下 totalM 都 ≥ 目标（除"撞上限"这一种情形）', () => {
  for (const km of [0.1, 0.3, 0.5, 1, 1.3, 2, 3.2, 5, 10, 21.1]) {
    for (const shape of [square, lineShape]) {
      const p = planFreePathTrips(shape, km)
      const reached = p.totalM >= km * 1000
      const capped = p.trips === FREE_PATH_MAX_TRIPS
      assert.ok(reached || capped, `${shape.kind} @ ${km} km：totalM=${p.totalM} trips=${p.trips}`)
    }
  }
})

// ---------------------------------------------------------------- ④ 单点/两点退化

test('退化：curve 单点 / 两点（长度 0）⇒ 不可用、trips=0、展开为空，但**不抛**', () => {
  const one: FreePathShape = { kind: 'curve', points: [{ ...A }] }
  const two: FreePathShape = { kind: 'curve', points: [{ ...A }, { ...A }] }
  for (const s of [one, two]) {
    assert.equal(curveLengthM(s, true), 0)
    assert.equal(usableFreePathShape(s), false, '长度为 0 的曲线不可用')
    const p = planFreePathTrips(s, 3.2)
    assert.equal(p.trips, 0)
    assert.equal(p.totalM, 0)
    assert.match(p.note, /还不能跑/)
    assert.deepEqual(expandFreePathTrajectory(s, 2), [])
  }
})

test('退化：line 两点重合 ⇒ 不可用（单程 0 m 没法折返）', () => {
  const zero: FreePathShape = { kind: 'line', from: A, to: { ...A } }
  assert.equal(lineLengthM(zero), 0)
  assert.equal(usableFreePathShape(zero), false)
  assert.equal(planFreePathTrips(zero, 1).trips, 0)
  assert.deepEqual(expandFreePathTrajectory(zero, 3), [])
})

test('退化：curve 两点但**不重合** ⇒ 可用（一条往返线，长度 = 去 + 回）', () => {
  const seg: FreePathShape = { kind: 'curve', points: [{ ...A }, { ...B }] }
  near(curveLengthM(seg, true), SIDE * 2, 0.5, '闭合后 = 去 + 回')
  assert.equal(usableFreePathShape(seg), true)
})

// ---------------------------------------------------------------- ⑤ 非法输入不抛

test('非法输入：null/undefined/缺字段/坐标是 NaN 一律安全降级（不抛）', () => {
  const junk: unknown[] = [
    null,
    undefined,
    {},
    { kind: 'curve' },
    { kind: 'curve', points: 'nope' },
    { kind: 'curve', points: [null, { latitude: 'x', longitude: 1 }] },
    { kind: 'line', from: { latitude: NaN, longitude: 1 }, to: { ...B } },
    { kind: 'line', from: null, to: null },
    { kind: 'unknown-kind', points: [{ ...A }, { ...B }] },
    'curve',
    42,
  ]
  for (const v of junk) {
    assert.doesNotThrow(() => usableFreePathShape(v as FreePathShape))
    assert.equal(usableFreePathShape(v as FreePathShape), false, `不可用：${JSON.stringify(v)}`)
    assert.doesNotThrow(() => curveLengthM(v as FreePathShape))
    assert.doesNotThrow(() => lineLengthM(v as FreePathShape))
    const p = planFreePathTrips(v as FreePathShape, 3.2)
    assert.equal(p.trips, 0)
    assert.doesNotThrow(() => expandFreePathTrajectory(v as FreePathShape, 3))
    assert.deepEqual(expandFreePathTrajectory(v as FreePathShape, 3), [])
    assert.equal(parseFreePathShape(v), undefined)
    assert.equal(freePathShapeText(v as FreePathShape), null)
  }
  // 目标里程非法 ⇒ 用默认 3 km 兜底，但仍然算出合法计划（不抛）
  for (const t of [0, -1, NaN, Number.POSITIVE_INFINITY, 'abc'] as unknown as number[]) {
    const p = planFreePathTrips(square, t)
    assert.ok(p.trips >= 1, `目标=${String(t)} 也该给出至少 1 趟`)
    assert.match(p.note, /默认 3 km/)
  }
  // 趟数非法 ⇒ 忽略手填值、回落自动
  for (const o of [0, -3, NaN, 'x', '']) {
    const p = planFreePathTrips(square, 1.0, o)
    assert.equal(p.trips, 3, `override=${String(o)} 应回落到自动算的 3 圈`)
  }
})

test('normalizeFreePathTrips：手填趟数的校验口径', () => {
  assert.equal(normalizeFreePathTrips(5), 5)
  assert.equal(normalizeFreePathTrips('7'), 7)
  assert.equal(normalizeFreePathTrips(2.4), 2)
  assert.equal(normalizeFreePathTrips(0), null)
  assert.equal(normalizeFreePathTrips(-1), null)
  assert.equal(normalizeFreePathTrips(''), null)
  assert.equal(normalizeFreePathTrips(undefined), null)
  assert.equal(normalizeFreePathTrips(1e9), FREE_PATH_MAX_TRIPS)
  const p = planFreePathTrips(lineShape, 0.5, '4')
  assert.equal(p.trips, 4)
  assert.match(p.note, /你手填的趟数/)
  assert.match(p.note, /合计约 0\.80 km/)
})

// ---------------------------------------------------------------- 展开（喂给生成器的几何）

test('expandFreePathTrajectory：curve **首尾严格同点**（生成器才会判为闭合、按取模绕圈）', () => {
  const out = expandFreePathTrajectory(square, 3)
  assert.ok(out.length > 0)
  assert.deepEqual(out[0], out[out.length - 1], '第 0 点与末点必须完全相等 ⇒ 判为闭合')
  // 3 圈 = 4 段/圈 × 3 + 1 个收盘点 = 13 点（**每圈之间不重复补点**，否则会多出 0 m 的段）
  assert.equal(out.length, square.points.length * 3 + 1, '只在整条展开的末尾补一个收盘点')
  // 逐段长度都 > 0（没有 0 长度的重复段 —— 生成器遇到它会把速度算成 0）
  for (let i = 1; i < out.length; i++) {
    assert.ok(dist(out[i - 1]!, out[i]!) > 1, `第 ${i} 段不该是 0`)
  }
})

test('expandFreePathTrajectory：curve 展开的实际弧长 = 计划长度（与 planFreePathTrips 同源）', () => {
  const p = planFreePathTrips(square, 1.0)
  const out = expandFreePathTrajectory(square, p.trips)
  near(polylineLengthM(out, false), p.totalM, 1, '展开后逐段累加 = perTripM × trips')
})

test('expandFreePathTrajectory：line 是 A→B→A 的来回序列（趟数 = 层数）', () => {
  const out = expandFreePathTrajectory(lineShape, 2)
  // A B A | B A  ⇒ 5 点（首点 + 每趟 2 点）
  assert.equal(out.length, 1 + 2 * 2)
  near(out[0]!.latitude, A.latitude, 1e-9, '第 0 点 = A')
  near(out[1]!.latitude, B.latitude, 1e-9, '第 1 点 = B')
  near(out[2]!.latitude, A.latitude, 1e-9, '第 2 点 = A（第 1 趟结束回到起点）')
  near(out[3]!.latitude, B.latitude, 1e-9, '第 3 点 = B（第 2 趟）')
  near(out[4]!.latitude, A.latitude, 1e-9, '末点 = A')
  // 首尾都是 A ⇒ 生成器的闭合判定（首尾 < 30 m）会判成闭合 ⇒ **必须靠长度**让它走折返：
  // 展开总弧长 ≥ 一趟 × 趟数（这里 400 m，首尾同点这件事本身不影响总长）
  near(polylineLengthM(out, false), lineLengthM(lineShape) * 2 * 2, 2, '总弧长 = 单程 × 2 × 趟数')
})

test('expandFreePathTrajectory：**相邻段方向相反** = 折返（可直接这样断言"在 A/B 之间来回"）', () => {
  const out = expandFreePathTrajectory(lineShape, 3)
  assert.equal(out.length, 1 + 2 * 3, 'A + 每趟 2 点')
  /** 第 i 段的单位方向（用局部平面近似：纬度当 y、经度按 cos 收缩当 x） */
  const dirAt = (i: number) => {
    const a = out[i]!
    const b = out[i + 1]!
    const mLng = M_PER_DEG_LAT * Math.cos((a.latitude * Math.PI) / 180)
    const dx = (b.longitude - a.longitude) * mLng
    const dy = (b.latitude - a.latitude) * M_PER_DEG_LAT
    const len = Math.hypot(dx, dy) || 1
    return { x: dx / len, y: dy / len }
  }
  for (let i = 0; i + 1 < out.length - 1; i++) {
    const d1 = dirAt(i)
    const d2 = dirAt(i + 1)
    assert.ok(d1.x * d2.x + d1.y * d2.y < -0.99, `第 ${i} 段与第 ${i + 1} 段必须反向（点积=${(d1.x * d2.x + d1.y * d2.y).toFixed(3)}）`)
  }
  // 展开后的总弧长 = 单程 × 2 × 趟数（与 planFreePathTrips 的 perTripM × trips 同源）
  near(polylineLengthM(out, false), SIDE * 2 * 3, 1, '总弧长 = 一来一回 × 趟数')
})

test('expandFreePathTrajectory：极短直线也是干净的往复（不出现 0 m 的段；已如实记下 30 m 边界）', () => {
  const short: FreePathShape = { kind: 'line', from: A, to: atM(0, 10) }
  const out = expandFreePathTrajectory(short, 2)
  assert.equal(out.length, 1 + 2 * 2, '仍是 A + 每趟 2 点（不做特判）')
  for (let i = 1; i < out.length; i++) {
    assert.ok(dist(out[i - 1]!, out[i]!) > 1, `第 ${i} 段不该是 0`)
  }
})

test('expandFreePathTrajectory：趟数非法 / 0 趟 ⇒ 空数组（调用方按"没有几何"处理）', () => {
  for (const t of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(expandFreePathTrajectory(square, t as number), [])
  }
})

// ---------------------------------------------------------------- 持久化归一化（老数据兼容的入口）

test('parseFreePathShape：合法形状往返（存→读）逐值一致，坐标统一成 number', () => {
  const round = parseFreePathShape(JSON.parse(JSON.stringify(square)))
  assert.deepEqual(round, {
    kind: 'curve',
    points: square.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
  })
  const roundLine = parseFreePathShape(JSON.parse(JSON.stringify(lineShape)))
  assert.deepEqual(roundLine, { kind: 'line', from: { latitude: A.latitude, longitude: A.longitude }, to: { latitude: B.latitude, longitude: B.longitude } })
})

test('parseFreePathShape：字符串坐标被收敛成数字（JSON 里坐标可能是字符串）', () => {
  const s = parseFreePathShape({ kind: 'curve', points: [{ latitude: '31.37', longitude: '119.48' }, { latitude: '31.371', longitude: '119.48' }] })
  assert.ok(s && s.kind === 'curve')
  assert.equal(typeof s.points[0]!.latitude, 'number')
  assert.equal(s.points[0]!.latitude, 31.37)
})

test('parseFreePathShape：不认识的形状 ⇒ undefined（**老条目/坏数据安全降级**），且不抛', () => {
  for (const v of [{ kind: 'circle', r: 5 }, { kind: 'curve', points: [{ latitude: 1, longitude: 2 }] }, null, 'x', 7, []]) {
    assert.equal(parseFreePathShape(v), undefined, `应安全降级：${JSON.stringify(v)}`)
  }
})

test('parseFreePathShape：点数超上限被截断（坏数据不许撑爆 localStorage）', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({ latitude: 31.37 + i * 1e-6, longitude: 119.48 }))
  const s = parseFreePathShape({ kind: 'curve', points: pts })
  assert.ok(s && s.kind === 'curve')
  assert.ok(s.points.length <= 2000, `截断到 ≤2000，实际 ${s.points.length}`)
})

test('freePathShapeText / freePathPointCount：给列表摘要用的读数', () => {
  assert.match(freePathShapeText(square)!, /圈型（闭合曲线）/)
  assert.match(freePathShapeText(lineShape)!, /直线型（折返）/)
  assert.equal(freePathPointCount(square), 4)
  assert.equal(freePathPointCount(lineShape), 2)
})
