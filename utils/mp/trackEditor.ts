/**
 * 跑道内外圈 → **车道线**（2026-09-17 用户要求："用户描外圈和内圈，你自己编算法搞某一道"）
 *
 * 设计要点：
 *   ① 纯函数、零依赖（可离线单测）；不碰 localStorage（存取由调用方负责）。
 *   ② **按弧长对齐**再插值：内外圈点数/起点都不一样，必须先各自按弧长重采样到同样点数，
 *      再用"整体平移最小距离"找对齐偏移 —— 否则弯道处会把内圈的弯配到外圈的直道，插出来的线会穿墙。
 *   ③ 车道 `ratio`：0 = 贴内圈，1 = 贴外圈；第 N 道（1 起、1=最内道）换算见 `laneRatioFor`。
 *   ④ 抖动**不在这里做**：本模块只给"干净的车道中心线"，抖动由 `generateRoute` 的
 *      "按段恒定的车道偏移 + 0.15 m 颗粒 + 偶发小凸起"负责（参数来自真跑实测）。
 */
import { distanceMeters, pointToSegmentDistance, type LatLng } from './routeSimilarity'

export interface TrackRings {
  /** 外圈（闭合折线；首尾可不重合，函数会当闭合处理） */
  outer: LatLng[]
  /** 内圈（同向；应与外圈同绕向） */
  inner: LatLng[]
}

/** 内部统一成 {latitude, longitude} 数值对 */
const norm = (list: LatLng[]) => list.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))

/** 闭合折线的累计弧长（含收尾段） */
function cumulative(ring: { latitude: number; longitude: number }[]): { cum: number[]; total: number } {
  const cum = [0]
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + 1) % ring.length]!
    cum.push(cum[i]! + distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude))
  }
  return { cum, total: cum[cum.length - 1]! }
}

/** 按弧长把闭合折线重采样成 n 个等弧长点（起点取原来的第 0 个点） */
function resampleClosed(ring: { latitude: number; longitude: number }[], n: number) {
  const { cum, total } = cumulative(ring)
  const out: { latitude: number; longitude: number }[] = []
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n
    let i = 1
    while (i < cum.length - 1 && cum[i]! < target) i++
    const a = ring[i - 1]!
    const b = ring[i % ring.length]!
    const segLen = (cum[i]! - cum[i - 1]!) || 1e-9
    const t = Math.min(1, Math.max(0, (target - cum[i - 1]!) / segLen))
    out.push({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t })
  }
  return out
}

/** 闭合折线周长（米） */
export function ringLengthM(ring: LatLng[]): number {
  return cumulative(norm(ring)).total
}

/**
 * 内外圈之间的**平均宽度**（米）——用来校验"这道是不是在跑道里"，以及换算第 N 道。
 * 做法：取内圈上若干点，量它们到外圈折线的最短距离，取中位数（抗噪）。
 */
export function ringWidthM(rings: TrackRings): number {
  const outer = norm(rings.outer)
  const inner = norm(rings.inner)
  if (outer.length < 2 || inner.length < 2) return 0
  const step = Math.max(1, Math.floor(inner.length / 24))
  const ds: number[] = []
  for (let i = 0; i < inner.length; i += step) {
    const p = inner[i]!
    let best = Number.POSITIVE_INFINITY
    for (let k = 0; k < outer.length; k++) {
      const a = outer[k]!
      const b = outer[(k + 1) % outer.length]!
      const d = pointToSegmentDistance(p.latitude, p.longitude, a.latitude, a.longitude, b.latitude, b.longitude)
      if (d < best) best = d
    }
    ds.push(best)
  }
  ds.sort((a, b) => a - b)
  return ds.length ? ds[Math.floor(ds.length / 2)]! : 0
}

/**
 * 第 N 道 → ratio（0=内圈边，1=外圈边）。
 * @param laneNo    道次，1 起（1 = 最内道）
 * @param laneCount 总道数（标准操场一般 4~8）
 */
export function laneRatioFor(laneNo: number, laneCount: number): number {
  const n = Math.max(1, Math.round(laneCount))
  const k = Math.min(Math.max(1, Math.round(laneNo)), n)
  // 道中心：第 k 道占据 [(k-1)/n, k/n]，取中点 ⇒ (k-0.5)/n
  return (k - 0.5) / n
}

/**
 * 生成**车道中心线**：在内外圈之间按 `ratio` 做径向插值。
 * @param samples 采样点数（越大越平滑；默认 240 足够）
 * @returns 闭合折线（首点即起点，末点不重复首点）
 */
