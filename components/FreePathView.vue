<script setup lang="ts">
/**
 * 「我的场地 → 非官方路径【测试】」页（2026-09-22 结构调整）
 *
 * ## 为什么它从跑道编辑页搬出来成了独立子页（用户原话）
 * > "非官方路径编辑放到与**签到区域**、**跑道编辑**同级的地方"
 *
 * 原先它是 `components/TrackEditorView.vue` 右侧一张"只在任务未下发线路时才出现"的卡片；
 * 现在它自己占一个子页（`/field/free-path`），与「跑道编辑」「签到区域」并列（同一套
 * `components/TabGroupShell.vue` 外壳 + `pages/field/[tab].vue` 动态段，见该页顶部说明）。
 *
 * 搬家的两条硬要求（都做到了）：
 *   · **UI 只有这一份**：`TrackEditorView.vue` 里那张卡、地图上的洋红图层、图例、提示全删了，
 *     它的双圈 / 起跑点 / 保存行为**逐字不变**（含"保存双圈时显式传 `freeShape: null`"这条审计 B4 修复）；
 *   · **本页恒可进入、恒显示这块 UI**（不再靠"当前任务有没有下发线路"决定渲不渲染）：
 *     下发了线路的任务进来时**如实说明**"本页画的路径只用于未下发线路的任务"（见模板第一条提示）。
 *
 * ## 口径（一个字都没变）
 *   · 形状存在**本机路线库**的固定键 `local:free`（`mp_track_library_v1`）；
 *   · 跑步页在"服务端未下发线路"的任务里读它生成轨迹；**下发了官方线路的任务不看它**；
 *   · 它**绝不会**进提交报文（提交用的是厂商线路 id，本机键进不去）。
 *
 * ## 算法一律走纯函数（界面不自己算）
 *   `utils/mp/pathShape.ts`（形状 / 长度 / 趟数 / 旧版本占位几何）、
 *   `utils/mp/freePathGeometry.ts`（形状 + 起跑点 → 生成器几何的**唯一入口**，与跑步页同源 ⇒ 所见即所跑）、
 *   `utils/mp/trackLibrary.ts`（`localFreeTrackLine` / `LOCAL_FREE_LINE_ID` / 列表摘要与详情行）。
 *   **本轮没有改它们任何一行。**
 */
import {
  curveLengthM,
  freePathPoints,
  freePathShapeText,
  normalizeFreePathTrips,
  parseFreePathShape,
  planFreePathTrips,
  polylineShapeLengthM,
  usableFreePathShape,
  type FreePathShape,
} from '~/utils/mp/pathShape'
// 🆕 2026-09-22（审计 B1/B2）：几何装配与跑步页**共用同一个纯函数入口**（否则"预览 ≠ 真跑"）
import { resolveFreePathGeometry } from '~/utils/mp/freePathGeometry'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import { distanceMeters, type LatLng } from '~/utils/mp/routeSimilarity'
// 🆕 2026-09-22（用户澄清"定位 = 定位我们在的位置"）：失败原因 → 人话 + 降级链的选择，都在这个纯模块里
import {
  geoLocatedText,
  geolocationFailure,
  locateFallbackNotice,
  pickLocateFallback,
  type GeoFailure,
  type LocateFallbackCandidate,
} from '~/utils/mp/geolocation'
// 🆕 2026-09-22（审计 B1）：保存形状的报文构造（**显式清掉起跑点**）与那句如实提示，抽成纯函数 + 单测
import { buildFreeShapeSave, startClearedNote } from '~/utils/mp/freePathSave'
// 「改回内外双圈」要判"记录上现存的这两圈到底合不合法" ⇒ 复用跑道编辑页同一套纯函数判据
import { validateRings } from '~/utils/mp/trackEditor'
import { LOCAL_FREE_LINE_ID, LOCAL_FREE_LINE_NAME, localFreeTrackLine } from '~/utils/mp/trackLibrary'
import type { MpRunLine } from '~/src/mp/types'

/** 契约层坐标（latitude/longitude 可能是字符串） */
type P = LatLng
/** 内部数值型坐标（**所有算术/存本机都用它**；N 可赋给 LatLng，反之不行） */
type N = { latitude: number; longitude: number }
const num = (p: LatLng): N => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })

// 与 run.vue / 跑道编辑页同一套取法：`useMpReal()` 返回 profile/status/task（真实链路），演示态用 useMpDemo 的 task 兜底
const { status: realStatus, task: realTask } = useMpReal()
const { task: demoTask } = useMpDemo()
const activeTask = computed(() => realTask.value ?? demoTask.value)
/** 任务下发的线路（**原样**；本页只用来"参照 + 定位"，从不写它、也不改它） */
const activeLines = computed<MpRunLine[]>(() => activeTask.value?.runPointList ?? [])
/**
 * 任务**有没有下发官方线路**：
 * 唯一判据来源是纯函数 `localFreeTrackLine`（`utils/mp/trackLibrary.ts`）——它内部走
 * `routeRequirementOf`，与跑道编辑页 / 跑步页 / 门禁**同源**，不许在这里另写一套。
 * 非空 = 未下发线路（如「研途健行」）⇒ 本页画的形状就是跑步页要用的几何。
 */
const localFreeLine = computed(() => localFreeTrackLine(activeTask.value))
/** 下发了官方线路（= 本页不生效）时的第一条官方路线：只为在卫星图上给个"大致位置"参照 */
const officialPts = computed<N[]>(() => {
  for (const l of activeLines.value) {
    const pts = (l.pointList ?? []).map(num)
    if (pts.length >= 2) return pts
  }
  return []
})
const showSnackbar = useNotice()

