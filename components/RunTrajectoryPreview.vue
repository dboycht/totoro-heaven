<script setup lang="ts">
/**
 * **轨迹预览（可交互矢量地图）** —— 2026-11-03 大改（用户要求）
 *
 * > 用户原话："大改轨道预览相关板块，要求与跑道编辑相关逻辑一致，可以滚轮放大，左键拖动，
 * > 点击单独某圈进行隐藏或者显示等功能"
 *
 * ## 与「跑道编辑」一致的**三件事**（这就是"逻辑一致"的具体含义）
 *   ① **同一套投影**：Web Mercator、`TILE = 256`、`lng2x/lat2y` 与编辑器**逐字相同**
 *      ⇒ 同一个纬度下一屏看到的比例尺一致，不会出现"编辑器里这样、预览里那样"；
 *   ② **滚轮缩放以光标为锚点**，且**必须 `preventDefault`**（否则页面跟着滚 —— 与编辑器同一坑）；
 *   ③ **左键拖动平移**。
 *
 * ## 本组件额外的一件（用户这次要的新功能）
 *   **点某一圈 ⇒ 隐藏/显示那一圈**：细线不好点，所以每圈都叠了一条**透明宽命中线**
 *   （`pointer-events="stroke"` + 14px），图例里的色块**也可点**（同一个动作两个入口）。
 *
 * ## 为什么仍**不请求底图**
 * 旧版的口径是"矢量图，离线绘制、不请求底图"（跑图数据本身完全本地）。
 * 这一版保留这条：缩放/拖动都在本地矢量上做，**不引瓦片**。
 * （现成的 `highmap` 底图接入在「跑道编辑」里；若以后要和编辑器完全同屏，可以在这一步加，但那是另一件事。）
 *
 * ## 三条不许动的不变量
 *   · `:lapLengthM` 必须是**驼峰**绑定（`camelize('lap-length')` ≠ `lapLengthM`，见 ERROR.md E48）；
 *   · 上屏点数报**真实点数**（切圈时交界点会被放进相邻两圈，不能用 `segs.flatMap` 的长度）；
 *   · "离官方路线最远 X m" 与"比例失衡"两句话**保留原措辞**（探针与用户都按它读数）。
 */
import { laneLoop, laneRatioFor, pointAtArcM, type TrackRings } from '~/utils/mp/trackEditor'
// 🆕 2026-09-22（审计 B3 连带）：带 freeShape 的条目画它自己的形状（内外圈只是占位几何，不能当车道线画）
import { freePathPoints, type FreePathShape } from '~/utils/mp/pathShape'
// 🆕 2026-11-03（用户要求"轨迹第 1 圈必须从起跑点开始"）：切圈判据抽成纯函数（有单测）
import { splitLapsByLength } from '~/utils/mp/lapSplit'
// 🆕 2026-11-05（整理轮）：Web Mercator 投影单一来源（与跑道编辑/自由跑共用同一份实现）
import { TILE, lng2x, lat2y, x2lng, y2lat } from '~/utils/mp/webMercator'

/** 本机路线库里的一条（只取画面要用的字段，避免组件依赖整个 TrackRouteEntry） */
type TrackEntryLike = {
  /**
   * 🆕 2026-11-03（1.3.6）：**预设主键**。一个地点可以有多条预设之后，
   * "画哪一条"必须按它来 —— 只按 `lineId` 找会永远画到该地点最新保存的那条。
   */
  id?: string
  lineId: string
  outer: { latitude: string | number; longitude: string | number }[]
  inner: { latitude: string | number; longitude: string | number }[]
  laneNo?: number
  laneCount?: number
  /** 🆕 非官方路径形状（2026-09-22）：有它时画面以它为准，不画内外圈/车道线 */
  freeShape?: FreePathShape
  /** 🆕 起跑点设置（1.1.12）：画一个红点 */
  start?: {
    offsetM?: number
    direction?: string
    point?: { latitude: string | number; longitude: string | number }
  }
}

