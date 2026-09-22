/**
 * 「非官方路径」几何装配的单测（2026-09-22，审计 B1/B2/B3 的回归钉子）
 *
 * 这一层是**跑步引擎与跑道编辑页预览共用的唯一入口**（`utils/mp/freePathGeometry.ts`），
 * 所以审计里三条"几何/圈数/旧版兼容"的问题都在这里钉死：
 *
 *   · **B1**：带 `start.offsetM > 0` 时，几何**必须**保持"用户画的那条线"——
 *     老 `applyStartToLoop`（按弧长均匀重采样）会把手点的 3~8 点几何弦切掉
 *     （实测三角形偏离 48 m、总长掉到 1096.7 m）；新入口用**保点旋转**，偏离 0、总长不变。
 *   · **B2**：几何**只展开 1 趟** ⇒ 生成器算出的 `lapLengthM` 恰好等于"画的一圈/一来一回"，
 *     跑步页的圈数才与编辑器一致（原先展开多趟 ⇒ 跑步页圈数差倍数）。
 *   · **B3**：占位几何**≥3 点**（旧版本按"内外圈各 ≥3 点"判合法，2 点会让旧版把整条记录连形状一起删掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FREE_PATH_GEOMETRY_TRIPS,
  freePathLapLengthM,
  geometryLengthM,
  resolveFreePathGeometry,
} from '../../utils/mp/freePathGeometry.ts'
import {
  curveLengthM,
  freePathPoints,
  freeShapePlaceholderRing,
  lineLengthM,
  planFreePathTrips,
  type FreePathShape,
} from '../../utils/mp/pathShape.ts'
import {
  applyStartToLoop,
  applyStartToLoopKeepingVertices,
  rotateLoopKeepingVertices,
} from '../../utils/mp/trackEditor.ts'
import { distanceMeters, pointToSegmentDistance } from '../../utils/mp/routeSimilarity.ts'
import { generateCorridorRoute } from '../../utils/mp/generateRoute.ts'
import { hasValidRings } from '../../utils/mp/trackLibrary.ts'

const M_PER_DEG_LAT = 111320
const ORIGIN = { latitude: 31.37, longitude: 119.48 }
const atM = (east: number, north: number) => ({
  latitude: ORIGIN.latitude + north / M_PER_DEG_LAT,
  longitude: ORIGIN.longitude + east / (M_PER_DEG_LAT * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
})

/** 审计用的那个三角形：3 点、周长 ≈ 900 m（两趟展开 ≈ 1800 m） */
const TRIANGLE: FreePathShape = {
  kind: 'curve',
  points: [atM(0, 0), atM(400, 0), atM(200, 350)],
}
/** 四边形（周长 ≈ 984 m），审计里的第二个例子 */
const QUAD: FreePathShape = {
  kind: 'curve',
  points: [atM(0, 0), atM(300, 0), atM(300, 200), atM(0, 200)],
}
const LINE: FreePathShape = { kind: 'line', from: atM(0, 0), to: atM(0, 300) }

/**
 * **"用户画的圈"到几何的最大偏离（米）**—— B1 的核心判据。
 *
 * ⚠️ 必须是这个方向（**用户几何 → 生成几何**），不能反过来只量"生成点 → 用户圈"：
 *    被弦切掉的几何，它的点**全都还在用户那条线上**（弧长采样点当然在线上）⇒ 反方向量出来是 0，
 *    照样"通过"。会露馅的是**用户画的那个折角离生成折线有多远**。
 * 判据：沿用户圈**密集采样**（顶点 + 每段 1/10、5/10、9/10 处），逐点量到生成折线的最近距离，取最大。
 */
