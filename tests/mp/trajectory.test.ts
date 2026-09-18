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
    /**
     * 判据拆成两条（2026-09-18 校准；起因：加入"逐圈漂移"后本测试从 1.4 m 变 1.7 m 判失败）：
     *
     * ① **圈内抖动**（旧算法"左右抖动太假"的真问题）：相邻采样点的横向偏移变化必须很小。
     *    真跑实测逐点横向变化约 0.175 m/点；旧算法的"波浪"是 2~3 m 级摆动 ⇒ 这条会爆。
     * ② **整体散布**上限：允许"逐圈漂移"造成的圈间平行错开（上限 2.2 m ⇒ 散布 ≤ ~2.2 m），
     *    但超过 3.5 m 就说明不是"平行错开"而是"歪了"。
     * ⚠️ 只靠 ① 不够（缓慢摆动也能骗过），只靠 ② 会误杀逐圈漂移 ⇒ 两条都要。
     */
    let jitterSum = 0
    let jitterN = 0
    for (let i = 1; i < lat.length; i++) {
      jitterSum += Math.abs(lat[i]! - lat[i - 1]!)
      jitterN++
    }
    const jitterPerStep = jitterN ? jitterSum / jitterN : 0
    assert.ok(jitterPerStep <= 0.4, `seed=${seed} 圈内逐点横向抖动 ${jitterPerStep.toFixed(2)} m/点（>0.4 就是"波浪"，直道看着不直）`)
    assert.ok(spread <= 3.5, `seed=${seed} 直道段内横向偏移散布 ${spread.toFixed(2)} m（>3.5 说明不是平行错开而是歪了）`)
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

    // ② **圈间平滑**：相邻两圈的位移差不得明显超过"逐圈漂移的封顶值"。
    //    ⚠️ 阈值**跟着幅度走**（不是写死）：把 `lapDriftMaxM` 调大时这里自动放宽，调小时自动收紧。
    //    真正的"左右剧烈晃动"是**几十米级**（旧算法每圈错开 30~86 m）⇒ 这条一定会爆。
    const driftCap = Math.max(...g.lapDriftM.map((v) => Math.abs(v)), 0.5)
    for (let i = 1; i < means.length; i++) {
      const d = Math.abs(means[i]! - means[i - 1]!)
      assert.ok(
        d <= driftCap + 0.35,
        `seed=${seed} 第 ${i}→${i + 1} 圈跳了 ${d.toFixed(2)} m（圈间漂移封顶 ${driftCap.toFixed(2)} m）：${means.map((m) => m.toFixed(2)).join(', ')}`,
      )
    }

    // ③ 幅度受控：每圈平均偏离 ≤ maxOffRouteM（5 m）⇒ 始终在跑道宽度内
    for (const m of means) assert.ok(m <= 5.01, `seed=${seed} 某圈平均偏离 ${m.toFixed(2)} m 超上限：${means.map((x) => x.toFixed(2)).join(', ')}`)

    // ④ 逐圈漂移量本身要有波动且不越界（上限 = `lapDriftMaxM`，默认 2.2 m）
    const drifts = g.lapDriftM
    assert.equal(drifts.length >= laps, true, `lapDriftM 长度不足：${drifts.length}`)
    assert.ok(new Set(drifts.slice(0, laps).map((v) => v.toFixed(2))).size >= 5, `逐圈漂移量太雷同：${drifts.join(', ')}`)
    for (const v of drifts) assert.ok(Math.abs(v) <= 2.21, `逐圈漂移 ${v} 超出 ±2.2 m 上限`)
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

