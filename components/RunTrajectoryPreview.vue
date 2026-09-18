<script setup lang="ts">
/**
 * 轨迹预览（矢量、离线）：把「真跑道几何（内外圈 + 所选车道线）」「官方路线」「本次轨迹」画在同一张图上。
 *
 * 为什么是矢量而不是地图底图：
 *   ① 不依赖外网瓦片 —— 离线可用、瓦片挂了也不影响（桌面工具常有网络受限的场景）；
 *   ② 目的是回答"**轨迹有没有贴着官方路线走 / 有没有夹在真跑道两圈之间**"，矢量已经能看出来；
 *   ③ 地图瓦片属第三方服务，不宜随产品分发（要底图请走官方 API + key）。
 *
 * ⚠️ 判据提醒：官方拟合度的**容差是 25 m**（5 m 采样 / 25 m 命中）⇒
 *    离路线越近，"在跑道上"越可信；若最远偏离 > 25 m 就会明显像"没沿路线跑"。
 *
 * 2026-09-18 两次改进（都来自用户反馈）：
 *   · 补画**内外圈 + 车道线**（此前只有官方模板 + 轨迹）；
 *   · **按圈着色**：多圈若同色，重叠时会糊成"一条粗带"，用户反馈"看着就是轨迹粗了一点"。
 *     现在按 `lapLengthM` 把轨迹拆成"第 1 圈、第 2 圈…"，每圈一色、只画 1.2px 细线，
 *     并另给一张**局部放大图**（1 m 的圈间差在整图尺度下只有 ~1.7 px，放大才看得清）。
 */
import { laneLoop, laneRatioFor, type TrackRings } from '~/utils/mp/trackEditor'

/** 本机路线库里的一条（只取画面要用的字段，避免组件依赖整个 TrackRouteEntry） */
type TrackEntryLike = {
  lineId: string
  outer: { latitude: string | number; longitude: string | number }[]
  inner: { latitude: string | number; longitude: string | number }[]
  laneNo?: number
  laneCount?: number
}

const props = defineProps<{
  points: { latitude: string | number; longitude: string | number }[]
  route?: { latitude: string | number; longitude: string | number }[]
  fitDegree?: number | string | null
  /** 本机路线库（跑道编辑页描好的内外圈）；用来画跑道两圈与所选车道线 */
  trackEntries?: TrackEntryLike[]
  /** 当前线路 id：决定用路线库里哪一条几何 */
  lineId?: string
  /** 本次轨迹的"一圈多长"（米）：据此按圈拆段着色；0/缺省 = 整条一色 */
  lapLengthM?: number
  /** 逐圈漂移量（米，来自生成器 `lapDriftM`）：图例里显示"第 N 圈偏了多少" */
  lapDriftM?: number[]
}>()

const W = 560
const PAD = 16
/** 局部放大面板的边长（米）：1 m 的圈间差在整图尺度只有 ~1.7 px，放大才看得清 */
const FOCUS_SPAN_M = 90

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

/** 两点距离（米，等距近似）——用于判断"描的圈"与"本次轨迹"是否相距过远 */
const distBetween = (a: P, b: P): number => {
  const mPerDegLat = 111320
  const mLng = 111320 * Math.cos(((a.latitude + b.latitude) / 2) * (Math.PI / 180))
  return Math.hypot((b.latitude - a.latitude) * mPerDegLat, (b.longitude - a.longitude) * mLng)
}

/** 每圈一个颜色（超出则循环），最后一档用于"其它圈" */
const LAP_COLORS = ['#38bdf8', '#a78bfa', '#22c55e', '#f59e0b', '#f472b6', '#facc15', '#2dd4bf', '#fb7185', '#93c5fd', '#c4b5fd', '#fca5a5', '#86efac']
const OTHER_COLOR = '#94a3b8'

/** 当前选中线路在本机路线库里的几何（没配置过 → undefined，那两层就不画） */
const entry = computed(() => {
  const id = String(props.lineId ?? '')
  if (!id) return undefined
  return (props.trackEntries ?? []).find((e) => String(e.lineId) === id)
})