const maxDeviationFromUserRing = (
  geometry: { latitude: number | string; longitude: number | string }[],
  ring: FreePathShape,
): number => {
  const user = freePathPoints(ring).map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  const gen = geometry.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  if (gen.length < 2) return Number.POSITIVE_INFINITY
  const distToPolyline = (p: { latitude: number; longitude: number }): number => {
    let best = Number.POSITIVE_INFINITY
    // ⚠️ 两边都按**闭合环**处理：圈型的占位几何存的是顶点（不重复收盘点），
    //    旧版本与预览都把它当闭合环画/插值 ⇒ 收尾那一段也必须算进去，
    //    否则"第三条边"上的采样点会被误判成偏离一百多米。
    for (let i = 0; i < gen.length; i++) {
      const a = gen[i]!
      const b = gen[(i + 1) % gen.length]!
      const d = pointToSegmentDistance(p.latitude, p.longitude, a.latitude, a.longitude, b.latitude, b.longitude)
      if (d < best) best = d
    }
    return best
  }
  let worst = 0
  for (let i = 0; i < user.length; i++) {
    const a = user[i]!
    const b = user[(i + 1) % user.length]!
    for (const t of [0, 0.1, 0.5, 0.9]) {
      const p = { latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t }
      const d = distToPolyline(p)
      if (d > worst) worst = d
    }
  }
  return worst
}

// ---------------------------------------------------------------- B1：起跑点不得改掉用户画的形状

test('B1：老 `applyStartToLoop` 确实会毁掉手点几何（**反向证据**，说明这次为什么要新增函数）', () => {
  const expanded = resolveFreePathGeometry(TRIANGLE)!.geometry
  const total0 = geometryLengthM(expanded)
  const broken = applyStartToLoop(expanded, { offsetM: 25, direction: 'forward' })
  const brokenTotal = geometryLengthM(broken)
  const brokenDev = maxDeviationFromUserRing(broken, TRIANGLE)
  // 审计实测：偏离 ~48 m、总长 1800.7 → 1096.7
  assert.ok(brokenDev > 5, `老实现必须表现出"弦切偏离"（实测 ${brokenDev.toFixed(2)} m）`)
  assert.ok(brokenTotal < total0 * 0.8, `老实现总长会明显掉（${total0.toFixed(1)} → ${brokenTotal.toFixed(1)} m）`)
})

test('B1：新入口（保点旋转）⇒ `offsetM > 0` 时**总长不变、逐点仍在用户画的线上**', () => {
  for (const shape of [TRIANGLE, QUAD]) {
    const before = resolveFreePathGeometry(shape)!.geometry
    const totalBefore = geometryLengthM(before)
    for (const offsetM of [1, 25, 120, 400, 99999]) {
      const after = resolveFreePathGeometry(shape, { offsetM, direction: 'forward' })!.geometry
      const totalAfter = geometryLengthM(after)
      const dev = maxDeviationFromUserRing(after, shape)
      assert.ok(
        Math.abs(totalAfter - totalBefore) <= Math.max(1e-6, totalBefore * 1e-6),
        `offsetM=${offsetM}：总长必须不变（${totalBefore.toFixed(3)} vs ${totalAfter.toFixed(3)}）`,
      )
      assert.ok(dev < 0.05, `offsetM=${offsetM}：最大偏离必须 ≈ 0（实测 ${dev.toFixed(3)} m）`)
      assert.deepEqual(after[0], after[after.length - 1], `offsetM=${offsetM}：圈型展开后仍须首尾同点（生成器判闭合）`)
    }
  }
})

test('B1：保点旋转把"第 0 点"真的挪到指定弧长处，且**保留全部顶点**（点数 +1）', () => {
  const ring = freePathPoints(TRIANGLE).map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  const closed = [...ring, ring[0]!]
  const out = rotateLoopKeepingVertices(closed, 25)
  assert.equal(out.length, closed.length + 1, '只插入一个点（外加末尾补回首点）')
  /**
   * 第 0 点必须落在第一段上、且**沿弧长的偏移 ≈ 25 m**。
   * ⚠️ 不能拿"按度数线性插值"去比（实测差几十厘米就假红）：haversine 弧长与经纬度**不是线性关系**
   *    （同一纬线上的两点尤其明显），所以这里比"弧长"和"在不在线上"，不比度数。
   */
  const headRaw = out[0]!
  const head = { latitude: Number(headRaw.latitude), longitude: Number(headRaw.longitude) }
  assert.ok(pointToSegmentDistance(head.latitude, head.longitude, ring[0]!.latitude, ring[0]!.longitude, ring[1]!.latitude, ring[1]!.longitude) < 0.05, '第 0 点必须在第一段上')
  const arcFromStart = distanceMeters(ring[0]!.latitude, ring[0]!.longitude, head.latitude, head.longitude)
  assert.ok(Math.abs(arcFromStart - 25) < 0.05, `沿弧长偏移必须 ≈ 25 m（实测 ${arcFromStart.toFixed(3)}）`)
  // 每个原始顶点都还在（保点）
  for (const p of ring) {
    assert.ok(
      out.some((q) => Math.abs(Number(q.latitude) - p.latitude) < 1e-12 && Math.abs(Number(q.longitude) - p.longitude) < 1e-12),
      `原顶点必须保留：${JSON.stringify(p)}`,
    )
  }
})

