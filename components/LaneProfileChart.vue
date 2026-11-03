<script setup lang="ts">
/**
 * **换圈图（XY）**：X = 时间（每圈一格），Y = 道次（第 1 道 = 最内道）。
 *
 * 用户口径（2026-11-03，需求②）：
 * > "作横向 XY 图，以时间 t 为 X 轴，道次为 y 轴，初始 y0 为用户预设中设置的道次，
 * >  随后上下随机波动（不超过其内外圈范围），设每一圈平均用时为 T，则最终 XY 图片中斜率均小于 1/T；
 * >  相关控件用户可以自行拖动"
 *
 * ## 这个组件的边界（故意的）
 * · **只画、只拖动、只回传**：合法性判据（斜率上限、道次范围）与初始图生成全在纯模块
 *   `utils/mp/laneProfile.ts`（有单测），本组件不自己判、也不自己造默认值 ——
 *   否则"界面说的"与"引擎跑的"会分叉。
 * · 拖动约束：**相邻控制点最多差 1 条道**（= 斜率上限 1/T 的等价写法）；
 *   越界的拖拽会被**夹住**（不是报错），并把"被夹过"如实说在下方文字里。
 * · 纵轴范围就是 `1..laneCount`（内外圈范围），永远不会拖出跑道。
 *
 * ## 为什么要"每圈一个控制点"
 * 斜率上限是 `|Δ道次| / 圈数 ≤ 1` ⇒ 只要控制点落在整圈边界上、且相邻差 ≤1，
 * 整条折线天然达标，用户拖的也正是"第 3 圈开始换到第 2 道"这种决策。
 */
import type { LanePoint } from '~/utils/mp/laneProfile'

const props = defineProps<{
  /** 控制点（`u` = 圈坐标 0..laps；`lane` = 道次 1..laneCount） */
  points: LanePoint[]
  /** 圈数 n（X 轴到 n 为止） */
  laps: number
  /** 道数（Y 轴上限） */
  laneCount: number
  /** 每圈用时 T（秒；0 = 未知，只影响 X 轴刻度标注） */
  lapSeconds: number
  /** 是否禁用拖动（跑步中 / 提交中） */
  disabled?: boolean
}>()

const emit = defineEmits<{ (e: 'update:points', v: LanePoint[]): void }>()

/** 画布尺寸（SVG 用户单位 = px） */
const W = 560
const H = 210
const PAD_L = 46
const PAD_R = 14
const PAD_T = 14
const PAD_B = 30
const plotW = W - PAD_L - PAD_R
const plotH = H - PAD_T - PAD_B

const laps = computed(() => Math.max(1, Math.round(Number(props.laps) || 1)))
const laneCount = computed(() => Math.max(1, Math.round(Number(props.laneCount) || 6)))

/** 圈坐标 → 屏幕 X */
const xOf = (u: number) => PAD_L + (Math.min(laps.value, Math.max(0, u)) / laps.value) * plotW
/** 道次 → 屏幕 Y（1 在底部：第 1 道最内，画在下方更符合"往里跑"的直觉） */
const yOf = (lane: number) => PAD_T + plotH - ((Math.min(laneCount.value, Math.max(1, lane)) - 1) / Math.max(1, laneCount.value - 1)) * plotH
/** 屏幕 X → 圈坐标（吸附到整圈边界：控制点只在整圈处） */
const uOf = (x: number) => {
  const raw = ((x - PAD_L) / plotW) * laps.value
  return Math.min(laps.value, Math.max(0, Math.round(raw)))
}
/** 屏幕 Y → 道次（连续值，拖动时夹到 1..laneCount） */
const laneOf = (y: number) => {
  const raw = 1 + ((PAD_T + plotH - y) / plotH) * Math.max(1, laneCount.value - 1)
  return Math.min(laneCount.value, Math.max(1, Math.round(raw * 2) / 2))
}

