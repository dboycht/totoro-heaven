<script setup lang="ts">
/**
 * 跑道编辑器（2026-09-17 用户方案）：
 *   ① 加载地图（高德瓦片，免 key，仅本地展示）
 *   ② 叠加**官方路线**（白虚线）作对照
 *   ③ 用户描**外圈**与**内圈**（点地图加点、可拖点/删点/撤销、可用官方路线打底）
 *   ④ 算法在这两圈之间生成**某一道**的车道线（随机道次 + 缓慢换道）
 *   ⑤ 再叠加**真实抖动**（参数来自真跑实测）生成最终轨迹预览
 *
 * 存储：本机 localStorage，按 lineId 保存（`mp_track_rings_v1`）——运行时数据不入库。
 */
import {
  applyStartToLoop,
  laneLoop,
  laneRatioFor,
  pointAtArcM,
  ringLengthM,
  ringWidthM,
  smoothClosedRing,
  snapToLoop,
  startDirectionLabel,
  validateRings,
  insetClosedRing,
  distanceToRingM,
  type LoopDirection,
  type TrackRings,
} from '~/utils/mp/trackEditor'
import {
  LOCAL_FREE_LINE_ID,
  TRACK_HISTORY_MAX,
  entryDetailRows,
  entrySummaryText,
  historyLogText,
  localFreeTrackLine,
  resolveEntryName,
  startSummaryText,
} from '~/utils/mp/trackLibrary'
import {
  curveLengthM,
  expandFreePathTrajectory,
  freePathShapeText,
  lineLengthM,
  normalizeFreePathTrips,
  planFreePathTrips,
  polylineLengthM,
  usableFreePathShape,
  type FreePathShape,
} from '~/utils/mp/pathShape'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import { distanceMeters, type LatLng } from '~/utils/mp/routeSimilarity'
import type { MpRunLine } from '~/src/mp/types'
// 🆕 2026-09-22（issue #12）：判"任务到底有没有下发线路"（纯函数，与跑步页/门禁同源）
import { routeRequirementOf } from '~/utils/mp/taskShape'

/** 契约层坐标（latitude/longitude 可能是字符串） */
type P = LatLng
/** 内部数值型坐标（**所有算术/存本机都用它**；N 可赋给 LatLng，反之不行） */
type N = { latitude: number; longitude: number }
const num = (p: LatLng): N => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })

// 与 run.vue 同一套取法：`useMpReal()` 返回 profile/status/task（真实链路），演示态用 useMpDemo 的 task 兜底
const { profile: realProfile, status: realStatus, task: realTask } = useMpReal()
const { task: demoTask } = useMpDemo()
const activeTask = computed(() => realTask.value ?? demoTask.value)
/** 服务端下发的线路（**原样**，不加任何本机条目） */
const activeLines = computed(() => activeTask.value?.runPointList ?? [])
/**
 * 🆕 2026-09-22（issue #12，用户实测 bug）：**本任务有没有下发线路**。
 * 唯一判据来源是纯函数 `routeRequirementOf`（`utils/mp/taskShape.ts`）——与跑步页/门禁同源，
 * 不许在这里另写一套"线路为空"的判断。
 *
 * `routeIsFree === true` = 服务端未下发线路（如「研途健行」）⇒ 下拉里**不会**有官方线路，
 * 但用户**必须**能描一条本机跑道（本版口径：轨迹基于用户自己描的几何），否则永远跑不了。
 */
const routeIsFree = computed(() => routeRequirementOf(activeTask.value).kind === 'free')
/**
 * 任务未下发线路时，编辑器里那条**固定标识的「本机跑道」条目**（`lineId = 'local:free'`）；
 * 任务下发了线路时恒为 `null` ⇒ **有线路的任务行为零变化**（见 `localFreeTrackLine` 的说明）。
 */
const localFreeLine = computed(() => localFreeTrackLine(activeTask.value))
const showSnackbar = useNotice()

// ---------- 地图（Web Mercator 滑溜地图：瓦片 + SVG 叠加）----------
const Z_MIN = 13
const Z_MAX = 19
const center = ref<N>({ latitude: 31.3735, longitude: 119.4808 }) // 默认：天目湖校区
const zoom = ref(17)
const TILE = 256

const lng2x = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z
const lat2y = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z
}
const x2lng = (x: number, z: number) => (x / 2 ** z) * 360 - 180
const y2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

const viewport = ref({ w: 900, h: 560 })
/**
 * 地图图层：
 *   road      = 高德街道图（style=7）
 *   satellite = 卫星影像（style=6，webst0x 域）—— 看操场实景最清楚
 *   hybrid    = 卫星影像 + 路网/地名标注（style=8，wprd0x 域叠在上层）
 */
const mapStyle = ref<'road' | 'satellite' | 'hybrid'>('satellite')
const roadTileUrl = (x: number, y: number, z: number, style: number) => {
  const sub = ((x + y) % 4) + 1
  return style === 7 || style === 8
    ? `https://wprd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=${style}&x=${x}&y=${y}&z=${z}`
    : `https://webst0${sub}.is.autonavi.com/appmaptile?style=${style}&x=${x}&y=${y}&z=${z}`
}
const centerPx = computed(() => ({ x: lng2x(center.value.longitude, zoom.value) * TILE, y: lat2y(center.value.latitude, zoom.value) * TILE }))
const originPx = computed(() => ({ x: centerPx.value.x - viewport.value.w / 2, y: centerPx.value.y - viewport.value.h / 2 }))

/** 经纬度 → 屏幕像素（相对画布左上角） */
const toPx = (raw: P) => {
  const p = num(raw)
  return {
    x: lng2x(p.longitude, zoom.value) * TILE - originPx.value.x,
    y: lat2y(p.latitude, zoom.value) * TILE - originPx.value.y,
  }
}
/** 屏幕像素 → 经纬度 */
const toLatLng = (x: number, y: number): N => ({
  longitude: x2lng((x + originPx.value.x) / TILE, zoom.value),
  latitude: y2lat((y + originPx.value.y) / TILE, zoom.value),
})

const tileRange = computed(() => {
  const z = zoom.value
  const x0 = Math.floor(originPx.value.x / TILE)
  const y0 = Math.floor(originPx.value.y / TILE)
  const x1 = Math.floor((originPx.value.x + viewport.value.w) / TILE)
  const y1 = Math.floor((originPx.value.y + viewport.value.h) / TILE)
  const max = 2 ** z
  const out: { x: number; y: number; wx: number; key: string }[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= max) continue
      out.push({ x, y, wx: ((x % max) + max) % max, key: `${z}/${x}/${y}` })
    }
  }
  return out
})

/** 底图瓦片（按图层选 style） */
const tiles = computed(() =>
  tileRange.value.map((t) => ({
    key: `b-${t.key}`,
    url: roadTileUrl(t.wx, t.y, zoom.value, mapStyle.value === 'road' ? 7 : 6),
    left: t.x * TILE - originPx.value.x,
    top: t.y * TILE - originPx.value.y,
  })),
)
/** 叠加层：卫星图时再叠一层"路网 + 地名"（style=8），否则没有 */
const overlayTiles = computed(() =>
  mapStyle.value === 'hybrid'
    ? tileRange.value.map((t) => ({
        key: `o-${t.key}`,
        url: roadTileUrl(t.wx, t.y, zoom.value, 8),
        left: t.x * TILE - originPx.value.x,
        top: t.y * TILE - originPx.value.y,
      }))
    : [],
)

// ---------- 本地路线库（含创建日期/版本）+ 正在编辑的草稿 ----------
/**
 * 下拉里可选的东西 = **服务端线路** ＋（仅当任务未下发线路时）那条**本机跑道**。
 *
 * ⚠️ 本机跑道是"伪装成线路"的 `MpRunLine`：`pointList: []`（本任务没有官方模板点列，
 *    如实留空 ⇒ 地图上那条白虚线不会画出来、"用官方路线打底"对它无效），
 *    但 `pointId` 就是本机路线库的**键名** ⇒ 保存/载入/改名/删除全走既有的路线库路径。
 */
const lines = computed<MpRunLine[]>(() => {
  const vendor = activeLines.value ?? []
  const local = localFreeLine.value
  if (!local) return vendor
  return [...vendor, { pointId: local.lineId, pointName: local.lineName, pointList: [] }]
})
const lineId = ref<string>('')
const lib = useTrackLibrary()
/** 模板里要用的 ref 需要拿出来（嵌套在对象里的 ref 模板不会自动解包） */
const libEntries = lib.entries
const draftOuter = ref<N[]>([])
const draftInner = ref<N[]>([])
/**
 * 🆕 **起跑点草稿**（2026-09-20，1.1.12 需求②）：
 *   · `draftStartOffsetM` = 沿所选车道的弧长偏移（米）；`draftStartPoint` = 吸附后的坐标；
 *   · `draftStartDirection` = 绕向（`forward` = 沿描圈方向）；
 *   · 三者**永远由同一批函数一起改**（`setStartFromMap` / `onStartOffsetInput` / `clearStart`），
 *     不允许某个入口只改其中一个 —— 否则"坐标与偏移对不上"，轨迹起点会飘。
 */