const props = defineProps<{
  points: (P0 | { latitude: string | number; longitude: string | number })[]
  route?: { latitude: string | number; longitude: string | number }[]
  /** 本机路线库（跑道编辑页描好的内外圈）；用来画跑道两圈与所选车道线 */
  trackEntries?: TrackEntryLike[]
  /** 当前线路 id：决定用路线库里哪一条几何 */
  lineId?: string
  /** 🆕 2026-11-03（1.3.6）：**这次实际要跑的预设 id**（传了就优先按它找条目） */
  presetId?: string
  /** 本次轨迹的"一圈多长"（米）：据此按圈拆段着色；0/缺省 = 整条一色 */
  lapLengthM?: number
  /** 逐圈漂移量（米，来自生成器 `lapDriftM`）：图例里显示"第 N 圈偏了多少" */
  lapDriftM?: number[]
  /**
   * 🆕 2026-11-03（用户要求"轨迹第 1 圈必须从起跑点开始"）：
   * **第 1 圈从第几个点开始**（= 进场段点数；0/缺省 = 没有进场段）。
   * 给了它之后，`points` 里下标更小的那一段会被画成"进场段（不计圈）"，
   * 第 1 圈的第 0 个点就是起跑点 —— 红色起跑点标记于是正好落在第 1 圈的起点上。
   */
  loopStartIndex?: number
}>()

type P0 = { latitude: number; longitude: number }

const W = 900
/** 画布高度（视口高度；不是内容高度 —— 内容随缩放/平移变） */
const H = 460
/** 与跑道编辑页一致：缩放区间（瓦片尺寸 `TILE` 统一从 `utils/mp/webMercator` 取） */
const Z_MIN = 13
const Z_MAX = 22

/**
 * 内部坐标：**用 `latitude/longitude` 命名**（而不是 lat/lng）——
 * `laneLoop` 的入参类型是 `LatLng[]`，命名一致才能直接传进去（省掉一次转换）。
 */
type P = { latitude: number; longitude: number }
const toP = (p: { latitude: string | number; longitude: string | number }): P => ({
  latitude: Number(p.latitude),
  longitude: Number(p.longitude),
})
const finite = (list: P[]) => list.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
/** 任意值 → 合法坐标点（不合法返回 null；只用于可选的起跑点字段） */
const asPoint = (raw: unknown): P | null => {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as { latitude?: unknown; longitude?: unknown }
  const latitude = Number(v.latitude)
  const longitude = Number(v.longitude)
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null
}

/** 两点距离（米，等距近似）——用于"描的圈"与"本次轨迹"相距多远 */
const distBetween = (a: P, b: P): number => {
  const mPerDegLat = 111320
  const mLng = 111320 * Math.cos(((a.latitude + b.latitude) / 2) * (Math.PI / 180))
  return Math.hypot((b.latitude - a.latitude) * mPerDegLat, (b.longitude - a.longitude) * mLng)
}

/** 每圈一个颜色（超出则循环），最后一档用于"其它圈" */
const LAP_COLORS = ['#38bdf8', '#a78bfa', '#22c55e', '#f59e0b', '#f472b6', '#facc15', '#2dd4bf', '#fb7185', '#93c5fd', '#c4b5fd', '#fca5a5', '#86efac']
const OTHER_COLOR = '#94a3b8'
const lapColorOf = (lap0: number) => (lap0 < LAP_COLORS.length ? LAP_COLORS[lap0]! : OTHER_COLOR)

// ---------------------------------------------------------------- 投影（与「跑道编辑」同一份实现，见 `utils/mp/webMercator.ts`）

/** 视图状态：中心经纬度 + 瓦片缩放（小数也能用 ⇒ 滚轮很顺） */
const center = ref<P>({ latitude: 0, longitude: 0 })
const zoom = ref(17)
const viewport = ref({ w: W, h: H })
/** 画布中心对应的世界像素（随 center/zoom 变） */
const originPx = computed(() => ({
  x: lng2x(center.value.longitude, zoom.value) * TILE - viewport.value.w / 2,
  y: lat2y(center.value.latitude, zoom.value) * TILE - viewport.value.h / 2,
}))
/** 经纬度 → 画布像素 */
const pxOf = (p: P) => ({
  x: lng2x(p.longitude, zoom.value) * TILE - originPx.value.x,
  y: lat2y(p.latitude, zoom.value) * TILE - originPx.value.y,
})
/** 画布像素 → 经纬度（滚轮以光标为锚点要用） */
const latLngOf = (x: number, y: number): P => ({
  longitude: x2lng((x + originPx.value.x) / TILE, zoom.value),
  latitude: y2lat((y + originPx.value.y) / TILE, zoom.value),
})

// ---------------------------------------------------------------- 数据准备（沿用旧版的取数口径）
/**
 * 当前选中线路在本机路线库里的几何（没配置过 → undefined，那两层就不画）。
 * 先按预设 id 找（一个地点多条预设 ⇒ 必须画"这次真要跑的那条"），找不到再按 `lineId` 退回。
 */
const entry = computed(() => {
  const list = props.trackEntries ?? []
  const preset = String(props.presetId ?? '')
  if (preset) {
    const hit = list.find((e) => String(e.id ?? e.lineId) === preset)
    if (hit) return hit
  }
  const id = String(props.lineId ?? '')
  if (!id) return undefined
  return list.find((e) => String(e.lineId) === id)
})