/** 折线路径（道次随圈变化） */
const linePath = computed(() => {
  const pts = [...props.points].sort((a, b) => a.u - b.u)
  if (pts.length < 2) return ''
  return pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.u).toFixed(1)},${yOf(p.lane).toFixed(1)}`).join(' ')
})
/** 逐圈"这一圈在第几道"的柱（帮助看清每圈的选择，而不是只看折线） */
const lapBands = computed(() =>
  Array.from({ length: laps.value }, (_, i) => {
    const a = props.points.find((p) => Math.abs(p.u - i) < 1e-9)
    const b = props.points.find((p) => Math.abs(p.u - i + 1) < 1e-9)
    const from = a?.lane ?? b?.lane ?? 1
    const to = props.points.find((p) => Math.abs(p.u - (i + 1)) < 1e-9)?.lane ?? from
    const x0 = xOf(i)
    const x1 = xOf(i + 1)
    const y0 = yOf(from)
    const y1 = yOf(to)
    return { key: `lap-${i}`, d: `M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} L${x1.toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${x0.toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z` }
  }),
)

// ---------------------------------------------------------------- 拖动
const svgEl = ref<SVGSVGElement | null>(null)
/** 正在拖的控制点下标（`null` = 没在拖） */
const dragIndex = ref<number | null>(null)
/** 最近一次拖动是否被"相邻差 ≤1"夹住（界面如实提示） */
const lastClamped = ref(false)

/** 把屏幕事件坐标换成 SVG 用户坐标（SVG 可能被 CSS 缩放，必须按 CTM 换算） */
const toLocal = (ev: MouseEvent): { x: number; y: number } | null => {
  const el = svgEl.value
  if (!el) return null
  const ctm = el.getScreenCTM()
  if (!ctm) return null
  const pt = el.createSVGPoint()
  pt.x = ev.clientX
  pt.y = ev.clientY
  const p = pt.matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

/**
 * 提交一次拖动结果。
 *
 * ## 约束（与 `checkLaneProfile` 的"每圈最多换 1 条道"同一口径）
 * 不变量：`|lane[i] − lane[i−1]| ≤ 1`。拖动第 i 个点时，**前后两个邻居都要满足** ⇒
 *   `lane ∈ [max(1, prev−1, next−1), min(laneCount, prev+1, next+1)]`。
 *
 * ⚠️ 2026-11-03 修（浏览器探针抓到的真 bug）：第一版只按**前**一个点夹，
 *    结果把中间点拖到 2.5 时后一个点（第 1 道）就变成 `|2.5−1| = 1.5` **违规** ⇒
 *    剖面校验失败、「重新模拟」按钮被禁用 —— 用户看到的是"拖一下就点不动了"。
 *    现在两侧一起夹：越界的拖拽被**夹住**（不报错），并在下方如实说"被夹过"。
 */
const applyDrag = (index: number, laneRaw: number) => {
  const sorted = [...props.points].sort((a, b) => a.u - b.u)
  const target = sorted[index]
  if (!target) return
  const prev = sorted[index - 1]
  const next = sorted[index + 1]
  const lo = Math.max(1, prev ? prev.lane - 1 : 1, next ? next.lane - 1 : 1)
  const hi = Math.min(laneCount.value, prev ? prev.lane + 1 : laneCount.value, next ? next.lane + 1 : laneCount.value)
  /** 夹紧（`lo > hi` = 数据本身已经自相矛盾时不抛，取 `hi`；剖面校验会把矛盾如实报出来） */
  const lane = lo <= hi ? Math.max(lo, Math.min(hi, laneRaw)) : hi
  lastClamped.value = Math.abs(lane - laneRaw) > 1e-9
  emit(
    'update:points',
    sorted.map((p, i) => (i === index ? { ...p, lane } : p)),
  )
}

const onDown = (index: number, ev: MouseEvent) => {
  if (props.disabled) return
  ev.preventDefault()
  dragIndex.value = index
  lastClamped.value = false
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
const onMove = (ev: MouseEvent) => {
  if (dragIndex.value === null) return
  const p = toLocal(ev)
  if (!p) return
  applyDrag(dragIndex.value, laneOf(p.y))
}
const onUp = () => {
  dragIndex.value = null
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
}
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
})

/** 键盘微调（可访问性 + 精确调一格）：聚焦圆点后按 ↑/↓ 换一条道 */
const nudge = (index: number, delta: number) => {
  if (props.disabled) return
  const sorted = [...props.points].sort((a, b) => a.u - b.u)
  const cur = sorted[index]?.lane
  if (cur === undefined) return
  applyDrag(index, Math.round(cur + delta))
}

/**
 * X 轴刻度：点数多时**只标首末与整 5 圈**（否则 8~20 个刻度会糊成一片）。
 * 同时把"第 k 圈结束的时刻"标出来（`T` 已知时）—— 用户口径里 X 轴就是时间。
 */
const ticks = computed(() => {
  const n = laps.value
  const every = n <= 6 ? 1 : n <= 12 ? 2 : 5
  const out: { u: number; label: string }[] = []
  for (let u = 0; u <= n; u++) {
    const isEdge = u === 0 || u === n
    if (!isEdge && u % every !== 0) continue
    out.push({ u, label: String(u) })
  }
  return out
})
const timeHint = computed(() => {
  const T = Number(props.lapSeconds) || 0
  if (!(T > 0)) return ''
  const total = Math.round(T * laps.value)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `共 ${laps.value} 圈 · 一圈约 ${Math.round(T)} 秒 · 预计 ${mm} 分 ${String(ss).padStart(2, '0')} 秒`
})
/** Y 轴刻度（道次；道数多时隔一个标一个） */
const yTicks = computed(() => {
  const n = laneCount.value
  const every = n <= 6 ? 1 : 2
  const out: number[] = []
  for (let k = 1; k <= n; k++) if (k === 1 || k === n || k % every === 0) out.push(k)
  return out
})
</script>

<template>
  <div class="lane-chart">
    <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" class="lane-svg" role="img" aria-label="换圈图：横轴是圈（时间），纵轴是道次">
      <!-- 底板 -->
      <rect :x="PAD_L" :y="PAD_T" :width="plotW" :height="plotH" fill="rgba(255,255,255,0.04)" rx="4" />
      <!-- 逐圈色块（看清"这一圈停在哪条道"，折线只是连接） -->
      <path v-for="band in lapBands" :key="band.key" :d="band.d" fill="rgba(56,189,248,0.08)" />
      <!-- 横向网格 + 道次刻度 -->
      <g>
        <line
          v-for="k in yTicks"
          :key="`gy-${k}`"
          :x1="PAD_L"
          :x2="PAD_L + plotW"
          :y1="yOf(k)"
          :y2="yOf(k)"
          stroke="rgba(255,255,255,0.12)"
          stroke-width="1"
          :stroke-dasharray="k === 1 || k === laneCount ? '' : '3 4'"
        />
        <text v-for="k in yTicks" :key="`ty-${k}`" :x="PAD_L - 8" :y="yOf(k) + 4" text-anchor="end" font-size="11" fill="rgba(255,255,255,0.65)">
          第 {{ k }} 道
        </text>
      </g>
      <!-- 纵向网格 + 圈刻度 -->
      <g>
        <line
          v-for="t in ticks"
          :key="`gx-${t.u}`"
          :x1="xOf(t.u)"
          :x2="xOf(t.u)"
          :y1="PAD_T"
          :y2="PAD_T + plotH"
          stroke="rgba(255,255,255,0.10)"
          stroke-width="1"
        />
        <text v-for="t in ticks" :key="`tx-${t.u}`" :x="xOf(t.u)" :y="PAD_T + plotH + 16" text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.6)">
          {{ t.label }}
        </text>
        <text :x="PAD_L + plotW" :y="PAD_T + plotH + 28" text-anchor="end" font-size="10" fill="rgba(255,255,255,0.45)">
          圈数（横轴 = 时间，每格一圈）
        </text>
      </g>
      <!-- 折线 -->
      <path :d="linePath" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linejoin="round" />
      <!-- 控制点（可拖） -->
      <g v-for="(p, i) in [...points].sort((a, b) => a.u - b.u)" :key="`pt-${p.u}`">
        <circle
          :cx="xOf(p.u)"
          :cy="yOf(p.lane)"
          r="7"
          :fill="dragIndex === i ? '#22c55e' : '#0ea5e9'"
          stroke="#fff"
          stroke-width="1.6"
          :style="{ cursor: disabled ? 'not-allowed' : 'grab' }"
          tabindex="0"
          role="slider"
          :aria-label="`第 ${p.u} 圈，第 ${p.lane} 道`"
          @mousedown="onDown(i, $event)"
          @keydown.up.prevent="nudge(i, 1)"
          @keydown.down.prevent="nudge(i, -1)"
        />
        <text :x="xOf(p.u) + 10" :y="yOf(p.lane) - 8" font-size="10" fill="rgba(255,255,255,0.75)">第 {{ p.lane }} 道</text>
      </g>
    </svg>
    <div class="text-caption text-medium-emphasis mt-1">
      <template v-if="timeHint">{{ timeHint }}　·　</template>
      拖动圆点改"这一圈停在哪条道"（相邻两圈最多差 1 条 = 你说的斜率上限 1/T）；也可点中后按 ↑/↓ 微调。
      <template v-if="lastClamped"><br /><span class="text-warning">刚才那一下被夹住了：相邻两圈最多只能差 1 条道，再往里/往外要再加一圈。</span></template>
    </div>
  </div>
</template>

<style scoped>
.lane-chart {
  width: 100%;
}
.lane-svg {
  width: 100%;
  height: auto;
  display: block;
  user-select: none;
}
</style>