/** 内外圈 + 所选车道线（纯函数，与跑道编辑页/真实提交用同一套算法） */
const track = computed(() => {
  const e = entry.value
  if (!e) return null
  const outer = finite((e.outer ?? []).map(toP))
  const inner = finite((e.inner ?? []).map(toP))
  if (outer.length < 3 || inner.length < 3) return null
  const rings: TrackRings = { outer, inner }
  const laneCount = e.laneCount && e.laneCount > 0 ? e.laneCount : 6
  const laneNo = e.laneNo && e.laneNo > 0 ? e.laneNo : Math.max(1, Math.round((laneCount + 1) / 2))
  const lanePts = finite(laneLoop(rings, laneRatioFor(laneNo, laneCount), 240).map(toP))
  return { outer, inner, lane: lanePts.length >= 3 ? lanePts : [], laneNo, laneCount }
})

/** 单点相对路线的最大允许偏离（米）—— 仅供文案提示，不上报 */

/** 第 n 圈（0 基）的漂移量（米）：来自生成器的 `lapDriftM`；缺失时返回 null（文案不显示） */
const lapDriftOf = (lap0: number): number | null => {
  const arr = props.lapDriftM
  if (!Array.isArray(arr) || lap0 < 0 || lap0 >= arr.length) return null
  const v = Number(arr[lap0])
  return Number.isFinite(v) ? v : null
}

/** 轨迹按"圈"拆段（多圈同色会糊成一条粗带；拆开后每圈一色，重叠也能看出分层） */
const lapSegments = computed<{ lap: number; pts: P[] }[]>(() => {
  const pts = finite((props.points ?? []).map(toP))
  const lapM = Number(props.lapLengthM ?? 0)
  if (!(lapM > 0) || pts.length < 2) return [{ lap: 0, pts }]
  const out: { lap: number; pts: P[] }[] = []
  let acc = 0
  let cur: P[] = [pts[0]!]
  let curLap = 0
  const mPerDegLat = 111320
  const mLngAt = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180)
  const dist = (a: P, b: P) =>
    Math.hypot((b.latitude - a.latitude) * mPerDegLat, (b.longitude - a.longitude) / (1 / mLngAt(a.latitude)))
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1]!, pts[i]!)
    const lap = Math.floor(acc / lapM)
    if (lap !== curLap) {
      // 本圈收尾：把新点也放进上一圈（线段跨圈时才不断裂）
      cur.push(pts[i]!)
      out.push({ lap: curLap, pts: cur })
      cur = [pts[i]!]
      curLap = lap
    } else {
      cur.push(pts[i]!)
    }
  }
  if (cur.length > 1) out.push({ lap: curLap, pts: cur })
  return out
})