/**
 * 内外圈 + 所选车道线（纯函数，与跑道编辑页/真实提交用同一套算法）。
 * 带 `freeShape` 的条目画它自己的形状（内外圈只是占位几何）。
 */
const track = computed(() => {
  const e = entry.value
  if (!e) return null
  const shape = freePathPoints(e.freeShape)
  if (shape.length >= 2) {
    const laneCount = e.laneCount && e.laneCount > 0 ? e.laneCount : 6
    const laneNo = e.laneNo && e.laneNo > 0 ? e.laneNo : Math.max(1, Math.round((laneCount + 1) / 2))
    return { outer: [], inner: [], lane: [], laneNo, laneCount, startPoint: null, shape: finite(shape.map(toP)) }
  }
  const outer = finite((e.outer ?? []).map(toP))
  const inner = finite((e.inner ?? []).map(toP))
  if (outer.length < 3 || inner.length < 3) return null
  const rings: TrackRings = { outer, inner }
  const laneCount = e.laneCount && e.laneCount > 0 ? e.laneCount : 6
  const laneNo = e.laneNo && e.laneNo > 0 ? e.laneNo : Math.max(1, Math.round((laneCount + 1) / 2))
  const lanePts = finite(laneLoop(rings, laneRatioFor(laneNo, laneCount), 240).map(toP))
  /** 起跑点：优先用**存的坐标**；只有偏移没坐标时按弧长反算到车道线上（offsetM=0 且无坐标 ⇒ 不画） */
  const stored = asPoint(e.start?.point)
  const offsetM = Number(e.start?.offsetM ?? 0)
  const startPoint =
    stored ?? (lanePts.length >= 3 && e.start && offsetM > 0 ? asPoint(pointAtArcM(lanePts, offsetM)) : null)
  return { outer, inner, lane: lanePts.length >= 3 ? lanePts : [], laneNo, laneCount, startPoint, shape: [] as P[] }
})

/** 第 n 圈（0 基）的漂移量（米）：来自生成器的 `lapDriftM`；缺失时返回 null（文案不显示） */
const lapDriftOf = (lap0: number): number | null => {
  const arr = props.lapDriftM
  if (!Array.isArray(arr) || lap0 < 0 || lap0 >= arr.length) return null
  const v = Number(arr[lap0])
  return Number.isFinite(v) ? v : null
}

/**
 * 轨迹按"圈"拆段（多圈同色会糊成一条粗带；拆开后每圈一色，重叠也能看出分层）。
 *
 * 🆕 2026-11-03（用户要求"轨迹第 1 圈必须从起跑点开始"）：
 * 切圈从 `loopStartIndex` 开始（= 进场段点数），进场段单独拿出来画成"不计圈"的一段。
 * 判据本体抽到了纯函数 `splitLapsByLength()`（`utils/mp/lapSplit.ts`，有单测）。
 */
const lapSplit = computed(() =>
  splitLapsByLength(
    finite((props.points ?? []).map(toP)),
    Number(props.lapLengthM ?? 0),
    Number(props.loopStartIndex ?? 0),
  ),
)
/** 兼容旧调用点：圈段列表（不含进场段） */
const lapSegments = computed(() => lapSplit.value.laps)

// ---------------------------------------------------------------- 统计（与画法无关的那些读数）
/**
 * 偏离统计 / 比例失衡 / 圈间分离 —— 这些是**事实读数**，与缩放平移无关，只算一次。
 * ⚠️ 其中 `maxDev` / `gapM` 的两句文案是探针与用户的读数入口，措辞不许改（见文件头"不变量"）。
 */
