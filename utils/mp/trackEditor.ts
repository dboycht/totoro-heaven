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

// ---------- 平面几何工具（米制，局部等距投影）----------
type XY = { x: number; y: number }

/** 以某纬度为基准的局部平面投影（小范围足够精确；所有几何判定都在这个平面里做） */
function makeProjector(refLat: number) {
  const mPerDegLat = 111320
  const mPerDegLng = 111320 * Math.cos((refLat * Math.PI) / 180)
  return {
    toXY: (p: { latitude: number | string; longitude: number | string }): XY => ({
      x: Number(p.longitude) * mPerDegLng,
      y: Number(p.latitude) * mPerDegLat,
    }),
    toLL: (q: XY) => ({ latitude: q.y / mPerDegLat, longitude: q.x / mPerDegLng }),
  }
}

const ringCentroidLat = (ring: { latitude: number | string }[]) =>
  ring.reduce((s, p) => s + Number(p.latitude), 0) / Math.max(1, ring.length)

/** 有向面积（>0 = 逆时针 CCW） */
function signedArea(pts: XY[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % pts.length]!
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** 点到线段最近点（平面） */
function closestOnSegment(p: XY, a: XY, b: XY): XY {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/** 点到折线（闭合）的最近点 */
function closestOnPolyline(p: XY, poly: XY[]): XY {
  let best: XY = poly[0]!
  let bestD = Number.POSITIVE_INFINITY
  for (let i = 0; i < poly.length; i++) {
    const q = closestOnSegment(p, poly[i]!, poly[(i + 1) % poly.length]!)
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2
    if (d < bestD) {
      bestD = d
      best = q
    }
  }
  return best
}

/** 点在多边形内（射线法） */
export function pointInRing(p: { latitude: number | string; longitude: number | string }, ring: { latitude: number | string; longitude: number | string }[]): boolean {
  if (ring.length < 3) return false
  const pr = makeProjector(ringCentroidLat(ring))
  const q = pr.toXY(p)
  const poly = ring.map(pr.toXY)
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** 两条线段是否相交（含共线重叠的粗略判定） */
function segmentsCross(a1: XY, a2: XY, b1: XY, b2: XY): boolean {
  const cross = (o: XY, p: XY, q: XY) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const d1 = cross(b1, b2, a1)
  const d2 = cross(b1, b2, a2)
  const d3 = cross(a1, a2, b1)
  const d4 = cross(a1, a2, b2)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

/**
 * **判定两条圈是否合法**（2026-09-17 用户要求："外圈必须包着内圈"）。
 * 检查：点数够 → 内圈**全部**在外圈之内 → 两圈**不相交** → 环宽合理（2~40 m）。
 * 返回的问题都是可读中文，直接显示给用户。
 */
export function validateRings(rings: TrackRings): { ok: boolean; problems: string[]; widthM: number; innerOutside: number; crossings: number } {
  const problems: string[] = []
  const outer = norm(rings.outer)
  const inner = norm(rings.inner)
  if (outer.length < 3) problems.push('外圈至少要 3 个点')
  if (inner.length < 3) problems.push('内圈至少要 3 个点')
  const widthM = outer.length >= 3 && inner.length >= 3 ? ringWidthM(rings) : 0
  if (outer.length < 3 || inner.length < 3) return { ok: false, problems, widthM, innerOutside: 0, crossings: 0 }

  // ① 内圈的每个点都必须在外圈之内
  let innerOutside = 0
  for (const p of inner) if (!pointInRing(p, outer)) innerOutside++
  if (innerOutside > 0) problems.push(`内圈有 ${innerOutside} 个点落在外圈之外 —— 内圈必须整个画在外圈里面`)

  // ② 两圈不能相交（相交时"车道线"必然一头贴外、一头贴内）
  const pr = makeProjector(ringCentroidLat(outer))
  const oXY = outer.map(pr.toXY)
  const iXY = inner.map(pr.toXY)
  let crossings = 0
  for (let i = 0; i < oXY.length; i++) {
    for (let j = 0; j < iXY.length; j++) {
      if (segmentsCross(oXY[i]!, oXY[(i + 1) % oXY.length]!, iXY[j]!, iXY[(j + 1) % iXY.length]!)) crossings++
    }
  }
  if (crossings > 0) problems.push(`内外圈相交 ${crossings} 处 —— 两条圈不能交叉，否则插出来的车道线会一头贴外圈、一头贴内圈`)

  // ③ 环宽（跑道宽度）合理 —— 标准田径场约 8~10 m（含内场缓冲也不该到 20 m）
  if (widthM < 2) problems.push(`内外圈间距只有 ${widthM.toFixed(1)} m，太窄（不像跑道）`)
  else if (widthM > 20)
    problems.push(
      `内外圈间距 ${widthM.toFixed(1)} m，太宽（标准跑道约 8~10 m）—— 这样"第 2 道"离内圈会有好几米，看起来就像压在圈上；建议把外圈贴着跑道外沿、或用「按外圈自动生成内圈」`,
    )

  return { ok: problems.length === 0, problems, widthM, innerOutside, crossings }
}

/**
 * 把闭合圈**向内缩** `meters` 米（真·法向偏移，直道保持直）。
 * 用途：用户只画外圈 ⇒ 一键生成"内圈"（跑道内沿），比手描两条圈靠谱得多。
 */
export function insetClosedRing<T extends { latitude: number | string; longitude: number | string }>(ring: T[], meters: number): T[] {
  const src = norm(ring)
  if (src.length < 3 || !(meters > 0)) return ring.map((p) => ({ ...p }) as T)
  const pr = makeProjector(ringCentroidLat(src))
  const pts = src.map(pr.toXY)
  const ccw = signedArea(pts) > 0
  const out: ReturnType<typeof pr.toLL>[] = []
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length]!
    const cur = pts[i]!
    const next = pts[(i + 1) % pts.length]!
    /** 单位法线（指向环内）：CCW 取左法线，CW 取右法线 */
    const nrm = (a: XY, b: XY): XY => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      return ccw ? { x: -dy / len, y: dx / len } : { x: dy / len, y: -dx / len }
    }
    const n1 = nrm(prev, cur)
    const n2 = nrm(cur, next)
    let nx = n1.x + n2.x
    let ny = n1.y + n2.y
    const nl = Math.hypot(nx, ny)
    if (nl < 1e-9) {
      nx = n1.x
      ny = n1.y
    } else {
      nx /= nl
      ny /= nl
    }
    // miter 修正：转角越尖，沿角平分线要走得更远（夹紧避免自交爆炸）
    const cosHalf = Math.max(0.35, n1.x * nx + n1.y * ny)
    const d = meters / cosHalf
    out.push(pr.toLL({ x: cur.x + nx * d, y: cur.y + ny * d }))
  }
  return out as T[]
}

/** 点到**闭合折线**的最短距离（米）——用于把"车道线离内圈/外圈各多少米"直接显示给用户 */
export function distanceToRingM(p: { latitude: number | string; longitude: number | string }, ring: { latitude: number | string; longitude: number | string }[]): number {
  if (ring.length < 2) return 0
  const pr = makeProjector(ringCentroidLat(ring))
  const q = pr.toXY(p)
  const poly = ring.map(pr.toXY)
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < poly.length; i++) {
    const c = closestOnSegment(q, poly[i]!, poly[(i + 1) % poly.length]!)
    best = Math.min(best, Math.hypot(c.x - q.x, c.y - q.y))
  }
  return best
}