/** 全图视图（装得下所有要画的东西） */
const view = computed(() => {
  const tr = track.value
  const segs = lapSegments.value
  const pts = segs.flatMap((s) => s.pts)
  const rt = finite((props.route ?? []).map(toP))
  if (pts.length < 2) return null
  const all = [...pts, ...rt, ...(tr ? [...tr.outer, ...tr.inner, ...tr.lane] : [])]
  const minLat = Math.min(...all.map((p) => p.latitude))
  const maxLat = Math.max(...all.map((p) => p.latitude))
  const minLng = Math.min(...all.map((p) => p.longitude))
  const maxLng = Math.max(...all.map((p) => p.longitude))
  const spanLat = Math.max(1e-6, maxLat - minLat)
  const spanLng = Math.max(1e-6, maxLng - minLng)
  const scale = Math.min((W - PAD * 2) / spanLng, (W - PAD * 2) / spanLat)
  const H = Math.round(spanLat * scale + PAD * 2)
  const x = (p: P) => PAD + (p.longitude - minLng) * scale
  const y = (p: P) => H - PAD - (p.latitude - minLat) * scale
  const d = (list: P[], close = false) => {
    if (!list.length) return ''
    const path = list.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ')
    return close && list.length > 2 ? `${path} Z` : path
  }

  // 偏离统计（米）：等距近似（预览用足够；与真算法同一量级）
  const mPerDegLat = 111320
  const mPerDegLng = 111320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
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

  /**
   * ⚠️ **绘图比例失衡**（2026-09-18 加；判据与提示文案必须同源 —— 审计 F4）：
   * 若"描的圈"或"官方路线"与本次轨迹相距极远，整图会被撑到几十公里尺度 ⇒ 图上看什么都只有一个小点。
   * 这是**用户可修的数据问题**（描错了圈），所以要明确提示，而不是给一张看不懂的图。
   * 阈值取 3000 m：远超 25 m 的拟合度容差，也与"校区聚类阈值"同量级。
   * 只算一次、两处共用（避免出现"相距约 0.0 km"这种自相矛盾提示）。
   */
  const gapM = Math.max(
    tr?.outer?.[0] ? distBetween(pts[0]!, tr.outer[0]) : 0,
    rt[0] ? distBetween(pts[0]!, rt[0]) : 0,
  )

  return {
    w: W,
    h: H,
    x,
    y,
    scale,
    center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 },
    routePath: rt.length >= 2 ? d(rt) : '',
    routePoints: rt.length,
    outerPath: tr ? d(tr.outer, true) : '',
    innerPath: tr ? d(tr.inner, true) : '',
    lanePath: tr && tr.lane.length >= 3 ? d(tr.lane, true) : '',
    laneNo: tr?.laneNo ?? 0,
    start: { x: x(pts[0]!), y: y(pts[0]!) },
    n: pts.length,
    lapCount: segs.length,
    maxDev: devs.length ? devs[devs.length - 1]! : null,
    p95: devs.length ? devs[Math.floor(devs.length * 0.95)]! : null,
    gapM,
    scaleBroken: gapM > 3000,
  }
})

/** 各段的 SVG 路径（d 字符串）——整图 */
const lapPaths = computed(() => {
  const v = view.value
  if (!v) return [] as { lap: number; d: string; color: string; label: string }[]
  return lapSegments.value.map((s) => ({
    lap: s.lap + 1,
    d: s.pts.map((p, i) => `${i ? 'L' : 'M'}${v.x(p).toFixed(1)},${v.y(p).toFixed(1)}`).join(' '),
    color: s.lap < LAP_COLORS.length ? LAP_COLORS[s.lap]! : OTHER_COLOR,
    label: s.lap < LAP_COLORS.length ? `第 ${s.lap + 1} 圈` : '其它圈',
  }))
})

/**
 * 局部放大面板：以"圈漂移最明显的位置"为中心 ——
 * 即**各圈到轨迹形心的距离差异最大**的那一段，保证放大图里一定看得到分层。
 * 一次算完所需的一切（含每圈路径），避免第二处重复做 bbox 数学。
 */