const draftStartOffsetM = ref(0)
const draftStartPoint = ref<N | null>(null)
const draftStartDirection = ref<LoopDirection>('forward')
const loadDraft = (id: string) => {
  const e = lib.get(id)
  draftOuter.value = (e?.outer ?? []).map(num)
  draftInner.value = (e?.inner ?? []).map(num)
  draftStartOffsetM.value = Number(e?.start?.offsetM ?? 0)
  draftStartPoint.value = e?.start?.point ? num(e.start.point) : null
  draftStartDirection.value = e?.start?.direction === 'reverse' ? 'reverse' : 'forward'
  // 🆕 2026-09-22：把这条记录存的**非官方路径形状**也一起载入（没有它 ⇒ 退回双圈模式）
  loadFreeDraft(e?.freeShape)
}
onMounted(() => {
  lib.load()
  const el = mapEl.value
  if (el) viewport.value = { w: el.clientWidth, h: el.clientHeight }
  window.addEventListener('resize', onResize)
  loadDraft(lineId.value)
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
const onResize = () => {
  const el = mapEl.value
  if (el) viewport.value = { w: el.clientWidth, h: el.clientHeight }
}

const mapEl = ref<HTMLElement | null>(null)
/**
 * 当前编辑**哪一样东西**：外圈 / 内圈 / 起跑点。
 * 🆕 2026-09-20（1.1.12 需求②）：多出 `'start'` —— 选中它时**地图单击 = 点选起跑点**
 * （不再往圈里加点）。为此下面所有"对当前圈操作"的函数都改走 `ringTarget`（永不为 `'start'`）。
 */
const editing = ref<'outer' | 'inner' | 'start'>('outer')
/** "当前圈"的收窄版本：只可能是 outer/inner（起跑点模式下不参与圈的编辑） */
const ringTarget = computed<'outer' | 'inner'>(() => (editing.value === 'inner' ? 'inner' : 'outer'))
const outer = computed(() => draftOuter.value)
const inner = computed(() => draftInner.value)
const setRing = (which: 'outer' | 'inner', pts: N[]) => {
  if (which === 'outer') draftOuter.value = pts
  else draftInner.value = pts
}
/** 切换线路 ⇒ 自动载入那条线路已保存的草稿（没保存过就是空的） */
watch(lineId, (id) => loadDraft(String(id ?? '')))

// ---------------------------------------------------------------- 【测试】非官方路径绘制（2026-09-22）

/**
 * ## 这是什么（用户原话）
 * > "主要的功能是绘制**非官方性路径**……点击**定位**按钮，相关的地图移动到定位位置，
 * >  用户可以选择**圈型**，或者**直线型**【直线型又有**折返性**】，然后绘制那些路径"
 *
 * ## 交互口径（为什么这么定）
 *   · **只在"任务未下发线路"时出现**（`localFreeLine` 非空）—— 有线路的任务**零变化**：
 *     它有自己的官方路线与双圈几何，硬塞一条"非官方路径"只会让人分不清在存什么；
 *   · 它与既有的「外圈/内圈/起跑点」编辑**互斥**：`freeMode` 非空时，地图点击一律走
 *     `onFreeMapClick`，不再往圈里加点（避免"我以为在画曲线、其实在上一个圈上加了个点"）；
 *   · 几何与趟数的算法全部在 `utils/mp/pathShape.ts`（纯函数、有单测），**界面不自己算**。
 */
const freeMode = ref<'off' | 'curve' | 'line'>('off')
/** 圈型草稿点（**不重复存收盘点** —— 闭合由算法统一补，界面只负责"点了几笔"） */
const draftFreePoints = ref<N[]>([])
/** 直线型草稿的两端（`lineFrom` = 起点，点第二下就是终点） */
const draftLineFrom = ref<N | null>(null)
const draftLineTo = ref<N | null>(null)
/** 目标里程（km，用于"自动算趟数"）—— 默认 3.2，与既有轨迹预览的口径一致 */
const freeTargetKm = ref(3.2)
/** 用户手填的趟数（空串/0/非法 = 回落到自动算，判据在 `normalizeFreePathTrips`） */
const freeTripsInput = ref<number | null>(null)

/** 当前草稿构成的形状（`null` = 还没画够） */
const draftFreeShape = computed<FreePathShape | null>(() => {
  if (freeMode.value === 'curve') {
    return draftFreePoints.value.length >= 2 ? { kind: 'curve', points: draftFreePoints.value.map((p) => ({ ...p })) } : null
  }
  if (freeMode.value === 'line' && draftLineFrom.value && draftLineTo.value) {
    return {
      kind: 'line',
      from: { latitude: draftLineFrom.value.latitude, longitude: draftLineFrom.value.longitude },
      to: { latitude: draftLineTo.value.latitude, longitude: draftLineTo.value.longitude },
    }
  }
  return null
})
/** 草稿是否**可用**（长度 > 0）—— 保存按钮的判据 */
const draftFreeUsable = computed(() => usableFreePathShape(draftFreeShape.value))
/** 趟数计划（自动/手填都在这里算，界面只渲染它的结果） */
const freePlan = computed(() => planFreePathTrips(draftFreeShape.value, freeTargetKm.value, freeTripsInput.value))
/** 手填的趟数是否非法（非法时界面要说明"已按自动算"） */
const freeTripsManualInvalid = computed(
  () => freeTripsInput.value !== null && freeTripsInput.value !== undefined && normalizeFreePathTrips(freeTripsInput.value) === null,
)

/** 当前画到哪儿了（给用户的实时反馈；**纯文本，不带 markdown 标记**——模板里是原样渲染的） */
const freeStatusText = computed(() => {
  if (freeMode.value === 'curve') {
    const n = draftFreePoints.value.length
    if (n === 0) return '还没开始：在地图上依次点出边缘的几个点（至少 3 个），算法会自动把首尾闭合起来'
    if (n < 3) return `已点 ${n} 个点，还不够闭合成曲线（至少 3 个点）`
    return `已点 ${n} 个点，已闭合成曲线（算法自动补上"最后一点 → 第一点"这一段）`
  }
  if (freeMode.value === 'line') {
    if (!draftLineFrom.value) return '还没开始：在地图上点出这条直路的起点'
    if (!draftLineTo.value) return '已选起点：再点一下终点（A→B，之后按折返跑）'
    return '已选好起点与终点（A→B，来回跑）'
  }
  return ''
})

/** 地图上要画的非官方路径（闭合曲线按闭合画，直线型就是一条线段） */
const freeShapePath = computed<N[]>(() => {
  if (freeMode.value === 'curve') return draftFreePoints.value
  if (freeMode.value === 'line' && draftLineFrom.value && draftLineTo.value) return [draftLineFrom.value, draftLineTo.value]
  return []
})

/**
 * 非官方路径的**最终轨迹预览**（橙色那条线）。
 * 与跑步页**同一套算法**：`expandFreePathTrajectory` 出几何 → `generateCorridorRoute` 出带抖动的轨迹。
 * 这样"预览里看到的形状"就是"开跑后跑出来的形状"（所见即所跑）。
 */
const freeTrajectory = computed<N[]>(() => {
  if (!draftFreeUsable.value || !draftFreeShape.value) return []
  const trips = Math.max(1, Math.min(8, freePlan.value.trips || 1))
  const geom = expandFreePathTrajectory(draftFreeShape.value, trips)
  if (geom.length < 2) return []
  try {
    /**
     * ⚠️ `smoothRoute: 0` **必须**：生成器默认的 2 轮 Chaikin 圆角会在**折返点（180°）**把几何毁掉
     *   —— 实测一条 313.7 m 的直线（展开 2510 m）圆角后总长只剩 725 m，轨迹根本到不了终点。
     *   跑步页那边也做了同一件事（`composables/demo/runner.ts` 的 `resolveTrackGeometry`）——
     *   两处必须一致，否则"预览的形状"与"真跑的形状"会对不上。
     */
    const g = generateCorridorRoute(geom, { targetKm: 1.5, stepM: 5, drift: true, seed: seed.value, smoothRoute: 0 })
    return g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  } catch {
    // 预览失败不影响保存（保存只需要形状本身）；不弹错、不让页面炸
    return []
  }
})

/** 切到/切出某个形状（`off` = 回到既有的双圈编辑） */
const setFreeMode = (m: 'off' | 'curve' | 'line') => {
  freeMode.value = m
  if (m === 'off') return
  // 切到非官方路径时把"当前编辑对象"收回外圈：避免地图上同时存在两套编辑语义
  editing.value = 'outer'
}
/**
 * 形状选择控件的**选中态**（`v-btn-toggle` 的 model）。
 *
 * 为什么不直接绑 `freeMode`：
 *   · 点**已选中**的按钮时，Vuetify 会把它置成 `null`（取消选中）⇒ 直接绑会把 `null` 写进
 *     `freeMode`，类型与逻辑都对不上；
 *   · `'off'`（没在画）不属于任何按钮 ⇒ 两个按钮都显示未选中，正是我们要的。
 * 这里统一收口：`null` / `'off'` 都是"退出非官方路径绘制"。
 */
const freeModeToggle = computed<'curve' | 'line' | null>({
  get: () => (freeMode.value === 'off' ? null : freeMode.value),
  set: (v) => setFreeMode(v === 'curve' || v === 'line' ? v : 'off'),
})
/** 撤销上一个点（圈型 = 弹掉最后一笔；直线型 = 先清终点、再清起点） */
const undoSelfFreePoint = () => {
  if (freeMode.value === 'curve') {
    draftFreePoints.value = draftFreePoints.value.slice(0, -1)
    return
  }
  if (draftLineTo.value) {
    draftLineTo.value = null
    return
  }
  draftLineFrom.value = null
}
/** 清空重画 */
const clearFreeShape = () => {
  draftFreePoints.value = []
  draftLineFrom.value = null
  draftLineTo.value = null
  showSnackbar('已清空非官方路径，可以重新画')
}
/** 地图点击（**只在 `freeMode` 非空时被调用**）—— 用户原话里的"直接在地图上点出路径" */
const onFreeMapClick = (p: N) => {
  if (freeMode.value === 'curve') {
    draftFreePoints.value = [...draftFreePoints.value, p]
    return
  }
  if (freeMode.value !== 'line') return
  if (!draftLineFrom.value) {
    draftLineFrom.value = p
    return
  }
  if (!draftLineTo.value) {
    if (distanceMeters(draftLineFrom.value.latitude, draftLineFrom.value.longitude, p.latitude, p.longitude) < 1) {
      showSnackbar('起点与终点太近了（不足 1 m），请在地图上离起点远一些的地方点终点', 'warning')
      return
    }
    draftLineTo.value = p
    return
  }
  // 两端都已选：再点一下就改**离点击处更近的那一端**（和大多数地图工具的直觉一致）
  const dFrom = distanceMeters(draftLineFrom.value.latitude, draftLineFrom.value.longitude, p.latitude, p.longitude)
  const dTo = distanceMeters(draftLineTo.value.latitude, draftLineTo.value.longitude, p.latitude, p.longitude)
  if (dFrom <= dTo) draftLineFrom.value = p
  else draftLineTo.value = p
}

/** 从库里载入某条记录时，同时把它的非官方形状填进草稿（没有就清空草稿） */
const loadFreeDraft = (raw: FreePathShape | null | undefined) => {
  const shape = usableFreePathShape(raw) ? (raw as FreePathShape) : null
  draftFreePoints.value = []
  draftLineFrom.value = null
  draftLineTo.value = null
  freeTripsInput.value = null
  if (!shape) {
    freeMode.value = 'off'
    return
  }
  if (shape.kind === 'curve') {
    freeMode.value = 'curve'
    draftFreePoints.value = shape.points.map(num)
  } else {
    freeMode.value = 'line'
    draftLineFrom.value = num(shape.from)
    draftLineTo.value = num(shape.to)
  }
}
/**
 * **【测试】非官方路径的保存**（唯一入口）。
 *
 * 沿既有保存/落盘提示链路（`lib.upsert` + `persisted` 如实提示），区别只有两点：
 *   ① 形状是权威（`freeShape`），`outer`/`inner` 只是给旧版本看的**占位几何**（至少各 3 点）；
 *   ② 校验走 `draftFreeUsable`（形状长度 > 0），**不要求内外圈合法** —— 自由路径本来就没有双圈。
 */
const saveFreeShape = () => {
  const shape = draftFreeShape.value
  if (!usableFreePathShape(shape)) {
    showSnackbar('还存不了非官方路径：圈型至少 3 个点且不能重合，直线型要选好起点和终点（两点不能重合）', 'warning')
    return
  }
  const placeholderInner = shape!.kind === 'curve' ? shape!.points : [shape!.from, shape!.to]
  const saved = lib.upsert({
    lineId: LOCAL_FREE_LINE_ID,
    lineName: String(currentLine.value?.pointName ?? '本机跑道（本任务未下发线路）'),
    outer: shape!.kind === 'curve' ? shape!.points.map(num) : [num(shape!.from), num(shape!.to)],
    inner: placeholderInner.map(num),
    laneNo: laneNo.value,
    laneCount: laneCount.value,
    freeShape: shape,
  })
  if (!saved) {
    showSnackbar('保存被拒：这条记录既没有合法的内外圈、也没有可用的非官方路径形状', 'error')
    return
  }
  const { entry, persisted } = saved
  const detail = `本机跑道 · 第 ${entry.editCount ?? 1} 次保存 · ${freePathShapeText(entry.freeShape) ?? '形状未存上'}`
  showSnackbar(`【测试】非官方路径已存入本机路线库（${detail}）${persisted ? '' : '（但本机存储写入失败，刷新后可能丢失）'}`, persisted ? undefined : 'warning')
}

/**
 * **快速定位**（用户要求）：把地图移到给定点集的范围，并挑一个刚好装得下的缩放级。
 * 不传参数时：优先用"已描的圈"，否则用官方路线。
 */
const focusOn = (ptsIn?: N[]) => {
  const pts =
    ptsIn ??
    (freeShapePath.value.length >= 2
      ? [...freeShapePath.value]
      : outer.value.length >= 3
        ? [...outer.value, ...inner.value]
        : official.value.map(num))
  if (pts.length < 2) {
    showSnackbar('这条线路还没有可定位的点', 'warning')
    return
  }
  const lats = pts.map((p) => p.latitude)
  const lngs = pts.map((p) => p.longitude)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  center.value = { latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2 }
  for (let z = Z_MAX; z >= Z_MIN; z--) {
    const wPx = (lng2x(maxLng, z) - lng2x(minLng, z)) * TILE
    const hPx = (lat2y(minLat, z) - lat2y(maxLat, z)) * TILE
    if (wPx <= viewport.value.w * 0.75 && hPx <= viewport.value.h * 0.75) {
      zoom.value = z
      break
    }
  }
}
watch(
  lines,
  (ls) => {
    /**
     * 🆕 2026-09-22（issue #12）：任务从"没下发线路"换成"下发了线路"时，
     * 若下拉里还停在 `local:free` 上，必须切回服务端线路 —— 否则会把几何**存到 `local:free`
     * 这个跟当前任务无关的键**上（脏数据；而且有线路的任务本该按线路 `pointId` 落库）。
     * 判据收得很窄：**只**重置这一个固定键，其它情况一律保持原行为（零回归）。
     */
    if (ls.length && String(lineId.value) === LOCAL_FREE_LINE_ID && !ls.some((l) => String(l.pointId) === LOCAL_FREE_LINE_ID)) {
      lineId.value = String(ls[0]!.pointId)
      return
    }
    if (!lineId.value && ls.length) lineId.value = String(ls[0]!.pointId)
  },
  { immediate: true },
)
const currentLine = computed(() => lines.value.find((l) => String(l.pointId) === String(lineId.value)))
const official = computed<N[]>(() => (currentLine.value?.pointList ?? []).map(num))

/** 当前编辑圈的点（含屏幕坐标，供 SVG 画）；**起跑点模式下没有"圈点"**（返回空数组） */
const editingPts = computed(() => (editing.value === 'outer' ? outer.value : editing.value === 'inner' ? inner.value : []))

/** 把官方路线点灌进当前圈，作为"打底"（用户只需微调） */
const useOfficialAsRing = () => {
  if (!official.value.length) return
  setRing(ringTarget.value, official.value.map((p) => ({ ...p })))
  showSnackbar(`已把官方路线 ${official.value.length} 点填入${ringTarget.value === 'outer' ? '外圈' : '内圈'}`)
}

const undo = () => {
  const pts = [...(ringTarget.value === 'outer' ? outer.value : inner.value)]
  pts.pop()
  setRing(ringTarget.value, pts)
}
/** 手工描的点必然有折角 ⇒ Chaikin 圆滑两轮，观感立刻像"跑道圈" */
const smoothRing = () => {
  const pts = ringTarget.value === 'outer' ? outer.value : inner.value
  if (pts.length < 3) {
    showSnackbar('先描够 3 个点再平滑', 'warning')
    return
  }
  setRing(ringTarget.value, smoothClosedRing(pts, 2))
  showSnackbar('已平滑这一圈')
}
const clearRing = () => setRing(ringTarget.value, [])

// ---------- 鼠标交互：拖动平移 / 点击加点 / 拖动点 ----------
let dragging = false
let dragFrom = { x: 0, y: 0 }
let moved = false
let pointDragIndex = -1
const onDown = (e: MouseEvent) => {
  dragging = true
  moved = false
  dragFrom = { x: e.offsetX, y: e.offsetY }
  pointDragIndex = nearestPointIndex(e.offsetX, e.offsetY)
}
const nearestPointIndex = (x: number, y: number) => {
  let best = -1
  let bestD = 12 // 12 px 内算"抓住这个点"
  editingPts.value.forEach((p, i) => {
    const s = toPx(p)
    const d = Math.hypot(s.x - x, s.y - y)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}
const onMove = (e: MouseEvent) => {
  if (!dragging) return
  const dx = e.offsetX - dragFrom.x
  const dy = e.offsetY - dragFrom.y
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
  if (pointDragIndex >= 0) {
    // 拖动已有的点（**只可能是圈上的点**：起跑点模式下 `editingPts` 为空 ⇒ 抓不到）
    const which = ringTarget.value
    const pts = [...(which === 'outer' ? outer.value : inner.value)]
    pts[pointDragIndex] = toLatLng(e.offsetX, e.offsetY)
    setRing(which, pts)
    return
  }
  // 拖动画布（往反方向移中心）
  const z = zoom.value
  center.value = {
    longitude: center.value.longitude - (dx / TILE / 2 ** z) * 360,
    latitude: y2lat(lat2y(center.value.latitude, z) - dy / TILE, z),
  }
  dragFrom = { x: e.offsetX, y: e.offsetY }
}
const onUp = (e: MouseEvent) => {
  const wasDragging = dragging
  const idx = pointDragIndex
  dragging = false
  pointDragIndex = -1
  if (!wasDragging || moved || idx >= 0) return
  /**
   * 单击（没拖动、也没抓点）的三种含义（**互斥，顺序即优先级**）：
   *   ① 🆕 `freeMode` 非空 = **画非官方路径**（圈型点点 / 直线型点起点与终点）—— 2026-09-22；
   *   ② `editing === 'start'` = 点选起跑点（1.1.12）；
   *   ③ 其余 = 在点击处给"当前圈"（外圈/内圈）加一个点（老行为）。
   */
  if (freeMode.value !== 'off') {
    onFreeMapClick(toLatLng(e.offsetX, e.offsetY))
    return
  }
  if (editing.value === 'start') {
    setStartFromMap(toLatLng(e.offsetX, e.offsetY))
    return
  }
  const which = ringTarget.value
  setRing(which, [...(which === 'outer' ? outer.value : inner.value), toLatLng(e.offsetX, e.offsetY)])
}

const zoomBy = (d: number) => {
  zoom.value = Math.min(Z_MAX, Math.max(Z_MIN, zoom.value + d))
}

// ---------- 车道 + 轨迹预览 ----------
const laneCount = ref(6)
const laneNo = ref(3) // 默认居中那道（第 1 道=最内道；居中才不会看着"压在内圈上"）
const seed = ref(20260917)
const rings = computed<TrackRings>(() => ({ outer: outer.value, inner: inner.value }))
const ringsReady = computed(() => outer.value.length >= 3 && inner.value.length >= 3)
/**
 * 内外圈合法性（用户要求：外圈必须包着内圈、不许相交、环宽要像跑道）。
 *
 * ⚠️ 2026-09-19 审计 S1 修掉的错法：原来是 `ringsReady ? validateRings(...) : null` ——
 *    **圈不足 3 点时返回 `null`**，而保存按钮判据是 `Boolean(ringCheck && !ringCheck.ok)` ⇒
 *    `null` 让判据直接为 `false`（= 可点）⇒ **空圈/残缺圈能被存进路线库**；之后跑步页把它当
 *    "已描过跑道"（绿条提示"以你描的真跑道为基准"），而 `runner.ts` 因点数不足 **回落到官方模板**
 *    ⇒ 正是本版明令禁止的行为。
 *    现在：**不足 3 点也返回 `{ ok: false, problems: [...] }`**，判据不再有"null 逃逸"路径。
 */
const ringCheck = computed(() =>
  ringsReady.value
    ? validateRings(rings.value)
    : { ok: false, widthM: 0, problems: ['内外圈各需至少 3 个点（当前 外圈 ' + outer.value.length + ' / 内圈 ' + inner.value.length + '）'] },
)
const widthM = computed(() => (ringsReady.value ? ringWidthM(rings.value) : 0))
/** 车道线实测：到内圈/外圈各多少米 —— 一眼看出"是不是夹在两圈中间"（免得误会"贴在内圈上"） */
const laneGap = computed(() => {
  if (!ringsReady.value || lane.value.length < 3) return null
  let toInner = 0
  let toOuter = 0
  for (const p of lane.value) {
    toInner += distanceToRingM(p, inner.value)
    toOuter += distanceToRingM(p, outer.value)
  }
  return { inner: toInner / lane.value.length, outer: toOuter / lane.value.length }
})
/** 一键居中：道次设为正中那道 */
const centerLane = () => {
  laneNo.value = Math.max(1, Math.round((laneCount.value + 1) / 2))
}
/** 按外圈自动生成内圈（法向向内缩 N 米）——只画一条外圈就够了 */
const insetM = ref(8)
const makeInnerFromOuter = () => {
  if (outer.value.length < 3) {
    showSnackbar('先画好外圈（至少 3 个点）', 'warning')
    return
  }
  setRing('inner', insetClosedRing(outer.value, insetM.value).map(num))
  showSnackbar(`已按外圈向内 ${insetM.value} m 生成内圈`)
}
const laneRatio = computed(() => laneRatioFor(laneNo.value, laneCount.value))
const lane = computed<N[]>(() => (ringsReady.value ? laneLoop(rings.value, laneRatio.value, 240).map(num) : []))

// ---------------------------------------------------------------- 起跑点（1.1.12 需求②）

/** 所选车道的周长（米）—— 起跑点滑杆的上限、也是"约几圈"的分母 */
const laneLengthM = computed(() => (lane.value.length >= 3 ? ringLengthM(lane.value) : 0))
/** 滑杆上限（至少 1，避免 max=0 时 Vuetify 把滑杆画成不可用的怪样子） */
const laneLengthSliderMax = computed(() => Math.max(1, Math.round(laneLengthM.value)))
/** 起跑点是否**已经设置**：偏移 > 0，或已经有吸附坐标（偏移 0 + 有坐标 = 起点就在第 0 点，仍然算"设过"） */
const hasStart = computed(() => draftStartOffsetM.value > 0 || Boolean(draftStartPoint.value))
/**
 * 地图上要画的那个"起跑点"：
 * 优先用存下来的坐标；只有偏移没有坐标（旧数据/手输偏移）时**按偏移反算到车道线上**。
 */
const startMarker = computed<N | null>(() => {
  if (!hasStart.value) return null
  if (draftStartPoint.value) return draftStartPoint.value
  if (lane.value.length < 3) return null
  const p = pointAtArcM(lane.value, draftStartOffsetM.value)
  return p ? num(p) : null
})
/** 绕向的两个选项（文案由**几何**算出来：有人从东侧起笔、有人从西侧，数组顺序本身不含方向语义） */
const directionOptions = computed(() => [
  { value: 'forward' as LoopDirection, label: startDirectionLabel(outer.value, 'forward') },
  { value: 'reverse' as LoopDirection, label: startDirectionLabel(outer.value, 'reverse') },
])
/** 当前起跑点的一句话（右侧说明与卡片提示共用） */
const startText = computed(() => {
  if (!hasStart.value) return '未设置（轨迹从车道线第 0 个点起跑）'
  return startSummaryText({ outer: outer.value, start: { offsetM: draftStartOffsetM.value, direction: draftStartDirection.value } })
})
/**
 * **地图点选起跑点**：把点击处**吸附到车道线**上（人点不到"线上"），
 * 同时写偏移与坐标 —— 两者从此保持一致。
 */
const setStartFromMap = (p: N) => {
  if (lane.value.length < 3) {
    showSnackbar('先把内外圈描好（车道线算出来之后）再点选起跑点', 'warning')
    return
  }
  const snapped = snapToLoop(lane.value, p)
  if (!snapped) {
    showSnackbar('这一点没吸附到跑道上，请点在跑道附近再试', 'warning')
    return
  }
  draftStartOffsetM.value = snapped.offsetM
  draftStartPoint.value = { latitude: Number(snapped.point.latitude), longitude: Number(snapped.point.longitude) }
  showSnackbar(`起跑点已设在这里（沿跑道 ${snapped.offsetM.toFixed(1)} m，离你点的位置 ${snapped.distanceM.toFixed(1)} m）`)
}
/** 滑杆微调偏移 ⇒ 同步把坐标算出来（两个字段永远一致） */
const onStartOffsetInput = (v: unknown) => {
  const next = Math.max(0, Math.round(Number(v) || 0))
  draftStartOffsetM.value = next
  const p = lane.value.length >= 3 ? pointAtArcM(lane.value, next) : null
  draftStartPoint.value = p ? num(p) : null
}
/** 取消起跑点（回到"不做旋转"的旧行为） */
const clearStart = () => {
  draftStartOffsetM.value = 0
  draftStartPoint.value = null
  showSnackbar('已取消起跑点设置（轨迹从车道线第 0 个点起跑）')
}
/**
 * **把起跑点与绕向落到几何上**：预览与真实生成都走这个 computed ⇒ 所见即所跑。
 * ⚠️ 未设起跑点时传 `null`：`rotateLoop(loop, 0)` 原样返回 ⇒ 与旧版逐点一致（回归保证）。
 */
const startLane = computed<N[]>(() =>
  applyStartToLoop(
    lane.value,
    hasStart.value ? { offsetM: draftStartOffsetM.value, direction: draftStartDirection.value } : null,
  ).map(num),
)

/** 最终轨迹：以（已按起跑点变换过的）车道线为参考几何，叠加"真实抖动"（直道恒定、小颗粒、偶发小凸起） */
const trajectory = computed<N[]>(() => {
  if (startLane.value.length < 3) return []
  const g = generateCorridorRoute(startLane.value, { targetKm: 3.2, stepM: 3, drift: true, seed: seed.value })
  return g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
})

const pathOf = (pts: P[], close = false) => {
  if (!pts.length) return ''
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${toPx(p).x.toFixed(1)},${toPx(p).y.toFixed(1)}`).join(' ')
  return close ? `${d} Z` : d
}

/**
 * 车道线：**就用你选的那一道**（0=贴内圈，1=贴外圈）。
 * ⚠️ 2026-09-17 用户确认：之前的"随机道次 + 偶尔缓慢换道"是**错误功能**（车道线看着乱、还让滑块失效），
 *    已整块删除；现在整圈**恒定**在该道上，所选道次会随路线一起存进本地路线库。
 */

const save = () => {
  /**
   * 🆕 2026-09-22「非官方路径绘制」：在画非官方路径时，走**另一条保存入口**（形状是权威，
   * 不要求内外圈合法）。有线路的任务走不到这里（那时 `freeMode` 恒为 `off`）。
   */
  if (freeMode.value !== 'off') {
    saveFreeShape()
    return
  }
  /**
   * ⚠️ 2026-09-22（issue #12）：这条提示是用户实测到的那一句（"需要选择一条路线"）。
   * 现在**任务未下发线路时下拉里必有那条「本机跑道」**（`local:free`）⇒ 正常路径走不到这里；
   * 只有"任务下发了线路、而线路还没载入"这种真异常才会出现，所以提示里要给出下一步。
   */
  if (!lineId.value) {
    showSnackbar('现在没有可保存的对象：请先在下拉里选一条线路（任务未下发线路时会有一条「本机跑道」）', 'warning')
    return
  }
  /**
   * ⚠️ 2026-09-19 审计 S1：这里原先**不检查几何合法性**就入库（按钮判据曾是唯一防线，而它在
   *   "内外圈不足 3 点"时因 `ringCheck === null` 而失效）⇒ 空圈能被存进库，跑步页随后把它当
   *   "已描过跑道"，而生成器因点数不足**回落到官方模板**（本版禁止）。
   *   现在两道防线：① 这里先判 `ringCheck.ok`；② `lib.upsert` 内部也会拒绝非法圈。
   */
  if (!ringCheck.value.ok) {
    showSnackbar(`内外圈不合法，无法保存：${ringCheck.value.problems.join('；')}`, 'error')
    return
  }
  const saved = lib.upsert({
    lineId: lineId.value,
    lineName: String(currentLine.value?.pointName ?? lineId.value),
    outer: outer.value,
    inner: inner.value,
    // ⭐ 把"所选道次"一起存起来（跑步页就按它生成，不再随机）
    laneNo: laneNo.value,
    laneCount: laneCount.value,
    /**
     * 🆕 起跑点（1.1.12 需求②）：`null` = **明确清掉**（用户点了「取消起跑点设置」就要能落盘，
     * 否则"删了又回来"）。`undefined` 才表示"保持原样" —— 这里**永远传明确值**。
     */
    start: hasStart.value
      ? {
          offsetM: draftStartOffsetM.value,
          direction: draftStartDirection.value,
          ...(draftStartPoint.value
            ? { point: { latitude: Number(draftStartPoint.value.latitude), longitude: Number(draftStartPoint.value.longitude) } }
            : {}),
        }
      : null,
  })
  if (!saved) {
    showSnackbar('保存被拒绝：内外圈点数不足（各需至少 3 点）', 'error')
    return
  }
  const { entry, persisted } = saved
  /**
   * ⚠️ **落盘是否成功必须如实说**（2026-09-22，issue #12）：
   *   `lib.upsert` 现在把 `persist()` 的结果一起返回（原先丢掉了）—— 否则配额满 / 隐私模式下
   *   "内存里存了、磁盘上没有"，界面却报成功；而**刷新后这条跑道就没了**，
   *   自由路线任务恰恰只有它这一条几何来源（跑步页读的就是它）。
   * 另外把"存的是哪一条"写清楚：本机跑道（本任务未下发线路）与"服务端线路"是两回事，
   *   混在一起用户会以为存成了官方路线。
   */
  const localSaving = String(lineId.value) === LOCAL_FREE_LINE_ID
  const detail = `${localSaving ? '本机跑道 · ' : ''}第 ${entry.editCount ?? 1} 次保存 · ${entry.updatedAppVersion ? `v${entry.updatedAppVersion}` : '版本未知'} · 起跑点${hasStart.value ? '已设' : '未设'}`
  showSnackbar(`已存入本机路线库（${detail}）${persisted ? '' : '（但本机存储写入失败，刷新后可能丢失）'}`, persisted ? undefined : 'warning')
}
const reset = () => {
  setRing('outer', [])
  setRing('inner', [])
  // 🆕 2026-09-22：非官方路径草稿也一起清掉（"清空这条线路的内外圈"按钮顺手把形状也清了，
  // 否则会出现"圈空了、但形状还在、一保存又把形状写回去"的怪状态）
  draftFreePoints.value = []
  draftLineFrom.value = null
  draftLineTo.value = null
}
/** 本地路线管理：载入到编辑器（顺带定位过去） */
const loadEntry = (id: string) => {
  lineId.value = String(id)
  loadDraft(String(id))
  focusOn()
  showSnackbar('已载入这条本地路线')
}
const removeEntry = (id: string) => {
  const persisted = lib.remove(String(id))
  if (String(id) === String(lineId.value)) reset()
  // 删掉的那条如果正展开着详情，收起它（否则详情区会挂在一个已不存在的条目上）
  if (isDetailOpen(id)) detailId.value = null
  // ⚠️ 2026-09-20 审计修复：落盘失败时不能报"已删除" —— 否则刷新后被删的路线又回来了
  showSnackbar(persisted ? '已从本机路线库删除' : '已从内存移除，但本机存储写入失败（刷新后可能还在）', persisted ? 'success' : 'warning')
}

// ---------------------------------------------------------------- 路线库「详情」展开（1.1.12 需求③）

/**
 * 正在展开详情的那一条（`null` = 全部收起）。
 * ⚠️ 用 **lineId** 而不是数组下标：删掉一条后下标会整体前移，展开的详情就会"跳到别的路线"上。
 * 🆕 为什么不是 `v-expansion-panels`：列表行上的「载入 / 重命名 / 删除」与摘要**必须常显**
 * （既有验证脚本在**未展开**状态下就要点到它们、断言到摘要里的官方原名）——
 * 那种面板默认把内容藏进折叠区，会让这些脚本和用户习惯都失效。
 */
const detailId = ref<string | null>(null)
/** 编辑历史的展示上限（与数据层同一个常量，避免两处各写一个 5） */
const historyMax = TRACK_HISTORY_MAX
const isDetailOpen = (id: string) => detailId.value === String(id)
const toggleDetail = (id: string) => {
  detailId.value = isDetailOpen(id) ? null : String(id)
}

// ---------- 重命名（1.1.9 需求②：给已保存的跑道改名）----------
// 只改**本机显示名**（`customName`），不动厂商线路名、不动几何、不动创建日期；
// 提交用的仍是厂商 `lineId`（报文口径零变化）。
const renameOpen = ref(false)
const renameId = ref('')
const renameText = ref('')
/** 正在改名的那一条（弹窗里显示官方原名用；找不到就是 undefined） */
const renameEntry = computed(() => lib.get(renameId.value))
/** 输入框实时长度（给用户看得见的计数） */
const renameLen = computed(() => Array.from(renameText.value ?? '').length)
const openRename = (id: string) => {
  const e = lib.get(String(id))
  renameId.value = String(id)
  renameText.value = e?.customName ?? ''
  renameOpen.value = true
}
const confirmRename = () => {
  const out = lib.rename(String(renameId.value), renameText.value)
  renameOpen.value = false
  if (!out) {
    showSnackbar('这条路线已经不在本机路线库里了', 'warning')
    return
  }
  const { entry: updated, persisted } = out
  showSnackbar(
    (updated.customName ? `已改名为「${resolveEntryName(updated)}」` : '已恢复显示官方线路名') +
      // ⚠️ 落盘失败要说清楚（否则刷新后名字"自己变回去"，用户以为没保存）
      (persisted ? '' : '（但本机存储写入失败，刷新后可能丢失）'),
    persisted ? 'success' : 'warning',
  )
}
/** 一键恢复官方名（清空自定义名） */
const clearCustomName = () => {
  renameText.value = ''
  showSnackbar('已清空输入框，点「保存名字」即恢复官方名', 'info')
}
/** 列表/标题统一用"自定义名优先"的显示名（纯函数，唯一入口） */
const nameOf = (e: { lineId: string; lineName: string; customName?: string }) => resolveEntryName(e)
/** 线路下拉的选项标题：库里有记录就用"你起的名字"，否则用厂商线路名（缺名时明确写"未命名"） */
const lineOptions = computed(() =>
  lines.value.map((l) => {
    const e = lib.get(String(l.pointId))
    const vendor = String(l.pointName ?? '').trim()
    return {
      title: e ? nameOf(e) : vendor || `未命名线路（${l.pointId}）`,
      value: String(l.pointId),
    }
  }),
)
</script>

<template>
  <v-container fluid>
    <v-alert v-if="realStatus !== 'ready'" type="info" variant="tonal" density="compact" class="mb-3">
      还没读取真实任务：回「工作台」点「一键获取 token」后这里才有线路可选（也可先用演示数据试手感）。
    </v-alert>

    <!--
      🆕 2026-09-22（issue #12，用户实测：任务没线路时"无法新建路线"）：
      任务未下发线路（runPointList 为空）时说清"你在描的是本机跑道"，避免用户以为存成了官方路线。
      ⚠️ 只在**确实读到了任务**时显示这条（连任务都没有时，上面那条提示已经说明该去做什么）。
    -->
    <v-alert v-if="localFreeLine && activeTask" type="info" variant="tonal" density="comfortable" class="mb-3">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-map-marker-path</v-icon>本任务「服务端未下发线路」—— 你在这页描的是<b>本机跑道</b>，不是官方路线
      </div>
      <div class="text-body-2 mt-1">
        该任务的 <b>runPointList 为空</b>（服务端没有下发可选线路），所以下拉里不会出现官方线路。
        你在下拉里选那条「<b>本机跑道</b>」→ 描好内外圈 → 点「<b>保存（本机）</b>」以后，
        <b>跑步页就会用你描的这条几何生成轨迹</b>。它只存在这台电脑的本机路线库里，不会、也不能当作官方线路标识提交。
      </div>
    </v-alert>

    <!-- ⚠️ 用户 2026-09-18 明确要求加的提示（置顶、常驻）：官方路线只能当"大致位置"参考 -->
    <v-alert type="warning" variant="tonal" density="comfortable" class="mb-3">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-alert-outline</v-icon>描圈请以<b>卫星图</b>为准，不要照着灰虚线（官方路线）描！
      </div>
      <div class="text-body-2 mt-1">
        部分线路的<b>官方路线偏差极大</b>（实测官方模板与真实跑道可差十几米到几十米），
        照它描会把偏差直接带进轨迹里。正确做法：切到「<b>卫星图</b>」→ 看清操场红色的跑道 →
        「<b>快速定位</b>」把地图移到这条线路 → 沿跑道边缘描外圈。
      </div>
    </v-alert>

    <v-row dense>
      <v-col cols="12" md="8">
        <v-card>
          <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2">
            跑道编辑器
            <v-chip size="small" variant="tonal" color="primary">白虚线=官方路线</v-chip>
            <v-chip size="small" variant="tonal" color="success">绿=车道线</v-chip>
            <v-chip size="small" variant="tonal" color="warning">橙=最终轨迹</v-chip>
            <v-chip size="small" variant="tonal" color="error">红点=起跑点</v-chip>
            <!-- 🆕 非官方路径（2026-09-22）：只在这一块 UI 出现时才加这个图例（有线路的任务一个字都不多） -->
            <v-chip v-if="localFreeLine" size="small" variant="tonal" color="warning">【测试】洋红=非官方路径</v-chip>
            <v-spacer />
            <v-btn-toggle v-model="mapStyle" mandatory density="compact" class="mr-2">
              <v-btn value="road" size="small">街道图</v-btn>
              <v-btn value="satellite" size="small">卫星图</v-btn>
              <v-btn value="hybrid" size="small">卫星+标注</v-btn>
            </v-btn-toggle>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-magnify-plus-outline" @click="zoomBy(1)">放大</v-btn>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-magnify-minus-outline" @click="zoomBy(-1)">缩小</v-btn>
          </v-card-title>
          <v-card-text class="pa-0">
            <div
              ref="mapEl"
              class="mapbox"
              @mousedown="onDown"
              @mousemove="onMove"
              @mouseup="onUp"
              @mouseleave="dragging = false"
            >
              <img
                v-for="t in tiles"
                :key="t.key"
                :src="t.url"
                class="tile"
                :style="{ left: `${t.left}px`, top: `${t.top}px` }"
                draggable="false"
              />
              <img
                v-for="t in overlayTiles"
                :key="t.key"
                :src="t.url"
                class="tile"
                :style="{ left: `${t.left}px`, top: `${t.top}px`, opacity: 0.85 }"
                draggable="false"
              />
              <svg class="overlay" :width="viewport.w" :height="viewport.h">
                <path v-if="official.length > 1" :d="pathOf(official, true)" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="6 5" opacity="0.9" />
                <path v-if="outer.length > 1" :d="pathOf(outer, outer.length > 2)" fill="none" stroke="#38bdf8" stroke-width="2" />
                <path v-if="inner.length > 1" :d="pathOf(inner, inner.length > 2)" fill="none" stroke="#a78bfa" stroke-width="2" />
                <path v-if="lane.length > 1" :d="pathOf(lane, true)" fill="none" stroke="#22c55e" stroke-width="2.4" />
                <path v-if="trajectory.length > 1" :d="pathOf(trajectory)" fill="none" stroke="#f59e0b" stroke-width="1.6" opacity="0.95" />
                <!--
                  🆕 非官方路径（2026-09-22）：**洋红 = 你画的那条形状本身**（圈型闭合曲线 / 直线 A→B）
                  ⚠️ 圈型用 `pathOf(..., true)` 闭合画 —— 用户点完最后一个点就该看到"已经连上了"，
                     而不是等保存后才发现自己画的其实是条开口折线。
                -->
                <template v-if="freeMode !== 'off'">
                  <path
                    v-if="freeShapePath.length > 1"
                    :d="pathOf(freeShapePath, freeMode === 'curve' && freeShapePath.length > 2)"
                    fill="none"
                    stroke="#e879f9"
                    stroke-width="3"
                    opacity="0.95"
                  />
                  <circle
                    v-for="(p, i) in freeShapePath"
                    :key="`free-${i}`"
                    :cx="toPx(p).x"
                    :cy="toPx(p).y"
                    r="4"
                    fill="#e879f9"
                    stroke="#fff"
                    stroke-width="1.2"
                  />
                  <!-- 非官方路径的轨迹预览（与跑步页同一套算法：展开 → 生成） -->
                  <path v-if="freeTrajectory.length > 1" :d="pathOf(freeTrajectory)" fill="none" stroke="#f59e0b" stroke-width="1.4" opacity="0.85" />
                </template>
                <circle
                  v-for="(p, i) in (freeMode !== 'off' ? [] : editingPts)"
                  :key="`${editing}-${i}`"
                  :cx="toPx(p).x"
                  :cy="toPx(p).y"
                  r="4"
                  :fill="editing === 'outer' ? '#38bdf8' : '#a78bfa'"
                  stroke="#fff"
                  stroke-width="1.2"
                />
                <!-- 🆕 起跑点（1.1.12 需求②）：红点 + 白描边 + 文字标注，一眼看出轨迹从哪儿起跑 -->
                <g v-if="startMarker">
                  <circle :cx="toPx(startMarker).x" :cy="toPx(startMarker).y" r="6" fill="#ef4444" stroke="#fff" stroke-width="2" />
                  <text
                    :x="toPx(startMarker).x + 9"
                    :y="toPx(startMarker).y - 8"
                    fill="#fecaca"
                    font-size="12"
                    font-weight="bold"
                  >
                    起跑点
                  </text>
                </g>
              </svg>
            </div>
          </v-card-text>
          <v-card-text class="text-caption text-medium-emphasis">
            拖动=平移地图　单击=<b>{{
              freeMode === 'curve'
                ? '在当前位置加一个非官方路径的点'
                : freeMode === 'line'
                  ? '依次点出这条直路的起点与终点'
                  : editing === 'start'
                    ? '点选起跑点（会自动吸附到车道上）'
                    : '在当前位置加一个点'
            }}</b>　按住已有的小圆点拖动=改点　（编辑哪一样见右侧）
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <!--
          🆕 2026-09-22【测试】非官方路径绘制（用户原话："绘制**非官方性路径**……圈型，或者直线型【折返】"）
          ⚠️ **只在任务未下发线路时出现**（`localFreeLine` 非空）⇒ 有线路的任务这块 UI 一个字都不渲染，
             它的下拉 / 白色官方虚线 / 起跑点 / 滑杆 / 绕向 / 保存全部照旧（零回归）。
        -->
        <v-card v-if="localFreeLine" class="mb-3" variant="outlined" color="warning">
          <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2">
            <v-chip size="small" color="warning" variant="flat">【测试】</v-chip>
            非官方路径绘制
          </v-card-title>
          <v-card-text>
            <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
              <div class="font-weight-bold">实验功能：用来给不指定路线的任务画一条自己的路径</div>
              <div class="text-body-2 mt-1">
                只对「<b>服务端未下发线路</b>」的任务（如研途健行）有意义 —— 这类任务没有官方路线可描，
                你可以直接画一条<b>圈型闭合曲线</b>绕着跑，或者画一条<b>直线</b>来回折返跑。
                画完保存进本机路线库（键名仍是 <code>local:free</code>），跑步页就会用这条几何开跑。
                <b>它不是官方线路</b>，只存在这台电脑上，也不会进提交报文。
              </div>
            </v-alert>

            <!-- ① 定位（复用既有的「快速定位」能力，不另造一套定位体系） -->
            <v-btn
              block
              size="small"
              color="secondary"
              variant="tonal"
              class="mb-3"
              prepend-icon="mdi-crosshairs-gps"
              @click="focusOn()"
            >
              定位（把地图移到这条路径）
            </v-btn>

            <!-- ② 形状选择：圈型 / 直线型（再点一次已选中的那个 = 退出绘制） -->
            <div class="text-caption text-medium-emphasis mb-1">选择形状（再点一次 = 退出绘制）：</div>
            <v-btn-toggle v-model="freeModeToggle" density="compact" class="mb-3">
              <v-btn value="curve" size="small">圈型（闭合曲线）</v-btn>
              <v-btn value="line" size="small">直线型（折返）</v-btn>
            </v-btn-toggle>

            <template v-if="freeMode === 'off'">
              <div class="text-caption text-medium-emphasis mb-2">
                上面两个按钮选一个形状后，<b>在地图上依次点出路径</b>即可；选了形状之后这个按钮才会变为可用。
              </div>
              <v-btn block size="small" color="primary" prepend-icon="mdi-content-save-outline" disabled>保存到本机路线库（先选形状）</v-btn>
            </template>

            <!-- ===== ③ 绘制交互 ===== -->
            <template v-else>
              <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                {{ freeStatusText }}
              </v-alert>
              <div class="text-caption mb-2">
                <template v-if="freeMode === 'curve'">
                  预计长度（闭合曲线一圈）：<b>{{ draftFreeUsable ? curveLengthM(draftFreeShape, true).toFixed(1) + ' m' : '—' }}</b>
                </template>
                <template v-else>
                  预计长度：单程 <b>{{ draftFreeUsable ? lineLengthM(draftFreeShape).toFixed(1) + ' m' : '—' }}</b>
                  <template v-if="draftFreeUsable">　·　一来一回 <b>{{ (lineLengthM(draftFreeShape) * 2).toFixed(1) }} m</b></template>
                </template>
              </div>
              <v-btn block size="small" variant="tonal" class="mb-2" prepend-icon="mdi-undo" :disabled="!draftFreeShape" @click="undoSelfFreePoint">
                撤销上一个点（非官方路径）
              </v-btn>
              <v-btn block size="small" variant="tonal" color="error" class="mb-3" prepend-icon="mdi-delete-outline" @click="clearFreeShape">
                清空重画
              </v-btn>

              <!-- ④ 直线型的折返趟数（圈型也用它算"绕几圈"，口径一致） -->
              <v-text-field
                v-model.number="freeTargetKm"
                type="number"
                :min="0.1"
                :step="0.1"
                suffix="km"
                label="目标里程（用来算趟数）"
                density="compact"
                hide-details="auto"
                class="mb-2"
              />
              <v-text-field
                v-model.number="freeTripsInput"
                type="number"
                :min="1"
                :step="1"
                :placeholder="String(freePlan.trips || 1)"
                label="趟数（留空＝按目标里程自动算）"
                density="compact"
                hide-details="auto"
                class="mb-1"
              />
              <div class="text-caption mb-1">
                共 <b>{{ freePlan.trips || 0 }}</b> {{ freeMode === 'curve' ? '圈' : '趟' }} · 合计约
                <b>{{ (freePlan.totalM / 1000).toFixed(2) }} km</b>
                <span class="text-medium-emphasis">（{{ freePlan.note }}）</span>
              </div>
              <div v-if="freeTripsManualInvalid" class="text-caption text-warning mb-1">
                ⚠️ 手填的趟数不是有效正数，已按目标里程自动算（口径：<b>宁可多跑，绝不少跑</b>）。
              </div>
              <v-alert v-if="!draftFreeUsable" type="warning" variant="tonal" density="compact" class="mb-2">
                还不能跑：{{ freeMode === 'curve' ? '圈型至少 3 个点（且不能都重合）' : '直线型要选好起点与终点（两点不能重合）' }}。
              </v-alert>
              <v-btn
                block
                size="small"
                color="primary"
                class="mb-2"
                prepend-icon="mdi-content-save-outline"
                :disabled="!draftFreeUsable"
                @click="saveFreeShape"
              >
                保存到本机路线库
              </v-btn>
              <div class="text-caption text-medium-emphasis">
                保存后回「跑步」页：本任务未下发线路 ⇒ 轨迹就用你刚画的这条几何生成（地图上橙色那条就是预览）。
              </div>
            </template>
          </v-card-text>
        </v-card>

        <v-card>
          <v-card-title class="text-subtitle-1">编辑</v-card-title>
          <v-card-text>
            <v-select
              v-model="lineId"
              :items="lineOptions"
              label="要编辑哪条线路"
              density="compact"
              hide-details
              class="mb-3"
            />
            <!-- 🆕 2026-09-22（issue #12）：任务未下发线路时，把"这是本机跑道"说在选项正下方 -->
            <div v-if="localFreeLine" class="text-caption text-medium-emphasis mb-3">
              本任务未下发线路 —— 上面这条「<b>本机跑道</b>」是本机的条目：在它上面描好内外圈并保存，
              跑步页就会用你描的这条生成轨迹（<b>不是官方路线</b>，只存在这台电脑上）。
            </div>
            <v-btn-toggle v-model="editing" mandatory density="compact" class="mb-3">
              <v-btn value="outer" size="small">外圈</v-btn>
              <v-btn value="inner" size="small">内圈</v-btn>
              <v-btn value="start" size="small">起跑点</v-btn>
            </v-btn-toggle>
            <!-- 快速定位（用户要求）：选中线路后一键把地图移到它那里 -->
            <v-btn
              block
              size="small"
              color="secondary"
              variant="tonal"
              class="mb-2"
              prepend-icon="mdi-crosshairs-gps"
              @click="focusOn()"
            >
              快速定位（把地图移到这条线路）
            </v-btn>

            <!-- ===== 外圈 / 内圈（描点）===== -->
            <template v-if="editing !== 'start'">
              <div class="text-caption text-medium-emphasis mb-2">
                当前{{ editing === 'outer' ? '外圈' : '内圈' }}：<b>{{ editingPts.length }}</b> 点
                <span v-if="editingPts.length > 2">· 周长 {{ ringLengthM(editingPts).toFixed(0) }} m</span>
              </div>
              <!--
                🆕 2026-09-22（issue #12）：**本机跑道没有官方点列**（`pointList: []`）⇒ 这个按钮
                对它是无效的。原先点了会**静默什么都不做**（函数里 `return`），容易被当成"按钮坏了"；
                现在无官方点列时直接标灰，并在下面说明原因。
              -->
              <v-btn
                block
                size="small"
                variant="tonal"
                class="mb-2"
                prepend-icon="mdi-map-marker-path"
                :disabled="!official.length"
                @click="useOfficialAsRing"
              >
                用官方路线打底（再微调）
              </v-btn>
              <div v-if="!official.length" class="text-caption text-medium-emphasis mb-2">
                {{ localFreeLine ? '本机跑道没有官方路线点列（服务端未下发线路），所以直接从卫星图描起。' : '这条线路服务端没有下发点列，所以没有可打底的官方路线。' }}
              </div>
              <v-btn block size="small" variant="tonal" class="mb-2" prepend-icon="mdi-undo" @click="undo">撤销上一个点</v-btn>
              <v-btn block size="small" variant="tonal" color="info" class="mb-2" prepend-icon="mdi-auto-fix" @click="smoothRing">
                把这一圈平滑一下（描的点难免有折角）
              </v-btn>
              <v-text-field v-model.number="insetM" type="number" density="compact" hide-details label="内缩米数（≈跑道宽度）" class="mb-2" />
              <v-btn block size="small" variant="tonal" color="info" class="mb-2" prepend-icon="mdi-arrow-collapse-all" @click="makeInnerFromOuter">
                按外圈自动生成内圈（向内缩 {{ insetM }} m）
              </v-btn>
              <v-btn block size="small" variant="tonal" color="error" class="mb-2" prepend-icon="mdi-delete-outline" @click="clearRing">清空这一圈</v-btn>
            </template>

            <!-- ===== 起跑点（1.1.12 需求②）===== -->
            <template v-else>
              <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                在<b>地图上点一下跑道</b>，就把起跑点设在那里（自动吸附到你所选的这道上）；下面的滑杆可沿跑道微调。
              </v-alert>
              <v-slider
                :model-value="draftStartOffsetM"
                :min="0"
                :max="laneLengthSliderMax"
                :step="1"
                :disabled="!ringsReady"
                label="沿跑道偏移（米）"
                thumb-label
                class="mb-1"
                @update:model-value="onStartOffsetInput"
              />
              <div class="text-caption text-medium-emphasis mb-2">绕向（决定轨迹往哪边跑）：</div>
              <v-btn-toggle v-model="draftStartDirection" mandatory density="compact" class="mb-2">
                <v-btn v-for="d in directionOptions" :key="d.value" :value="d.value" size="small">{{ d.label }}</v-btn>
              </v-btn-toggle>
              <div class="text-caption text-medium-emphasis mb-2">
                起跑点：<b>{{ startText }}</b>
                <template v-if="laneLengthM > 0"><br />所选车道一圈 {{ laneLengthM.toFixed(0) }} m（偏移 0 = 你描圈的第一笔处）</template>
                <template v-if="startMarker && draftStartPoint">
                  <br />坐标 {{ draftStartPoint.latitude.toFixed(6) }}, {{ draftStartPoint.longitude.toFixed(6) }}
                </template>
              </div>
              <v-btn
                block
                size="small"
                variant="tonal"
                color="error"
                class="mb-2"
                prepend-icon="mdi-close-circle-outline"
                :disabled="!hasStart"
                @click="clearStart"
              >
                取消起跑点设置
              </v-btn>
            </template>

            <!-- 合法性判定（用户要求：外圈必须包着内圈） -->
            <v-alert v-if="ringCheck && !ringCheck.ok" type="error" variant="tonal" density="compact" class="mb-2">
              <div class="font-weight-bold">内外圈不合法，先修好再保存：</div>
              <ul class="text-caption mt-1">
                <li v-for="(t, i) in ringCheck.problems" :key="i">{{ t }}</li>
              </ul>
            </v-alert>
            <v-alert v-else-if="ringCheck && ringCheck.ok" type="success" variant="tonal" density="compact" class="mb-2">
              内外圈合法 ✅ 跑道宽度 {{ ringCheck.widthM.toFixed(1) }} m
            </v-alert>
            <v-btn
              block
              size="small"
              color="primary"
              prepend-icon="mdi-content-save-outline"
              :disabled="Boolean(ringCheck && !ringCheck.ok)"
              @click="save"
            >
              保存（本机）
            </v-btn>
            <v-btn block size="small" variant="text" color="error" class="mb-2" prepend-icon="mdi-restore" @click="reset">把这条线路的内外圈都清空</v-btn>
          </v-card-text>
        </v-card>

        <v-card class="mt-3">
          <v-card-title class="text-subtitle-1">车道与轨迹</v-card-title>
          <v-card-text>
            <div v-if="!ringsReady" class="text-caption text-medium-emphasis">
              内外圈各描够 3 个点后，这里会算出车道线与最终轨迹。
            </div>
            <template v-else>
              <div class="text-caption mb-2">
                跑道宽度（内外圈中位间距）<b>{{ widthM.toFixed(1) }} m</b>
                <span v-if="widthM < 4 || widthM > 20" class="text-warning">　⚠️ 看起来不像跑道宽度，请核对内外圈</span>
              </div>
              <v-slider v-model="laneNo" :min="1" :max="laneCount" :step="1" label="第几道（1=最内）" thumb-label />
              <v-slider v-model="laneCount" :min="2" :max="8" :step="1" label="一共几道" thumb-label />
              <div class="text-caption text-medium-emphasis mt-1">
                车道线整圈恒定在这一道上（不再随机、不再换道）。所选道次会随路线一起存进本地路线库。
              </div>
              <v-text-field v-model.number="seed" label="随机种子（换一条不同的抖动）" density="compact" hide-details class="mb-2" />
              <div class="text-caption">
                所选道次：<b>第 {{ laneNo }} 道</b>（共 {{ laneCount }} 道，第 1 道=最内道）
                <v-btn size="x-small" variant="text" class="ml-1" @click="centerLane">居中</v-btn>
                <br />车道比例 <b>{{ laneRatio.toFixed(3) }}</b>
                （0=贴内圈，1=贴外圈）　车道周长 {{ lane.length ? ringLengthM(lane).toFixed(0) : '—' }} m
                <template v-if="laneGap">
                  <br />车道线实测：离内圈 <b>{{ laneGap.inner.toFixed(1) }} m</b> · 离外圈
                  <b>{{ laneGap.outer.toFixed(1) }} m</b>（两者之和 ≈ 跑道宽度就是夹在中间）
                </template>
                <br />最终轨迹 {{ trajectory.length }} 点（含真实抖动：直道恒定 + 0.15 m 颗粒 + 偶发小凸起）
                <template v-if="hasStart">
                  <br />起跑点：<b>{{ startText }}</b> —— 轨迹从该点出发（跑到第 0 点必是起跑点）
                </template>
              </div>
            </template>
          </v-card-text>
        </v-card>
        <v-card class="mt-3">
          <v-card-title class="text-subtitle-1">
            本地路线库
            <span class="text-caption text-medium-emphasis">（{{ libEntries.length }} 条）</span>
          </v-card-title>
          <v-card-text>
            <div v-if="!libEntries.length" class="text-caption text-medium-emphasis">
              还没有配置好的路线。描好内外圈后点「保存（本机）」，这里就会按「创建 / 最近保存的时间与版本 + 编辑次数」列出来。
            </div>
            <v-list v-else density="compact" class="pa-0">
              <template v-for="e in libEntries" :key="e.lineId">
                <v-list-item class="px-0">
                  <v-list-item-title class="text-body-2 d-flex flex-wrap align-center ga-1">
                    {{ nameOf(e) }}
                    <v-chip v-if="String(e.lineId) === String(lineId)" size="x-small" color="primary" variant="tonal">正在编辑</v-chip>
                    <v-chip v-if="e.customName" size="x-small" color="info" variant="tonal">已改名</v-chip>
                    <!-- 🆕 起跑点/编辑次数：不展开也能一眼看到（1.1.12 需求②③）
                         ⚠️ 编辑次数**只在真的记录过时才显示**：旧条目没有这个字段，
                            显示"编辑 1 次"是替用户猜的（详情里如实写"未记录（旧数据）"）。 -->
                    <v-chip v-if="e.start" size="x-small" color="error" variant="tonal">起跑点已设</v-chip>
                    <v-chip v-if="e.editCount" size="x-small" color="secondary" variant="tonal">编辑 {{ e.editCount }} 次</v-chip>
                    <!-- 🆕 非官方路径（2026-09-22）：不展开也能一眼看出"这条是圈型/直线型" -->
                    <v-chip v-if="e.freeShape" size="x-small" color="warning" variant="tonal">
                      【测试】{{ e.freeShape.kind === 'curve' ? '圈型' : '直线型（折返）' }}
                    </v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle class="text-caption">{{ entrySummaryText(e) }}</v-list-item-subtitle>
                  <template #append>
                    <v-btn size="x-small" variant="text" @click="toggleDetail(e.lineId)">
                      {{ isDetailOpen(e.lineId) ? '收起详情' : '详情' }}
                    </v-btn>
                    <v-btn size="x-small" variant="text" @click="loadEntry(e.lineId)">载入</v-btn>
                    <v-btn size="x-small" variant="text" color="primary" @click="openRename(e.lineId)">重命名</v-btn>
                    <v-btn size="x-small" variant="text" color="error" @click="removeEntry(e.lineId)">删除</v-btn>
                  </template>
                </v-list-item>
                <!-- 详情（1.1.12 需求③）：时间 / 版本 / 次数 / 几何 / 起跑点 + 最近几次编辑留痕 -->
                <v-expand-transition>
                  <div v-if="isDetailOpen(e.lineId)" class="lib-detail mb-2 pa-2">
                    <v-table density="compact" class="lib-detail-table mb-2">
                      <tbody>
                        <tr v-for="row in entryDetailRows(e)" :key="`${e.lineId}-${row.label}`">
                          <td class="text-medium-emphasis lib-detail-label">{{ row.label }}</td>
                          <td>{{ row.value }}</td>
                        </tr>
                      </tbody>
                    </v-table>
                    <div class="text-caption text-medium-emphasis">
                      编辑历史（最近 {{ historyMax }} 次，最新在上）
                    </div>
                    <ul v-if="e.history?.length" class="text-caption pl-4 mt-1 mb-0">
                      <li v-for="(log, i) in e.history" :key="`${e.lineId}-log-${i}`">{{ historyLogText(log) }}</li>
                    </ul>
                    <div v-else class="text-caption pl-1 mt-1">还没有编辑历史（这一条是用旧版本存的）。</div>
                  </div>
                </v-expand-transition>
              </template>
            </v-list>
          </v-card-text>
        </v-card>

        <!-- 重命名弹窗（1.1.9 需求②）：只改本机显示名，不动厂商线路名 -->
        <v-dialog v-model="renameOpen" max-width="460">
          <v-card>
            <v-card-title class="text-subtitle-1">给这条路线改个名字</v-card-title>
            <v-card-text>
              <v-text-field
                v-model="renameText"
                label="新名字（留空＝恢复官方名）"
                density="compact"
                autofocus
                clearable
                :counter="24"
                maxlength="24"
                hide-details="auto"
                class="mb-2"
                @keyup.enter="confirmRename"
              />
              <div class="text-caption text-medium-emphasis">
                当前输入 {{ renameLen }} / 24 字。改的是<b>本机显示名</b>，只影响这台电脑上的列表；
                厂商线路名与提交用的线路 id 都不变。
                <template v-if="renameEntry">官方名：<b>{{ renameEntry.lineName }}</b></template>
              </div>
            </v-card-text>
            <v-card-actions>
              <v-btn variant="text" size="small" @click="clearCustomName">清空输入</v-btn>
              <v-spacer />
              <v-btn variant="text" size="small" @click="renameOpen = false">取消</v-btn>
              <v-btn color="primary" size="small" variant="flat" @click="confirmRename">保存名字</v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>
      </v-col>
    </v-row>
  </v-container>
</template>

<style scoped>
.mapbox {
  position: relative;
  width: 100%;
  height: 60vh;
  min-height: 420px;
  overflow: hidden;
  background: #0b1220;
  cursor: crosshair;
  user-select: none;
}
.tile {
  position: absolute;
  width: 256px;
  height: 256px;
  pointer-events: none;
}
.overlay {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}
/* 路线库「详情」区块（1.1.12 需求③）：给它一个浅底，和列表行区分开 */
.lib-detail {
  background: rgba(148, 163, 184, 0.08);
  border-radius: 6px;
}
.lib-detail-table {
  background: transparent;
}
.lib-detail-table td {
  height: 28px;
}
.lib-detail-label {
  width: 42%;
  white-space: nowrap;
}
</style>
