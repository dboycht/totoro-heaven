/**
 * 轨迹生成 + 数据自洽测试
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateCorridorRoute, buildTimeline } from '../../utils/mp/generateRoute.ts'
import { calculateRouteSimilarity, pathLengthMeters, distanceMeters } from '../../utils/mp/routeSimilarity.ts'
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

test('generateCorridorRoute：drift 开启后拟合度仍落进 0.97~1.00（2026-09-17 用户改口径）', () => {
  const route = loopRoute()
  const scores = [7, 11, 42, 2026, 20260914].map((seed) => {
    const g = generateCorridorRoute(route, { targetKm: 0.6, seed, drift: true })
    assert.ok(g.driftEpisodes > 0, `seed=${seed} 应至少产生一次精度下降期`)
    const pts = g.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
    return calculateRouteSimilarity(route, pts)
  })
  for (const [i, score] of scores.entries()) {
    // 2026-09-17 口径变更：**拟合度容差是 25 m** ⇒ 想把拟合度压到 0.8x 就必须偏离路线 25 m+（甩出跑道）。
    // 用户拍板"优先看起来在跑道上、接受更高的拟合度"；且本账号 2025 学年真跑记录大多就是 1.00/0.99。
    assert.ok(score >= 0.97, `第 ${i} 个种子的拟合度 ${score} 低于控幅下限 0.97`)
    assert.ok(score <= 1.0, `第 ${i} 个种子的拟合度 ${score} 超出上限 1.00`)
  }
})

/** 点到折线的最短距离（米）——用等距近似（小范围足够精确） */
const distToPolylineM = (p: { latitude: number; longitude: number }, poly: { latitude: number; longitude: number }[]) => {
  let best = Number.POSITIVE_INFINITY
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!
    const b = poly[i]!
    const refLat = ((a.latitude + b.latitude) / 2) * (Math.PI / 180)
    const mPerDegLat = 111320
    const mPerDegLng = 111320 * Math.cos(refLat)
    const ax = a.longitude * mPerDegLng
    const ay = a.latitude * mPerDegLat
    const bx = b.longitude * mPerDegLng
    const by = b.latitude * mPerDegLat
    const px = p.longitude * mPerDegLng
    const py = p.latitude * mPerDegLat
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const qx = ax + t * dx
    const qy = ay + t * dy
    best = Math.min(best, Math.hypot(px - qx, py - qy))
  }
  return best
}

/** 语义别名：到"闭合路线"的最短距离（实现同 `distToPolylineM`，只是读起来更贴合闭环绕圈场景） */
const distToLoopM = distToPolylineM

test('★ generateCorridorRoute：**直道必须是直的**（段内横向偏移近似恒定）—— 2026-09-17 用户要求', () => {
  // 夹具是 100 m 的正方形环：四条边都是**纯直道**，最适合验证"直道不抖"。
  const route = loopRoute()
  for (const seed of [7, 42, 20260914]) {
    const g = generateCorridorRoute(route, { targetKm: 0.8, stepM: 3, seed, drift: true })
    const pts = g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
    // 取第一条边（route[0]→route[1]）：收集"走在这条边上"的轨迹点（投影参数 t∈[0.15,0.85] 且离边 <15 m）
    const A = route[0]!
    const B = route[1]!
    const mLat = 111320
    const mLng = 111320 * Math.cos((((A.latitude + B.latitude) / 2) * Math.PI) / 180)
    const ax = A.longitude * mLng, ay = A.latitude * mLat
    const bx = B.longitude * mLng, by = B.latitude * mLat
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const lat: number[] = []
    for (const p of pts) {
      const px = p.longitude * mLng, py = p.latitude * mLat
      const t = ((px - ax) * dx + (py - ay) * dy) / len2
      if (t < 0.15 || t > 0.85) continue
      const qx = ax + t * dx, qy = ay + t * dy
      const d = Math.hypot(px - qx, py - qy)
      if (d < 15) lat.push(d)
    }
    assert.ok(lat.length > 10, `seed=${seed} 落在第一条边上的点太少（${lat.length}）`)
    const spread = Math.max(...lat) - Math.min(...lat)
    // 判据：直道段内横向偏移基本恒定 ⇒ 轨迹与官方直道**平行** ⇒ 看起来"跑得直"。
    // 1.5 m ≈ 一条跑道宽的 1/8（地图上不到 1 像素）；旧算法在这里是 2~3 m 的"波浪"，
    // 正是用户说的"左右抖动太假、直道不直"。
    assert.ok(spread <= 1.5, `seed=${seed} 直道段内横向偏移波动 ${spread.toFixed(2)} m（>1.5 m 看起来就不直）`)
  }
})