test('B1：保点旋转的兜底 —— 退化/非法输入原样返回（不抛、不改几何）', () => {
  const few = [{ latitude: 1, longitude: 2 }, { latitude: 1.1, longitude: 2 }]
  assert.deepEqual(rotateLoopKeepingVertices(few, 10), few.map((p) => ({ ...p })), '点数不足 ⇒ 原样')
  const ring = freePathPoints(TRIANGLE)
  assert.deepEqual(applyStartToLoopKeepingVertices(ring, null), ring.map((p) => ({ ...p })), '没设起跑点 ⇒ 原样（回归保证）')
  assert.deepEqual(applyStartToLoopKeepingVertices(ring, { offsetM: 0, direction: 'forward' }), ring.map((p) => ({ ...p })), 'offsetM=0 ⇒ 原样')
  // 反向：几何必须与正向"同一条线"（只是顺序相反），总长不变
  const fwd = applyStartToLoopKeepingVertices(ring, { offsetM: 25, direction: 'forward' })
  const rev = applyStartToLoopKeepingVertices(ring, { offsetM: 25, direction: 'reverse' })
  assert.equal(fwd.length, rev.length)
  assert.ok(Math.abs(geometryLengthM(fwd) - geometryLengthM(rev)) < 1e-6, '反向不改变总长')
  assert.deepEqual(fwd[0], rev[0], '起跑点相同（反向只改后续顺序）')
})

// ---------------------------------------------------------------- B2：圈数与跑步页同源

test('B2：几何只展开 1 趟（`FREE_PATH_GEOMETRY_TRIPS === 1`）', () => {
  assert.equal(FREE_PATH_GEOMETRY_TRIPS, 1)
  const curveGeom = resolveFreePathGeometry(QUAD)!.geometry
  assert.equal(curveGeom.length, freePathPoints(QUAD).length + 1, '圈型 = 顶点 + 收尾点（不是 N 趟重复）')
  assert.equal(resolveFreePathGeometry(LINE)!.geometry.length, 3, '直线型 = A→B→A（一趟 = 一来一回）')
})

test('B2：生成器算出的 `lapLengthM` == 界面报的"一圈/一来一回"（编辑器与跑步页同口径）', () => {
  for (const shape of [TRIANGLE, QUAD, LINE]) {
    const resolved = resolveFreePathGeometry(shape)!
    const plan = planFreePathTrips(shape, 1)
    assert.ok(Math.abs(resolved.lapLengthM - plan.perTripM) < 1e-6, '装配结果里的圈长 = plan.perTripM')
    assert.ok(Math.abs(freePathLapLengthM(shape) - plan.perTripM) < 1e-6)
    const g = generateCorridorRoute(resolved.geometry, { targetKm: 3.2, stepM: 3, drift: true, seed: 20260922, smoothRoute: 0 })
    // 生成器内部（toFixed(1) 后）报的"一圈"必须与界面同一口径（允许 0.05 m 的取整误差）
    assert.ok(
      Math.abs(g.lapLengthM - plan.perTripM) < 0.06,
      `${shape.kind}：生成器 lapLengthM=${g.lapLengthM} vs 界面一圈=${plan.perTripM.toFixed(1)}`,
    )
    // 里程照旧跑满（几何只有 1 趟也不会少跑：生成器自己会一直绕）
    assert.ok(Number(g.km) >= 3.2 * (1 - 1e-3), `${shape.kind}：km=${g.km} 必须 ≈ 目标 3.2`)
    assert.ok(Number(g.km) <= 3.2 * 1.2, `${shape.kind}：km=${g.km} 不该超出太多`)
  }
})

