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
  TRACK_NAME_MAX,
  duplicateNameGroups,
  entryDetailRows,
  entrySummaryText,
  formatLocalDateTime,
  historyLogText,
  isRealPathEntry,
  localFreeTrackLine,
  resolveEntryName,
  splitRealPathEntries,
  startSummaryText,
} from '~/utils/mp/trackLibrary'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
// 🆕 1.3.3（2026-10-30）：进场段 —— 与跑步引擎**同一个纯函数**，保证"所见即所跑"
import { prependEntrySegment } from '~/utils/mp/pathShape'
// 🆕 2026-09-22（真实用户实测）：从跑步页直达进来时 `?line=<pointId>` 要能**预选**这条线路
import { lineIdFromQuery } from '~/utils/mp/routeGroups'
import type { LatLng } from '~/utils/mp/routeSimilarity'
import type { MpRunLine } from '~/src/mp/types'
// 🆕 2026-09-22（issue #12）：判"任务到底有没有下发线路"（纯函数，与跑步页/门禁同源）
import { routeRequirementOf } from '~/utils/mp/taskShape'
// 🆕 2026-11-05（整理轮）：Web Mercator 投影单一来源（与轨迹预览/自由跑共用同一份实现）
import { TILE, lng2x, lat2y, x2lng, y2lat } from '~/utils/mp/webMercator'

/** 契约层坐标（latitude/longitude 可能是字符串） */
type P = LatLng
/** 内部数值型坐标（**所有算术/存本机都用它**；N 可赋给 LatLng，反之不行） */
type N = { latitude: number; longitude: number }
const num = (p: LatLng): N => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })

// 与 run.vue 同一套取法：`useMpReal()` 返回 profile/status/task（真实链路），演示态用 useMpDemo 的 task 兜底
const { profile: realProfile, status: realStatus, task: realTask, autoRestoreFromCache } = useMpReal()
const route = useRoute()
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
/**
 * 🆕 2026-11-03（1.3.6）：**正在编辑的是哪一条预设**（一个地点可以有多条）。
 *   · 非空 ⇒ 保存就是**更新这一条**；空串 ⇒ 保存是**新建一条**（`presetId` 由组合层生成）。
 *   · 与 `lineId` 的关系：`lineId` 是**地点**，`presetId` 是这个地点下的**某一条预设**。
 */
