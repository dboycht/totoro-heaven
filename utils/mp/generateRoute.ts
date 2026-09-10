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
}

export interface GeneratedRoute {
  /** 轨迹点（字符串化后 6 位小数，符合接口习惯） */
  points: { latitude: string; longitude: string }[]
  /** 实际累计里程（公里，两位小数） */
  km: string
  /** 自算拟合度（0~1，两位小数），可直接作为 fitDegree 提交 */
  fitDegree: string
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

  /** 按弧长取路径上的基准点（position 超出则按 loop 处理） */
  const pointAt = (position: number): { latitude: number; longitude: number } => {
    if (position <= 0) return { ...path[0]! }
    if (position >= pathTotal) {
      if (!loop) return { ...path[path.length - 1]! }
      position = position % pathTotal
    }
    // 二分找所在段
    let lo = 0
    let hi = segLen.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid + 1]! < position) lo = mid + 1
      else hi = mid
    }
    const segIndex = lo
    const segStart = cum[segIndex]!
    const len = segLen[segIndex]!
    const t = len > 0 ? (position - segStart) / len : 0
    const a = path[segIndex]!
    const b = path[segIndex + 1]!
    return {
      latitude: a.latitude + (b.latitude - a.latitude) * t,
      longitude: a.longitude + (b.longitude - a.longitude) * t,
    }
  }

  const raw: { latitude: number; longitude: number }[] = []
  const maxPosition = loop ? targetM * 3 : Math.min(targetM, pathTotal)

  // 时间相关抖动（OU/AR(1) 过程）：
  //   白噪声（ρ=0）会让 2m 步长配 σ=2.2m 的轨迹变成锯齿，实际长度翻倍（踩坑）；
  //   ρ=0.92 时相邻点误差高度相关，轨迹平滑漂移，仍保持真实 GPS 观感。
  const rho = Math.min(0.999, Math.max(0, jitterRho))
  const innovScale = Math.sqrt(Math.max(0, 1 - rho * rho))
  let errLat = 0
  let errLng = 0

  let accumulated = 0
  let pos = 0
  raw.push(pointAt(0))

  while (pos < maxPosition && accumulated < targetM) {
    pos += stepM
    const base = pointAt(pos)

    // 抖动误差按米累积，再换算为经纬度增量
    errLat = rho * errLat + innovScale * gauss(rng, 0, jitterSigmaM)
    errLng = rho * errLng + innovScale * gauss(rng, 0, jitterSigmaM)

    const lat = base.latitude + errLat / M_PER_DEG_LAT
    const lng = base.longitude + errLng * degLngPerMeter(base.latitude)

    const prev = raw[raw.length - 1]!
    accumulated += distanceMeters(prev.latitude, prev.longitude, lat, lng)
    raw.push({ latitude: lat, longitude: lng })
  }

  const fit = calculateRouteSimilarity(route, raw)

  return {
    points: raw.map((p) => ({
      latitude: p.latitude.toFixed(6),
      longitude: p.longitude.toFixed(6),
    })),
    km: (accumulated / 1000).toFixed(2),
    fitDegree: Number(fit).toFixed(2),
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
