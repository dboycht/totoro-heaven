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

/* ⚠️ 2026-09-19 删除过两个**当时**零引用的导出：`laneStartIndex()`（东侧起跑点）与一个早期的
   `rotateLoop()`（"固定起跑点"方案留下的）。
   ⚠️ **2026-09-20 更正**：`rotateLoop()` 在 1.1.12 的「起跑点」需求里**被重新实现并投入使用**
   （见本文件下面的 `rotateLoop` / `applyStartToLoop`）—— **起跑点就是靠它按弧长旋转车道线落地的**。
   所以别再按上面那句"起跑点由 generateRoute 决定"去改地方：**改起跑点只能改 `applyStartToLoop`**。 */

// ---------------------------------------------------------------- 起跑点（2026-09-20，1.1.12 需求②）

/**
 * 起跑点是怎么起作用的（**先把机制说清，再谈界面**）：
 *
 *   `generateCorridorRoute(geometry, …)` **永远从 `geometry[0]` 开始按数组顺序推进**
 *   （生成器内部按弧长前进，不认"起点坐标"这种东西）。所以"设置起跑点"在本工程里
 *   **不是**给生成器传一个点，而是**把车道线数组变换一下**：
 *     ① 按弧长**旋转**，让第 0 点落到起跑点处（`rotateLoop`）；
 *     ② 需要反向跑时，把起点保留在第 0 位、其余元素**倒序**（`applyStartToLoop` 的 reverse 分支）。
 *
 *   ⚠️ 判据：**任何"改变起跑点/绕向"的需求，都只能通过这两个函数落到几何上**；
 *      谁也别去改 `generateRoute.ts` 的推进方向（那是拟合度与多圈切圈的公共基准）。
 *
 *   顺带解释"顺时针/逆时针"为什么必须**算出来**而不是写死：
 *      数组顺序本身不含方向语义 —— 有人从东侧起笔、有人从西侧，画出来的 `outer` 数组
 *      可能是 CCW 也可能是 CW。所以界面上的"顺时针/逆时针"由 `ringOrientation(外圈)`
 *      （有向面积符号）与用户选的 `forward/reverse` **共同决定**（`startDirectionLabel`）。
 */

/** 绕向（相对"描圈时点的顺序"而言，与地理方向无关；地理方向由 `startDirectionLabel` 翻译） */
export type LoopDirection = 'forward' | 'reverse'

/** 起跑点设置（存进本地路线库的形态） */
export interface TrackStartInput {
  /** 沿所选车道的弧长偏移（米，0 ~ 该车道周长） */
  offsetM: number
  /** 绕向：`forward` = 沿描圈方向；`reverse` = 反向 */
  direction: LoopDirection
}

/** 闭合圈的绕向：用有向面积符号判定（>0 = 逆时针 CCW） */
export function ringOrientation(ring: LatLng[]): 'ccw' | 'cw' | 'unknown' {
  const pts = norm(ring)
  if (pts.length < 3) return 'unknown'
  const pr = makeProjector(ringCentroidLat(pts))
  return signedArea(pts.map(pr.toXY)) > 0 ? 'ccw' : 'cw'
}

/**
 * 闭合折线上**弧长 `arcM` 处的点**（超出周长自动取模；点数不足/周长非法返回 `null`）。
 * 与 `cumulative`/`resampleClosed` 同一套口径：**弧长从数组第 0 点起算、沿数组顺序增长**。
 */
export function pointAtArcM(loop: LatLng[], arcM: number): LatLng | null {
  const pts = norm(loop)
  if (pts.length < 2) return null
  const { cum, total } = cumulative(pts)
  if (!(total > 0)) return null
  const raw = Number(arcM)
  const target = (((Number.isFinite(raw) ? raw : 0) % total) + total) % total
  let i = 1
  while (i < cum.length - 1 && cum[i]! < target) i++
  const a = pts[i - 1]!
  const b = pts[i % pts.length]!
  const segLen = (cum[i]! - cum[i - 1]!) || 1e-9
  const t = Math.min(1, Math.max(0, (target - cum[i - 1]!) / segLen))
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  }
}