test('★ generateCorridorRoute：**未闭合路线（折返跑）**折返点两侧不许有横向阶跃（审计 F1 回归）', () => {
  /**
   * 一条 300 m 的**直线**（首末点相距 300 m ≫ 30 m ⇒ `closed=false`）：
   * `locate()` 会用折返（ping-pong）走 0→L→0→L…
   * 真实跑的一个"来回"才算一圈 ⇒ 漂移的圈号必须是 `floor(p / (2L))`。
   * 修之前用的是 `floor(p / L)`，于是折返点两侧漂移编号不同、符号相反 ⇒ 单步横向阶跃 ≈ 2×车道偏移。
   */
  const lat0 = 32.0
  const lng0 = 118.0
  const dLat = 300 / 111320
  const straight = [
    { latitude: lat0, longitude: lng0 },
    { latitude: lat0 + dLat, longitude: lng0 },
  ]
  const g = generateCorridorRoute(straight, { targetKm: 3.2, stepM: 3, seed: 20260914, drift: true, smoothRoute: 0 })
  const pts = g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))

  // 逐点步长（米）：正常应 ≈ stepM(3) + 抖动；出现折返/阶跃时会明显更大
  const steps: number[] = []
  for (let i = 1; i < pts.length; i++) {
    steps.push(distanceMeters(pts[i - 1]!.latitude, pts[i - 1]!.longitude, pts[i]!.latitude, pts[i]!.longitude))
  }
  const maxStep = Math.max(...steps)
  // 判据：最大单步 ≤ 3× 步长（9 m）。修之前折返点单步达 6+ m **且方向左右翻转**；
  // 这里同时卡住"阶跃"与"点间距异常"两类问题（飞点守卫本身就是 ≤12 m/s 量级）。
  assert.ok(maxStep <= 9, `折返点出现阶跃：最大单步 ${maxStep.toFixed(2)} m（步长 3 m）`)

  // 更强的判据：折返点附近**横向（经度）方向**不应出现符号翻转的横向偏移跳变
  const lateral = pts.map((p) => (p.longitude - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180))
  const wrapIndex = steps.indexOf(Math.max(...steps)) // 折返发生处（步长最大点）
  const near = lateral.slice(Math.max(0, wrapIndex - 2), Math.min(lateral.length, wrapIndex + 3))
  const nearSpread = Math.max(...near) - Math.min(...near)
  assert.ok(nearSpread <= 3.5, `折返点附近横向偏移跨度 ${nearSpread.toFixed(2)} m 过大（漂移把折返当成两圈了）`)

  // lapLengthM 必须是"往返全长"（2×300 m），否则预览切圈也会错
  assert.ok(Math.abs(g.lapLengthM - 600) < 5, `未闭合路线的 lapLengthM 应为往返全长 600 m，实际 ${g.lapLengthM}`)
})

test('★ generateCorridorRoute：路线太短且 loop=false 时必须**显式报错**，不许静默给短轨迹（审计 F3）', () => {
  const lat0 = 32.0
  const lng0 = 118.0
  /**
   * `loop: false` 的语义 = **只走一遍**。若一遍走完还不够目标里程，就没有合法轨迹可给：
   *   · 修之前的行为：`locate()` 把位置**夹在终点**，轨迹于是"在原地抖动"直到凑够里程
   *     （物理上不可能，且调用方会把 `generated.km` 当真实里程 ⇒ 可能给出"没跑够却判通过"的错结果）；
   *   · 现在的行为：**显式抛错**，让调用方知道路线不够长。
   * 真实调用方（`composables/demo/runner.ts`）都用默认 `loop: true`，所以这只影响显式传参的用法。
   */
  const openShort = [
    { latitude: lat0, longitude: lng0 },
    { latitude: lat0 + 50 / 111320, longitude: lng0 },
  ]
  assert.throws(
    () => generateCorridorRoute(openShort, { targetKm: 3.2, stepM: 3, seed: 1, loop: false }),
    /路线太短/,
    'loop=false 且一遍走完不足目标里程时应显式报错',
  )
  // 同一路线用默认 loop=true 时正常（折返跑），不报错
  const folded = generateCorridorRoute(openShort, { targetKm: 0.3, stepM: 3, seed: 1 })
  assert.ok(Number(folded.km) > 0.2, `折返跑应正常出轨迹，实际 km=${folded.km}`)

  /**
   * ⚠️ 2026-09-18 发布前审计 L3 的回归：**判据要用"一遍的长度"，不能用到"往返全长"**。
   * 300 m 未闭合直线（smoothRoute:0 ⇒ 一遍 = 300 m）配 **0.5 km** 目标：
   * 落在 `[pathTotal, 2×pathTotal)` 这个窗口里 —— 旧写法拿 `lapLengthM`(=2×pathTotal≈600 m) 当门槛，
   * 于是**不抛错**，返回 km=0.50 而后面几百个点都是"终点原地抖动凑里程"。
   */
  const straight300 = [
    { latitude: lat0, longitude: lng0 },
    { latitude: lat0 + 300 / 111320, longitude: lng0 },
  ]
  assert.throws(
    () => generateCorridorRoute(straight300, { targetKm: 0.5, stepM: 3, seed: 1, loop: false, smoothRoute: 0 }),
    /路线太短/,
    '一遍只有 300 m 却要 0.5 km：必须抛错，不能靠终点原地抖动凑里程',
  )
})

