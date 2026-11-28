<template>
  <!--
    「插值前后对照」（可交互） —— 2026-11-28 用户要求：
    "展示效果和我们下面的展示一样，能让我用滚轮来放大。"
    交互与「轨迹预览」同一套口径：滚轮以光标为锚点缩放（必须 preventDefault）、左键拖动平移、
    一键「适应视图」；投影同样走 `utils/mp/webMercator.ts`（单一来源）。
    三条线：灰 = 原始点列 / 绿 = 最终提交 / 红 = 被裁掉的尾巴；放大到够大时自动显示「两套点」。
  -->
  <div>
    <div class="d-flex align-center ga-2 mb-1 flex-wrap">
      <v-btn size="x-small" variant="tonal" prepend-icon="mdi-magnify-plus-outline" @click="zoomBy(1.35)">放大</v-btn>
      <v-btn size="x-small" variant="tonal" prepend-icon="mdi-magnify-minus-outline" @click="zoomBy(1 / 1.35)">缩小</v-btn>
      <v-btn size="x-small" variant="text" prepend-icon="mdi-fit-to-page-outline" @click="fit">适应视图</v-btn>
      <span class="text-caption text-medium-emphasis">滚轮缩放（以光标为中心）· 左键拖动平移</span>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">{{ scaleText }}</span>
    </div>
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      :data-view="`${view.cx.toFixed(2)},${view.cy.toFixed(2)},${view.scale.toFixed(4)}`"
      class="w-100"
      style="background: #141414; border-radius: 6px; cursor: grab; touch-action: none"
      @wheel.prevent="onWheel"
      @mousedown="onDown"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onUp"
    >
      <!-- 灰晕圈：原始点列整体（宽、低透明），保证在绿线底下也看得见 -->
      <polyline :points="toLine(rawPts)" fill="none" stroke="#888" stroke-width="7" stroke-opacity="0.28" stroke-linecap="round" />
      <!-- 绿：最终提交 -->
      <polyline :points="toLine(finalPts)" fill="none" stroke="#4caf50" stroke-width="2.2" stroke-linecap="round" />
      <!-- 红：被裁掉的尾巴（最后画、最粗，闭环轨迹里它会盖在来路上） -->
      <polyline v-if="cutPts.length > 1" :points="toLine(cutPts)" fill="none" stroke="#ef5350" stroke-width="4.5" stroke-linecap="round" />

      <!-- 两套点：只有放大到"一步 ≥ 4 px"才画（否则一片糊） -->
      <template v-if="showDots">
        <circle v-for="(p, i) in rawPts" :key="`r-${i}`" :cx="p.x" :cy="p.y" r="2.4" fill="#b0b0b0" />
        <circle v-for="(p, i) in sampledPts" :key="`s-${i}`" :cx="p.x" :cy="p.y" r="2.2" fill="#4caf50" />
      </template>

      <!-- 起点 / 最终终点 / 裁切起点 -->
      <circle v-if="startPt" :cx="startPt.x" :cy="startPt.y" r="4.5" fill="#42a5f5" />
      <circle v-if="endPt" :cx="endPt.x" :cy="endPt.y" r="4.5" fill="#4caf50" />
      <circle v-if="cutStartPt" :cx="cutStartPt.x" :cy="cutStartPt.y" r="4.5" fill="#ef5350" />
    </svg>
    <div class="text-caption text-medium-emphasis mt-1">
      灰 = 原始点列 · 绿 = 最终提交 · <span style="color:#ef5350">红</span> = 被裁掉的尾巴
      · 蓝点起点 · 绿点终点 · 红点裁切处
      <span v-if="!showDots">·（放大到足够近会显示两套点）</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 交互口径（与 `RunTrajectoryPreview` 一致，2026-11-28）：
 *   · 滚轮以**光标为锚点**缩放，`@wheel.prevent` 必须有（否则整页跟着滚 —— E 系老坑）；
 *   · 左键拖动平移；
 *   · 投影用 `webMercator`（单一来源），z 取 19 固定，缩放靠 `scale` 倍数。
 */
import { TILE, lng2x, lat2y } from '~/utils/mp/webMercator'

type P = { latitude: number; longitude: number }

const props = defineProps<{
  raw: P[]
  sampled: P[]
  final: P[]
  /** 被裁掉的尾巴（含裁切起点那一点，红线才接得上绿线） */
  cut: P[]
}>()

const W = 900
const H = 420
const Z = 19
/**
 * ⚠️ `lng2x/lat2y` 的单位是**瓦片**（不是像素）：z=0 时一个单位 = 一整张 256 px 瓦片。
 * 所以"每单位多少米" = 赤道 156543.03392 m/px（z0）× 256 px ÷ 2^z。
 * （第一版漏了 ×256 ⇒ 比例尺显示成 0.00 m，探针当场抓到。）
 */