const stats = computed(() => {
  const tr = track.value
  const segs = lapSegments.value
  const pts = finite((props.points ?? []).map(toP))
  const rt = finite((props.route ?? []).map(toP))
  if (pts.length < 2) return null
  /** 偏离统计（米）：等距近似（预览用足够；与真算法同一量级） */
  const mPerDegLat = 111320
  const mPerDegLng = 111320 * Math.cos((((pts[0]!.latitude + pts[pts.length - 1]!.latitude) / 2) * Math.PI) / 180)
  const distToRoute = (p: P) => {
    let best = Number.POSITIVE_INFINITY
    for (let i = 1; i < rt.length; i++) {
      const a = rt[i - 1]!
      const b = rt[i]!
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
      best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    }
    return best
  }
  const devs = rt.length >= 2 ? pts.map(distToRoute).sort((a, b) => a - b) : []
  /** 比例失衡判据：描的圈 / 官方路线与本次轨迹相距极远 ⇒ 整图会被撑到几十公里 */
  const gapM = Math.max(
    tr?.outer?.[0] ? distBetween(pts[0]!, tr.outer[0]) : 0,
    rt[0] ? distBetween(pts[0]!, rt[0]) : 0,
  )
  /** 圈间分离（米）：各圈平均半径的极差 —— 用来看"换圈/漂移到底有没有分开" */
  const mLng = 111320 * Math.cos((pts[0]!.latitude * Math.PI) / 180)
  const cx = pts.reduce((s, p) => s + p.longitude * mLng, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.latitude * mPerDegLat, 0) / pts.length
  const radiusOf = (p: P) => Math.hypot(p.longitude * mLng - cx, p.latitude * mPerDegLat - cy)
  const lapRadii = segs.map((s) => s.pts.reduce((sum, p) => sum + radiusOf(p), 0) / Math.max(1, s.pts.length))
  const spreadM = lapRadii.length > 1 ? Math.max(...lapRadii) - Math.min(...lapRadii) : 0
  return {
    maxDev: devs.length ? devs[devs.length - 1]! : null,
    p95: devs.length ? devs[Math.floor(devs.length * 0.95)]! : null,
    gapM,
    scaleBroken: gapM > 3000,
    spreadM,
    lapCount: segs.length,
    /** ⚠️ 上屏点数必须是**真实点数**（切圈时交界点会被放进相邻两圈，用 segs 会多算） */
    n: pts.length,
    routePoints: rt.length,
    hasTrack: Boolean(tr),
  }
})

// ---------------------------------------------------------------- 隐藏/显示某一圈
/** 被隐藏的圈（键 = 圈序号 1 基；`true` = 隐藏） */
const hiddenLaps = ref<Record<number, boolean>>({})
const isLapHidden = (lap1: number) => Boolean(hiddenLaps.value[lap1])
const toggleLap = (lap1: number) => {
  hiddenLaps.value = { ...hiddenLaps.value, [lap1]: !hiddenLaps.value[lap1] }
}
const hiddenCount = computed(() => Object.values(hiddenLaps.value).filter(Boolean).length)
const showAllLaps = () => {
  hiddenLaps.value = {}
}
const hideAllLaps = () => {
  const next: Record<number, boolean> = {}
  for (const s of lapSegments.value) next[s.lap + 1] = true
  hiddenLaps.value = next
}

// ---------------------------------------------------------------- 绘图（随缩放/平移重算）
/**
 * **形状要不要闭合**（米）。
 *
 * 与 `utils/mp/pathShape.ts` 的「首尾 < 30 m 即闭合」同一个数：
 *   · 手绘圈 / 折线：首尾重合或在几米内 ⇒ 闭合（观感与以前逐字一致）；
 *   · **真实路径**：跑完没回到起点（几十米起）⇒ **不闭合**，不补那条假的斜线。
 */
const SHAPE_CLOSE_TOL_M = 30
const shapeLooksClosed = (pts: P[]): boolean => {
  if (pts.length <= 2) return false
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  const mLat = 111320
  const mLng = 111320 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180)
  const dx = (b.longitude - a.longitude) * mLng
  const dy = (b.latitude - a.latitude) * mLat
  return Math.hypot(dx, dy) <= SHAPE_CLOSE_TOL_M
}

