/**
 * 「非官方路径（自由路径）」纯算法层单测（2026-09-22 新功能）
 *
 * 覆盖规格里点名的五类情形：
 *   ① 闭合（首尾是否连上）；② 趟数取整方向（**宁可多跑、不许少跑**）；
 *   ③ 总长 ≥ 目标；④ 单点/两点退化；⑤ 非法输入不抛。
 *
 * 🆕 2026-09-22 用户澄清"我要的是**折线**，不是直线" ⇒ 第二类形状从 `{kind:'line',from,to}`
 *    改成 **`{kind:'polyline',points}`**（可以拐弯、不闭合）。本文件同时钉住：
 *   · 折线的**分段长度**与"一趟 = 单程 × 2"；
 *   · 展开序列（**端点不重复放两遍**、方向反转要真实、趟与趟接缝不重复）；
 *   · **老 `{kind:'line'}` 的向后兼容读**（等价成 2 点折线，读→写一轮不丢数据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FREE_PATH_MAX_TRIPS,
  curveLengthM,
  expandFreePathTrajectory,
  freePathPointCount,
  freePathShapeText,
  normalizeFreePathTrips,
  parseFreePathShape,
  planFreePathTrips,
  polylineLengthM,
  polylineShapeLengthM,
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
/** 2 点折线（= 老"直线型"的等价形状）：单程 `SIDE` */
const lineShape: FreePathShape = { kind: 'polyline', points: [A, B] }
/**
 * 🆕 **4 点折线（会拐弯）**：A(0,0) → B(0,100) → C(100,100) → D(100,200)
 * ⇒ 三段：南北 SIDE + 东西 SIDE + 南北 SIDE（总长 3 × SIDE），是一个"Z"形。
 */
const P_C = atM(100, 100)
const P_D = atM(100, 200)
const zigzag: FreePathShape = { kind: 'polyline', points: [A, B, P_C, P_D] }
/** 老格式（磁盘上已有的样子）：解析时应当被读成**等价的 2 点折线** */
const legacyLine = { kind: 'line', from: A, to: B }

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

test('polylineShapeLengthM：2 点折线 = 一段（折返"一来一回"由 planFreePathTrips 按 2×算）', () => {
  near(polylineShapeLengthM(lineShape), SIDE, 0.5, '单程 = 一段')
})