const presetId = ref<string>('')
/** 预设名称输入框（保存时交给 `lib.upsert({presetName})`；留空 = 自动命名） */
const presetName = ref<string>('')
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
const loadDraft = (ref: string) => {
  const e = lib.get(ref)
  /**
   * 🆕 2026-11-03（1.3.6）：把"正在编辑哪条预设 + 它叫什么"一起载入 ——
   * ⚠️ 名称框里放的是**显示名**（`resolveEntryName`）：旧条目没有自定义名时就是厂商线路名，
   *    用户直接点保存会把它**显式**存成预设名 —— 显示不变，但从此这条预设有了自己的名字（符合"名称不可为空"）。
   */
  presetId.value = e ? String(e.id) : ''
  presetName.value = e ? resolveEntryName(e) : ''
  draftOuter.value = (e?.outer ?? []).map(num)
  draftInner.value = (e?.inner ?? []).map(num)
  draftStartOffsetM.value = Number(e?.start?.offsetM ?? 0)
  draftStartPoint.value = e?.start?.point ? num(e.start.point) : null
  draftStartDirection.value = e?.start?.direction === 'reverse' ? 'reverse' : 'forward'
  // 🆕 1.3.3：进场点草稿（旧条目没有这个字段 ⇒ null = 未设置，与旧行为一致）
  draftEntryPoint.value = e?.entry?.point ? num(e.entry.point) : null
}
onMounted(() => {
  /**
   * 🆕 2026-09-22（真实用户实测）：**先从本机缓存把任务恢复回来**，再读路线库。
   * 否则从跑步页那条「去「跑道编辑」描一条」直达进来时，内存里没有任务 ⇒ 下拉里一条线路都没有
   * ⇒ 用户画完也存不了（他实测就是这样兜了半天的）。
   */
  autoRestoreFromCache()
  lib.load()
  const el = mapEl.value
  if (el) {
    viewport.value = { w: el.clientWidth, h: el.clientHeight }
    /**
     * 🆕 2026-10-30：滚轮缩放必须**非 passive** 注册（否则 `preventDefault()` 无效、页面会跟着滚）。
     * 为什么不在模板里写 `@wheel.prevent`：Vue 对 wheel 事件在部分浏览器会按 passive 注册，
     * 那种情况下 `.prevent` 无效且**不会报错** —— 症状正是"滚轮把整页滚走了"。手动挂最稳。
     */
    el.addEventListener('wheel', onWheel, { passive: false })
  }
  window.addEventListener('resize', onResize)
  loadDraft(lineId.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  // 🆕 1.3.3：滚轮监听是手动挂的，必须手动解绑（否则切走页面后 mapEl 引用不释放）
  mapEl.value?.removeEventListener('wheel', onWheel)
})
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
const editing = ref<'outer' | 'inner' | 'start' | 'entry'>('outer')
/** "当前圈"的收窄版本：只可能是 outer/inner（起跑点模式下不参与圈的编辑） */
const ringTarget = computed<'outer' | 'inner'>(() => (editing.value === 'inner' ? 'inner' : 'outer'))
const outer = computed(() => draftOuter.value)
const inner = computed(() => draftInner.value)
const setRing = (which: 'outer' | 'inner', pts: N[]) => {
  if (which === 'outer') draftOuter.value = pts
  else draftInner.value = pts
}
/**
 * 切换线路（地点）⇒ 自动载入**这个地点这次该编辑的那条预设**。
 * 🆕 2026-11-03（1.3.6）：判据用算法层的 `resolvePresetForLine()`（与跑步页/引擎同源）——
 * 一个地点有多条时取"用户选过的（可用）→ 第一条可用的 → 第一条"，
 * 旧数据（一个地点一条、id === lineId）下结果与旧版**逐字一致**。
 */
watch(lineId, (id) => loadDraft(String(lib.presetResolutionFor(String(id ?? '')).entry?.id ?? '')))

/**
 * 🔴 2026-11-10（用户口径"两种路径不是同一类"）：把库拆成**手绘跑道**与**真实路径**两组。
 * 判据在纯函数里（`splitRealPathEntries`），界面不自己写 `e.realPath` —— 那样两处口径会漂。
 */
const splitEntries = computed(() => splitRealPathEntries(libEntries.value))
const drawnEntries = computed(() => splitEntries.value.drawn)
const realEntries = computed(() => splitEntries.value.real)
/** 真实路径那一组是否展开（默认收起：它们常常一堆，全铺开会把跑道预设挤没） */
const realOpen = ref(false)

/**
 * 🆕 2026-11-03（1.3.6）：**"预设"下拉 + 名称输入**（用户要求"一个点位可以创建多个预设"、
 * "保存预设的时候可以输入相关名字进行存储，便于用户区分"）。
 *
 * 选项 = 这个地点的全部预设（最新保存在前），外加一项**「新建预设」**（空串值）：
 * 选中它 ⇒ 只清空"正在编辑的是哪条"，草稿与名称框**保留**（用户常常是"照着这条改一版"，别把手上的点清掉）。
 */
const presetOptions = computed(() => [
  /**
   * 🔴 2026-11-10 二次验收修正：**真实路径不进这个下拉**。
   *
   * 用户反馈："为什么我还是可以选择我之前导入的真实路径进行编辑？"——
   * 上一轮只改了下面的「本地路线库」列表，**这个下拉漏了**：它列的是"这个地点的全部预设"，
   * 真实路径也在其中，选中它就等于把真实跑出来的点列载进编辑器、存一下就改写了原始几何。
   * 判据与列表同源（`isRealPathEntry`），不再各写一套。
   */
  ...drawnEntries.value
    .filter((e) => String(e.lineId) === String(lineId.value))
    .map((e) => ({ title: `${resolveEntryName(e)} —— ${entrySummaryText(e)}`, value: String(e.id) })),
  { title: '＋ 新建一条预设（保存后出现在上面）', value: '' },
])
/**
 * 🆕 2026-11-03（用户实测反馈："点击新建预设，为什么会自动填充已经有的相关预设"）：
 * **新建 = 完全空白，从头描**（用户选择的口径）。
 *
 * 旧行为（本次改掉）：只清 `presetId`/`presetName`，把**草稿里的点全留着**（当时想的是"照着这条改一版"）。
 * 代价是：点「新建」后画布上还挂着上一条的内外圈、起跑点、进场点与偏移 —— 看起来像"自动填充了已有预设"，
 * 用户会怀疑是不是读错了数据。现在改成把**画布上的东西全清**，并把这句写在提示里。
 *
 * ⚠️ 保留的两个**参数**：`laneCount`（车道数）与 `insetM`（内缩米数）—— 它们是"这条路多宽"的常量，
 * 每次重设一遍没意义；但**必须在面板上写明"沿用当前值"**，否则又是一次"悄悄填充"。
 * `laneNo`（第几道）会回到"居中那道"，避免出现"新建的预设莫名其妙是第 8 道"（而这条路只有 6 道）。
 */
const startNewPreset = () => {
  presetId.value = ''
  presetName.value = ''
  /** 画布清空：内外圈、起跑点、进场点、沿跑道偏移、绕向 */
  draftOuter.value = []
  draftInner.value = []
  draftStartPoint.value = null
  draftStartOffsetM.value = 0
  draftStartDirection.value = 'forward'
  draftEntryPoint.value = null
  /** 回到外圈开始描（"从头描"的自然顺序：先外后内） */
  editing.value = 'outer'
  laneNo.value = Math.max(1, Math.round((laneCount.value + 1) / 2))
  showSnackbar(
    `已切到「新建预设」：画布已清空，从头描 —— 先描外圈、再描内圈 → 填名字（可留空）→ 点「保存（本机）」` +
      `（车道数 ${laneCount.value} 与内缩 ${insetM.value} m 沿用当前值，可在右侧改）`,
    'info',
  )
}
/**
 * 「预设」下拉变化：选中一条 ⇒ 载入它；选到「＋ 新建一条预设」（空串）⇒ 走 `startNewPreset()`。
 * ⚠️ 两条路径都**不静默改草稿**：载入是明确动作，新建则保留手上的点（用户常是"照着这条改一版"）。
 */
const onPresetPick = (v: unknown) => {
  const id = String(v ?? '').trim()
  if (!id) {
    startNewPreset()
    return
  }
  loadDraft(id)
}
/** 这个地点**同名预设**的检测结果（旧数据可能本来就有同名 —— 只提示，绝不自动改名） */
const dupNames = computed(() => duplicateNameGroups(libEntries.value))
/**
/** 正在编辑的那条预设（`presetId` 为空 = 还没保存过 / 正在新建） */
const editingEntry = computed(() => (presetId.value ? lib.get(presetId.value) : undefined))

/**
 * **快速定位**（用户要求）：把地图移到"已描的圈"的范围，并挑一个刚好装得下的缩放级。
 */
const focusOn = () => {
  const pts = outer.value.length >= 3 ? [...outer.value, ...inner.value] : official.value.map(num)
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
     * 🆕 2026-09-22（真实用户实测）：从跑步页的「去「跑道编辑」描一条」按钮进来时会带
     * `?line=<pointId>` ⇒ **预选这条线路**（否则用户还得自己在下拉里找，实测有人在别的页面兜了半天）。
     * 判据：只有"参数里指定的线路**确实在可选列表里**"才认；不在列表里就退回原逻辑（不猜）。
     */
    const wanted = lineIdFromQuery(route.query.line)
    if (wanted && ls.some((l) => String(l.pointId) === wanted)) {
      if (String(lineId.value) !== wanted) lineId.value = wanted
      return
    }
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
  /**
   * ⚠️ 2026-09-22（审计 B8 的原则）：**屏幕上看得见的点才允许被抓住** —— 看不见就不参与命中判定。
   *
   * 病因（当时的现场）：`nearestPointIndex` 走的是 `editingPts`（当前**圈**草稿），而画非官方路径时
   * 地图上根本没画那些圈点，落在它们 12 px 内的点击仍会被判成"抓住了一个点"⇒ `onUp` 里 `idx >= 0`
   * 直接 `return`，**这一点被静默吞掉**（用户只看到"点了没反应"）。那套"非官方路径"UI 已搬到
   * `components/FreePathView.vue`（独立子页），本页只剩"给当前圈加点/点选起跑点"⇒ 这里的判据
   * 自然只剩一种：**本页画出来的圈点就是全部可见点**。
   */
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
   *   ① `editing === 'start'` = 点选起跑点（1.1.12）；
   *   ② `editing === 'entry'` = 点选**进场点**（1.3.3，2026-10-30）—— 它是跑道外侧的那个点，
   *      **不吸附车道线**（本来就在跑道外），只校验"别离得太离谱"；
   *   ③ 其余 = 在点击处给"当前圈"（外圈/内圈）加一个点（老行为）。
   * ⚠️ 2026-09-22：原先这里还有"画非官方路径"这一支 —— 那套 UI 已搬到独立子页
   *    `components/FreePathView.vue`（`/field/free-path`），本页只剩上述几种含义。
   */
  if (editing.value === 'start') {
    setStartFromMap(toLatLng(e.offsetX, e.offsetY))
    return
  }
  if (editing.value === 'entry') {
    setEntryFromMap(toLatLng(e.offsetX, e.offsetY))
    return
  }
  const which = ringTarget.value
  setRing(which, [...(which === 'outer' ? outer.value : inner.value), toLatLng(e.offsetX, e.offsetY)])
}

const zoomBy = (d: number) => {
  zoom.value = Math.min(Z_MAX, Math.max(Z_MIN, zoom.value + d))
}

/**
 * 🆕 2026-10-30（1.3.3，用户要求）**光标在地图上时滚轮缩放**。
 *
 * 三条要点（少一条体验就坏）：
 *   ① **以光标为锚点**：先记下光标下的经纬度，缩放后把它重新放到同一个屏幕位置 ——
 *      否则"滚轮放大"会让视野整体跳走，用户得再拖回来（地图类软件的通行做法）。
 *   ② **必须 `preventDefault`**：不拦的话页面会跟着上下滚，地图反而从光标下面滑走。
 *      ⚠️ 为此监听必须是 **非 passive**：Vue 的 `@wheel` 模板写法在部分浏览器会注册成 passive，
 *      所以这里用 `addEventListener('wheel', …, { passive: false })` 手动挂（见 `onMounted`）。
 *   ③ **节流 + 合并**：触控板一次滑动会连发几十个 wheel 事件 ⇒ 用极小的时间窗合并成一次缩放，
 *      否则会"一下从 13 跳到 19"。用请求序号而不是定时器：同一帧内只处理最后一次，且**不丢用户意图**。
 */
const WHEEL_MIN_INTERVAL_MS = 40
let lastWheelAt = 0
const onWheel = (e: WheelEvent) => {
  const el = mapEl.value
  if (!el) return
  // 阻止页面滚动（③ 的前提）
  e.preventDefault()

  /** ③ 节流：过于密集的事件直接忽略（它们代表同一次滑动） */
  const now = Date.now()
  if (now - lastWheelAt < WHEEL_MIN_INTERVAL_MS) return
  lastWheelAt = now

  /** 在本级缩放下，光标处对应的经纬度 */
  const rect = el.getBoundingClientRect()
  const ox = e.clientX - rect.left
  const oy = e.clientY - rect.top
  const anchor = toLatLng(ox, oy)

  /** 滚轮向上（deltaY < 0）= 放大 */
  const step = e.deltaY < 0 ? 1 : -1
  const next = Math.min(Z_MAX, Math.max(Z_MIN, zoom.value + step))
  if (next === zoom.value) return
  zoom.value = next

  /**
   * ① 重新居中：让 `anchor` 回到光标原有的屏幕位置。
   * 新缩放下 anchor 的像素坐标 = `anchorPx`；我们希望它出现在 `(ox, oy)`，
   * 而屏幕位置 = 世界像素 - originPx，且 originPx = centerPx - 视口/2
   * ⇒ 反解出新的 center。
   */
  const anchorPx = { x: lng2x(anchor.longitude, next) * TILE, y: lat2y(anchor.latitude, next) * TILE }
  const newCenterPx = { x: anchorPx.x - ox + viewport.value.w / 2, y: anchorPx.y - oy + viewport.value.h / 2 }
  center.value = {
    longitude: x2lng(newCenterPx.x / TILE, next),
    latitude: y2lat(newCenterPx.y / TILE, next),
  }
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

/**
 * 最终轨迹预览：几何 = **跑道本身**（已按起跑点变换），进场点通过 `leadIn` 传入 ——
 * 与跑步引擎（`composables/demo/runner.ts`）**完全同一套口径**，保证"所见即所跑"。
 * ⚠️ 1.3.3 第一版的错法：把进场点拼进几何数组 ⇒ 它被当成跑道的一部分、每圈都绕回进场点
 *    （用户 2026-10-30 实测指正："现在并不是这个样子的"）。现在几何里**不许**出现进场点。
 */
const trajectory = computed<N[]>(() => {
  if (startLane.value.length < 3) return []
  const ep = draftEntryPoint.value
  const lead = ep && !entryNotice.value
  const g = generateCorridorRoute(startLane.value, {
    targetKm: 3.2,
    stepM: 3,
    drift: true,
    seed: seed.value,
    ...(lead ? { leadIn: [{ latitude: Number(ep.latitude), longitude: Number(ep.longitude) }] } : {}),
  })
  return g.points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
})

// ---------------------------------------------------------------- 进场点（1.3.3，2026-10-30）

/**
 * 🆕 **进场点**：真人绕圈前从跑道外侧走到跑道上，那一段小直线就是"进场段"。
 * 用户口径（2026-10-30）："**用户自行设置这一小段**" ⇒ 在地图上点哪就是哪，
 * **不自动算切点、不吸附车道线**（它本来就在跑道外）。
 *
 * 数据流与起跑点一致：`draftEntryPoint` 是编辑草稿，保存时写进条目的 `entry` 字段；
 * 真正的拼接在跑步引擎里（`composables/demo/runner.ts` 的 `withEntrySegment`），
 * 这里只负责"画给你看"——预览与真实生成走**同一个纯函数** `prependEntrySegment`。
 */
const draftEntryPoint = ref<N | null>(null)
const hasEntry = computed(() => Boolean(draftEntryPoint.value))

/** 进场段预览：车道线（已应用起跑点）+ 进场点拼好；`skipped` 非空时**界面必须显示原因** */
const entryPreview = computed(() =>
  prependEntrySegment(startLane.value, hasEntry.value ? { point: draftEntryPoint.value! } : null),
)
/** 进场段实际长度（米）；未设置 ⇒ 0 */
const entryLengthM = computed(() => (hasEntry.value ? entryPreview.value.entryM : 0))
/** 进场点不合理时的一句话（空串 = 没问题） */
const entryNotice = computed(() => entryPreview.value.skipped)

/**
 * 进场段连线在地图上的终点 —— 就是**起跑点**（进场段 = 进场点 → 起跑点）。
 * 用 `startMarker` 而不是 `draftEntryPoint`：起跑点没设时它是车道线第 0 点，也是轨迹真正起步处。
 */
const entryLineEnd = computed<N>(() => {
  const p = entryPreview.value.points[1]
  if (p) return { latitude: Number(p.latitude), longitude: Number(p.longitude) }
  return draftEntryPoint.value ?? { latitude: 0, longitude: 0 }
})

/** 地图点选进场点（不吸附：它本来就在跑道外侧） */
const setEntryFromMap = (p: N) => {
  if (lane.value.length < 3) {
    showSnackbar('先把内外圈描好（车道线算出来之后）再点选进场点', 'warning')
    return
  }
  draftEntryPoint.value = num(p)
  if (entryPreview.value.skipped) {
    showSnackbar(entryPreview.value.skipped, 'warning')
    return
  }
  showSnackbar(`进场点已设在这里（到起跑点约 ${entryPreview.value.entryM.toFixed(1)} m，轨迹会先走这段再进跑道）`)
}
/** 取消进场点（回到"直接从起跑点开始"的旧行为） */
const clearEntry = () => {
  draftEntryPoint.value = null
  showSnackbar('已取消进场点（轨迹直接从起跑点开始）')
}

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
  /** 🆕 审计 B4：这次保存会清掉一条已存在的非官方路径形状 ⇒ 提示里要如实说（见下面的 `freeShape: null`） */
  const hadFreeShapeAtSave = Boolean(editingEntry.value?.freeShape)
  /**
   * 🆕 2026-11-03（1.3.6）：**保存的是哪一条预设**。
   *   · `presetId` 非空 ⇒ **更新那一条**（保留创建日期/创建版本/编辑历史）；
   *   · `presetId` 为空（点了「＋ 新建一条预设」/ 这个地点还没有预设）⇒ **新建一条**。
   * ⚠️ 这是与旧版最大的差别：旧版的 `upsert` 按 `lineId` 覆盖 ⇒ 一个地点永远只有一条。
   */
  const savingPresetId = presetId.value.trim()
  const saved = lib.upsert({
    ...(savingPresetId ? { id: savingPresetId } : {}),
    lineId: lineId.value,
    lineName: String(currentLine.value?.pointName ?? lineId.value),
    /** 🆕 预设名称（用户手填；留空 ⇒ 组合层自动命名，保证不重名且非空） */
    presetName: presetName.value,
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
    /**
     * 🆕 进场点（1.3.3，2026-10-30）：同样**永远传明确值** ——
     * `null` = 明确清掉（用户点了「取消进场点」要能落盘，否则"删了又回来"）。
     */
    entry: hasEntry.value
      ? { point: { latitude: Number(draftEntryPoint.value!.latitude), longitude: Number(draftEntryPoint.value!.longitude) } }
      : null,
    /**
     * 🆕 **明确清掉非官方路径形状**（2026-09-22 审计 B4）。
     *
     * 病因：`freeShape` 的"不传 = 沿用旧值"是给老调用方留的，但**保存内外圈**这个动作本身
     * 就是在选择"用双圈几何跑" ⇒ 若还留着上一次存的形状，跑步页（有形状就优先用它）会**继续跑旧形状**，
     * 而用户刚描的两圈被**无声忽略** —— 界面还提示"已存入本机路线库"，属于最坏的一类静默错误。
     * 所以这里**永远传明确值 `null`**：存双圈 = 同时声明"不用非官方路径了"。
     */
    freeShape: null,
  })
  if (!saved.ok) {
    // 🆕 2026-11-03（1.3.6）：两种拒绝要**分开说**（几何不合法 / 名称撞车），措辞由组合层给
    showSnackbar(saved.message, 'error')
    return
  }
  const { entry, persisted } = saved
  /** 保存成功后把编辑器切到"正在编辑这一条"（否则下一次保存又会新建一条，越存越多） */
  presetId.value = String(entry.id)
  presetName.value = resolveEntryName(entry)
  /**
   * ⚠️ **落盘是否成功必须如实说**（2026-09-22，issue #12）：
   *   `lib.upsert` 现在把 `persist()` 的结果一起返回（原先丢掉了）—— 否则配额满 / 隐私模式下
   *   "内存里存了、磁盘上没有"，界面却报成功；而**刷新后这条跑道就没了**，
   *   自由路线任务恰恰只有它这一条几何来源（跑步页读的就是它）。
   * 另外把"存的是哪一条"写清楚：本机跑道（本任务未下发线路）与"服务端线路"是两回事，
   *   混在一起用户会以为存成了官方路线。
   * 🆕 2026-11-03：再补上**预设名**（一个地点多条时，"存的是哪一条"就靠它）。
   */
  const localSaving = String(lineId.value) === LOCAL_FREE_LINE_ID
  const detail = `${localSaving ? '本机跑道 · ' : ''}预设「${resolveEntryName(entry)}」· 第 ${entry.editCount ?? 1} 次保存 · ${entry.updatedAppVersion ? `v${entry.updatedAppVersion}` : '版本未知'} · 起跑点${hasStart.value ? '已设' : '未设'}`
  /**
   * 🆕 审计 B4：这次保存**确实清掉了一条已存在的路径形状**时要如实说 ——
   * 否则用户会以为"存了双圈、形状还在"（实际跑步页已经改走双圈几何）。
   * ⚠️ 2026-09-29 改名（用户口径）：那句话里的「【测试】非官方路径」→「研途健行路径」。
   */
  const clearedShape = hadFreeShapeAtSave ? '（原先的研途健行路径形状已清除，这条记录改回内外双圈）' : ''
  showSnackbar(
    `已存入本机路线库（${detail}）${clearedShape}${persisted ? '' : '（但本机存储写入失败，刷新后可能丢失）'}`,
    persisted ? undefined : 'warning',
  )
}
const reset = () => {
  setRing('outer', [])
  setRing('inner', [])
}
/**
 * 本地路线管理：载入到编辑器（顺带定位过去）。
 *
 * 🔴 2026-11-10（用户口径"跑道编辑相关页面应该无法对真实路径进行编辑以及选中、修改"）：
 * **真实路径一律拒绝载入** —— 它是别人真实跑出来的点列，载进编辑器就等于把它降级成草图，
 * 一保存就把原始几何改写了。界面上这条按钮对它**根本不渲染**，这里再拦一道（纵深防御）。
 */
const loadEntry = (id: string) => {
  const target = lib.get(String(id))
  if (!target) {
    showSnackbar('这条预设已经不在本机路线库里了', 'warning')
    return
  }
  if (isRealPathEntry(target)) {
    showSnackbar('真实路径不能载入到跑道编辑器（它是真实跑出来的点列，改动会丢掉原始几何）—— 要改名/删除请在本列表操作', 'warning', { timeout: 7000 })
    return
  }
  // ⚠️ 先把地点切过去，再**显式**载入这一条 —— 只改 lineId 的话，watch 会载入"这个地点默认那条"，
  //    而不是用户点的这一条（一个地点多条预设时这正是要避免的"点了 A 载入了 B"）
  lineId.value = String(target.lineId)
  loadDraft(String(target.id))
  focusOn()
  showSnackbar(`已载入预设「${resolveEntryName(target)}」`)
}
const removeEntry = (id: string) => {
  const out = lib.remove(String(id))
  if (!out.removed) {
    showSnackbar('这条预设已经不在本机路线库里了', 'warning')
    return
  }
  // 删掉的正是手上这条 ⇒ 清空草稿与"正在编辑"标记（否则界面还停在一个已不存在的预设上）
  if (String(id) === String(presetId.value)) {
    presetId.value = ''
    presetName.value = ''
    reset()
  }
  // 删掉的那条如果正展开着详情，收起它（否则详情区会挂在一个已不存在的条目上）
  if (isDetailOpen(id)) detailId.value = null
  // ⚠️ 2026-09-20 审计修复：落盘失败时不能报"已删除" —— 否则刷新后被删的路线又回来了
  showSnackbar(out.persisted ? '已从本机路线库删除' : '已从内存移除，但本机存储写入失败（刷新后可能还在）', out.persisted ? 'success' : 'warning')
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
  // 🆕 2026-11-03（1.3.6）：改名框里放**显示名**（旧条目没有自定义名时就是厂商名）——
  //    一个地点多条预设后，"这条现在叫什么"必须看得见，否则改完不知道原来叫什么。
  renameText.value = e ? resolveEntryName(e) : ''
  renameOpen.value = true
}
const confirmRename = () => {
  const out = lib.rename(String(renameId.value), renameText.value)
  renameOpen.value = false
  if (!out.ok) {
    // 🆕 2026-11-03："名称不可以相同"与"这条已不在库里"是两种不同的拒绝，措辞由组合层给
    showSnackbar(out.message, out.reason === 'duplicate-name' ? 'error' : 'warning')
    return
  }
  const { entry: updated, persisted } = out
  // 改名的就是手上这条 ⇒ 名称框跟着变（否则保存时又把它改回旧名字）
  if (String(updated.id) === String(presetId.value)) presetName.value = resolveEntryName(updated)
  showSnackbar(
    `已改名为「${resolveEntryName(updated)}」` +
      // ⚠️ 落盘失败要说清楚（否则刷新后名字"自己变回去"，用户以为没保存）
      (persisted ? '' : '（但本机存储写入失败，刷新后可能丢失）'),
    persisted ? 'success' : 'warning',
  )
}
/**
 * 一键填回当前名称（🆕 2026-11-03 语义变化）。
 * ⚠️ 旧版这里是"清空输入框 = 恢复官方名"，但**预设名称不可以为空**（用户要求）⇒
 *    改名入口不再提供"清空"，而是"填回这条现在显示的名字"（改错了可以退回）。
 */
const resetRenameText = () => {
  renameText.value = renameEntry.value ? resolveEntryName(renameEntry.value) : ''
  showSnackbar('已填回这条预设现在的名字', 'info')
}
/** 列表/标题统一用"自定义名优先"的显示名（纯函数，唯一入口） */
const nameOf = (e: { lineId: string; lineName: string; customName?: string }) => resolveEntryName(e)
/**
 * 线路下拉的选项标题。
 * 🆕 2026-11-03（1.3.6）：这个地点有 **N 条预设**时标题带上条数 ——
 * 否则用户会以为"我存了三条，下拉里怎么还是一条"（下拉选的是**地点**，预设看旁边的「预设」下拉）。
 */
const lineOptions = computed(() =>
  lines.value.map((l) => {
    const list = libEntries.value.filter((e) => String(e.lineId) === String(l.pointId))
    const vendor = String(l.pointName ?? '').trim()
    const base = list.length === 1 ? nameOf(list[0]!) : vendor || `未命名线路（${l.pointId}）`
    return {
      title: list.length > 1 ? `${base}（${list.length} 条预设）` : base,
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
                  ⚠️ 2026-09-22：原先这里还有"洋红=非官方路径"这一层（画非官方路径时才画）。
                  那套 UI 已搬到独立子页 `components/FreePathView.vue`（`/field/free-path`）⇒
                  本页的地图上只剩官方虚线 / 内外圈 / 车道线 / 最终轨迹 / 起跑点，**一个字都没变**。
                -->
                <circle
                  v-for="(p, i) in editingPts"
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
                <!--
                  🆕 进场点（1.3.3，2026-10-30）：蓝点 + 到起跑点的虚线。
                  虚线就是"进场段"——用户在跑圈之前从跑道外侧走上跑道的那一小段。
                  ⚠️ 只在真的会拼进轨迹时才画（`entryNotice` 非空 = 不合法，画了会误导）。
                -->
                <g v-if="hasEntry && draftEntryPoint && !entryNotice">
                  <line
                    :x1="toPx(draftEntryPoint).x"
                    :y1="toPx(draftEntryPoint).y"
                    :x2="toPx(entryLineEnd).x"
                    :y2="toPx(entryLineEnd).y"
                    stroke="#22d3ee"
                    stroke-width="2"
                    stroke-dasharray="5 4"
                    opacity="0.95"
                  />
                  <circle :cx="toPx(draftEntryPoint).x" :cy="toPx(draftEntryPoint).y" r="6" fill="#0ea5e9" stroke="#fff" stroke-width="2" />
                  <text
                    :x="toPx(draftEntryPoint).x + 9"
                    :y="toPx(draftEntryPoint).y + 16"
                    fill="#bae6fd"
                    font-size="12"
                    font-weight="bold"
                  >
                    进场点 {{ entryLengthM.toFixed(0) }} m
                  </text>
                </g>
              </svg>
            </div>
          </v-card-text>
          <v-card-text class="text-caption text-medium-emphasis">
            拖动=平移地图　单击=<b>{{
              editing === 'start'
                ? '点选起跑点（会自动吸附到车道上）'
                : editing === 'entry'
                  ? '点选进场点（选在跑道外侧，不会吸附）'
                  : '在当前位置加一个点'
            }}</b>　按住已有的小圆点拖动=改点　（编辑哪一样见右侧）
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
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
            <!--
              🆕 2026-11-03（1.3.6）：「预设」下拉 + 名称输入（用户要求：一个点位可以创建多条预设，
              保存时可以输入名字便于区分，名称不可相同）。
              · 选项 = 这个地点的全部预设 + 一项「＋ 新建一条预设」；
              · 选中一条 ⇒ 保存就是更新它；选「新建」⇒ 保存是新建（同一个地点下多出一条）；
              · 名称留空 ⇒ 自动命名（优先用线路名，撞名了叫「东操场 · 预设 2」），绝不会存成空名字。
            -->
            <div class="d-flex align-center ga-2 mb-2">
              <v-select
                v-model="presetId"
                :items="presetOptions"
                label="这个地点的预设"
                density="compact"
                hide-details
                class="flex-grow-1"
                @update:model-value="onPresetPick"
              />
              <v-btn size="small" variant="tonal" class="mt-1" @click="startNewPreset">新建</v-btn>
            </div>
            <v-text-field
              v-model="presetName"
              label="预设名称（留空 = 自动命名）"
              density="compact"
              :counter="TRACK_NAME_MAX"
              :maxlength="TRACK_NAME_MAX"
              hide-details="auto"
              class="mb-2"
            />
            <div class="text-caption text-medium-emphasis mb-3">
              一个地点可以存<b>多条预设</b>（例如东操场的「内道 / 外道 / 起跑点在东侧」）：
              描好内外圈 → 起个名字 → 点「保存（本机）」。<b>名称全库不可重复</b>；
              跑步页会在选完线路后再让你选这个地点用哪条预设。
              <template v-if="editingEntry">
                <br />正在编辑：<b>{{ resolveEntryName(editingEntry) }}</b>
                （预设编号 {{ editingEntry.id }}）·
                创建 {{ editingEntry.createdAt ? formatLocalDateTime(editingEntry.createdAt) : '未记录' }}
              </template>
              <template v-else><br />当前是<b>新建模式</b>：保存后会在这个地点下多出一条预设。
                <br />⚠️ 新建时<b>画布已清空</b>（内外圈 / 起跑点 / 进场点都从零开始）；
                只有<b>车道数 {{ laneCount }}</b> 与<b>内缩 {{ insetM }} m</b> 沿用当前值（可在下方改）。
              </template>
            </div>
            <!-- 🆕 2026-09-22（issue #12）：任务未下发线路时，把"这是本机跑道"说在选项正下方 -->
            <div v-if="localFreeLine" class="text-caption text-medium-emphasis mb-3">
              本任务未下发线路 —— 上面这条「<b>本机跑道</b>」是本机的条目：在它上面描好内外圈并保存，
              跑步页就会用你描的这条生成轨迹（<b>不是官方路线</b>，只存在这台电脑上）。
            </div>
            <v-btn-toggle v-model="editing" mandatory density="compact" class="mb-3">
              <v-btn value="outer" size="small">外圈</v-btn>
              <v-btn value="inner" size="small">内圈</v-btn>
              <v-btn value="start" size="small">起跑点</v-btn>
              <v-btn value="entry" size="small">进场点</v-btn>
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
            <template v-if="editing !== 'start' && editing !== 'entry'">
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

            <!-- ===== 进场点（1.3.3，2026-10-30）===== -->
            <template v-if="editing === 'entry'">
              <v-alert type="info" variant="tonal" density="compact" class="mb-2">
                真人在绕圈之前，通常先从跑道<b>外侧</b>走到跑道上再开跑 —— 这一段小直线就叫「进场段」。
                在<b>地图上点一下</b>你想进场的位置即可（不会吸附到车道上，因为它本来就在跑道外）。
              </v-alert>
              <div class="text-caption text-medium-emphasis mb-2">
                进场点：<b>{{ hasEntry ? '已设置' : '未设置（轨迹直接从起跑点开始）' }}</b>
                <template v-if="hasEntry && !entryNotice">
                  <br />进场段长度 {{ entryLengthM.toFixed(1) }} m（先进场、到起跑点后沿跑道开跑）
                </template>
                <template v-if="hasEntry && draftEntryPoint">
                  <br />坐标 {{ draftEntryPoint.latitude.toFixed(6) }}, {{ draftEntryPoint.longitude.toFixed(6) }}
                </template>
              </div>
              <v-alert v-if="entryNotice" type="warning" variant="tonal" density="compact" class="mb-2">
                {{ entryNotice }}
              </v-alert>
              <v-btn
                block
                size="small"
                variant="tonal"
                color="error"
                class="mb-2"
                prepend-icon="mdi-close-circle-outline"
                :disabled="!hasEntry"
                @click="clearEntry"
              >
                取消进场点
              </v-btn>
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
            <span class="text-caption text-medium-emphasis">（{{ libEntries.length }} 条预设）</span>
          </v-card-title>
          <v-card-text>
            <!-- 🆕 2026-11-03（1.3.6）：旧数据里可能本来就有同名预设（那时没有唯一性约束）
                 ⇒ **只提示、绝不自动改名**；新保存/改名时才会被拒绝（名称全库唯一）。 -->
            <v-alert v-if="dupNames.length" type="warning" variant="tonal" density="compact" class="mb-2">
              有 {{ dupNames.length }} 组预设<b>重名</b>（{{ dupNames.map((g) => g.name).join('、') }}）——
              这是旧数据留下的（那时还没有"名称不可重复"这条规则）。我们<b>不会替你自动改名</b>，
              请点「重命名」自己区分开；新保存或改名时重名会被拒绝。
            </v-alert>
            <div v-if="!libEntries.length" class="text-caption text-medium-emphasis">
              还没有配置好的路线。描好内外圈后点「保存（本机）」，这里就会按「创建 / 最近保存的时间与版本 + 编辑次数」列出来。
            </div>
            <template v-else>
              <!-- 🔴 2026-11-10（用户口径"两种路径不是同一类"）：
                   手绘跑道与真实路径分成两组；后者可折叠（它常常一堆，混在一起完全看不清） -->
              <div class="text-subtitle-2 mb-1">跑道预设（{{ drawnEntries.length }} 条）</div>
              <div v-if="!drawnEntries.length" class="text-caption text-medium-emphasis mb-2">
                还没有手绘跑道：在上面描好内外圈后点「保存（本机）」。
              </div>
              <v-list v-else density="compact" class="pa-0">
                <template v-for="e in drawnEntries" :key="e.id">
                  <TrackLibraryRow
                    :entry="e"
                    :name="nameOf(e)"
                    :detail-open="isDetailOpen(e.id)"
                    :history-max="historyMax"
                    :real-path="false"
                    :current="String(e.id) === String(presetId)"
                    @toggle-detail="toggleDetail(e.id)"
                    @load="loadEntry(e.id)"
                    @rename="openRename(e.id)"
                    @remove="removeEntry(e.id)"
                  />
                </template>
              </v-list>

              <v-divider class="my-3" />
              <!-- 真实路径组（可折叠）：没有「载入」，因为跑道编辑器不负责编辑它们 -->
              <div class="d-flex flex-wrap align-center ga-2 mb-1">
                <div class="text-subtitle-2">真实路径（{{ realEntries.length }} 条）</div>
                <v-btn size="x-small" variant="text" :prepend-icon="realOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="realOpen = !realOpen">
                  {{ realOpen ? '收起' : '展开' }}
                </v-btn>
              </div>
              <div class="text-caption text-medium-emphasis mb-2">
                来自「我的场地 → 真实路径」那一页导出的<b>真实跑轨迹</b>：与手绘跑道是两类，
                这里<b>只能看详情、重命名、删除</b>（不能载入编辑 —— 那会改写原始几何）。
              </div>
              <v-expand-transition>
                <div v-show="realOpen">
                  <div v-if="!realEntries.length" class="text-caption text-medium-emphasis">还没有真实路径预设。</div>
                  <v-list v-else density="compact" class="pa-0">
                    <template v-for="e in realEntries" :key="e.id">
                      <TrackLibraryRow
                        :entry="e"
                        :name="nameOf(e)"
                        :detail-open="isDetailOpen(e.id)"
                        :history-max="historyMax"
                        :real-path="true"
                        :current="String(e.id) === String(presetId)"
                        @toggle-detail="toggleDetail(e.id)"
                        @rename="openRename(e.id)"
                        @remove="removeEntry(e.id)"
                      />
                    </template>
                  </v-list>
                </div>
              </v-expand-transition>
            </template>
          </v-card-text>
        </v-card>

        <!-- 重命名弹窗（1.1.9 需求②）：只改预设名，不动厂商线路名、不动几何、不动创建日期 -->
        <v-dialog v-model="renameOpen" max-width="460">
          <v-card>
            <v-card-title class="text-subtitle-1">给这条预设改个名字</v-card-title>
            <v-card-text>
              <v-text-field
                v-model="renameText"
                label="新名字"
                density="compact"
                autofocus
                :counter="TRACK_NAME_MAX"
                :maxlength="TRACK_NAME_MAX"
                hide-details="auto"
                class="mb-2"
                @keyup.enter="confirmRename"
              />
              <div class="text-caption text-medium-emphasis">
                当前输入 {{ renameLen }} / {{ TRACK_NAME_MAX }} 字。<b>名称全库不可重复</b>（撞了会被拒绝，并告诉你被谁占了）；
                留空会自动命名。改的是<b>这条预设的名字</b>，只影响这台电脑上的列表；
                厂商线路名与提交用的线路 id 都不变。
                <template v-if="renameEntry">地点：<b>{{ renameEntry.lineName || renameEntry.lineId }}</b></template>
              </div>
            </v-card-text>
            <v-card-actions>
              <v-btn variant="text" size="small" @click="resetRenameText">填回当前名字</v-btn>
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
