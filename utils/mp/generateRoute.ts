/**
 * 小程序版模拟轨迹生成（走廊式 · 弧长连续推进）
 *
 * 与旧版 `utils/generateRoute.ts` 的关键差别：
 *   旧版是「在路线上随机取点 + 抖动 + 累加到目标公里数」，点序可能跳变；
 *   小程序服务端会算**拟合度**（采样点到官方折线 ≤25 米才命中），所以这里改为
 *   **沿官方折线按弧长顺序前进、在走廊内做高斯抖动、走满目标公里数**，
 *   保证 `fitDegree` 天然接近 1，同时保留真实 GPS 的抖动观感。
 *
 * 实现要点（踩坑）：
 *   必须用**全局弧长**做插值推进，不能用「每段内部从段首按步长走」——
 *   后者在闭合路线跑第二圈时会从段首重启，产生 m 级跳变，拟合度直接掉到 0.45。
 *
 * 逆向依据：`_mp-analyze/小程序逆向分析.md` 第 5.3 节（算法参数 5m/25m）
 */

import { distanceMeters, calculateRouteSimilarity, type LatLng } from './routeSimilarity'

export interface CorridorOptions {
  /** 目标里程（公里） */
  targetKm: number
  /** 抖动标准差（米），默认 2.2（与旧版一致） */
  jitterSigmaM?: number
  /** 抖动时间相关系数 ρ ∈ [0,1)，默认 0.92（模拟真实 GPS 漂移，避免锯齿） */
  jitterRho?: number
  /** 采样步长（米），默认 2（≈ 真实 GPS 上报间隔） */
  stepM?: number
  /** 路线走完后是否循环（默认 true，支持跑多圈） */
  loop?: boolean
  /** 随机种子（便于测试复现） */
  seed?: number
  /**
   * 真实感：叠加**GPS 精度下降期**（树下 / 楼旁 / 拐角贴墙），让拟合度自然落到 0.9x
   * 而不是满分 1.00（默认 false，保持既有测试口径）。
   * ⚠️ 偏移用"缓慢随机游走"实现（每点位移 ≤ ~6m），**不会制造飞点**（逐点速度远低于 12 m/s）。
   */
  drift?: boolean
  /** 漂移期参数（给测试用；默认 2~4 次、每次 24~44 点、峰值偏移 14~30 米） */
  driftOptions?: { minCount?: number; maxCount?: number; minLen?: number; maxLen?: number; minM?: number; maxM?: number }
}

export interface GeneratedRoute {
  /** 轨迹点（字符串化后 6 位小数，符合接口习惯） */
  points: { latitude: string; longitude: string }[]
  /** 实际累计里程（公里，两位小数） */
  km: string
  /** 自算拟合度（0~1，两位小数），可直接作为 fitDegree 提交 */
  fitDegree: string
  /** 漂移期次数（0 = 未开启/未命中） */
  driftEpisodes: number
}

/** 可复现随机数（mulberry32） */
function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 高斯随机（Box-Muller），sigma 为标准差 */
function gauss(rng: () => number, mean: number, sigma: number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 米 → 纬度增量（度） */
const M_PER_DEG_LAT = 111320
/** 米 → 经度增量（度），随纬度收缩 */
const degLngPerMeter = (lat: number) => 1 / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))

/**
 * 沿官方路线生成走廊内轨迹
 * @param officialRoute 官方路线点列（pointList）
 */
