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
import { laneLoop, laneRatioFor, ringLengthM, ringWidthM, smoothClosedRing, validateRings, insetClosedRing, distanceToRingM, type TrackRings } from '~/utils/mp/trackEditor'
import { entrySummaryText, resolveEntryName } from '~/utils/mp/trackLibrary'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import type { LatLng } from '~/utils/mp/routeSimilarity'

/** 契约层坐标（latitude/longitude 可能是字符串） */
type P = LatLng
/** 内部数值型坐标（**所有算术/存本机都用它**；N 可赋给 LatLng，反之不行） */
type N = { latitude: number; longitude: number }
const num = (p: LatLng): N => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })

// 与 run.vue 同一套取法：`useMpReal()` 返回 profile/status/task（真实链路），演示态用 useMpDemo 的 task 兜底
const { profile: realProfile, status: realStatus, task: realTask } = useMpReal()
const { task: demoTask } = useMpDemo()
const activeTask = computed(() => realTask.value ?? demoTask.value)
const activeLines = computed(() => activeTask.value?.runPointList ?? [])
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
const lines = computed(() => activeLines.value ?? [])
const lineId = ref<string>('')
const lib = useTrackLibrary()
/** 模板里要用的 ref 需要拿出来（嵌套在对象里的 ref 模板不会自动解包） */
const libEntries = lib.entries
const draftOuter = ref<N[]>([])
const draftInner = ref<N[]>([])
const loadDraft = (id: string) => {
  const e = lib.get(id)
  draftOuter.value = (e?.outer ?? []).map(num)
  draftInner.value = (e?.inner ?? []).map(num)
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
/** 当前编辑哪一圈 */
const editing = ref<'outer' | 'inner'>('outer')
const outer = computed(() => draftOuter.value)
const inner = computed(() => draftInner.value)
const setRing = (which: 'outer' | 'inner', pts: N[]) => {
  if (which === 'outer') draftOuter.value = pts
  else draftInner.value = pts
}
/** 切换线路 ⇒ 自动载入那条线路已保存的草稿（没保存过就是空的） */
watch(lineId, (id) => loadDraft(String(id ?? '')))

/**
 * **快速定位**（用户要求）：把地图移到给定点集的范围，并挑一个刚好装得下的缩放级。
 * 不传参数时：优先用"已描的圈"，否则用官方路线。
 */
const focusOn = (ptsIn?: N[]) => {
  const pts = ptsIn ?? (outer.value.length >= 3 ? [...outer.value, ...inner.value] : official.value.map(num))
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
    if (!lineId.value && ls.length) lineId.value = String(ls[0]!.pointId)
  },
  { immediate: true },
)
const currentLine = computed(() => lines.value.find((l) => String(l.pointId) === String(lineId.value)))
const official = computed<N[]>(() => (currentLine.value?.pointList ?? []).map(num))

/** 当前编辑圈的点（含屏幕坐标，供 SVG 画） */
const editingPts = computed(() => (editing.value === 'outer' ? outer.value : inner.value))

/** 把官方路线点灌进当前圈，作为"打底"（用户只需微调） */
const useOfficialAsRing = () => {
  if (!official.value.length) return
  setRing(editing.value, official.value.map((p) => ({ ...p })))
  showSnackbar(`已把官方路线 ${official.value.length} 点填入${editing.value === 'outer' ? '外圈' : '内圈'}`)
}

const undo = () => {
  const pts = [...editingPts.value]
  pts.pop()
  setRing(editing.value, pts)
}
/** 手工描的点必然有折角 ⇒ Chaikin 圆滑两轮，观感立刻像"跑道圈" */
const smoothRing = () => {
  if (editingPts.value.length < 3) {
    showSnackbar('先描够 3 个点再平滑', 'warning')
    return
  }
  setRing(editing.value, smoothClosedRing(editingPts.value, 2))
  showSnackbar('已平滑这一圈')
}
const clearRing = () => setRing(editing.value, [])

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
    // 拖动已有的点
    const pts = [...editingPts.value]
    pts[pointDragIndex] = toLatLng(e.offsetX, e.offsetY)
    setRing(editing.value, pts)
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
  // 单击（没拖动、也没抓点）⇒ 在点击处加一个点
  setRing(editing.value, [...editingPts.value, toLatLng(e.offsetX, e.offsetY)])
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