test('polylineShapeLengthM：**多点折线 = 逐段求和**（拐弯也算进去）', () => {
  near(polylineShapeLengthM(zigzag), SIDE * 3, 1, 'A→B→C→D 三段相加')
  // 逐段现算一遍（不许写成"3 × SIDE"就完事：期望值必须来自 dist）
  const segs = dist(A, B) + dist(B, P_C) + dist(P_C, P_D)
  near(polylineShapeLengthM(zigzag), segs, 0.5, '与逐段累加一致')
  // 相邻重复点被去掉（手抖双击同一点不虚增长度）
  near(polylineShapeLengthM({ kind: 'polyline', points: [A, { ...A }, B, P_C, { ...P_C }, P_D] }), segs, 0.5, '重复点不参与求和')
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

test('planFreePathTrips：折线一趟 = 一来一回（A→B→…→A），趟数按 2×单程算', () => {
  // 单程 SIDE（≈99.89 m）⇒ 一趟 ≈199.8 m；目标 0.5 km ⇒ 3 趟（2 趟 ~399.5 m 不够）
  const p = planFreePathTrips(lineShape, 0.5)
  assert.equal(p.trips, 3, '0.5 km / 一趟 ⇒ 3 趟')
  near(p.perTripM, SIDE * 2, 1, '一趟 = 一来一回')
  assert.ok(p.totalM >= 500, `总长必须 ≥ 目标：${p.totalM}`)
  assert.match(p.note, /共 3 趟/)
})

test('planFreePathTrips：**多点折线**的"一趟"同样是 单程 × 2（拐弯越多、一趟越长）', () => {
  const p = planFreePathTrips(zigzag, 1.0)
  near(p.perTripM, SIDE * 3 * 2, 2, '一趟 = 三段一来一回')
  assert.equal(p.trips, Math.ceil(1000 / (SIDE * 6)), `1 km / 一趟 ⇒ ${Math.ceil(1000 / (SIDE * 6))} 趟`)
  assert.ok(p.totalM >= 1000)
  assert.match(p.note, /共 \d+ 趟/)
  assert.match(p.note, /一来一回/)
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
  const tiny: FreePathShape = { kind: 'polyline', points: [A, atM(0, 0.5)] }
  const p = planFreePathTrips(tiny, 100)
  assert.equal(p.trips, FREE_PATH_MAX_TRIPS, '被夹到上限')
  assert.ok(Number.isFinite(p.totalM))
})

// ---------------------------------------------------------------- ③ 总长 ≥ 目标（扫一遍所有目标）

test('planFreePathTrips：任意目标下 totalM 都 ≥ 目标（除"撞上限"这一种情形）', () => {
  for (const km of [0.1, 0.3, 0.5, 1, 1.3, 2, 3.2, 5, 10, 21.1]) {
    for (const shape of [square, lineShape, zigzag]) {
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

test('退化：折线两点重合 / 所有点重合 ⇒ 不可用（单程 0 m 没法折返）', () => {
  const zero: FreePathShape = { kind: 'polyline', points: [A, { ...A }] }
  assert.equal(polylineShapeLengthM(zero), 0)
  assert.equal(usableFreePathShape(zero), false)
  assert.equal(planFreePathTrips(zero, 1).trips, 0)
  assert.deepEqual(expandFreePathTrajectory(zero, 3), [])
  /** 多点但全都重合（含中间点）：去重后只剩 1 点 ⇒ 同样不可用 */
  const allSame: FreePathShape = { kind: 'polyline', points: [A, { ...A }, { ...A }] }
  assert.equal(usableFreePathShape(allSame), false)
  assert.equal(planFreePathTrips(allSame, 1).trips, 0)
  assert.deepEqual(expandFreePathTrajectory(allSame, 2), [])
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
    { kind: 'polyline', points: 'nope' },
    { kind: 'polyline', points: [{ latitude: NaN, longitude: 1 }, { ...B }] },
    { kind: 'unknown-kind', points: [{ ...A }, { ...B }] },
    'curve',
    42,
  ]
  for (const v of junk) {
    assert.doesNotThrow(() => usableFreePathShape(v as FreePathShape))
    assert.equal(usableFreePathShape(v as FreePathShape), false, `不可用：${JSON.stringify(v)}`)
    assert.doesNotThrow(() => curveLengthM(v as FreePathShape))
    assert.doesNotThrow(() => polylineShapeLengthM(v as FreePathShape))
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

test('expandFreePathTrajectory：折线（2 点）仍然展开成 A→B→A 的来回序列', () => {
  const out = expandFreePathTrajectory(lineShape, 2)
  // A B A | B A  ⇒ 5 点（首点 + 每趟 2 点）
  assert.equal(out.length, 1 + 2 * 2)
  near(out[0]!.latitude, A.latitude, 1e-9, '第 0 点 = A')
  near(out[1]!.latitude, B.latitude, 1e-9, '第 1 点 = B')
  near(out[2]!.latitude, A.latitude, 1e-9, '第 2 点 = A（第 1 趟结束回到起点）')
  near(out[3]!.latitude, B.latitude, 1e-9, '第 3 点 = B（第 2 趟）')
  near(out[4]!.latitude, A.latitude, 1e-9, '末点 = A')
  near(polylineLengthM(out, false), polylineShapeLengthM(lineShape) * 2 * 2, 2, '总弧长 = 单程 × 2 × 趟数')
})

test('⭐ expandFreePathTrajectory：**多点折线**一趟 = 去(A,B,C,D) + 原路返回(C,B,A)，**端点不重复放两遍**', () => {
  const out = expandFreePathTrajectory(zigzag, 1)
  /** 期望序列（逐点比对）：A B C D C B A —— 去程末点 D 只出现一次，回程依次 C/B/A */
  const want = [A, B, P_C, P_D, P_C, B, A]
  assert.equal(out.length, want.length, `一趟 = ${want.length} 点（去 4 + 回 3），实际 ${out.length}`)
  for (let i = 0; i < want.length; i++) {
    near(out[i]!.latitude, want[i]!.latitude, 1e-9, `第 ${i} 点 latitude`)
    near(out[i]!.longitude, want[i]!.longitude, 1e-9, `第 ${i} 点 longitude`)
  }
  /** ⓐ 端点/接缝不重复：相邻两点**绝不重合**（否则会多出 0 m 的段） */
  for (let i = 1; i < out.length; i++) {
    assert.ok(dist(out[i - 1]!, out[i]!) > 1, `第 ${i} 段不该是 0 m`)
  }
  /** ⓒ 首末同点（回到起点）⇒ 生成器判闭合、按取模绕圈推进 */
  assert.deepEqual(out[0], out[out.length - 1], '整条展开的首末必须同点')
  /** 总弧长 = 单程 × 2 × 趟数 */
  near(polylineLengthM(out, false), SIDE * 3 * 2, 2, '一趟 = 三段 × 2')
})

test('⭐ expandFreePathTrajectory：多点折线**每一段的往返方向都真实反转**（含趟与趟的接缝）', () => {
  const out = expandFreePathTrajectory(zigzag, 2)
  // 一趟 7 点、相邻两趟接缝去掉一个重复的 A ⇒ 7 + (7 - 1) = 13 点
  assert.equal(out.length, 7 + 6, `2 趟 = 13 点，实际 ${out.length}`)
  /** 第 i 段的单位方向（局部平面近似：纬度当 y、经度按 cos 收缩当 x） */
  const dirAt = (i: number) => {
    const a = out[i]!
    const b = out[i + 1]!
    const mLng = M_PER_DEG_LAT * Math.cos((a.latitude * Math.PI) / 180)
    const dx = (b.longitude - a.longitude) * mLng
    const dy = (b.latitude - a.latitude) * M_PER_DEG_LAT
    const len = Math.hypot(dx, dy) || 1
    return { x: dx / len, y: dy / len }
  }
  /**
   * 去程的第 i 段与回程对应的那一段必须**严格反向**（点积 ≈ -1）；
   * 用"段序列"比对更直观：A→B, B→C, C→D, D→C, C→B, B→A, A→B, …
   * ⇒ 相邻两段的**方向序列**应当是 +,+,-,-,-,+,+,-,-,- …
   */
  const signs: number[] = []
  for (let i = 0; i + 1 < out.length; i++) {
    const d = dirAt(i)
    /** 用"是否沿去程方向的某一段"来定符号：与去程任何一段同向 ⇒ +1，反向 ⇒ -1 */
    const legs = [
      { a: A, b: B },
      { a: B, b: P_C },
      { a: P_C, b: P_D },
    ]
    const along = legs.some(({ a, b }) => {
      const mLng = M_PER_DEG_LAT * Math.cos((a.latitude * Math.PI) / 180)
      const lx = (b.longitude - a.longitude) * mLng
      const ly = (b.latitude - a.latitude) * M_PER_DEG_LAT
      const ll = Math.hypot(lx, ly) || 1
      return (d.x * lx) / ll + (d.y * ly) / ll > 0.99
    })
    signs.push(along ? 1 : -1)
  }
  assert.deepEqual(
    signs,
    [1, 1, 1, -1, -1, -1, 1, 1, 1, -1, -1, -1],
    `2 趟的方向序列应如上（去 3 段、回 3 段、再去 3 段、再回 3 段），实际 ${JSON.stringify(signs)}`,
  )
  near(polylineLengthM(out, false), SIDE * 3 * 2 * 2, 3, '总弧长 = 单程 × 2 × 趟数')
})

test('expandFreePathTrajectory：**相邻段方向相反** = 折返（可直接这样断言"在两端之间来回"）', () => {
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

test('expandFreePathTrajectory：极短折线也是干净的往复（不出现 0 m 的段；已如实记下 30 m 边界）', () => {
  const short: FreePathShape = { kind: 'polyline', points: [A, atM(0, 10)] }
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
  const roundPoly = parseFreePathShape(JSON.parse(JSON.stringify(zigzag)))
  assert.deepEqual(roundPoly, {
    kind: 'polyline',
    points: zigzag.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
  }, '多点折线往返后点数与坐标都不变')
})

test('⭐⭐ **向后兼容**：老 `{kind:\'line\',from,to}` 读成等价的 2 点折线（不丢数据、不抛）', () => {
  const parsed = parseFreePathShape(JSON.parse(JSON.stringify(legacyLine)))
  assert.ok(parsed, '老格式**必须**能读（不许被丢掉）')
  assert.equal(parsed!.kind, 'polyline', '读出来就是新形状（polyline）')
  assert.deepEqual(parsed, {
    kind: 'polyline',
    points: [
      { latitude: A.latitude, longitude: A.longitude },
      { latitude: B.latitude, longitude: B.longitude },
    ],
  }, '两点与老数据逐值一致（几何不变）')
  /** 几何口径一致：可用、长度、展开、趟数都与"等价的 2 点折线"逐值相同 */
  assert.equal(usableFreePathShape(parsed), true)
  near(polylineShapeLengthM(parsed), polylineShapeLengthM(lineShape), 1e-9, '长度与等价折线一致')
  assert.deepEqual(expandFreePathTrajectory(parsed, 2), expandFreePathTrajectory(lineShape, 2), '展开序列逐值一致')
  assert.equal(planFreePathTrips(parsed, 0.5).trips, planFreePathTrips(lineShape, 0.5).trips, '趟数一致')
  /** 写回一轮（= upsert 里保存的就是 parse 的结果）⇒ 存储格式迁移，几何不变 */
  const writtenBack = JSON.parse(JSON.stringify(parsed))
  assert.equal(writtenBack.kind, 'polyline')
  assert.deepEqual(parseFreePathShape(writtenBack), parsed, '读→写→再读 稳定（不丢数据、不再变形）')
  /** 老格式但不可用（两点重合/坐标坏）⇒ 仍然安全降级 */
  assert.equal(parseFreePathShape({ kind: 'line', from: A, to: { ...A } }), undefined)
  assert.equal(parseFreePathShape({ kind: 'line', from: null, to: B }), undefined)
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
  assert.match(freePathShapeText(lineShape)!, /折线型（折返）/)
  assert.match(freePathShapeText(zigzag)!, /折线型（折返）：4 个点/)
  assert.match(freePathShapeText(zigzag)!, /一来一回/)
  assert.equal(freePathPointCount(square), 4)
  assert.equal(freePathPointCount(lineShape), 2)
  assert.equal(freePathPointCount(zigzag), 4)
  /** 老格式（未过 parse）不是形状 ⇒ 读数一律 0/null（唯一入口是 parseFreePathShape） */
  assert.equal(freePathPointCount(legacyLine as unknown as FreePathShape), 0)
  assert.equal(freePathShapeText(legacyLine as unknown as FreePathShape), null)
})