export function generateCorridorRoute(officialRoute: LatLng[], options: CorridorOptions): GeneratedRoute {
  const {
    targetKm,
    jitterSigmaM = 2.2,
    jitterRho = 0.92,
    stepM = 2,
    loop = true,
    seed = 20260914,
  } = options

  if (!officialRoute || officialRoute.length < 2) {
    throw new Error('官方路线点列不足（至少需要 2 个点）')
  }
  if (!(targetKm > 0)) {
    throw new Error('目标里程必须大于 0')
  }

  const rng = createRng(seed)
  const targetM = targetKm * 1000

  const route = officialRoute.map((p) => ({
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
  }))

  // 闭合路线：把首点接到末尾，保证最后一圈也能走满
  const closed = distanceMeters(
    route[0]!.latitude,
    route[0]!.longitude,
    route[route.length - 1]!.latitude,
    route[route.length - 1]!.longitude,
  ) < 30
  const path = closed ? [...route, route[0]!] : route

  // 预计算每段长度与累计弧长
  const segLen: number[] = []
  const cum: number[] = [0]
  for (let i = 0; i < path.length - 1; i++) {
    const d = distanceMeters(path[i]!.latitude, path[i]!.longitude, path[i + 1]!.latitude, path[i + 1]!.longitude)
    segLen.push(d)
    cum.push(cum[i]! + d)
  }
  const pathTotal = cum[cum.length - 1]!
  if (!(pathTotal > 0)) throw new Error('官方路线长度为 0（点列退化）')

  /**
   * 按弧长取路径上的基准点，并**同时返回"该处对应的路线弧长位置"**。
   *
   * ⚠️ 接圈规则（2026-09-14 修）：**闭合路线**直接取模绕圈；
   *    **未闭合路线**必须用**折返（ping-pong）**而不是取模 ——
   *    取模会让轨迹从路线终点"瞬移"回起点（实测出现 35m 的逐点跳变，等于飞点）。
   *    折返既符合真实跑法（折返跑），也彻底消除瞬移。
   */
  const locate = (position: number): { lat: number; lng: number; arc: number } => {
    let p = position
    if (p <= 0) p = 0
    if (p >= pathTotal) {
      if (!loop) p = pathTotal
      else if (closed) p = p % pathTotal
      else {
        // 折返：0 → pathTotal → 0 → pathTotal …
        const period = pathTotal * 2
        const q = p % period
        p = q <= pathTotal ? q : period - q
      }
    }
    // 二分找所在段
    let lo = 0
    let hi = segLen.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid + 1]! < p) lo = mid + 1
      else hi = mid
    }
    const segIndex = lo
    const segStart = cum[segIndex]!
    const len = segLen[segIndex]!
    const t = len > 0 ? (p - segStart) / len : 0
    const a = path[segIndex]!
    const b = path[segIndex + 1]!
    return {
      lat: a.latitude + (b.latitude - a.latitude) * t,
      lng: a.longitude + (b.longitude - a.longitude) * t,
      arc: p,
    }
  }
  const pointAt = (position: number) => {
    const { lat, lng } = locate(position)
    return { latitude: lat, longitude: lng }
  }

  const maxPosition = loop ? targetM * 3 : Math.min(targetM, pathTotal)

  // 时间相关抖动（OU/AR(1) 过程）：
  //   白噪声（ρ=0）会让 2m 步长配 σ=2.2m 的轨迹变成锯齿，实际长度翻倍（踩坑）；
  //   ρ=0.92 时相邻点误差高度相关，轨迹平滑漂移，仍保持真实 GPS 观感。
  const rho = Math.min(0.999, Math.max(0, jitterRho))
  const innovScale = Math.sqrt(Math.max(0, 1 - rho * rho))

  // ---- 真实感：GPS 精度下降「区」（按**路线弧长位置**定义，而不是按时间）----
  // ⚠️ 两个关键认知（2026-09-14 踩坑后想通）：
  //   ① 拟合度 = 官方路线每个采样点到**用户折线的最短距离**。多圈路线下，若漂移只发生在某几圈，
  //      同一采样点会被**另外几圈干净地经过** → 拟合度照样 1.00。所以偏移必须与"跑到哪儿"绑定。
  //   ② 偏移方向必须**以垂直于路线为主**：若方向恰好与路线平行，垂直偏差≈0 → 采样点照样命中。
  //      （实测：纯随机方向时，12 组种子里有 7 组仍是满分。）
  interface DriftZone {
    startM: number
    lenM: number
    /** 偏移方向（单位向量，**创建时定死**，避免沿线切向在某些位置退化/翻转造成跳变） */
    perpLat: number
    perpLng: number
    alongLat: number
    alongLng: number
    perpM: number
    alongM: number
  }
  const driftOn = options.drift === true
  const driftCfg = {
    minLenM: options.driftOptions?.minLen ?? 50,
    maxLenM: options.driftOptions?.maxLen ?? 140,
    minM: options.driftOptions?.minM ?? 26,
    maxM: options.driftOptions?.maxM ?? 44,
  }
  /** 取某弧长所在**线段**的单位切向（用折线本身，绕开 locate 的折返/夹紧） */
  const segmentTangentAt = (arc: number): { lat: number; lng: number } => {
    const p = Math.min(Math.max(arc, 0), pathTotal - 1e-6)
    let lo = 0
    let hi = segLen.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid + 1]! < p) lo = mid + 1
      else hi = mid
    }
    const a = path[lo]!
    const b = path[lo + 1]!
    const dNorth = (b.latitude - a.latitude) * M_PER_DEG_LAT
    const dEast = (b.longitude - a.longitude) / degLngPerMeter(a.latitude)
    const len = Math.hypot(dNorth, dEast)
    if (!(len > 1e-6)) return { lat: 0, lng: 1 } // 退化线段：给个稳定方向
    return { lat: dNorth / len, lng: dEast / len }
  }

  /**
   * 生成最多 `DRIFT_MAX_ZONES` 个候选"精度下降区"（位置/长度/方向随机，振幅随档位缩放）。
   * ⚠️ 为什么不做"固定幅度"，而是**闭环加码**（见下方控制循环）：
   *    实测发现**路线自身会折返重叠** —— 偏移 26m 的轨迹点，其采样点常被"隔壁车道"（只偏 12m）
   *    在 25m 容差内接住，所以固定幅度不保证拟合度降下来。必须用**真算法测量**后再加码。
   */
  const DRIFT_MAX_ZONES = 5
  const zones: DriftZone[] = []
  if (driftOn) {
    for (let i = 0; i < DRIFT_MAX_ZONES; i++) {
      const lenM = driftCfg.minLenM + rng() * (driftCfg.maxLenM - driftCfg.minLenM)
      const startM = rng() * pathTotal
      const amp = driftCfg.minM + rng() * (driftCfg.maxM - driftCfg.minM)
      const sign = rng() < 0.5 ? -1 : 1
      const t = segmentTangentAt(startM)
      zones.push({
        startM,
        lenM,
        perpLat: t.lng * sign,
        perpLng: -t.lat * sign,
        alongLat: t.lat,
        alongLng: t.lng,
        perpM: amp,
        alongM: amp * (rng() * 0.4 - 0.2), // ±20% 切向分量，方向不总是 90°
      })
    }
  }
  /** 按弧长位置查偏移（米）：同路段每圈/每次折返偏移一致 → 像真实多径 */
  const offsetAt = (arcPos: number, zoneCount: number, ampScale: number): { lat: number; lng: number } => {
    let lat = 0
    let lng = 0
    for (let zi = 0; zi < zoneCount; zi++) {
      const z = zones[zi]!
      const d = (((arcPos - z.startM) % pathTotal) + pathTotal) % pathTotal
      if (d <= z.lenM) {
        const w = Math.sin(Math.PI * (d / z.lenM)) // 平滑进出，峰值在区间中点
        lat += (z.perpM * ampScale * z.perpLat + z.alongM * ampScale * z.alongLat) * w
        lng += (z.perpM * ampScale * z.perpLng + z.alongM * ampScale * z.alongLng) * w
      }
    }
    return { lat, lng }
  }

  /** 构建一条轨迹（**同一 seed** → 每次尝试的抖动完全一致，只有偏移档位不同） */
  const buildTrajectory = (zoneCount: number, ampScale: number) => {
    const r = createRng(seed)
    const pts: { latitude: number; longitude: number }[] = []
    let eLat = 0
    let eLng = 0
    let acc = 0
    let p = 0
    // ⚠️ 首点也必须走同一套"抖动 + 偏移"（否则首点与第二点之间会凭空出现一次 15~22m 跳变 —— 实测抓到的）
    const first = locate(0)
    const off0 = driftOn ? offsetAt(first.arc, zoneCount, ampScale) : { lat: 0, lng: 0 }
    pts.push({
      latitude: first.lat + off0.lat / M_PER_DEG_LAT,
      longitude: first.lng + off0.lng * degLngPerMeter(first.lat),
    })
    while (p < maxPosition && acc < targetM) {
      p += stepM
      const here = locate(p)
      eLat = rho * eLat + innovScale * gauss(r, 0, jitterSigmaM)
      eLng = rho * eLng + innovScale * gauss(r, 0, jitterSigmaM)
      const off = driftOn ? offsetAt(here.arc, zoneCount, ampScale) : { lat: 0, lng: 0 }
      const lat = here.lat + (eLat + off.lat) / M_PER_DEG_LAT
      const lng = here.lng + (eLng + off.lng) * degLngPerMeter(here.lat)
      const prev = pts[pts.length - 1]!
      acc += distanceMeters(prev.latitude, prev.longitude, lat, lng)
      pts.push({ latitude: lat, longitude: lng })
    }
    return { pts, accumulated: acc }
  }

  // 初始：1 个偏移区、原始幅度
  let built = buildTrajectory(driftOn ? 1 : 0, 1)
  let fit = calculateRouteSimilarity(route, built.pts)
  let usedZones = driftOn ? 1 : 0

  // 闭环加码：用**真算法**测到拟合度落进 [0.90, 0.985]（不是满分、也不至于太离谱）
  if (driftOn) {
    const ladder: [number, number][] = [
      [1, 1.3],
      [1, 1.65],
      [2, 1.0],
      [2, 1.3],
      [2, 1.6],
      [3, 1.0],
      [3, 1.3],
      [4, 1.0],
      [4, 1.25],
      [5, 1.0],
    ]
    for (const [zoneCount, ampScale] of ladder) {
      if (fit <= 0.985) break
      const attempt = buildTrajectory(zoneCount, ampScale)
      const f = calculateRouteSimilarity(route, attempt.pts)
      if (f < 0.88) break // 掉太狠：保留上一档（宁可略高，别失真）
      built = attempt
      fit = f
      usedZones = zoneCount
    }
  }

  return {
    points: built.pts.map((p) => ({
      latitude: p.latitude.toFixed(6),
      longitude: p.longitude.toFixed(6),
    })),
    km: (built.accumulated / 1000).toFixed(2),
    fitDegree: Number(fit).toFixed(2),
    driftEpisodes: usedZones,
  }
}

/**
 * 由轨迹生成等间隔时间戳（毫秒），用于构造 startTime/endTime 与配速一致性检查
 * @param count 轨迹点数
 * @param totalSeconds 总时长（秒）
 */
export function buildTimeline(count: number, totalSeconds: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0]
  const stepMs = (totalSeconds * 1000) / (count - 1)
  return Array.from({ length: count }, (_, i) => Math.round(i * stepMs))
}