test('★ generateCorridorRoute：轨迹必须**留在路线上**（单点偏离 ≤ 10 m）—— "在跑道上"的回归守卫', () => {
  const route = loopRoute()
  for (const seed of [7, 11, 42, 2026, 20260914]) {
    const g = generateCorridorRoute(route, { targetKm: 0.6, stepM: 3, seed, drift: true })
    const pts = g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
    const devs = pts.map((p) => distToPolylineM(p, route))
    const worst = Math.max(...devs)
    const p95 = devs.slice().sort((x, y) => x - y)[Math.floor(devs.length * 0.95)]!
    // 判据来源（2026-09-17 实测）：旧算法最大偏离 46~77 m ⇒ 手机上能看出"甩出跑道、一眼假"。
    // 现在 (a) 偏移向量按 MAX_OFF_ROUTE_M=6 截断、(b) 圆角、(c) 抖动按弧长锁定 ⇒ 应稳定在个位数米。
    assert.ok(worst <= 10, `seed=${seed} 最大偏离 ${worst.toFixed(1)} m（>10 m 就会看起来不在跑道上）`)
    assert.ok(p95 <= 8, `seed=${seed} P95 偏离 ${p95.toFixed(1)} m（>8 m 偏松）`)
  }
})

test('generateCorridorRoute：drift 不产生飞点（逐点速度 < 12 m/s）', () => {
  const route = loopRoute()
  for (const seed of [7, 42, 20260914]) {
    // 真实模式口径：步长 3m ≈ 1Hz（3 m/s），因此每点间隔 1 秒
    const g = generateCorridorRoute(route, { targetKm: 0.6, stepM: 3, seed, drift: true })
    const pts = g.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))
    const totalSeconds = (Number(g.km) * 1000) / 3
    const timeline = buildTimeline(pts.length, totalSeconds)
    assert.deepEqual(findSpeedOutliers(pts, timeline), [], `seed=${seed} 出现飞点`)
  }
})

test('generateCorridorRoute：drift 下里程仍贴合目标（±5%）', () => {
  const route = loopRoute()
  for (const seed of [3, 42, 777]) {
    const g = generateCorridorRoute(route, { targetKm: 1, stepM: 3, seed, drift: true })
    const actual = Number(g.km)
    assert.ok(Math.abs(actual - 1) / 1 < 0.05, `seed=${seed} 实际 ${actual} km`)
  }
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

test('★ generateCorridorRoute：**多圈不许完全重合**（用户 2026-09-18：8 圈落在同一个圈上）', () => {
  // 夹具周长 400 m，目标 3.2 km ⇒ 恰好 8 圈（与用户实跑同量级）
  const route = loopRoute()
  const stepM = 3
  const laps = 8
  for (const seed of [20260914, 7, 2026]) {
    const g = generateCorridorRoute(route, { targetKm: 3.2, stepM, seed, drift: true })
    const pts = g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))

    // 按"走出来的弧长"切圈（不除以 400：轨迹略长于名义周长，除固定值会串圈）
    const perLap: { sum: number; n: number }[] = []
    let acc = 0
    let lap = 0
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) acc += distanceMeters(pts[i - 1]!.latitude, pts[i - 1]!.longitude, pts[i]!.latitude, pts[i]!.longitude)
      lap = Math.floor(acc / 400)
      if (!perLap[lap]) perLap[lap] = { sum: 0, n: 0 }
      perLap[lap]!.sum += distToLoopM(pts[i]!, route)
      perLap[lap]!.n++
    }
    const means = perLap.slice(0, laps).map((x) => (x && x.n ? x.sum / x.n : 0))

    // ① 不许"都落在同一个圈"：各圈到模板的平均距离必须**互不相同**
    const uniq = new Set(means.map((m) => m.toFixed(2)))
    assert.ok(uniq.size >= 6, `seed=${seed} 各圈平均偏离太雷同（${uniq.size} 种）：${means.map((m) => m.toFixed(2)).join(', ')}`)

    // ② **圈间平滑**：相邻两圈的位移差 ≤ 1.5 m（旧版"左右剧烈晃动"是几十米级，这条会爆掉）
    for (let i = 1; i < means.length; i++) {
      const d = Math.abs(means[i]! - means[i - 1]!)
      assert.ok(d <= 1.5, `seed=${seed} 第 ${i}→${i + 1} 圈跳了 ${d.toFixed(2)} m：${means.map((m) => m.toFixed(2)).join(', ')}`)
    }

    // ③ 幅度受控：每圈平均偏离 ≤ maxOffRouteM（5 m）⇒ 始终在跑道宽度内
    for (const m of means) assert.ok(m <= 5.01, `seed=${seed} 某圈平均偏离 ${m.toFixed(2)} m 超上限：${means.map((x) => x.toFixed(2)).join(', ')}`)

    // ④ 逐圈漂移量本身要有波动且不越界
    const drifts = g.lapDriftM
    assert.equal(drifts.length >= laps, true, `lapDriftM 长度不足：${drifts.length}`)
    assert.ok(new Set(drifts.slice(0, laps).map((v) => v.toFixed(2))).size >= 5, `逐圈漂移量太雷同：${drifts.join(', ')}`)
    for (const v of drifts) assert.ok(Math.abs(v) <= 1.01, `逐圈漂移 ${v} 超出 ±1 m 上限`)
  }
})

