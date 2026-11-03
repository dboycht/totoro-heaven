/**
 * **「每轮换圈」纯逻辑测试**（2026-11-03，1.3.6 需求②）
 *
 * 用户口径（原话要点）：先算圈数 n（向上取整）与每圈平均用时 T，画"时间 × 道次"的图，
 * 图里**斜率均小于 1/T**；用户可拖动控制点。流程：原胚跑道 → 模拟跑道 → 最终路径 → 提交。
 *
 * 这里钉住五件事：
 *   ① n / T 的算式（含"刚好整除"不能多算一圈、非法输入不许返回 0/NaN）；
 *   ② **斜率上限 1/T 的换算**：`|Δ道次| / Δ圈 ≤ 1`，逐段校验（不是只看全局平均）；
 *   ③ 归一化不会偷偷改用户的图（只在越界时夹紧并在校验里**如实报出来**）；
 *   ④ 初始换圈图**永远达标**（每圈 ±1 道、不跑出内外圈、首点 = 预设道次）；
 *   ⑤ 生成器：换圈剖面真的让轨迹逐圈挪道，且**不制造飞点**、拟合度仍达标。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LANE_COUNT,
  DEFAULT_LANE_NO,
  MAX_LANE_CHANGE_PER_LAP,
  checkLaneProfile,
  clampLane,
  defaultLanePoints,
  laneAtU,
  laneProfileText,
  laneRatioExact,
  lanesByLap,
  lapCountForKm,
  lapSecondsForPace,
  maxSlopePerLap,
  normalizeLanePoints,
  type LanePoint,
} from '../../utils/mp/laneProfile.ts'
import { laneRatioFor, outwardNormalSign } from '../../utils/mp/trackEditor.ts'
import { generateCorridorRoute } from '../../utils/mp/generateRoute.ts'
import { distanceMeters } from '../../utils/mp/routeSimilarity.ts'

const mLat = 111320
const mLng = 111320 * Math.cos((31.99 * Math.PI) / 180)
/** 以 (31.99, 118.84) 为心的正圆（半径米） */
const circle = (radiusM: number, n = 48) =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { latitude: 31.99 + (radiusM * Math.sin(a)) / mLat, longitude: 118.84 + (radiusM * Math.cos(a)) / mLng }
  })
/** 从轨迹点量它到圆心的距离（米）——用来断言"这一圈真的在外道/内道" */
const radiusOf = (p: { latitude: number; longitude: number }) =>
  Math.hypot((p.latitude - 31.99) * mLat, (p.longitude - 118.84) * mLng)

test('lapCountForKm：向上取整；刚好整除不多算一圈；非法输入回落到 1', () => {
  assert.equal(lapCountForKm(3.2, 400), 8, '3.2 km / 400 m = 8 圈整')
  assert.equal(lapCountForKm(3.2, 390), 9, '390 m 一圈 ⇒ 8.2 圈 ⇒ 向上取整 9')
  assert.equal(lapCountForKm(0.5, 400), 2, '0.5 km 也要跑满 1.25 圈 ⇒ 2')
  assert.equal(lapCountForKm(0.1, 400), 1, '连一圈都不到 ⇒ 1（绝不返回 0）')
  assert.equal(lapCountForKm(0, 400), 1)
  assert.equal(lapCountForKm(3, 0), 1)
  assert.equal(lapCountForKm(Number.NaN, 400), 1)
  assert.equal(lapCountForKm(3, Number.NaN), 1)
})

test('lapSecondsForPace：T = 配速 × 一圈公里数；非法输入返回 0（界面据此不显示 T）', () => {
  assert.equal(lapSecondsForPace(360, 400), 144)
  assert.equal(lapSecondsForPace(330, 500), 165)
  assert.equal(lapSecondsForPace(0, 400), 0)
  assert.equal(lapSecondsForPace(360, 0), 0)
  assert.equal(lapSecondsForPace(Number.NaN, 400), 0)
})

test('laneRatioExact：整数入参与 laneRatioFor **逐位一致**；小数入参落在两道之间', () => {
  for (const n of [4, 6, 8]) {
    for (let k = 1; k <= n; k++) {
      assert.equal(laneRatioExact(k, n), laneRatioFor(k, n), `第 ${k} 道/${n} 道要一致`)
    }
  }
  assert.ok(Math.abs(laneRatioExact(2.5, 6) - (laneRatioFor(2, 6) + laneRatioFor(3, 6)) / 2) < 1e-12, '2.5 道 = 第 2、3 道正中间')
  // 夹紧：0 与 99 都落在 [1, n]
  assert.equal(laneRatioExact(0, 6), laneRatioFor(1, 6))
  assert.equal(laneRatioExact(99, 6), laneRatioFor(6, 6))
})