/** 最终轨迹：以车道线为参考几何，叠加"真实抖动"（直道恒定、小颗粒、偶发小凸起） */
const trajectory = computed<N[]>(() => {
  if (lane.value.length < 3) return []
  const g = generateCorridorRoute(lane.value, { targetKm: 3.2, stepM: 3, drift: true, seed: seed.value })
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
  if (!lineId.value) {
    showSnackbar('先选一条线路', 'warning')
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
  const e = lib.upsert({
    lineId: lineId.value,
    lineName: String(currentLine.value?.pointName ?? lineId.value),
    outer: outer.value,
    inner: inner.value,
    // ⭐ 把"所选道次"一起存起来（跑步页就按它生成，不再随机）
    laneNo: laneNo.value,
    laneCount: laneCount.value,
  })
  if (!e) {
    showSnackbar('保存被拒绝：内外圈点数不足（各需至少 3 点）', 'error')
    return
  }
  showSnackbar(`已存入本机路线库（v${e.appVersion}；创建日期见右侧列表）`)
}
const reset = () => {
  setRing('outer', [])
  setRing('inner', [])
}
/** 本地路线管理：载入到编辑器（顺带定位过去） */
const loadEntry = (id: string) => {
  lineId.value = String(id)
  loadDraft(String(id))
  focusOn()
  showSnackbar('已载入这条本地路线')
}
const removeEntry = (id: string) => {
  lib.remove(String(id))
  if (String(id) === String(lineId.value)) reset()
  showSnackbar('已从本机路线库删除')
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
  const updated = lib.rename(String(renameId.value), renameText.value)
  renameOpen.value = false
  if (!updated) {
    showSnackbar('这条路线已经不在本机路线库里了', 'warning')
    return
  }
  showSnackbar(
    updated.customName ? `已改名为「${resolveEntryName(updated)}」` : '已恢复显示官方线路名',
    'success',
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
              </svg>
            </div>
          </v-card-text>
          <v-card-text class="text-caption text-medium-emphasis">
            拖动=平移地图　单击=在当前位置<b>加一个点</b>　按住已有的小圆点拖动=改点　（编辑哪一圈见右侧）
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
            <v-btn-toggle v-model="editing" mandatory density="compact" class="mb-3">
              <v-btn value="outer" size="small">外圈</v-btn>
              <v-btn value="inner" size="small">内圈</v-btn>
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
            <div class="text-caption text-medium-emphasis mb-2">
              当前{{ editing === 'outer' ? '外圈' : '内圈' }}：<b>{{ editingPts.length }}</b> 点
              <span v-if="editingPts.length > 2">· 周长 {{ ringLengthM(editingPts).toFixed(0) }} m</span>
            </div>
            <v-btn block size="small" variant="tonal" class="mb-2" prepend-icon="mdi-map-marker-path" @click="useOfficialAsRing">
              用官方路线打底（再微调）
            </v-btn>
            <v-btn block size="small" variant="tonal" class="mb-2" prepend-icon="mdi-undo" @click="undo">撤销上一个点</v-btn>
            <v-btn block size="small" variant="tonal" color="info" class="mb-2" prepend-icon="mdi-auto-fix" @click="smoothRing">
              把这一圈平滑一下（描的点难免有折角）
            </v-btn>
            <v-text-field v-model.number="insetM" type="number" density="compact" hide-details label="内缩米数（≈跑道宽度）" class="mb-2" />
            <v-btn block size="small" variant="tonal" color="info" class="mb-2" prepend-icon="mdi-arrow-collapse-all" @click="makeInnerFromOuter">
              按外圈自动生成内圈（向内缩 {{ insetM }} m）
            </v-btn>
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
            <v-btn block size="small" variant="tonal" color="error" class="mb-2" prepend-icon="mdi-delete-outline" @click="clearRing">清空这一圈</v-btn>
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
              还没有配置好的路线。描好内外圈后点「保存（本机）」，这里就会按"创建日期 + 版本"列出来。
            </div>
            <v-list v-else density="compact" class="pa-0">
              <v-list-item v-for="e in libEntries" :key="e.lineId" class="px-0">
                <v-list-item-title class="text-body-2">
                  {{ nameOf(e) }}
                  <v-chip v-if="String(e.lineId) === String(lineId)" size="x-small" color="primary" variant="tonal" class="ml-1">
                    正在编辑
                  </v-chip>
                  <v-chip v-if="e.customName" size="x-small" color="info" variant="tonal" class="ml-1">已改名</v-chip>
                </v-list-item-title>
                <v-list-item-subtitle class="text-caption">{{ entrySummaryText(e) }}</v-list-item-subtitle>
                <template #append>
                  <v-btn size="x-small" variant="text" @click="loadEntry(e.lineId)">载入</v-btn>
                  <v-btn size="x-small" variant="text" color="primary" @click="openRename(e.lineId)">重命名</v-btn>
                  <v-btn size="x-small" variant="text" color="error" @click="removeEntry(e.lineId)">删除</v-btn>
                </template>
              </v-list-item>
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
</style>