/**
 * 把地图上点选的起跑点**吸附到闭合折线（车道线）上**：
 * 返回线上最近点、它到"数组第 0 点"的弧长偏移，以及**用户点偏了多少米**（`distanceM`，供界面提示）。
 *
 * 为什么要吸附而不是直接存点击坐标：车道线是算法算出来的，人点不到"线上"；
 * 若把点击坐标当起点存下来，轨迹的第 0 点就会**脱离车道线**（起手就是一个偏移点）。
 */
export function snapToLoop(
  loop: LatLng[],
  p: { latitude: number | string; longitude: number | string },
): { point: LatLng; offsetM: number; distanceM: number } | null {
  const pts = norm(loop)
  if (pts.length < 3) return null
  const pr = makeProjector(ringCentroidLat(pts))
  const q = pr.toXY(p)
  const { cum } = cumulative(pts)
  let bestD = Number.POSITIVE_INFINITY
  let bestArc = 0
  let bestXY: XY | null = null
  for (let i = 0; i < pts.length; i++) {
    const aXY = pr.toXY(pts[i]!)
    const bXY = pr.toXY(pts[(i + 1) % pts.length]!)
    const c = closestOnSegment(q, aXY, bXY)
    const d = Math.hypot(c.x - q.x, c.y - q.y)
    if (d < bestD) {
      bestD = d
      bestArc = cum[i]! + Math.hypot(c.x - aXY.x, c.y - aXY.y)
      bestXY = c
    }
  }
  if (!bestXY) return null
  const ll = pr.toLL(bestXY)
  return {
    point: { latitude: ll.latitude, longitude: ll.longitude },
    offsetM: Math.round(bestArc * 10) / 10,
    distanceM: bestD,
  }
}

/**
 * 按弧长**旋转**闭合折线：让第 0 点落到 `offsetM` 处（点数与"等弧长"性质都保持不变）。
 *
 * ⚠️ `offsetM <= 0`（或几何非法）时**原样返回点的一份拷贝** ——
 *    这条短路是**回归保证**：没设起跑点的老数据必须与旧版生成结果**逐点一致**。
 */
export function rotateLoop(loop: LatLng[], offsetM: number): LatLng[] {
  const pts = norm(loop)
  const copy = () => pts.map((p) => ({ ...p }))
  if (pts.length < 3) return copy()
  const off = Number(offsetM)
  if (!(off > 0)) return copy()
  const { total } = cumulative(pts)
  if (!(total > 0)) return copy()
  const start = off % total
  const n = pts.length
  const out: LatLng[] = []
  for (let k = 0; k < n; k++) {
    const p = pointAtArcM(pts, start + (total * k) / n)
    if (p) out.push(p)
  }
  return out.length === n ? out : copy()
}

/**
 * **把起跑点与绕向落到几何上**（唯一入口，跑步引擎与跑道编辑页预览都必须走它）：
 * 先按 `offsetM` 旋转，再在 `reverse` 时把起点留在第 0 位、其余倒序。
 */
export function applyStartToLoop(loop: LatLng[], start?: TrackStartInput | null): LatLng[] {
  const rotated = rotateLoop(loop, Number(start?.offsetM) || 0)
  if (start?.direction !== 'reverse' || rotated.length < 2) return rotated
  return [rotated[0]!, ...rotated.slice(1).reverse()]
}

/**
 * 绕向的**用户可读文案**：把"沿数组顺序 / 反向"翻译成地理上的顺时针 / 逆时针。
 * 圈向未知（点数不足）时退化成"沿描圈方向 / 反向"，**绝不瞎猜顺逆**。
 */
export function startDirectionLabel(ring: LatLng[], direction: LoopDirection): string {
  const o = ringOrientation(ring)
  if (o === 'unknown') return direction === 'reverse' ? '反向' : '沿描圈方向'
  const forward = o === 'ccw' ? '逆时针' : '顺时针'
  const reverse = o === 'ccw' ? '顺时针' : '逆时针'
  return direction === 'reverse' ? reverse : forward
}