/**
 * 生成**车道中心线**：把**外圈**按等弧长采样，再把每个采样点投影到**内圈上最近的点**，
 * 在两点之间按 `ratio` 线性插值。
 *
 * ⚠️ 为什么不是"内外圈各自等弧长采样 + 按索引配对"（第一版就是这么写的）：
 *    两条圈形状不同（尤其**手描的圈**，拐角位置对不上）时，同一索引的两点**根本不在同一条法线上**，
 *    插出来的线会**一头贴外圈、一头贴内圈**（用户实测就是这个现象）。
 *    沿法向就近配对则**天然**保证插值点落在"外圈点 ↔ 内圈最近点"之间 ⇒ 永远夹在两个环之间。
 *
 * @param ratio  0 = 贴内圈，1 = 贴外圈；也可以是 `(arcM) => ratio`（表达"跑到一半慢慢切到另一条道"）
 */
export function laneLoop(rings: TrackRings, ratio: number | ((arcM: number) => number), samples = 240): LatLng[] {
  const outerRaw = norm(rings.outer)
  const innerRaw = norm(rings.inner)
  if (outerRaw.length < 3 || innerRaw.length < 3) return []
  const n = Math.max(24, Math.round(samples))
  const outer = resampleClosed(outerRaw, n)
  const outerTotal = cumulative(outerRaw).total
  const pr = makeProjector(ringCentroidLat(outerRaw))
  const innerXY = innerRaw.map(pr.toXY)

  const out: { latitude: number; longitude: number }[] = []
  for (let i = 0; i < n; i++) {
    const o = outer[i]!
    const r = typeof ratio === 'function' ? Math.min(1, Math.max(0, ratio((outerTotal * i) / n))) : Math.min(1, Math.max(0, ratio))
    const oXY = pr.toXY(o)
    const q = pr.toLL(closestOnPolyline(oXY, innerXY))
    out.push({
      latitude: Number(q.latitude) + (o.latitude - Number(q.latitude)) * r,
      longitude: Number(q.longitude) + (o.longitude - Number(q.longitude)) * r,
    })
  }
  return out
}

/**
 * 把手工描的闭合圈**平滑**（Chaikin 圆角）。
 * 用途：手上描的点必然有折角，直接拿去插值出来的车道线也是折线；
 *      平滑后人眼一看就是"跑道那种圆滑的圈"。
 * @param iterations 轮数（每轮点数翻倍；2 轮足够，4 轮开始"糊"）
 */
export function smoothClosedRing<T extends { latitude: number; longitude: number }>(ring: T[], iterations = 2): T[] {
  let out: T[] = ring.map((p) => ({ ...p }))
  const rounds = Math.max(0, Math.min(4, Math.round(iterations)))
  for (let it = 0; it < rounds; it++) {
    if (out.length < 3) break
    const next: T[] = []
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!
      const b = out[(i + 1) % out.length]!
      next.push({ ...a, latitude: a.latitude * 0.75 + b.latitude * 0.25, longitude: a.longitude * 0.75 + b.longitude * 0.25 })
      next.push({ ...a, latitude: a.latitude * 0.25 + b.latitude * 0.75, longitude: a.longitude * 0.25 + b.longitude * 0.75 })
    }
    out = next
  }
  return out
}

/* ⚠️ 2026-09-19 删除两个**零引用**的导出：`laneStartIndex()`（东侧起跑点）与
   `rotateLoop()`（按起点旋转车道线）。它们是早期"起跑点固定"方案留下的，后来起跑点由
   `generateRoute.ts` 里的另一套逻辑决定，这两个函数**从未被任何地方引用**（grep 全仓仅声明处）。
   删掉而不是留着：留着会让人误以为"起跑点由这里控制"，从而改错地方。 */