const focus = computed(() => {
  const tr = track.value
  const segs = lapSegments.value
  const pts = segs.flatMap((s) => s.pts)
  if (pts.length < 4) return null

  const mPerDegLat = 111320
  const mLng = 111320 * Math.cos((pts[0]!.latitude * Math.PI) / 180)
  const cx = pts.reduce((s, p) => s + p.longitude * mLng, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.latitude * mPerDegLat, 0) / pts.length
  const radiusOf = (p: P) => Math.hypot(p.longitude * mLng - cx, p.latitude * mPerDegLat - cy)
  const lapRadii = segs.map((s) => s.pts.reduce((sum, p) => sum + radiusOf(p), 0) / Math.max(1, s.pts.length))
  const spreadM = lapRadii.length > 1 ? Math.max(...lapRadii) - Math.min(...lapRadii) : 0
  // 放大中心取"半径最大那一圈"的中间点（该处圈间分离最明显）
  const idxOfMax = lapRadii.indexOf(Math.max(...lapRadii))
  const seg = segs[idxOfMax]?.pts ?? pts
  const center = seg[Math.floor(seg.length / 2)] ?? pts[0]!

  const w = 420
  const spanLat = FOCUS_SPAN_M / mPerDegLat
  const spanLng = FOCUS_SPAN_M / mLng
  const minLat = center.latitude - spanLat / 2
  const minLng = center.longitude - spanLng / 2
  const scale = w / spanLng
  const h = Math.round(spanLat * scale)
  /** 只保留落在放大窗口内的点，避免画到画布外（SVG 不裁剪但会白画） */
  const inWindow = (p: P) => p.latitude >= minLat && p.latitude <= minLat + spanLat && p.longitude >= minLng && p.longitude <= minLng + spanLng
  const x = (p: P) => (p.longitude - minLng) * scale
  const y = (p: P) => h - (p.latitude - minLat) * scale
  /**
   * ⚠️ 放大面板里**不要用 `close=true`**（审计 F2，2026-09-18）：
   * `win()` 只留下窗口内的点，若再 `Z` 强闭合，就会把"窗口内首末两点"直接连起来 ——
   * 每层都会多出一条横贯画布的假连线（实测约 410 px），正好盖住这张图唯一要看的东西
   * （各圈 1~3 m 的分离）。窗口内的本来就是**弧段**，不闭合才对。
   */
  const d = (list: P[], _close = false) => {
    if (!list.length) return ''
    return list.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ')
  }
  const win = (list: P[]) => list.filter(inWindow)

  return {
    w,
    h,
    spanM: FOCUS_SPAN_M,
    pxPerM: scale / mLng,
    spreadM,
    lapCount: segs.length,
    lapDrifts: segs.map((s) => lapDriftOf(s.lap)),
    outerPath: tr ? d(win(tr.outer)) : '',
    innerPath: tr ? d(win(tr.inner)) : '',
    lanePath: tr && tr.lane.length >= 3 ? d(win(tr.lane)) : '',
    routePath: (props.route ?? []).length > 1 ? d(win(finite((props.route ?? []).map(toP)))) : '',
    lapPaths: segs.map((s) => ({
      lap: s.lap + 1,
      d: d(win(s.pts)),
      color: s.lap < LAP_COLORS.length ? LAP_COLORS[s.lap]! : OTHER_COLOR,
    })),
  }
})
</script>