test('clampLane / normalizeLanePoints：夹紧 + 排序 + 首尾补齐；**不偷改用户的图**', () => {
  assert.equal(clampLane(0, 6), 1)
  assert.equal(clampLane(9, 6), 6)
  assert.equal(clampLane('3.4', 6), 3.4)
  assert.equal(clampLane(Number.NaN, 6), 1)

  const p = normalizeLanePoints(
    [
      { u: 2, lane: 2 },
      { u: 0, lane: 3 },
      { u: 1, lane: 2.5 },
    ],
    { laps: 3, baseLane: 3, laneCount: 6 },
  )
  assert.deepEqual(p, [
    { u: 0, lane: 3 },
    { u: 1, lane: 2.5 },
    { u: 2, lane: 2 },
    { u: 3, lane: 2 },
  ])

  // 首点缺 ⇒ 用 baseLane 补；尾点缺 ⇒ 沿用最后一条
  const q = normalizeLanePoints([{ u: 1, lane: 4 }], { laps: 2, baseLane: 3, laneCount: 6 })
  assert.deepEqual(q, [
    { u: 0, lane: 3 },
    { u: 1, lane: 4 },
    { u: 2, lane: 4 },
  ])

  // 坏数据一律安全降级（不抛）：非数组 / 元素是垃圾 / NaN
  assert.equal(normalizeLanePoints(null, { laps: 2, baseLane: 3, laneCount: 6 }).length, 2)
  assert.equal(normalizeLanePoints([null, 1, 'x'], { laps: 2, baseLane: 3, laneCount: 6 }).length, 2)
  assert.deepEqual(normalizeLanePoints([{ u: Number.NaN, lane: 3 }], { laps: 2, baseLane: 3, laneCount: 6 }), [
    { u: 0, lane: 3 },
    { u: 2, lane: 3 },
  ])
  // 越界的 lane **照原样夹紧**（不在这里修正斜率，交给 checkLaneProfile 如实报）；
  // 尾点会被补到 `laps`（u=1 之后补 u=2，沿用最后一条）⇒ 3 个点
  const clamped = normalizeLanePoints([{ u: 0, lane: 0 }, { u: 1, lane: 99 }], { laps: 2, baseLane: 3, laneCount: 6 })
  assert.deepEqual(clamped.map((x) => x.lane), [1, 6, 6])
  assert.deepEqual(clamped.map((x) => x.u), [0, 1, 2])
})

test('laneAtU：分段线性插值 + 端点夹紧', () => {
  const pts: LanePoint[] = [
    { u: 0, lane: 3 },
    { u: 1, lane: 2 },
    { u: 2, lane: 2 },
  ]
  assert.equal(laneAtU(pts, 0), 3)
  assert.equal(laneAtU(pts, 0.5), 2.5)
  assert.equal(laneAtU(pts, 1), 2)
  assert.equal(laneAtU(pts, 1.5), 2)
  assert.equal(laneAtU(pts, -5), 3, '越界按端点（不抛）')
  assert.equal(laneAtU(pts, 99), 2)
  assert.equal(laneAtU([], 1), 1, '空剖面 ⇒ 1（不返回 NaN）')
})

test('maxSlopePerLap / checkLaneProfile：**逐段**校验"斜率 < 1/T"', () => {
  const ok = { points: [{ u: 0, lane: 3 }, { u: 1, lane: 2 }, { u: 2, lane: 3 }], laps: 2, laneCount: 6, baseLane: 3 }
  assert.equal(maxSlopePerLap(ok.points), 1)
  assert.equal(checkLaneProfile(ok, 144).ok, true)

  // 一圈换 2 条道 ⇒ 超限，且要说清"第几圈~第几圈、换了几条"
  const bad = { points: [{ u: 0, lane: 4 }, { u: 1, lane: 2 }], laps: 2, laneCount: 6, baseLane: 4 }
  const r = checkLaneProfile(bad, 144)
  assert.equal(r.ok, false)
  assert.equal(r.maxSlope, 2)
  assert.match(r.problems.join('；'), /第 0~1 圈/)
  assert.match(r.problems.join('；'), /上限是每圈 1 条/)

  // 🔴 逐段：中间猛换一次、首尾抵消（全局平均看起来没问题）必须被抓到
  const spike = { points: [{ u: 0, lane: 3 }, { u: 1, lane: 1 }, { u: 2, lane: 3 }], laps: 2, laneCount: 6, baseLane: 3 }
  assert.equal(checkLaneProfile(spike, 144).ok, false, '首尾都是第 3 道，但中间那一段换了 2 条')

  // 越界要在 problems 里如实说（用户会看到"已夹到第 1~N 道之间"）
  const outside = { points: [{ u: 0, lane: 0 }, { u: 1, lane: 9 }], laps: 1, laneCount: 6, baseLane: 3 }
  assert.match(checkLaneProfile(outside, 144).problems.join('；'), /落在跑道外/)
})