/** SVG 路径（当前视图下） */
const paths = computed(() => {
  const z = zoom.value
  const d = (list: P[], close = false) => {
    if (!list.length) return ''
    const path = list
      .map((p, i) => {
        const x = lng2x(p.longitude, z) * TILE - originPx.value.x
        const y = lat2y(p.latitude, z) * TILE - originPx.value.y
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    return close && list.length > 2 ? `${path} Z` : path
  }
  const tr = track.value
  const rt = finite((props.route ?? []).map(toP))
  return {
    route: rt.length >= 2 ? d(rt) : '',
    outer: tr ? d(tr.outer, true) : '',
    inner: tr ? d(tr.inner, true) : '',
    lane: tr && tr.lane.length >= 3 ? d(tr.lane, true) : '',
    /**
     * 🔴 2026-11-10（用户反馈"真实路径有突变斜线"）：**只有首尾真的接得上才闭合**。
     *
     * 以前是无条件 `d(tr.shape, true)` —— 手绘的圈首尾本来就重合，看不出问题；
     * 但真实路径是**真实跑出来的轨迹**，跑完停在哪就是哪（实测 22 个包首尾全部差 9~153 m）
     * ⇒ 无条件闭合会给每条都补一条斜穿操场的直线，看着像"数据突变"，其实是画出来的。
     * 判据 `SHAPE_CLOSE_TOL_M` 与 `utils/mp/pathShape.ts` 的"首尾 < 30 m 即闭合"同一个数。
     */
    shape: tr && tr.shape.length >= 2 ? d(tr.shape, shapeLooksClosed(tr.shape)) : '',
  }
})
/** 进场段（第 1 圈之前的点）：单独一段，**不计圈**、不上色（灰色实线） */
const leadInPath = computed(() => {
  const list = lapSplit.value.leadIn
  if (!list.length) return ''
  /**
   * 🆕 2026-11-04（用户实测"灰线没有接到起跑点"）：切圈口径里**交界点归属两圈**，
   * 但 `leadIn = points[0..loopStartIndex-1]` **不含**第 1 圈的首点（= 起跑点）⇒
   * 灰线停在最后一个步行插值点（演示步长 20 m 时断口 20 m），红点孤在前面。
   * 画图时把第 1 圈首点补上，灰线才真正落到红点上 —— **数据口径不变**（"进场段 N 点"仍不含起跑点）。
   */
  const firstLapPt = lapSplit.value.laps[0]?.pts?.[0]
  const pts = firstLapPt ? [...list, firstLapPt] : list
  if (pts.length < 2) return ''
  return pts
    .map((p, i) => {
      const x = lng2x(p.longitude, zoom.value) * TILE - originPx.value.x
      const y = lat2y(p.latitude, zoom.value) * TILE - originPx.value.y
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})
/** 每圈一条路径（隐藏的圈**不画**；图例里仍然列出来，用来恢复） */
const lapPaths = computed(() =>
  lapSegments.value
    .filter((s) => !isLapHidden(s.lap + 1))
    .map((s) => ({
      lap: s.lap + 1,
      d: s.pts
        .map((p, i) => {
          const x = lng2x(p.longitude, zoom.value) * TILE - originPx.value.x
          const y = lat2y(p.latitude, zoom.value) * TILE - originPx.value.y
          return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' '),
      color: lapColorOf(s.lap),
      label: s.lap < LAP_COLORS.length ? `第 ${s.lap + 1} 圈` : '其它圈',
    })),
)
/** 起跑点 / 轨迹起点 的屏幕坐标 */
const markers = computed(() => {
  const pts = finite((props.points ?? []).map(toP))
  const tr = track.value
  return {
    start: pts.length ? pxOf(pts[0]!) : null,
    startMarker: tr?.startPoint ? pxOf(tr.startPoint) : null,
  }
})

// ---------------------------------------------------------------- 视图操作：适应视图 / 缩放 / 拖动
/** 内容外接框（所有要画的东西） */
const contentBounds = computed(() => {
  const tr = track.value
  const segs = lapSegments.value
  const pts = segs.flatMap((s) => s.pts)
  const rt = finite((props.route ?? []).map(toP))
  const all = [...pts, ...rt, ...(tr ? [...tr.outer, ...tr.inner, ...tr.lane, ...tr.shape] : [])]
  if (!all.length) return null
  return {
    minLat: Math.min(...all.map((p) => p.latitude)),
    maxLat: Math.max(...all.map((p) => p.latitude)),
    minLng: Math.min(...all.map((p) => p.longitude)),
    maxLng: Math.max(...all.map((p) => p.longitude)),
  }
})
const clampZoom = (z: number) => Math.min(Z_MAX, Math.max(Z_MIN, z))
/**
 * **适应视图**：把内容装进画布（留 `PAD` 边距）。
 * 做法与编辑器一致：在 `Z_MIN..Z_MAX` 里挑一个刚好装得下的缩放级。
 */
const fitView = () => {
  const b = contentBounds.value
  const vp = viewport.value
  if (!b) return
  const midLat = (b.minLat + b.maxLat) / 2
  const midLng = (b.minLng + b.maxLng) / 2
  const spanM = Math.max(1, (b.maxLat - b.minLat) * 111320, (b.maxLng - b.minLng) * 111320 * Math.cos((midLat * Math.PI) / 180))
  /** 目标：内容占画布 ~76% */
  const usable = Math.min(vp.w, vp.h) * 0.76
  /** 每米对应的世界像素（在 zoom z 下：TILE * 2^z / 地球周长），反解 z */
  const EARTH_C = 40075016.686
  const z = Math.log2((usable * EARTH_C) / (TILE * spanM))
  zoom.value = clampZoom(z)
  center.value = { latitude: midLat, longitude: midLng }
}

/** 滚轮缩放（以光标为锚点；**必须非 passive + preventDefault**，否则整页跟着滚 —— 与编辑器同一坑） */
const onWheel = (ev: WheelEvent) => {
  ev.preventDefault()
  const el = mapEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  /** 画布可能被 CSS 缩放过 ⇒ 把屏幕坐标换成 viewBox 坐标 */
  const mx = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * viewport.value.w
  const my = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * viewport.value.h
  const before = latLngOf(mx, my)
  const step = ev.deltaY > 0 ? -0.25 : 0.25
  zoom.value = clampZoom(zoom.value + step)
  const after = latLngOf(mx, my)
  /** 把光标下的点重新对回原处：中心按差值平移 */
  center.value = {
    latitude: center.value.latitude + (before.latitude - after.latitude),
    longitude: center.value.longitude + (before.longitude - after.longitude),
  }
}

/** 左键拖动平移 */
const drag = { active: false, moved: 0, from: { x: 0, y: 0 }, center: { latitude: 0, longitude: 0 } }
const onDown = (ev: MouseEvent) => {
  if (ev.button !== 0) return
  if (!mapEl.value) return
  drag.active = true
  drag.moved = 0
  drag.from = { x: ev.clientX, y: ev.clientY }
  drag.center = { ...center.value }
  /** 在画布上按下时不要顺手选中文字 */
  ev.preventDefault()
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
/**
 * 拖动：屏幕位移 → 世界瓦片坐标位移 → 反算中心经纬度。
 *
 * ⚠️ 不要"用度/米硬凑"（第一版那样写会随纬度漂移）—— 直接在世界瓦片坐标系里平移再反算，
 * 与滚轮缩放用的是**同一套投影**，所以放大/缩小时手感一致。
 */
const onMove = (ev: MouseEvent) => {
  if (!drag.active) return
  const el = mapEl.value
  const rect = el ? el.getBoundingClientRect() : null
  /** 画布被 CSS 拉伸过 ⇒ 屏幕像素先换算回 viewBox 像素 */
  const sx = rect ? viewport.value.w / Math.max(1, rect.width) : 1
  const sy = rect ? viewport.value.h / Math.max(1, rect.height) : 1
  const dxPx = (ev.clientX - drag.from.x) * sx
  const dyPx = (ev.clientY - drag.from.y) * sy
  drag.moved = Math.max(drag.moved, Math.hypot(dxPx, dyPx))
  const z = zoom.value
  const tileX = lng2x(drag.center.longitude, z) - dxPx / TILE
  const tileY = lat2y(drag.center.latitude, z) - dyPx / TILE
  center.value = { latitude: y2lat(tileY, z), longitude: x2lng(tileX, z) }
}
const onUp = () => {
  drag.active = false
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
  /** 松开后再下一帧才允许"点击"（否则拖动结尾会被当成点圈） */
  window.setTimeout(() => {
    drag.moved = 0
  }, 0)
}
/** 点某一圈（命中线 / 图例都走它）。拖动过就不当点击。 */
const onLapClick = (lap1: number, ev?: MouseEvent) => {
  if (drag.moved > 4) return
  if (ev) ev.stopPropagation()
  toggleLap(lap1)
}

const mapEl = ref<HTMLElement | null>(null)
/** 容器尺寸（CSS 宽度可变；内部坐标系固定为 viewBox 的 w/h） */
const syncViewport = () => {
  viewport.value = { w: W, h: H }
}
/**
 * ⚠️ **滚轮监听必须跟着元素出现/消失绑定**（2026-11-03 实测踩到）：
 * 这个组件在本页一挂载就存在，而画布在 `v-if="stats"` 里面 —— **还没跑过的时候画布并不存在**，
 * 所以 `onMounted` 里 `mapEl.value` 是 null，监听器绑不上 ⇒ 滚轮不缩放、整页跟着滚（探针实测：
 * 缩放前后跨度一模一样，且 `window.scrollY` 从 1266 跳到 786）。
 * 用 `watch(mapEl, ..., { flush: 'post' })` 在元素真正插入 DOM 之后再绑。
 */
let boundEl: HTMLElement | null = null
const bindWheel = () => {
  const el = mapEl.value ?? null
  if (el === boundEl) return
  boundEl?.removeEventListener('wheel', onWheel)
  boundEl = el
  boundEl?.addEventListener('wheel', onWheel, { passive: false })
}
watch(mapEl, bindWheel, { flush: 'post' })
onMounted(() => {
  syncViewport()
  fitView()
  bindWheel()
})
onBeforeUnmount(() => {
  boundEl?.removeEventListener('wheel', onWheel)
  boundEl = null
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
})
/**
 * 内容变了就**重新适应视图**（换了一条轨迹 / 换了预设）。
 * ⚠️ 只在这两个键变化时自动适配 —— 用户手动拖到某处看细节时，不能因为一次重绘被拽回去。
 */
watch(
  () => [finite((props.points ?? []).map(toP)).length, String(entry.value?.id ?? entry.value?.lineId ?? '')] as const,
  () => {
    hiddenLaps.value = {}
    fitView()
  },
)
</script>

<template>
  <v-card class="mt-4">
    <v-card-title class="text-subtitle-1 d-flex flex-wrap align-center ga-2">
      轨迹预览
      <span class="text-caption text-medium-emphasis">（矢量图，离线绘制、不请求底图）</span>
      <v-spacer />
      <!-- 与「跑道编辑」一致的操作提示 + 视图按钮 -->
      <span class="text-caption text-medium-emphasis mr-1">滚轮缩放 · 左键拖动 · 点某一圈可隐藏/显示</span>
      <v-btn size="x-small" variant="tonal" prepend-icon="mdi-magnify-plus-outline" @click="zoom = clampZoom(zoom + 0.5)">放大</v-btn>
      <v-btn size="x-small" variant="tonal" prepend-icon="mdi-magnify-minus-outline" @click="zoom = clampZoom(zoom - 0.5)">缩小</v-btn>
      <v-btn size="x-small" variant="tonal" prepend-icon="mdi-fit-to-page-outline" @click="fitView">适应视图</v-btn>
      <v-btn v-if="hiddenCount" size="x-small" variant="text" @click="showAllLaps">显示全部（{{ hiddenCount }} 圈已隐藏）</v-btn>
      <v-btn v-else-if="lapSegments.length > 1" size="x-small" variant="text" @click="hideAllLaps">隐藏全部圈</v-btn>
    </v-card-title>
    <v-card-text>
      <template v-if="stats">
        <!-- 描的圈与本次轨迹相距极远（多半是描错了圈/选了别的校区）：整图会被撑到几十公里 -->
        <v-alert v-if="stats.scaleBroken" type="error" variant="tonal" density="compact" class="mb-3">
          <div class="font-weight-bold">这张图的比例失衡了：你描的圈与本次轨迹不在同一处。</div>
          <div class="text-caption mt-1">
            两者相距约 <b>{{ (stats.gapM / 1000).toFixed(1) }} km</b> —— 多半是<b>描错了线路</b>（描到别的校区去了），
            或这条本地路线是用别的线路的几何存的。请回「跑道编辑」：选对线路 →「快速定位」→ 对着<b>卫星图</b>重描一次即可。
          </div>
        </v-alert>

        <!-- 地图本体：滚轮缩放 / 左键拖动 / 点圈隐藏（与跑道编辑同一套交互） -->
        <div ref="mapEl" class="traj-map" @mousedown="onDown">
          <svg :viewBox="`0 0 ${W} ${H}`" style="width: 100%; height: auto; display: block; cursor: grab">
            <rect x="0" y="0" :width="W" :height="H" fill="#0b1220" />
            <!-- 官方路线（灰虚线，仅作对照） -->
            <path v-if="paths.route" :d="paths.route" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="5 4" />
            <!-- 内外圈 / 车道线 / 非官方形状（与跑道编辑同色） -->
            <path v-if="paths.outer" :d="paths.outer" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9" />
            <path v-if="paths.inner" :d="paths.inner" fill="none" stroke="#a78bfa" stroke-width="1.4" opacity="0.9" />
            <path v-if="paths.lane" :d="paths.lane" fill="none" stroke="#22c55e" stroke-width="1" opacity="0.7" />
            <path v-if="paths.shape" :d="paths.shape" fill="none" stroke="#e879f9" stroke-width="1.6" opacity="0.9" />

            <!-- 进场段（从进场点走到起跑点的那一段）：灰色实线，不计圈、不参与按圈着色 -->
            <path v-if="leadInPath" :d="leadInPath" fill="none" stroke="#cbd5e1" stroke-width="1.6" opacity="0.85" stroke-linecap="round" />

            <!-- 每圈一色、细线；下面再叠一条透明宽命中线用于点击隐藏/显示 -->
            <g v-for="p in lapPaths" :key="`lap-${p.lap}`">
              <path :d="p.d" :data-lap="p.lap" fill="none" :stroke="p.color" stroke-width="1.2" opacity="0.95" />
              <path
                :d="p.d"
                :data-lap-hit="p.lap"
                fill="none"
                stroke="rgba(0,0,0,0)"
                stroke-width="14"
                pointer-events="stroke"
                style="cursor: pointer"
                @click="onLapClick(p.lap, $event)"
              />
            </g>

            <!-- 起点（橙）/ 起跑点（红） -->
            <circle v-if="markers.start" :cx="markers.start.x" :cy="markers.start.y" r="3.5" fill="#f59e0b" stroke="#fff" stroke-width="1.2" />
            <circle
              v-if="markers.startMarker"
              :cx="markers.startMarker.x"
              :cy="markers.startMarker.y"
              r="4.5"
              fill="#ef4444"
              stroke="#fff"
              stroke-width="1.4"
            />
          </svg>
        </div>

        <div class="text-caption text-medium-emphasis mt-2">
          <template v-if="paths.outer">
            <b>本次轨迹是按你描的跑道（绿线=所选第 {{ track?.laneNo ?? '—' }} 道）生成的。</b>
            蓝实线 = 外圈　紫线 = 内圈　
          </template>
          橙点 = 本次轨迹起点<template v-if="markers.startMarker">　红点 = 你设的起跑点</template>　
          灰虚线 = 官方路线（{{ stats.routePoints }} 点），仅作对照
          <template v-if="stats.maxDev !== null">
            　轨迹离这条<b>官方路线</b>最远 <b>{{ stats.maxDev.toFixed(1) }} m</b>（P95 {{ stats.p95 !== null ? stats.p95.toFixed(1) : '—' }} m）
            —— ⚠️ 这个数是<b>到官方路线</b>的距离，偏大<b>不代表你跑偏了</b>：
            官方路线本身就可能与真实跑道差十几米到几十米（提交时服务端仍按官方路线算拟合度，所以它仍有参考意义）。
          </template>
        </div>

        <!-- 按圈图例（可点 = 隐藏/显示那一圈，与在地图上点线是同一个动作） -->
        <div class="d-flex flex-wrap align-center ga-2 mt-2">
          <span class="text-caption text-medium-emphasis">
            共 <b>{{ stats.lapCount }}</b> 圈，每圈一色（{{ stats.n }} 点）· 点色块可隐藏/显示：
          </span>
          <button
            v-for="s in lapSegments"
            :key="`lg-${s.lap}`"
            type="button"
            class="lap-chip"
            :class="{ 'lap-chip--off': isLapHidden(s.lap + 1) }"
            :data-lap-legend="s.lap + 1"
            @click="onLapClick(s.lap + 1)"
          >
            <span class="lap-chip__swatch" :style="{ background: lapColorOf(s.lap) }" />
            {{ s.lap < LAP_COLORS.length ? `第 ${s.lap + 1} 圈` : '其它圈' }}<template v-if="lapDriftOf(s.lap) !== null">
              （相对模板 {{ lapDriftOf(s.lap)! >= 0 ? '+' : '' }}{{ lapDriftOf(s.lap)!.toFixed(1) }} m）</template
            >
          </button>
          <span v-if="stats.spreadM > 0" class="text-caption text-medium-emphasis">
            · 各圈平均半径差 <b>{{ stats.spreadM.toFixed(1) }} m</b>（放大后可看清分层）
          </span>
          <span v-if="lapSplit.leadIn.length" class="text-caption text-medium-emphasis" :data-lead-in="lapSplit.leadIn.length">
            · 另有<b>进场段 {{ lapSplit.leadIn.length }} 点</b>（灰实线，<b>不计圈</b>；第 1 圈从起跑点开始）
          </span>
        </div>

        <v-alert v-if="stats.maxDev !== null && stats.maxDev > 25" type="warning" variant="tonal" density="compact" class="mt-2">
          轨迹离<b>官方路线</b>超过了拟合度判据的容差（25 m）。
          <div class="mt-1">
            ⚠️ <b>这不代表你跑偏了</b> —— 官方路线本身就可能与真实跑道差十几到几十米
            （实测中位 11.6 m、最远 50 m）；本轨迹是按<b>你描的跑道</b>生成的，以图上那两圈为准。
            该数值偏大时，服务端判分可能不认这段轨迹，所以依然值得留意。
          </div>
        </v-alert>
      </template>
      <div v-else class="text-caption text-medium-emphasis">还没有轨迹（先「开始跑步」生成并结算）</div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.traj-map {
  user-select: none;
  touch-action: none;
}
.lap-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  padding: 1px 8px;
  color: inherit;
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}
.lap-chip:hover {
  border-color: rgba(255, 255, 255, 0.4);
}
.lap-chip--off {
  opacity: 0.42;
  text-decoration: line-through;
}
.lap-chip__swatch {
  display: inline-block;
  width: 14px;
  height: 3px;
  border-radius: 2px;
}
</style>