<template>
  <v-card class="mt-4">
    <v-card-title class="text-subtitle-1">
      轨迹预览
      <span class="text-caption text-medium-emphasis">（矢量图，离线绘制、不请求底图）</span>
    </v-card-title>
    <v-card-text>
      <template v-if="view">
        <!-- ⚠️ 描的圈与本次轨迹相距极远（多半是描错了圈/选了别的校区）：
             此时整图会被撑到几十公里尺度 ⇒ 图上看不清任何东西，必须明确告诉用户怎么修。
             📌 2026-09-18 措辞修正（用户反馈"看着像劝我别用自己描的跑道"）：
                不说"删掉这条本地路线"，而是给"重描 / 换一条库里的路线"两条正向出路。 -->
        <v-alert v-if="view.scaleBroken" type="error" variant="tonal" density="compact" class="mb-3">
          <div class="font-weight-bold">这张图的比例失衡了：你描的圈与本次轨迹不在同一处。</div>
          <div class="text-caption mt-1">
            两者相距约 <b>{{ (view.gapM / 1000).toFixed(1) }} km</b> —— 多半是<b>描错了线路</b>（描到别的校区去了），
            或这条本地路线是用别的线路的几何存的。请回「跑道编辑」：选对线路 →「快速定位」→ 对着<b>卫星图</b>重描一次即可。
          </div>
        </v-alert>
        <v-row dense>
          <!-- 左：全图（按圈着色） -->
          <v-col cols="12" md="7">
            <svg :viewBox="`0 0 ${view.w} ${view.h}`" style="width: 100%; height: auto; background: #0b1220; border-radius: 6px">
              <path v-if="view.outerPath" :d="view.outerPath" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9" />
              <path v-if="view.innerPath" :d="view.innerPath" fill="none" stroke="#a78bfa" stroke-width="1.4" opacity="0.9" />
              <path v-if="view.lanePath" :d="view.lanePath" fill="none" stroke="#22c55e" stroke-width="1" opacity="0.7" />
              <path v-if="view.routePath" :d="view.routePath" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="5 4" />
              <!-- 每圈一色、**细线**（多圈同色 + 粗描边会糊成一条粗带） -->
              <path
                v-for="p in lapPaths"
                :key="`lap-${p.lap}`"
                :d="p.d"
                :data-lap="p.lap"
                fill="none"
                :stroke="p.color"
                stroke-width="1.2"
                opacity="0.95"
              />
              <circle :cx="view.start.x" :cy="view.start.y" r="3.5" fill="#f59e0b" stroke="#fff" stroke-width="1.2" />
            </svg>
          </v-col>
          <!-- 右：局部放大（圈间 1~3 m 的差别只有放大才看得清） -->
          <v-col cols="12" md="5">
            <svg
              v-if="focus"
              :viewBox="`0 0 ${focus.w} ${focus.h}`"
              style="width: 100%; height: auto; background: #0b1220; border-radius: 6px"
            >
              <path v-if="focus.outerPath" :d="focus.outerPath" fill="none" stroke="#38bdf8" stroke-width="1.4" opacity="0.9" />
              <path v-if="focus.innerPath" :d="focus.innerPath" fill="none" stroke="#a78bfa" stroke-width="1.4" opacity="0.9" />
              <path v-if="focus.lanePath" :d="focus.lanePath" fill="none" stroke="#22c55e" stroke-width="1" opacity="0.7" />
              <path
                v-if="focus.routePath"
                :d="focus.routePath"
                fill="none"
                stroke="#94a3b8"
                stroke-width="1.4"
                stroke-dasharray="5 4"
              />
              <path
                v-for="p in focus.lapPaths"
                :key="`f-${p.lap}`"
                :d="p.d"
                :data-lap="p.lap"
                fill="none"
                :stroke="p.color"
                stroke-width="1.4"
              />
            </svg>
            <div class="text-caption text-medium-emphasis mt-1">
              局部放大（约 {{ focus?.spanM }} m × {{ focus?.spanM }} m，≈ {{ focus?.pxPerM.toFixed(1) }} 像素/米）：
              各圈在这里分开约 <b>{{ focus?.spreadM.toFixed(1) }} m</b>
            </div>
          </v-col>
        </v-row>

        <div class="text-caption text-medium-emphasis mt-2">
          <!-- 📌 2026-09-18 措辞修正：明确"轨迹是按你描的跑道生成的"，避免被读成"没用上你描的跑道" -->
          <template v-if="view.outerPath">
            <b>本次轨迹是按你描的跑道（绿线=所选第 {{ view.laneNo }} 道）生成的。</b>
            蓝实线 = 外圈　紫线 = 内圈　
          </template>
          灰虚线 = 官方路线（{{ view.routePoints }} 点），仅作对照
          <template v-if="view.maxDev !== null">
            　轨迹离这条<b>官方路线</b>最远 <b>{{ view.maxDev.toFixed(1) }} m</b>（P95 {{ view.p95 !== null ? view.p95.toFixed(1) : '—' }} m）
            —— ⚠️ 这个数是<b>到官方路线</b>的距离，偏大<b>不代表你跑偏了</b>：
            官方路线本身就可能与真实跑道差十几米到几十米（提交时服务端仍按官方路线算拟合度，所以它仍有参考意义）。
          </template>
        </div>
        <!-- 按圈图例：直接回答"是不是真的一圈"；有逐圈漂移量时一并显示（例：第 3 圈 +0.7 m） -->
        <div class="d-flex flex-wrap align-center ga-2 mt-2">
          <span class="text-caption text-medium-emphasis">
            共 <b>{{ view.lapCount }}</b> 圈，每圈一色（{{ view.n }} 点）：
          </span>
          <span v-for="p in lapPaths" :key="`lg-${p.lap}`" class="d-inline-flex align-center text-caption">
            <span :style="{ display: 'inline-block', width: '14px', height: '3px', background: p.color, marginRight: '4px' }" />
            {{ p.label }}<template v-if="lapDriftOf(p.lap - 1) !== null">
              （相对模板 {{ lapDriftOf(p.lap - 1)! >= 0 ? '+' : '' }}{{ lapDriftOf(p.lap - 1)!.toFixed(1) }} m）</template
            >
          </span>
        </div>
        <v-alert
          v-if="view.maxDev !== null && view.maxDev > 25"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
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