// ---------- 本机路线库（固定键 local:free）----------
const lib = useTrackLibrary()
/** 模板里要用的 ref 需要拿出来（嵌套在对象里的 ref 模板不会自动解包） */
const libEntries = lib.entries
/** 本任务对应的那条本机记录（键名固定 `local:free`；还没有就是 undefined） */
const entry = computed(() => lib.get(LOCAL_FREE_LINE_ID))
/** 这条记录上已保存的形状（纯函数读数；界面只渲染它，不自己拼字符串） */
const savedShapeText = computed(() => freePathShapeText(entry.value?.freeShape))
/**
 * 记录上的**起跑点/绕向**（在「跑道编辑」里设）：圈型轨迹预览必须与跑步页用同一份设置，
 * 否则"预览的形状"与"真跑的形状"又是两条线（审计 B1）。
 */
const entryStart = computed(() => entry.value?.start ?? null)
const hasStart = computed(() => Boolean(entryStart.value))

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
 * 地图图层（与跑道编辑页同一套地址）：
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

const mapEl = ref<HTMLElement | null>(null)
const onResize = () => {
  const el = mapEl.value
  if (el) viewport.value = { w: el.clientWidth, h: el.clientHeight }
}
onMounted(() => {
  lib.load()
  onResize()
  window.addEventListener('resize', onResize)
  /**
   * 把这条本机记录上**已经保存的形状**填进草稿（没有就停在"先选形状"）。
   * ⚠️ 只在挂载时读一次：保存后记录会变，若跟着 watch 重灌草稿会把用户
   *    正在填的趟数/正在画的草稿冲掉。
   */
  loadFreeDraft(lib.get(LOCAL_FREE_LINE_ID)?.freeShape)
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

// ---------- 鼠标交互：拖动平移 / 单击加点（本页**没有**可拖动的点）----------
let dragging = false
let dragFrom = { x: 0, y: 0 }
let moved = false
/**
 * 按下：只记录起点。
 *
 * ⚠️ 跑道编辑页在这里还有一步"抓点"判定（12 px 内算抓住那个小圆点），而**抓点只能抓屏幕上看得见的点**
 *    （审计 B8：看不见的草稿点若参与命中判定，点击会被静默吞掉）。本页只画你正在画的这条路径、
 *    **不提供拖点**（要改就"撤销上一个点"或"清空重画"）⇒ 这里不做命中判定，任何一次单击都必然生效。
 */
const onDown = (e: MouseEvent) => {
  dragging = true
  moved = false
  dragFrom = { x: e.offsetX, y: e.offsetY }
}
const onMove = (e: MouseEvent) => {
  if (!dragging) return
  const dx = e.offsetX - dragFrom.x
  const dy = e.offsetY - dragFrom.y
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
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
  dragging = false
  if (!wasDragging || moved) return
  /** 单击（没拖动）= **画非官方路径**：圈型与折线型都是"逐点添加" */
  onFreeMapClick(toLatLng(e.offsetX, e.offsetY))
}
const zoomBy = (d: number) => {
  zoom.value = Math.min(Z_MAX, Math.max(Z_MIN, zoom.value + d))
}

// ---------------------------------------------------------------- 【测试】非官方路径绘制（2026-09-22）

/**
 * ## 这是什么（用户原话）
 * > "主要的功能是绘制**非官方性路径**……点击**定位**按钮，相关的地图移动到定位位置，
 * >  用户可以选择**圈型**，或者**直线型**【直线型又有**折返性**】，然后绘制那些路径"
 *
 * ## 交互口径（为什么这么定）
 *   · 它与「外圈 / 内圈 / 起跑点」是**两页**的事：本页只画"非官方路径"，双圈几何在「跑道编辑」里描；
 *   · `freeMode` 非空 = 正在画这条路径，地图单击一律走 `onFreeMapClick`（本页没有别的编辑语义）；
 *   · 几何与趟数的算法全部在 `utils/mp/pathShape.ts`（纯函数、有单测），**界面不自己算**。
 */
const freeMode = ref<'off' | 'curve' | 'polyline'>('off')
/** 圈型草稿点（**不重复存收盘点** —— 闭合由算法统一补，界面只负责"点了几笔"） */
const draftFreePoints = ref<N[]>([])
/**
 * 🆕 **折线型草稿点**（2026-09-22 用户澄清："我要的是折线，不是直线"）：**逐点添加**、**不闭合**、可拐弯。
 * 一趟 = 沿它去 + 原路返回（算法在 `expandFreePathTrajectory` 里展开，界面不自己拼）。
 */
const draftPolyPoints = ref<N[]>([])
/** 目标里程（km，用于"自动算趟数"）—— 默认 3.2，与既有轨迹预览的口径一致 */
const freeTargetKm = ref(3.2)
/**
 * 用户手填的趟数。
 * ⚠️ 类型故意放宽到 `string`：`v-model.number` 在**输入框被清空**时会把 `''` 写进来
 *    （不是 `null`）—— 声明成 `number | null` 只是骗自己，`normalizeFreePathTrips` 本来就收 `unknown`。
 */
const freeTripsInput = ref<number | string | null>(null)

/** 当前草稿构成的形状（`null` = 还没画够） */
const draftFreeShape = computed<FreePathShape | null>(() => {
  if (freeMode.value === 'curve') {
    return draftFreePoints.value.length >= 2 ? { kind: 'curve', points: draftFreePoints.value.map((p) => ({ ...p })) } : null
  }
  if (freeMode.value === 'polyline') {
    return draftPolyPoints.value.length >= 2 ? { kind: 'polyline', points: draftPolyPoints.value.map((p) => ({ ...p })) } : null
  }
  return null
})
/** 草稿是否**可用**（长度 > 0）—— 保存按钮的判据 */
const draftFreeUsable = computed(() => usableFreePathShape(draftFreeShape.value))
/**
 * 草稿**是不是空的**（一个点都没有）—— 「撤销上一个点」的禁用判据（审计 B6）。
 *
 * ⚠️ 不能拿 `draftFreeShape` 当判据：形状至少要 2 个点才成立 ⇒ 只点了 1 个点时按钮是灰的，
 *    用户**撤不掉自己刚点错的那一笔**（"撤销"恰恰是那时最需要按的按钮）。
 */
const freeDraftEmpty = computed(() => {
  if (freeMode.value === 'curve') return draftFreePoints.value.length === 0
  if (freeMode.value === 'polyline') return draftPolyPoints.value.length === 0
  return true
})
/** 趟数计划（自动/手填都在这里算，界面只渲染它的结果） */
const freePlan = computed(() => planFreePathTrips(draftFreeShape.value, freeTargetKm.value, freeTripsInput.value))
/**
 * 手填的趟数是否**填错了**（审计 B7）。
 * ⚠️ **清空输入框（`''`）＝ "没填"**，不是"填错" —— 输入框标签写的就是"留空＝按目标里程自动算"，
 *    所以这里必须把空白排除掉，否则用户一清空就看到"不是有效正数"的自相矛盾提示。
 */
const freeTripsManualInvalid = computed(() => {
  const raw = freeTripsInput.value
  const blank = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')
  return !blank && normalizeFreePathTrips(raw) === null
})

/** 当前画到哪儿了（给用户的实时反馈；**纯文本，不带 markdown 标记**——模板里是原样渲染的） */
const freeStatusText = computed(() => {
  if (freeMode.value === 'curve') {
    const n = draftFreePoints.value.length
    if (n === 0) return '还没开始：在地图上依次点出边缘的几个点（至少 2 个；点满 3 个才是真正的圈），算法会自动把首尾闭合起来'
    if (n === 1) return '已点 1 个点：再点至少 1 个点才能成为一条路径（只有 2 个点 = 一条往返线）'
    if (n === 2) return '已点 2 个点：已闭合成一条"往返线"（等于折线型折返）。想画圈就再点几个点'
    return `已点 ${n} 个点，已闭合成曲线（算法自动补上"最后一点 → 第一点"这一段）`
  }
  if (freeMode.value === 'polyline') {
    const n = draftPolyPoints.value.length
    if (n === 0) return '还没开始：在地图上依次点出这条折线的点（至少 2 个；每多点一个就多一个拐弯）'
    if (n === 1) return '已点 1 个点：再点至少 1 个点才能成为一条折线（两点就是一条来回的直路）'
    return `已点 ${n} 个点：已连成折线（不闭合），轨迹会沿它来回跑 —— 去 + 原路返回 = 一趟`
  }
  return ''
})

/** 地图上要画的非官方路径（圈型按闭合画；折线型是**不闭合**的折线） */
const freeShapePath = computed<N[]>(() => {
  if (freeMode.value === 'curve') return draftFreePoints.value
  if (freeMode.value === 'polyline') return draftPolyPoints.value
  return []
})

/** 预览用的随机种子（固定值：预览要稳定，不能每次重算都变一条线） */
const seed = ref(20260917)

/**
 * 非官方路径的**最终轨迹预览**（橙色那条线）。
 *
 * ⚠️ 2026-09-22（审计 B1）：预览与跑步页**必须走同一个入口** `resolveFreePathGeometry()` ——
 *   此前预览直接用 `expandFreePathTrajectory`（**没套起跑点变换**），而跑步页套了 `applyStartToLoop`
 *   ⇒ 只要那条记录带 `start.offsetM > 0`，"预览的形状"与"真跑的形状"就是两条不同的线（所见非所跑）。
 *   现在两处同源：同一趟数（1 趟，审计 B2）、同一个圆角开关（关）、同一个保点旋转。
 *
 * ⚠️ 2026-09-22（终检口径提示）：预览里程**固定 1.5 km**，**不跟随**上面的"目标里程/趟数"。
 *   为什么这么选（而不是按真实目标里程出预览）：
 *     · 真实目标里程可达 100 km（`FREE_PATH_MAX_TARGET_KM`）⇒ 预览会生成上万点、地图卡顿，
 *       而它**只需要证明"轨迹贴着形状"**（审计 B1 的所见即所跑），不需要画满全程；
 *     · 固定值 ⇒ 预览**稳定可比**（同一个形状每次画出来一模一样，便于用户/探针对照）。
 *   代价：**圈数会明显多于"共 N 圈"**（小圈尤其明显）⇒ 界面上必须**如实写明**"预览固定 1.5 km，
 *   不代表实际圈数"（见模板里那行小字），否则测试用户会误判"轨迹与形状不一致"。
 */
const PREVIEW_TARGET_KM = 1.5
const freeTrajectory = computed<N[]>(() => {
  if (!draftFreeUsable.value) return []
  const resolved = resolveFreePathGeometry(draftFreeShape.value, hasStart.value ? entryStart.value : null)
  if (!resolved) return []
  try {
    const g = generateCorridorRoute(resolved.geometry, {
      targetKm: PREVIEW_TARGET_KM,
      stepM: 5,
      drift: true,
      seed: seed.value,
      smoothRoute: resolved.smooth ? 2 : 0,
    })
    return g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
  } catch {
    // 预览失败不影响保存（保存只需要形状本身）；不弹错、不让页面炸
    return []
  }
})

/** 切到/切出某个形状（`off` = 没在画） */
const setFreeMode = (m: 'off' | 'curve' | 'polyline') => {
  freeMode.value = m
}
/**
 * 形状选择控件的**选中态**（`v-btn-toggle` 的 model）。
 *
 * 为什么不直接绑 `freeMode`：
 *   · 点**已选中**的按钮时，Vuetify 会把它置成 `null`（取消选中）⇒ 直接绑会把 `null` 写进
 *     `freeMode`，类型与逻辑都对不上；
 *   · `'off'`（没在画）不属于任何按钮 ⇒ 两个按钮都显示未选中，正是我们要的。
 * 这里统一收口：`null` / `'off'` 都是"退出绘制"。
 */
const freeModeToggle = computed<'curve' | 'polyline' | null>({
  get: () => (freeMode.value === 'off' ? null : freeMode.value),
  set: (v) => setFreeMode(v === 'curve' || v === 'polyline' ? v : 'off'),
})
/** 撤销上一个点（两种形状一样：都是"弹掉刚点的那一笔"） */
const undoFreePoint = () => {
  if (freeMode.value === 'polyline') {
    draftPolyPoints.value = draftPolyPoints.value.slice(0, -1)
    return
  }
  draftFreePoints.value = draftFreePoints.value.slice(0, -1)
}
/** 清空重画 */
const clearFreeShape = () => {
  draftFreePoints.value = []
  draftPolyPoints.value = []
  showSnackbar('已清空非官方路径，可以重新画')
}

/**
 * **定位 = 定位"我们在的位置"**（2026-09-22 用户澄清）。
 *
 * ## 主行为：浏览器定位
 * 点「定位（我的位置）」⇒ `navigator.geolocation.getCurrentPosition(...)`（高精度、10 秒超时、不缓存），
 * **成功**就把地图**居中并缩放到 `GEO_ZOOM`** 到那个坐标，在地图上放"你在这里"标记 + **精度圈**
 * （半径 = `coords.accuracy` 米），并**如实报出精度**（`geoLocatedText`）。
 *
 * ## 降级：只有在浏览器定位不可用时才走
 * 原因分情形说人话（拒绝授权 / 位置不可用 / 超时 / 浏览器不支持 / **非安全上下文**，见纯模块
 * `utils/mp/geolocation.ts`），然后按**优先级链**退回：你正在画的路径 → 本任务下发的官方路线 →
 * 本机路线库里已保存的几何；提示里必须同时说清"为什么"与"退到了哪一级"（`locateFallbackNotice`）。
 *
 * ## 隐私（与需求一致）
 * 坐标**只在本页内存里**用于地图居中与画标记：不写 localStorage、不进日志、不进提交报文，
 * 也没有任何"自动上传位置"的行为。
 */
const GEO_ZOOM = 17
/** 上一次成功读到的位置（内存态；`accuracyM <= 0` 表示浏览器没给精度） */
const myPos = ref<N & { accuracyM: number } | null>(null)
/** 上一次失败的原因（内存态；成功一次就清掉） */
const geoFailure = ref<GeoFailure | null>(null)
/** 正在请求定位（按钮转圈，防止用户连点） */
const geoBusy = ref(false)

/** 精度圈的**像素半径**：把"北偏 accuracy 米"的点按同一套投影算回屏幕，取 y 方向差 */
const accuracyRadiusPx = computed(() => {
  const p = myPos.value
  if (!p || !(p.accuracyM > 0)) return 0
  const dLat = p.accuracyM / 111320
  return Math.abs(toPx({ latitude: p.latitude - dLat, longitude: p.longitude }).y - toPx(p).y)
})

/**
 * **降级**（唯一出口）：如实说明失败原因 + 退到链上第一个可用的几何；一级都没有就明说"先画一笔"。
 * ⚠️ 这里**不再**是主行为 —— 只有浏览器定位不可用时才被调用。
 */
const degradeToFallback = (failure: GeoFailure) => {
  geoFailure.value = failure
  const choice = pickLocateFallback(freeLocateCandidates.value)
  if (choice) focusOn(choice.pts)
  showSnackbar(locateFallbackNotice(failure, choice), 'warning')
}

/** 「定位（我的位置）」：先问浏览器要位置；不可用/被拒/超时 ⇒ 降级（见 `degradeToFallback`） */
const locateMe = () => {
  const geo = typeof navigator === 'undefined' ? undefined : navigator.geolocation
  const supported = Boolean(geo && typeof geo.getCurrentPosition === 'function')
  /** ⚠️ 浏览器只在**安全上下文**（https / localhost / 127.0.0.1）里允许定位；换普通域名会被直接禁掉 */
  const secure = typeof window === 'undefined' ? true : window.isSecureContext !== false
  /** `!geo` 单列一条：既短路，也让 TS 把 `geo` 收窄成"一定有"（否则下面调用处报 possibly undefined） */
  if (!geo || !supported || !secure) {
    degradeToFallback(geolocationFailure(undefined, { supported, secure }))
    return
  }
  geoBusy.value = true
  try {
    geo.getCurrentPosition(
      (pos) => {
        geoBusy.value = false
        const latitude = Number(pos?.coords?.latitude)
        const longitude = Number(pos?.coords?.longitude)
        const rawAccuracy = Number(pos?.coords?.accuracy)
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          // 拿到了"成功"回调却没有可用坐标：当作失败降级，绝不假装定位成功
          degradeToFallback(geolocationFailure(undefined))
          return
        }
        const accuracyM = Number.isFinite(rawAccuracy) && rawAccuracy > 0 ? rawAccuracy : 0
        /** 坐标**只放内存**（见上面"隐私"一段） */
        myPos.value = { latitude, longitude, accuracyM }
        geoFailure.value = null
        center.value = { latitude, longitude }
        zoom.value = GEO_ZOOM
        showSnackbar(geoLocatedText(accuracyM))
      },
      (err) => {
        geoBusy.value = false
        degradeToFallback(geolocationFailure((err as GeolocationPositionError | undefined)?.code, { supported: true, secure }))
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  } catch {
    // 某些环境（老浏览器 / 被企业策略拦截）会在**调用时**直接抛 ⇒ 按"浏览器不支持"降级，不让页面炸
    geoBusy.value = false
    degradeToFallback(geolocationFailure(undefined, { supported: false }))
  }
}

/**
 * **降级用的定位链**（按优先级排列，只在浏览器定位不可用时被消费）：
 *   ① 你正在画的非官方路径 → ② 本任务下发的官方路线（若真有）→ ③ 本机路线库里已保存的几何。
 * 三级都空（全新状态）⇒ `pickLocateFallback` 返回 `null`，提示里明确说"先画一笔"。
 */
const freeLocateCandidates = computed<LocateFallbackCandidate[]>(() => {
  const out: LocateFallbackCandidate[] = []
  if (freeShapePath.value.length >= 2) out.push({ level: 'draft', pts: [...freeShapePath.value], label: '你正在画的非官方路径' })
  if (officialPts.value.length >= 2) out.push({ level: 'official', pts: officialPts.value, label: '本任务下发的官方路线' })
  const libPts: N[] = []
  for (const e of libEntries.value) {
    libPts.push(...freePathPoints(e.freeShape).map(num))
    libPts.push(...(e.outer ?? []).map(num))
  }
  if (libPts.length >= 2) out.push({ level: 'library', pts: libPts, label: '本机路线库里已保存的几何' })
  return out
})
/** 地图点击（**画非官方路径时唯一的加点入口**）—— 用户原话里的"直接在地图上点出路径" */
const onFreeMapClick = (p: N) => {
  if (freeMode.value === 'curve') {
    draftFreePoints.value = [...draftFreePoints.value, p]
    return
  }
  if (freeMode.value !== 'polyline') return
  /**
   * 折线型：**逐点添加**（可以拐弯）。
   * ⚠️ 与上一个点太近（< 1 m）就直接拒绝并说明 —— 双击/手抖会在同一点点两下，
   *    那种"0 m 的段"没有意义（算法里也会被 `dedupeAdjacent` 去掉，这里先如实告诉用户）。
   */
  const last = draftPolyPoints.value[draftPolyPoints.value.length - 1]
  if (last && distanceMeters(last.latitude, last.longitude, p.latitude, p.longitude) < 1) {
    showSnackbar('这个点与上一个点太近了（不足 1 m），请在地图上离远一些再点', 'warning')
    return
  }
  draftPolyPoints.value = [...draftPolyPoints.value, p]
}

/**
 * 从库里载入某条记录的形状时，把它填进草稿（没有就清空草稿、停在"先选形状"）。
 * ⚠️ 一律先过 `parseFreePathShape()`：**老记录里的 `{kind:'line',from,to}` 会被读成等价的 2 点折线**
 *    （向后兼容的唯一入口），于是本页只会看到 `curve` / `polyline` 两种形状。
 */
const loadFreeDraft = (raw: unknown) => {
  const shape = parseFreePathShape(raw)
  draftFreePoints.value = []
  draftPolyPoints.value = []
  freeTripsInput.value = null
  if (!shape) {
    freeMode.value = 'off'
    return
  }
  if (shape.kind === 'curve') {
    freeMode.value = 'curve'
    draftFreePoints.value = shape.points.map(num)
  } else {
    freeMode.value = 'polyline'
    draftPolyPoints.value = shape.points.map(num)
  }
}
/**
 * **【测试】非官方路径的保存**（唯一入口）。
 *
 * 沿既有保存/落盘提示链路（`lib.upsert` + `persisted` 如实提示），区别只有两点：
 *   ① 形状是权威（`freeShape`），`outer`/`inner` 是**给旧版本应用看的占位几何**；
 *   ② 校验走 `draftFreeUsable`（形状长度 > 0），**不要求内外圈合法** —— 自由路径本来就没有双圈。
 *
 * ⚠️ 2026-09-22（审计 B3）：占位几何**必须 ≥3 点**（`freeShapePlaceholderRing`）。
 *    1.2.4 及更早的版本按"内外圈各 ≥3 点"判合法 ⇒ 只放 2 点时旧版会认为这条记录不合法、
 *    列表里看不到它，而旧版**任何一次写操作**都会把"不含它"的整份 `entries` 写回 localStorage
 *    ⇒ **把用户画的非官方路径永久删掉**。补到 3 点（2 点的折线就是 A/中点/B）就能让旧版收下这条记录。
 *
 * ⭐ 2026-09-22（审计 B1，真 bug）：报文里**显式传 `start: null`** —— 形状变了，起跑点就失效。
 *    原先**没传** `start`，而 `upsert` 的口径是「`undefined` = 沿用旧值」⇒
 *    在「跑道编辑」里按**旧几何**设过的 `offsetM` 会被**悄悄沿用到新形状**上
 *    （`applyStartToLoopKeepingVertices` 只按模绕回、不报错 ⇒ 用户以为起点还在原处）。
 *    报文构造与这句提示都在纯模块 `utils/mp/freePathSave.ts`（有单测钉住，防"顺手不传"再回归）。
 *
 * ⚠️ 本页**不传** `laneNo` / `laneCount`：那两个是「跑道编辑」里双圈几何的选项，
 *    `upsert` 的"不传 = 沿用旧值"正是我们要的（本页不去动它，也不假装知道）。
 */
const saveFreeShape = () => {
  const shape = draftFreeShape.value
  const payload = buildFreeShapeSave({
    shape,
    lineId: LOCAL_FREE_LINE_ID,
    lineName: String(localFreeLine.value?.lineName ?? entry.value?.lineName ?? LOCAL_FREE_LINE_NAME),
  })
  if (!payload) {
    showSnackbar('还存不了非官方路径：至少 2 个不重合的点（圈型 3 点以上才是真正的圈；折线型多点几个就多几个拐弯）', 'warning')
    return
  }
  /** 这次保存会不会**真的清掉**一个原先存在的起跑点（提示里如实说，见 `startClearedNote`） */
  const hadStartAtSave = hasStart.value
  const saved = lib.upsert(payload)
  if (!saved) {
    showSnackbar('保存被拒：这条记录既没有合法的内外圈、也没有可用的非官方路径形状', 'error')
    return
  }
  const { entry: savedEntry, persisted } = saved
  const detail = `本机跑道 · 第 ${savedEntry.editCount ?? 1} 次保存 · ${freePathShapeText(savedEntry.freeShape) ?? '形状未存上'}`
  const clearedStart = startClearedNote(hadStartAtSave)
  showSnackbar(
    `【测试】非官方路径已存入本机路线库（${detail}）${clearedStart}${persisted ? '' : '（但本机存储写入失败，刷新后可能丢失）'}`,
    persisted ? undefined : 'warning',
  )
}

/**
 * **改回内外双圈**（删除这条记录上的非官方路径形状）—— 审计 B4 的显式入口。
 *
 * 为什么必须有它：保存内外圈的那条路（「跑道编辑」里的 `save()`）会**显式清掉** `freeShape`
 * （避免"新描的两圈被旧形状无声压住"），但用户也可能只想"把形状删掉、保留双圈"。
 *
 * ⚠️ 本页**不画双圈**（那是「跑道编辑」的事）⇒ 这里只能用**记录上已经存着的那两圈**：
 *   · 那两圈**合法**（各 ≥3 点、不相交、环宽合理）⇒ 存双圈 + 清掉形状；
 *   · 不合法 ⇒ **拒绝**并说清下一步。带形状的记录，内外圈放的是**形状的占位几何**
 *     （审计 B3：占位是 ≥3 点、但外圈与内圈是同一份）⇒ 直接清掉形状会让这条记录变成
 *     "没有任何可用几何"的垃圾条目，所以必须先回跑道编辑描出真的两圈。
 */
const clearFreeShapeOnEntry = () => {
  const e = entry.value
  if (!e) {
    showSnackbar('本机路线库里还没有这条记录，没有可删的形状', 'warning')
    return
  }
  const rings = { outer: (e.outer ?? []).map(num), inner: (e.inner ?? []).map(num) }
  const check = validateRings(rings)
  if (!check.ok) {
    showSnackbar(
      `要改回内外双圈，请先回「跑道编辑」的「外圈/内圈」里描好合法的两圈并点「保存（本机）」（现在清掉形状会让这条记录没有任何可用几何）：${check.problems.join('；')}`,
      'warning',
    )
    return
  }
  const saved = lib.upsert({
    lineId: LOCAL_FREE_LINE_ID,
    lineName: String(localFreeLine.value?.lineName ?? e.lineName ?? LOCAL_FREE_LINE_NAME),
    outer: rings.outer,
    inner: rings.inner,
    freeShape: null,
  })
  if (!saved) {
    showSnackbar('删除被拒：内外圈不合法（各需至少 3 点）', 'error')
    return
  }
  freeMode.value = 'off'
  draftFreePoints.value = []
  draftPolyPoints.value = []
  showSnackbar(
    `已删除「【测试】非官方路径」形状，这条记录改回内外双圈几何${saved.persisted ? '' : '（但本机存储写入失败，刷新后可能丢失）'}`,
    saved.persisted ? undefined : 'warning',
  )
}

/**
 * **快速定位**（用户要求）：把地图移到给定点集的范围，并挑一个刚好装得下的缩放级。
 * 不传参数时：优先用"你正在画的那条路径"，否则用这个任务下发的官方路线。
 * 入参用**契约层坐标**（`P`，允许字符串）——降级链给回来的就是 `LatLng[]`，这里统一过一遍 `num()`。
 */
const focusOn = (ptsIn?: P[]) => {
  const pts: N[] = (ptsIn ?? (freeShapePath.value.length >= 2 ? freeShapePath.value : officialPts.value)).map(num)
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
/** 快速定位（卡片上的按钮）：把地图移到当前几何 / 官方路线 */
const locateNow = () => focusOn()
/** 这个任务下发的官方线路条数（提示里如实报数） */
const officialLineCount = computed(() => activeLines.value.length)
/** SVG path 构造（与跑道编辑页同一个写法） */
const pathOf = (pts: P[], close = false) => {
  if (!pts.length) return ''
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${toPx(p).x.toFixed(1)},${toPx(p).y.toFixed(1)}`).join(' ')
  return close ? `${d} Z` : d
}
</script>

<template>
  <v-container fluid>
    <!--
      🆕 2026-09-22（结构调整）：本页从「跑道编辑」里搬出来，与「签到区域」「跑道编辑」并列。
      提示链路照既有写法：先如实说任务状态，再如实说"这块 UI 在当前任务下到底生不生效"。
    -->
    <v-alert v-if="realStatus !== 'ready'" type="info" variant="tonal" density="compact" class="mb-3">
      还没读取真实任务：回「工作台」点「一键获取 token」后，本页才知道当前任务下发了什么（也可先用演示数据试手感）。
    </v-alert>

    <!--
      ① 任务**下发了官方线路**时的如实说明（用户要求：本页仍可进入，但必须说清楚它不生效）。
      ⚠️ 只在确实读到任务时显示（连任务都没有时，上面那条已经说明该去做什么）。
    -->
    <v-alert v-if="activeTask && !localFreeLine" type="warning" variant="tonal" density="comfortable" class="mb-3">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-alert-outline</v-icon>本任务下发了官方线路（{{ officialLineCount }} 条）—— 本页画的路径只用于「未下发线路」的任务
      </div>
      <div class="text-body-2 mt-1">
        这个任务的 <b>runPointList 里有官方线路</b>，跑步页会按你在跑步页选的那条<b>官方线路</b>生成轨迹，
        <b>不会</b>用本页画的路径。本页画的东西仍然存进本机路线库的固定键 <code>local:free</code>，
        只有「<b>服务端未下发线路</b>」的任务（如研究生院「<b>研途健行</b>」）才会用它开跑 ——
        那种任务没有官方路线可选，跑步页就用这条本机几何生成轨迹。
        它<b>不会影响官方线路任务</b>，也<b>绝不会</b>进提交报文（提交用的是厂商线路 id）。
      </div>
    </v-alert>

    <!-- ② 任务未下发线路（本页真正生效的情形）：与原先那张卡里的说明同一个口径 -->
    <v-alert v-if="localFreeLine && activeTask" type="warning" variant="tonal" density="comfortable" class="mb-3">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-flask-outline</v-icon>【测试】实验功能：用来给不指定路线的任务画一条自己的路径
      </div>
      <div class="text-body-2 mt-1">
        本任务「服务端未下发线路」（runPointList 为空），所以跑步页没有官方路线可用 ——
        你可以直接画一条<b>圈型闭合曲线</b>绕着跑，或者画一条<b>折线</b>（可以拐弯，如 A→B→C→D）来回折返跑。
        画完保存进本机路线库（键名仍是 <code>local:free</code>），跑步页就会用这条几何开跑。
        <b>它不是官方线路</b>，只存在这台电脑上，也不会进提交报文。
      </div>
    </v-alert>

    <v-row dense>
      <v-col cols="12" md="8">
        <v-card>
          <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2">
            【测试】非官方路径地图
            <v-chip size="small" variant="tonal" color="warning">【测试】洋红=非官方路径</v-chip>
            <v-chip size="small" variant="tonal" color="warning">橙=最终轨迹</v-chip>
            <v-chip v-if="officialPts.length > 1" size="small" variant="tonal" color="primary">白虚线=官方路线（参照）</v-chip>
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
                <!-- 官方路线（参照用；任务没下发线路时这条不画） -->
                <path
                  v-if="officialPts.length > 1"
                  :d="pathOf(officialPts, true)"
                  fill="none"
                  stroke="#ffffff"
                  stroke-width="2"
                  stroke-dasharray="6 5"
                  opacity="0.9"
                />
                <!--
                  🆕 非官方路径（2026-09-22）：**洋红 = 你画的那条形状本身**（圈型闭合曲线 / 折线 A→B→C…）
                  ⚠️ 圈型用 `pathOf(..., true)` 闭合画 —— 用户点完最后一个点就该看到"已经连上了"，
                     而不是等保存后才发现自己画的其实是条开口折线。
                -->
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
                <!-- 非官方路径的轨迹预览（与跑步页同一套算法：展开 → 生成；里程固定 1.5 km） -->
                <path v-if="freeTrajectory.length > 1" :d="pathOf(freeTrajectory)" fill="none" stroke="#f59e0b" stroke-width="1.4" opacity="0.85" />
                <!--
                  🆕 2026-09-22（用户澄清"定位 = 定位我们在的位置"）：**你在这里** + **精度圈**
                  （精度半径按同一套投影换算成像素 ⇒ 缩放/平移时圈也跟着对得上）。
                  坐标只在本页内存里用于居中与画这个标记：不落盘、不进日志、不进提交报文。
                -->
                <template v-if="myPos">
                  <circle
                    :cx="toPx(myPos).x"
                    :cy="toPx(myPos).y"
                    :r="accuracyRadiusPx"
                    fill="#38bdf8"
                    fill-opacity="0.18"
                    stroke="#38bdf8"
                    stroke-width="1"
                  />
                  <circle :cx="toPx(myPos).x" :cy="toPx(myPos).y" r="6" fill="#0ea5e9" stroke="#fff" stroke-width="2" />
                  <text :x="toPx(myPos).x + 9" :y="toPx(myPos).y - 8" fill="#e0f2fe" font-size="12" font-weight="bold">你在这里</text>
                </template>
              </svg>
            </div>
          </v-card-text>
          <v-card-text class="text-caption text-medium-emphasis">
            拖动=平移地图　单击=<b>{{
              freeMode === 'curve'
                ? '在当前位置加一个非官方路径的点（首尾会自动闭合）'
                : freeMode === 'polyline'
                  ? '在当前位置加一个折线点（逐个点出来，可以拐弯）'
                  : '先在右侧选一个形状（圈型 / 折线型）'
            }}</b>　画好的点<b>不可拖动</b>：要改就「撤销上一个点」或「清空重画」
            <template v-if="myPos">
              <br />蓝点=你在这里（半透明圆 = 浏览器给的精度范围 ±{{ myPos.accuracyM > 0 ? Math.round(myPos.accuracyM) : '?' }} m）
            </template>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <v-card variant="outlined" color="warning">
          <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2">
            <v-chip size="small" color="warning" variant="flat">【测试】</v-chip>
            非官方路径绘制
          </v-card-title>
          <v-card-text>
            <div v-if="savedShapeText" class="text-caption text-medium-emphasis mb-3">
              本机记录（<code>local:free</code>）上已保存的形状：<b>{{ savedShapeText }}</b>
            </div>

            <!--
              ① 定位（2026-09-22 用户澄清："定位是**定位我们在的位置**"）
              ⇒ 主行为是**浏览器定位**（成功后居中到当前位置 + 画"你在这里"+ 精度圈 + 如实报精度）；
                 只有浏览器定位不可用（拒绝授权 / 位置不可用 / 超时 / 浏览器不支持 / 非安全上下文）时，
                 才**降级**到下面那条链，并在提示里说清"为什么 + 退到了哪一级"。
            -->
            <v-btn
              block
              size="small"
              color="secondary"
              variant="tonal"
              class="mb-1"
              prepend-icon="mdi-crosshairs-gps"
              :loading="geoBusy"
              @click="locateMe"
            >
              定位（我的位置）
            </v-btn>
            <div class="text-caption text-medium-emphasis mb-2">
              会向浏览器申请一次定位权限，用于把地图移到你当前所在位置（只在本页内存里用来居中，不落盘、不上传）。
              <br />拒绝也能用：会退回到你正在画的路径 / 官方路线 / 本机已保存的几何。
            </div>
            <div v-if="myPos" class="text-caption mb-2">
              你在这里：<b>{{ myPos.latitude.toFixed(6) }}, {{ myPos.longitude.toFixed(6) }}</b>
              <template v-if="myPos.accuracyM > 0">　·　精度 <b>±{{ Math.round(myPos.accuracyM) }} m</b></template>
            </div>
            <div v-if="geoFailure" class="text-caption text-warning mb-2">
              上次定位失败：{{ geoFailure.reason }}（{{ geoFailure.hint }}）
            </div>

            <!-- ② 形状选择：圈型 / 折线型（再点一次已选中的那个 = 退出绘制） -->
            <div class="text-caption text-medium-emphasis mb-1">选择形状（再点一次 = 退出绘制）：</div>
            <v-btn-toggle v-model="freeModeToggle" density="compact" class="mb-3">
              <v-btn value="curve" size="small">圈型（闭合曲线）</v-btn>
              <v-btn value="polyline" size="small">折线型（折返）</v-btn>
            </v-btn-toggle>
            <div class="text-caption text-medium-emphasis mb-3">
              圈型 = 绕圈跑；<b>折线型</b> = 在地图上<b>逐个点出多个点</b>（可以拐弯，如 A→B→C→D），
              轨迹沿这条折线<b>来回跑</b>（去 + 原路返回 = 一趟）。
            </div>

            <template v-if="freeMode === 'off'">
              <div class="text-caption text-medium-emphasis mb-2">
                上面两个按钮选一个形状后，<b>在地图上依次点出路径</b>即可；选了形状之后这个按钮才会变为可用。
                <br />⚠️ 反过来：要回到内外双圈几何，请回「<b>跑道编辑</b>」描好外圈/内圈并点「<b>保存（本机）</b>」——
                那一步会清掉这条记录上的形状（避免"新描的两圈被旧形状无声压住"），提示里会写明。
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
                  预计长度（折线单程）：<b>{{ draftFreeUsable ? polylineShapeLengthM(draftFreeShape).toFixed(1) + ' m' : '—' }}</b>
                  <template v-if="draftFreeUsable">　·　一来一回 <b>{{ (polylineShapeLengthM(draftFreeShape) * 2).toFixed(1) }} m</b></template>
                </template>
                <!--
                  🆕 审计 B1：圈型**保留起跑点/绕向**，且用的是"保点旋转"（只插一个点、保留你点的每个折角，
                  几何总长与形状都不变）；折线型没有"沿弧长旋转"的语义，如实忽略起跑点。
                  ⭐ 但**保存形状会清掉起跑点**（形状变了，旧 offsetM 是按旧几何量的；见 saveFreeShape 的说明）：
                    有起跑点时这里必须把这件事说出来，否则用户会以为起点还在原处。
                -->
                <template v-if="freeMode === 'curve'">
                  <br />
                  <template v-if="hasStart">
                    圈型会保留本机记录上的起跑点/绕向（在「跑道编辑」里设；用保点旋转，不会改掉你画的形状）。
                    <br />⚠️ 但<b>保存这条形状会清掉起跑点</b>（形状变了，旧起跑点是按旧形状量的）——
                    保存后请回「<b>跑道编辑</b>」按新形状重设。
                  </template>
                  <template v-else>圈型当前没有起跑点设置（起跑点在「跑道编辑」里设）。</template>
                </template>
                <template v-else>
                  <br />折线型忽略起跑点设置（折线没有"沿弧长旋转"的语义）。
                  <template v-if="hasStart">
                    <br />⚠️ 另外：<b>保存这条形状会清掉起跑点</b>（形状变了，旧起跑点是按旧形状量的）——
                    保存后请回「<b>跑道编辑</b>」按新形状重设。
                  </template>
                </template>
              </div>
              <v-btn block size="small" variant="tonal" class="mb-2" prepend-icon="mdi-undo" :disabled="freeDraftEmpty" @click="undoFreePoint">
                撤销上一个点（非官方路径）
              </v-btn>
              <v-btn block size="small" variant="tonal" color="error" class="mb-3" prepend-icon="mdi-delete-outline" @click="clearFreeShape">
                清空重画
              </v-btn>

              <!-- ④ 折线型的折返趟数（圈型也用它算"绕几圈"，口径一致） -->
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
              <!--
                ⚠️ 审计 B7：**只渲染 `freePlan.note` 这一句**。
                note 本身已经带了"共 N 圈 · 合计约 X km（依据；一圈多长）" ⇒ 原先外面又拼一遍 head，
                整句会**打印两遍**（"共 3 圈 · 合计约 1.25 km（共 3 圈 · 合计约 1.25 km（…））"）。
              -->
              <div class="text-caption mb-1">{{ freePlan.note }}</div>
              <div v-if="freeTripsManualInvalid" class="text-caption text-warning mb-1">
                ⚠️ 手填的趟数不是有效正数，已按目标里程自动算（口径：<b>宁可多跑，绝不少跑</b>）。
              </div>
              <v-alert v-if="!draftFreeUsable" type="warning" variant="tonal" density="compact" class="mb-2">
                还不能跑：{{ freeMode === 'curve' ? '圈型至少 2 个不重合的点（3 点以上才是真正的圈）' : '折线型至少要 2 个不重合的点（多点几个就多几个拐弯）' }}。
              </v-alert>
              <!--
                ⚠️ 2026-09-22（终检口径提示）：预览里程**固定 1.5 km**，与上面的"目标里程/趟数"无关
                ⇒ 小圈型会画出好几圈，看着像"圈数与上面写的不一致"。这里**如实写明**，
                免得测试用户误判"轨迹与形状不一致"（预览只负责证明"轨迹贴着形状"）。
              -->
              <div class="text-caption text-medium-emphasis mb-2">
                地图上橙色那条是<b>轨迹预览</b>：固定画 <b>1.5 km</b> 只为看清"轨迹是否贴着形状"，
                <b>不代表实际圈数/里程</b>（实际按上面的目标里程与趟数生成）。
              </div>
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
                <template v-if="localFreeLine">
                  保存后回「跑步」页：本任务未下发线路 ⇒ 轨迹就用你刚画的这条几何生成（地图上橙色那条就是预览）。
                </template>
                <template v-else>
                  ⚠️ 本任务下发了官方线路 ⇒ 跑步页<b>不会</b>用这条几何（它只对"未下发线路"的任务生效）；地图上橙色那条只是预览。
                </template>
              </div>
              <!--
                🆕 审计 B4 的显式出口：把这条记录上的非官方路径形状**删掉**、改回内外双圈。
                ⚠️ 另一种"清掉形状"的方式是在「跑道编辑」里用「保存（本机）」存双圈 —— 那条路会自动清掉形状（并在提示里说明）。
              -->
              <v-btn
                v-if="entry?.freeShape"
                block
                size="small"
                variant="text"
                color="error"
                class="mt-2"
                prepend-icon="mdi-vector-polyline-remove"
                @click="clearFreeShapeOnEntry"
              >
                改回内外双圈（删除本机记录上的【测试】形状）
              </v-btn>
            </template>
          </v-card-text>
        </v-card>

        <!-- 快速定位：只动地图，不改任何几何 -->
        <v-btn
          block
          size="small"
          color="secondary"
          variant="tonal"
          class="mt-3"
          prepend-icon="mdi-crosshairs-gps"
          @click="locateNow"
        >
          快速定位（把地图移到当前几何 / 官方路线）
        </v-btn>
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
</style>