test('★ generateCorridorRoute：**圈内仍然"直道笔直"**（逐圈漂移不能变成波浪）', () => {
  const route = loopRoute()
  const stepM = 3
  const g = generateCorridorRoute(route, { targetKm: 3.2, stepM, seed: 20260914, drift: true })
  const pts = g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))

  // 只看**第 1 圈内**：沿第一条边（纯直道）的横向偏移应当近似恒定（极差 ≤ 0.5 m）
  let acc = 0
  const offsets: number[] = []
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += distanceMeters(pts[i - 1]!.latitude, pts[i - 1]!.longitude, pts[i]!.latitude, pts[i]!.longitude)
    if (acc > 400) break // 只取第 1 圈
    const p = pts[i]!
    const A = { latitude: 32.0, longitude: 118.0 }
    const B = route[1]!
    const mLat = 111320
    const mLng = 111320 * Math.cos((32.0 * Math.PI) / 180)
    const ax = A.longitude * mLng, ay = A.latitude * mLat
    const bx = B.longitude * mLng, by = B.latitude * mLat
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const px = p.longitude * mLng, py = p.latitude * mLat
    const t = ((px - ax) * dx + (py - ay) * dy) / len2
    if (t < 0.2 || t > 0.8) continue
    const qx = ax + t * dx, qy = ay + t * dy
    const d = Math.hypot(px - qx, py - qy)
    // ⚠️ 必须同时限制"离这条边的距离"：正方形环的**对边**投影参数与这条边相同（平行），
    //    不过滤距离就会把对边的点（约 100 m 外）算进来 ⇒ 极差算出 99 m 的假失败。
    if (d > 12) continue
    offsets.push(d)
  }
  assert.ok(offsets.length >= 8, `直道采样点太少：${offsets.length}`)
  const spread = Math.max(...offsets) - Math.min(...offsets)
  assert.ok(spread <= 1.0, `同一圈直道内的横向偏移极差 ${spread.toFixed(2)} m 过大（说明又变成波浪了）：${offsets.map((o) => o.toFixed(2)).join(', ')}`)
})

test('★ generateCorridorRoute：lapDrift=false 时回到"多圈重合"的旧行为（可回退）', () => {
  const route = loopRoute()
  const g = generateCorridorRoute(route, { targetKm: 3.2, stepM: 3, seed: 20260914, drift: true, lapDrift: false })
  const uniq = new Set(g.lapDriftM.map((v) => v.toFixed(2)))
  assert.equal(uniq.size, 1, `lapDrift=false 时逐圈漂移应恒为 0：${g.lapDriftM.join(', ')}`)
  assert.equal(g.lapDriftM[0], 0)
})