export function laneLoop(rings: TrackRings, ratio: number, samples = 240): LatLng[] {
  const outerRaw = norm(rings.outer)
  const innerRaw = norm(rings.inner)
  if (outerRaw.length < 3 || innerRaw.length < 3) return []
  const n = Math.max(24, Math.round(samples))
  const outer = resampleClosed(outerRaw, n)
  const inner = resampleClosed(innerRaw, n)

  // 找"整体平移最小距离"的对齐偏移：把内圈的起点挪到与外圈最匹配的位置
  let bestShift = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let shift = 0; shift < n; shift++) {
    let cost = 0
    for (let i = 0; i < n; i += 4) {
      const a = outer[i]!
      const b = inner[(i + shift) % n]!
      cost += distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude)
    }
    if (cost < bestCost) {
      bestCost = cost
      bestShift = shift
    }
  }

  const r = Math.min(1, Math.max(0, ratio))
  const out: { latitude: number; longitude: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = inner[(i + bestShift) % n]!
    const b = outer[i]!
    out.push({
      latitude: a.latitude + (b.latitude - a.latitude) * r,
      longitude: a.longitude + (b.longitude - a.longitude) * r,
    })
  }
  return out
}

/** 车道的**起跑点**（最靠"东侧"的那个点）——让起跑位置稳定、可复现 */
export function laneStartIndex(lane: LatLng[]): number {
  let best = 0
  for (let i = 1; i < lane.length; i++) if (lane[i]!.longitude > lane[best]!.longitude) best = i
  return best
}

/** 把车道线旋转到指定起点（起跑点固定，避免每次落在随机位置） */
export function rotateLoop(lane: LatLng[], startIndex: number): LatLng[] {
  if (!lane.length) return lane
  const i = ((startIndex % lane.length) + lane.length) % lane.length
  return [...lane.slice(i), ...lane.slice(0, i)]
}

/**
 * 随机道次 + 偶尔缓慢换道（用户选定："随机选一道 + 偶尔缓慢换道"）。
 * 返回一条**按弧长**的车道比例曲线（0=内圈边，1=外圈边），供生成器按弧长取用：
 *   - 基准道次随机；
 *   - 全程 0~2 次换道，每次用**余弦平滑**跨 `changeLenM` 米（默认 30 m）过渡 ⇒ 看起来就是"慢慢切进去"。
 * @param rng 取值 [0,1) 的随机源（传入可复现的种子随机数）
 */
export function laneRatioProfile(
  rng: () => number,
  laneCount: number,
  loopLengthM: number,
  options: { maxChanges?: number; changeLenM?: number } = {},
): (arcM: number) => number {
  const n = Math.max(1, Math.round(laneCount))
  const maxChanges = options.maxChanges ?? 2
  const changeLenM = options.changeLenM ?? 30
  const baseLane = 1 + Math.floor(rng() * n)
  const base = laneRatioFor(baseLane, n)

  const changes: { fromM: number; toLane: number }[] = []
  const count = Math.floor(rng() * (maxChanges + 1)) // 0 ~ maxChanges 次
  for (let i = 0; i < count; i++) {
    changes.push({ fromM: rng() * Math.max(1, loopLengthM), toLane: 1 + Math.floor(rng() * n) })
  }
  changes.sort((a, b) => a.fromM - b.fromM)

  /**
   * 实现：先做"阶跃"（基准道 + 若干次换道），再对整圈做**循环滑动平均**平滑。
   * ⚠️ 为什么不用"逐次叠加余弦"（第一版就是那样）：换道起点处仍会出现台阶（实测跳变 0.166 = 整整一道），
   *    而且**圈首与圈尾不连续**（跑第二圈时会横跳一次）。循环平滑两个问题一起解决。
   */
  const N = 240 // 一圈的采样格
  const idx: number[] = new Array<number>(N).fill(base)
  for (const c of changes) {
    const at = Math.floor((c.fromM / Math.max(1, loopLengthM)) * N) % N
    const target = laneRatioFor(c.toLane, n)
    for (let i = at; i < N; i++) idx[i] = target
  }
  const w = Math.max(1, Math.round((changeLenM / Math.max(1, loopLengthM)) * N))
  const smoothIdx = idx.map((_, i) => {
    let s = 0
    for (let k = i - w; k <= i + w; k++) s += idx[((k % N) + N) % N]!
    return s / (2 * w + 1)
  })

  return (arcM: number) => {
    const t = (((((arcM % loopLengthM) + loopLengthM) % loopLengthM) / loopLengthM) * N) % N
    const i = Math.floor(t)
    const f = t - i
    const v = smoothIdx[i]! * (1 - f) + smoothIdx[(i + 1) % N]! * f
    return Math.min(1, Math.max(0, v))
  }
}