const M_PER_UNIT_AT_Z = (156543.03392 / 2 ** Z) * TILE

const view = reactive({ cx: 0, cy: 0, scale: 1 })
const dragging = ref(false)
let dragFrom = { x: 0, y: 0, cx: 0, cy: 0 }

const world = (p: P) => ({ x: lng2x(p.longitude, Z), y: lat2y(p.latitude, Z) })
const rawWorld = computed(() => props.raw.map(world))
const sampledWorld = computed(() => props.sampled.map(world))
const finalWorld = computed(() => props.final.map(world))
const cutWorld = computed(() => props.cut.map(world))

/** 适应视图：按**原始点列**的包围盒铺满（三条线在同一坐标系里，比例不会骗人） */
const fit = () => {
  const pts = rawWorld.value.length ? rawWorld.value : sampledWorld.value
  if (pts.length < 2) return
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = Math.max(1e-9, maxX - minX)
  const spanY = Math.max(1e-9, maxY - minY)
  view.scale = Math.min((W * 0.9) / spanX, (H * 0.9) / spanY)
  view.cx = (minX + maxX) / 2
  view.cy = (minY + maxY) / 2
}

onMounted(fit)
watch(() => props.raw.length, fit)

const screen = (p: { x: number; y: number }) => ({
  x: (p.x - view.cx) * view.scale + W / 2,
  y: (p.y - view.cy) * view.scale + H / 2,
})
/**
 * ⚠️ 入参是**已经投影到屏幕**的点（`rawPts/finalPts/cutPts`），这里只做格式化 ——
 * 第一版又调了一次 `screen()`，等于投影两遍：坐标飞到 -5e7，图上一片空白（探针的坐标抽样抓到）。
 */
const toLine = (list: { x: number; y: number }[]) => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

const rawPts = computed(() => rawWorld.value.map(screen))
const sampledPts = computed(() => sampledWorld.value.map(screen))
const finalPts = computed(() => finalWorld.value.map(screen))
const cutPts = computed(() => cutWorld.value.map(screen))
const startPt = computed(() => (rawPts.value[0] ?? null))
const endPt = computed(() => finalPts.value[finalPts.value.length - 1] ?? null)
const cutStartPt = computed(() => cutPts.value[0] ?? null)

/** 一步在屏幕上占多少像素 —— 决定要不要画点（< 4 px 画出来就是一团） */
const stepPx = computed(() => {
  const pts = sampledPts.value
  if (pts.length < 2) return 0
  let sum = 0
  const n = Math.min(40, pts.length - 1)
  for (let i = 0; i < n; i++) sum += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y)
  return sum / n
})
const showDots = computed(() => stepPx.value >= 4)

/** 比例尺文案：当前 1 像素 ≈ 多少米 */
const scaleText = computed(() => {
  const lat = props.raw[0]?.latitude ?? 31
  const mPerUnit = M_PER_UNIT_AT_Z * Math.cos((lat * Math.PI) / 180)
  const mPerScreenPx = mPerUnit / view.scale
  return `1 px ≈ ${mPerScreenPx.toFixed(2)} m · 视图宽约 ${(mPerScreenPx * W).toFixed(0)} m`
})

const zoomBy = (factor: number) => {
  view.scale = Math.min(1e6, Math.max(1e-6, view.scale * factor))
}

const onWheel = (e: WheelEvent) => {
  /** 以光标为锚点：缩放前后"光标下的世界点"不动 */
  const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
  const mx = ((e.clientX - rect.left) / rect.width) * W
  const my = ((e.clientY - rect.top) / rect.height) * H
  const worldX = (mx - W / 2) / view.scale + view.cx
  const worldY = (my - H / 2) / view.scale + view.cy
  const factor = Math.exp(-e.deltaY * 0.0015)
  const next = Math.min(1e6, Math.max(1e-6, view.scale * factor))
  view.scale = next
  view.cx = worldX - (mx - W / 2) / next
  view.cy = worldY - (my - H / 2) / next
  /** 滚轮缩放时顺带抑制触控板横向手势 */
  e.stopPropagation()
}

const onDown = (e: MouseEvent) => {
  dragging.value = true
  dragFrom = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
}
const onMove = (e: MouseEvent) => {
  if (!dragging.value) return
  const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
  const k = W / rect.width
  view.cx = dragFrom.cx - (e.clientX - dragFrom.x) * k / view.scale
  view.cy = dragFrom.cy - (e.clientY - dragFrom.y) * k / view.scale
}
const onUp = () => {
  dragging.value = false
}

/** 供调试：尺度变化写一行（探针按它断言"滚轮真的放大了"） */
defineExpose({ view })
</script>