test('defaultLanePoints：初始图**永远达标**（±1 道/圈、不越界、首点=预设道次）', () => {
  for (const seed of [1, 2, 20261103, 987654]) {
    for (const laneCount of [4, 6, 8]) {
      const pts = defaultLanePoints({ laps: 9, laneCount, baseLane: 3 }, seed)
      assert.equal(pts.length, 10, '每个整圈边界一个控制点')
      assert.equal(pts[0]!.lane, 3, 'y0 = 预设道次')
      for (let i = 1; i < pts.length; i++) {
        assert.equal(pts[i]!.u, i)
        assert.ok(Math.abs(pts[i]!.lane - pts[i - 1]!.lane) <= MAX_LANE_CHANGE_PER_LAP + 1e-9, `第 ${i} 圈换道超限：${JSON.stringify(pts)}`)
        assert.ok(pts[i]!.lane >= 1 && pts[i]!.lane <= laneCount, `第 ${i} 圈跑出道次范围：${pts[i]!.lane}`)
      }
      assert.equal(checkLaneProfile({ points: pts, laps: 9, laneCount, baseLane: 3 }, 144).ok, true)
    }
  }
  // 同一个 seed 可复现
  assert.deepEqual(defaultLanePoints({ laps: 5, laneCount: 6, baseLane: 3 }, 42), defaultLanePoints({ laps: 5, laneCount: 6, baseLane: 3 }, 42))
  // 贴边时不会"卡死在外道"（随机游走要能折返）
  const long = defaultLanePoints({ laps: 60, laneCount: 6, baseLane: 6 }, 7)
  assert.ok(long.some((p) => p.lane < 6), `贴外道起步也要能往内跑：${JSON.stringify(long.slice(0, 20))}`)
})

test('lanesByLap / laneProfileText：逐圈读数与"界面那句话"同一基准', () => {
  /**
   * ⚠️ `lanesByLap` 返回的是**精确值（可含小数）** —— 换道过渡期间人确实在两道之间
   * （四舍五入会掩盖"这一圈其实正在换道"）。要"整道"的说法用 `laneProfileText`（它才取整）。
   */
  const ramp: LanePoint[] = [
    { u: 0, lane: 3 },
    { u: 2, lane: 2 },
    { u: 4, lane: 4 },
  ]
  const exact = lanesByLap(ramp, 4, 6)
  // 各圈中点 u = 0.5 / 1.5 / 2.5 / 3.5 处的插值：2.75 / 2.25 / 2.5 / 3.5
  assert.deepEqual(exact, [2.75, 2.25, 2.5, 3.5])
  // 界面那句话取整（2.75→3、2.25→2、2.5→3、3.5→4）
  assert.equal(laneProfileText(ramp, 4, 6), '第 1 圈 第 3 道 · 第 2 圈 第 2 道 · 第 3 圈 第 3 道 · 第 4 圈 第 4 道')

  // 干净的一段（整圈都在同一道）⇒ 相邻同道的圈合并成区间
  const step: LanePoint[] = [
    { u: 0, lane: 3 },
    { u: 1, lane: 2 },
  ]
  assert.equal(laneProfileText(step, 2, 6), '第 1 圈 第 3 道 · 第 2 圈 第 2 道')
  assert.deepEqual(lanesByLap(step, 2, 6), [2.5, 2], '第 1 圈中点正好在两道之间 ⇒ 如实给 2.5')

  assert.equal(DEFAULT_LANE_COUNT, 6)
  assert.equal(DEFAULT_LANE_NO, 3)
})

// ---------------------------------------------------------------- 生成器：换圈剖面真的生效
const RINGS = { outer: circle(100), inner: circle(90) }
/** 环宽（米）——与 `trackEditor.ringWidthM` 同口径（这里用理想正圆，直接 10 m） */
const WIDTH_M = 10
/** 第 k 道的比例（6 道） */
const ratio = (lane: number) => laneRatioExact(lane, 6)
/** 环宽与法向朝向都由几何算（与跑步引擎同一套调用；**不许在测试里写死 ±1**） */
const normalSign = outwardNormalSign(circle(90 + ratio(3) * WIDTH_M), RINGS)

