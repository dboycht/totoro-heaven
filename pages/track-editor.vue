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
import { laneLoop, laneRatioFor, ringLengthM, ringWidthM, type TrackRings } from '~/utils/mp/trackEditor'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import type { LatLng } from '~/utils/mp/routeSimilarity'

const STORE_KEY = 'mp_track_rings_v1'
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
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

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

const tiles = computed(() => {
  const z = zoom.value
  const x0 = Math.floor(originPx.value.x / TILE)
  const y0 = Math.floor(originPx.value.y / TILE)
  const x1 = Math.floor((originPx.value.x + viewport.value.w) / TILE)
  const y1 = Math.floor((originPx.value.y + viewport.value.h) / TILE)
  const max = 2 ** z
  const out: { key: string; url: string; left: number; top: number }[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= max) continue
      const wx = ((x % max) + max) % max
      out.push({
        key: `${z}/${x}/${y}`,
        url: `https://wprd0${((wx + y) % 4) + 1}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x=${wx}&y=${y}&z=${z}`,
        left: x * TILE - originPx.value.x,
        top: y * TILE - originPx.value.y,
      })
    }
  }
  return out
})

// ---------- 线路与两圈数据 ----------
const lines = computed(() => activeLines.value ?? [])
const lineId = ref<string>('')
watch(
  lines,
  (ls) => {
    if (!lineId.value && ls.length) lineId.value = String(ls[0]!.pointId)
  },
  { immediate: true },
)
const currentLine = computed(() => lines.value.find((l) => String(l.pointId) === String(lineId.value)))
const official = computed<N[]>(() => (currentLine.value?.pointList ?? []).map(num))

const all = ref<Record<string, { outer: N[]; inner: N[] }>>({})
const loadAll = () => {
  try {
    all.value = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, { outer: N[]; inner: N[] }>
  } catch {
    all.value = {}
  }
}
const saveAll = () => localStorage.setItem(STORE_KEY, JSON.stringify(all.value))
onMounted(() => {
  loadAll()
  const el = mapEl.value
  if (el) viewport.value = { w: el.clientWidth, h: el.clientHeight }
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))
const onResize = () => {
  const el = mapEl.value
  if (el) viewport.value = { w: el.clientWidth, h: el.clientHeight }
}

const mapEl = ref<HTMLElement | null>(null)
/** 当前编辑哪一圈 */
const editing = ref<'outer' | 'inner'>('outer')
const ringsOf = (id: string): { outer: N[]; inner: N[] } => all.value[id] ?? { outer: [], inner: [] }
const outer = computed(() => ringsOf(lineId.value).outer)
const inner = computed(() => ringsOf(lineId.value).inner)
const setRing = (which: 'outer' | 'inner', pts: N[]) => {
  all.value = { ...all.value, [lineId.value]: { ...ringsOf(lineId.value), [which]: pts } }
}

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
const laneNo = ref(2)
const seed = ref(20260917)
const rings = computed<TrackRings>(() => ({ outer: outer.value, inner: inner.value }))
const ringsReady = computed(() => outer.value.length >= 3 && inner.value.length >= 3)
const widthM = computed(() => (ringsReady.value ? ringWidthM(rings.value) : 0))
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

const save = () => {
  saveAll()
  showSnackbar('已保存到本机（按线路）')
}
const reset = () => {
  setRing('outer', [])
  setRing('inner', [])
  saveAll()
}
</script>

<template>
  <v-container fluid>
    <v-alert v-if="realStatus !== 'ready'" type="info" variant="tonal" density="compact" class="mb-3">
      还没读取真实任务：回「工作台」点「一键获取 token」后这里才有线路可选（也可先用演示数据试手感）。
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
            拖动=平移地图　单击=在当前位置**加一个点**　按住已有的小圆点拖动=改点　（编辑哪一圈见右侧）
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <v-card>
          <v-card-title class="text-subtitle-1">编辑</v-card-title>
          <v-card-text>
            <v-select
              v-model="lineId"
              :items="lines.map((l) => ({ title: `${l.pointName}`, value: String(l.pointId) }))"
              label="要编辑哪条线路"
              density="compact"
              hide-details
              class="mb-3"
            />
            <v-btn-toggle v-model="editing" mandatory density="compact" class="mb-3">
              <v-btn value="outer" size="small">外圈</v-btn>
              <v-btn value="inner" size="small">内圈</v-btn>
            </v-btn-toggle>
            <div class="text-caption text-medium-emphasis mb-2">
              当前{{ editing === 'outer' ? '外圈' : '内圈' }}：<b>{{ editingPts.length }}</b> 点
              <span v-if="editingPts.length > 2">· 周长 {{ ringLengthM(editingPts).toFixed(0) }} m</span>
            </div>
            <v-btn block size="small" variant="tonal" class="mb-2" prepend-icon="mdi-map-marker-path" @click="useOfficialAsRing">
              用官方路线打底（再微调）
            </v-btn>
            <v-btn block size="small" variant="tonal" class="mb-2" prepend-icon="mdi-undo" @click="undo">撤销上一个点</v-btn>
            <v-btn block size="small" variant="tonal" color="error" class="mb-2" prepend-icon="mdi-delete-outline" @click="clearRing">清空这一圈</v-btn>
            <v-btn block size="small" variant="text" color="error" class="mb-2" prepend-icon="mdi-restore" @click="reset">把这条线路的内外圈都清空</v-btn>
            <v-btn block size="small" color="primary" prepend-icon="mdi-content-save-outline" @click="save">保存（本机）</v-btn>
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
              <v-text-field v-model.number="seed" label="随机种子（换一条不同的抖动）" density="compact" hide-details class="mb-2" />
              <div class="text-caption">
                车道比例 {{ laneRatio.toFixed(3) }}　车道周长 {{ lane.length ? ringLengthM(lane).toFixed(0) : '—' }} m
                <br />最终轨迹 {{ trajectory.length }} 点（含真实抖动：直道恒定 + 0.15 m 颗粒 + 偶发小凸起）
              </div>
            </template>
          </v-card-text>
        </v-card>
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