test('B2：直线型 1 趟几何仍能跑出"来回"（相邻段方向相反）', () => {
  const a = freePathPoints(LINE)[0]!
  const b = freePathPoints(LINE)[1]!
  const geom = resolveFreePathGeometry(LINE)!.geometry.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  assert.equal(geom.length, 3)
  const dirAt = (i: number) => {
    const p = geom[i]!
    const q = geom[i + 1]!
    const mLng = M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180)
    const dx = (q.longitude - p.longitude) * mLng
    const dy = (q.latitude - p.latitude) * M_PER_DEG_LAT
    const len = Math.hypot(dx, dy) || 1
    return { x: dx / len, y: dy / len }
  }
  const d0 = dirAt(0)
  const d1 = dirAt(1)
  assert.ok(d0.x * d1.x + d0.y * d1.y < -0.99, '第 1 段与第 2 段必须反向（折返）')
  assert.ok(lineLengthM(LINE) > 0 && curveLengthM(TRIANGLE, true) > 0, '长度读数健全')
  assert.ok(distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude) > 0)
})

// ---------------------------------------------------------------- B3：占位几何 ≥3 点（旧版本才丢不了数据）

test('B3：占位几何 ≥3 点，且每个点都落在原形状上（旧版按"内外圈各 ≥3 点"判合法）', () => {
  const cases: FreePathShape[] = [
    LINE,
    TRIANGLE,
    QUAD,
    // 2 点的"圈型"（= 一条往返线）：也必须补到 3 点
    { kind: 'curve', points: [atM(0, 0), atM(0, 200)] },
  ]
  for (const shape of cases) {
    const placeholder = freeShapePlaceholderRing(shape)
    assert.ok(placeholder.length >= 3, `${shape.kind}：占位几何必须 ≥3 点（实际 ${placeholder.length}）`)
    for (const p of placeholder) {
      assert.equal(typeof p.latitude, 'number', '坐标必须是 number')
      assert.equal(typeof p.longitude, 'number')
    }
    // 旧口径的合法性判据（1.2.4 及更早版本用的就是它）必须放行
    assert.equal(
      hasValidRings({ outer: placeholder, inner: placeholder }),
      true,
      `${shape.kind}：旧版 hasValidRings 必须收下这条记录（否则它会连 freeShape 一起写没）`,
    )
    // 点必须落在原形状上（不能凭空造出一条离谱的几何给旧版画）
    const dev = shape.kind === 'line' ? maxDeviationFromUserRing(placeholder, { kind: 'curve', points: [shape.from, shape.to] }) : maxDeviationFromUserRing(placeholder, shape)
    assert.ok(dev < 0.05, `${shape.kind}：占位点必须落在原形状上（偏离 ${dev.toFixed(3)} m）`)
  }
})

test('B3：形状不可用 ⇒ 占位几何为空（调用方会如实报错，不伪造几何）', () => {
  assert.deepEqual(freeShapePlaceholderRing({ kind: 'line', from: atM(0, 0), to: atM(0, 0) }), [])
  assert.deepEqual(freeShapePlaceholderRing({ kind: 'curve', points: [atM(0, 0)] }), [])
  assert.deepEqual(freeShapePlaceholderRing(null), [])
  assert.deepEqual(freeShapePlaceholderRing(undefined), [])
})

test('resolveFreePathGeometry：形状不可用 ⇒ null（调用方按"没有几何"处理，绝不伪造）', () => {
  assert.equal(resolveFreePathGeometry(null), null)
  assert.equal(resolveFreePathGeometry(undefined), null)
  assert.equal(resolveFreePathGeometry({ kind: 'curve', points: [{ ...atM(0, 0) }] }), null)
  assert.equal(resolveFreePathGeometry({ kind: 'line', from: atM(0, 0), to: atM(0, 0) }), null)
})