test('outwardNormalSign：**同一圈**反过来描 ⇒ 法向朝向必须相反（换圈方向不许靠约定猜）', () => {
  const ccw = circle(90 + ratio(3) * WIDTH_M)
  const cw = [...ccw].reverse()
  assert.equal(outwardNormalSign(ccw, RINGS), -1, '逆时针描（从东往北）⇒ 右法向朝内')
  assert.equal(outwardNormalSign(cw, RINGS), 1, '顺时针描 ⇒ 右法向朝外')
  // 退化输入不许返回 0（会让偏移恒为 0，换圈静默失效）
  assert.equal(outwardNormalSign([], RINGS), 1)
  assert.equal(outwardNormalSign(ccw, { outer: [], inner: [] }), 1)
})

test('生成器（换圈）：轨迹**逐圈挪道**，且每圈平均半径与该圈道次一致', () => {
  const baseLane = 3
  /** 基准道那条车道线（半径 = 内圈 90 + 比例 × 10） */
  const baseLaneLine = circle(90 + ratio(baseLane) * WIDTH_M)
  // 8 圈：前 4 圈第 3 道 → 后 4 圈第 1 道（每圈最多 1 道 ⇒ 用两个中间点过渡到 1 道不可能，
  // 所以改成 3 → 2 → 1，各停 2~3 圈）
  const points: LanePoint[] = [
    { u: 0, lane: 3 },
    { u: 2, lane: 2 },
    { u: 4, lane: 1 },
    { u: 8, lane: 1 },
  ]
  const gen = generateCorridorRoute(baseLaneLine, {
    targetKm: (baseLaneLine.length ? 3.2 : 3.2),
    stepM: 3,
    drift: true,
    seed: 12345,
    smoothRoute: 0,
    lanePlan: { laneCount: 6, baseLane, points, ringWidthM: WIDTH_M, transitionM: 18, normalSign },
  })
  /** 剖面本身：逐圈中点往外/往内的进度（用于说明"图里是怎么走的"） */
  const laneExact = lanesByLap(points, 8, 6)
  assert.ok(laneExact[0]! > laneExact[3]! && laneExact[3]! > laneExact[7]!, `图里应逐圈靠内：${laneExact}`)

  // 按"一圈多长"把点分到各圈，量每圈平均半径
  const lapM = gen.lapLengthM
  assert.ok(lapM > 0)
  const radii: number[][] = Array.from({ length: 8 }, () => [])
  let acc = 0
  let prev = gen.points[0]!
  for (const p of gen.points) {
    acc += distanceMeters(Number(prev.latitude), Number(prev.longitude), Number(p.latitude), Number(p.longitude))
    prev = p
    const lap = Math.min(7, Math.floor(acc / lapM))
    radii[lap]!.push(radiusOf({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const lapMeans = radii.map((xs) => (xs.length ? mean(xs) : 0))
  const expect = (lane: number) => 90 + ((lane - 0.5) / 6) * WIDTH_M
  // 第 1 圈 ~ 第 3 道；第 3 圈 ~ 第 2 道；第 5 圈 ~ 第 1 道（留 1.5 m 容差给抖动与法向近似）
  assert.ok(Math.abs(lapMeans[0]! - expect(3)) < 1.5, `第 1 圈应约 ${expect(3).toFixed(1)} m，实测 ${lapMeans[0]!.toFixed(1)}`)
  assert.ok(Math.abs(lapMeans[2]! - expect(2)) < 1.5, `第 3 圈应约 ${expect(2).toFixed(1)} m，实测 ${lapMeans[2]!.toFixed(1)}`)
  assert.ok(Math.abs(lapMeans[4]! - expect(1)) < 1.5, `第 5 圈应约 ${expect(1).toFixed(1)} m，实测 ${lapMeans[4]!.toFixed(1)}`)
  // 且逐圈是**单调向内**的（3→2→1 道）
  assert.ok(lapMeans[0]! > lapMeans[3]! && lapMeans[3]! > lapMeans[5]!, `逐圈应越来越靠内：${lapMeans.map((x) => x.toFixed(1))}`)
  // 换圈模式：不报漂移期（那是"左右抖动"，已被换圈接管），逐圈偏移按**朝外米数**报出来
  assert.equal(gen.driftEpisodes, 0)
  // 3.2 km ÷ 一圈 590.6 m ⇒ 实际跑到第 6 圈（剖面配到第 8 圈，超出本次的部分用不到）
  assert.ok(gen.lapDriftM.length >= 5, `逐圈偏移条数 ${gen.lapDriftM.length}`)
  // 3 道 → 1 道 ⇒ 每一圈都是"偏内"（负数），且越来越内（单调递减）
  assert.ok(
    gen.lapDriftM.every((v) => v <= 0),
    `全程向内侧移动 ⇒ 每圈都该是负数（正 = 偏外）：${JSON.stringify(gen.lapDriftM)}`,
  )
  assert.ok(
    gen.lapDriftM[0]! > gen.lapDriftM[gen.lapDriftM.length - 1]!,
    `越跑越靠内：${JSON.stringify(gen.lapDriftM)}`,
  )
  assert.ok(Math.abs(gen.lapDriftM[gen.lapDriftM.length - 1]! - -3.33) < 0.6, `最后应约 -3.3 m（3 道→1 道）：${gen.lapDriftM.at(-1)}`)
})

test('生成器（换圈）：不制造飞点（逐点位移 < 12 m/s 的上限量级），拟合度仍达标', () => {
  const baseLane = 3
  const baseLaneLine = circle(90 + ratio(baseLane) * WIDTH_M)
  const points = defaultLanePoints({ laps: 8, laneCount: 6, baseLane }, 20261103)
  const gen = generateCorridorRoute(baseLaneLine, {
    targetKm: 3.2,
    stepM: 3,
    drift: true,
    seed: 777,
    smoothRoute: 0,
    lanePlan: { laneCount: 6, baseLane, points, ringWidthM: WIDTH_M, normalSign },
  })
  let worst = 0
  for (let i = 1; i < gen.points.length; i++) {
    const a = gen.points[i - 1]!
    const b = gen.points[i]!
    worst = Math.max(worst, distanceMeters(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude)))
  }
  // 3 m 步长 + 0.6 m 级抖动 ⇒ 正常应在 3~6 m；>9 m 就说明换道把点甩出去了
  assert.ok(worst < 9, `相邻点最大位移 ${worst.toFixed(2)} m（换道不该制造飞点）`)
  // 拟合度按**原始路线**算（这里路线就是基准道圈），换道只挪几米 ⇒ 仍应高
  assert.ok(Number(gen.fitDegree) >= 0.9, `拟合度 ${gen.fitDegree}（换道幅度只有几米，不该掉）`)
})

test('生成器：**jitterSigmaM 越大，逐点越抖**（GPS 抖动度滑杆之所以有意义）', () => {
  /**
   * 用户口径："增加新的操作变量，用户当然可以设置相关 **GPS 抖动度**"（滑杆 0~2 m，步长 0.1）。
   * 判据：同一条几何、同一个 seed，只改 σ ⇒ 逐点半径的**粗糙度**（相对该圈均值的平均绝对偏差）必须单调变大。
   * ⚠️ 这条必须钉在**生成器**这一层：浏览器里两次跑之间差得太少、且会被换道本身淹没。
   */
  const baseLine = circle(95)
  /** 一圈内逐点半径相对中位半径的平均绝对偏差（越小越平滑） */
  const roughness = (pts: { latitude: string; longitude: string }[]) => {
    const rs = pts.map((p) => radiusOf({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
    const sorted = [...rs].sort((a, b) => a - b)
    const med = sorted[Math.floor(sorted.length / 2)]!
    return rs.reduce((s, r) => s + Math.abs(r - med), 0) / Math.max(1, rs.length)
  }
  const at = (sigma: number) =>
    roughness(
      generateCorridorRoute(baseLine, { targetKm: 0.8, stepM: 3, drift: false, seed: 4242, smoothRoute: 0, jitterSigmaM: sigma })
        .points,
    )
  const r0 = at(0)
  const r06 = at(0.6)
  const r2 = at(2)
  assert.ok(r06 > r0, `σ=0.6 应比 σ=0 抖：${r0.toFixed(3)} → ${r06.toFixed(3)}`)
  assert.ok(r2 > r06, `σ=2 应比 σ=0.6 抖：${r06.toFixed(3)} → ${r2.toFixed(3)}`)
})

test('生成器（不传 lanePlan）：横向行为**逐字保持旧口径**（回归保证）', () => {
  const baseLaneLine = circle(95)
  const a = generateCorridorRoute(baseLaneLine, { targetKm: 0.8, stepM: 3, drift: true, seed: 99, smoothRoute: 0 })
  const b = generateCorridorRoute(baseLaneLine, { targetKm: 0.8, stepM: 3, drift: true, seed: 99, smoothRoute: 0 })
  assert.deepEqual(a.points, b.points, '同一 seed 必须逐点一致')
  assert.ok(a.driftEpisodes > 0, '没给剖面时仍走旧的"精度下降期"逻辑')
  assert.deepEqual(a.lapDriftM, b.lapDriftM)
})
