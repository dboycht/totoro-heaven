<script setup lang="ts">
/**
 * 轨迹预览（**矢量、离线**）：把「真跑道几何（内外圈 + 所选车道线）」「官方路线」「本次轨迹」画在一张图上，
 * 并报出"离路线最远多少米"。
 *
 * 为什么是矢量而不是地图底图：
 *   ① 不依赖外网瓦片 —— 离线可用、瓦片挂了也不影响（桌面工具常有网络受限的场景）；
 *   ② 目的是回答"**轨迹有没有贴着官方路线走 / 有没有夹在真跑道两圈之间**"，矢量已经能看出来；
 *   ③ 地图瓦片属第三方服务，不宜随产品分发（要底图请走官方 API + key）。
 *
 * ⚠️ 判据提醒：官方拟合度的**容差是 25 m**（5 m 采样 / 25 m 命中）⇒
 *    离路线越近，"在跑道上"越可信；若最远偏离 > 25 m 就会明显像"没沿路线跑"。
 *
 * 🆕 2026-09-18（1.1.9）：补上**内外圈 + 车道线**（此前只画官方模板 + 轨迹）——
 *    用户要的是"一眼看出这条轨迹是不是跑在自己描的那条跑道里"，而这两圈就是跑道本身。
 *    几何来自**本机路线库**（`trackEntries` prop）；没配置过该线路时这一段不画（保持原样）。
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
}>()

const W = 560
const H = 300
const PAD = 16

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

const geometry = computed(() => {
  const pts = finite((props.points ?? []).map(toP))
  const rt = finite((props.route ?? []).map(toP))
  const tr = track.value
  if (pts.length < 2) return null
  // 视图必须**装得下所有要画的东西**，否则跑道圈会被裁到画布外（看起来像"没画"）
  const all = [...pts, ...rt, ...(tr ? [...tr.outer, ...tr.inner, ...tr.lane] : [])]
  const minLat = Math.min(...all.map((p) => p.latitude))
  const maxLat = Math.max(...all.map((p) => p.latitude))
  const minLng = Math.min(...all.map((p) => p.longitude))
  const maxLng = Math.max(...all.map((p) => p.longitude))
  const spanLat = Math.max(1e-6, maxLat - minLat)
  const spanLng = Math.max(1e-6, maxLng - minLng)
  const scale = Math.min((W - PAD * 2) / spanLng, (H - PAD * 2) / spanLat)
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
  return {
    w: W,
    h: H,
    routePath: rt.length >= 2 ? d(rt) : '',
    routePoints: rt.length,
    outerPath: tr ? d(tr.outer, true) : '',
    innerPath: tr ? d(tr.inner, true) : '',
    lanePath: tr && tr.lane.length >= 3 ? d(tr.lane, true) : '',
    laneNo: tr?.laneNo ?? 0,
    trajPath: d(pts),
    start: { x: x(pts[0]!), y: y(pts[0]!) },
    n: pts.length,
    maxDev: devs.length ? devs[devs.length - 1]! : null,
    p95: devs.length ? devs[Math.floor(devs.length * 0.95)]! : null,
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
      <template v-if="geometry">
        <svg :viewBox="`0 0 ${geometry.w} ${geometry.h}`" style="width: 100%; height: auto; background: #0b1220; border-radius: 6px">
          <!-- 真跑道几何（本机路线库）：整圈闭合，所以用 Z 收尾 -->
          <path
            v-if="geometry.outerPath"
            :d="geometry.outerPath"
            fill="none"
            stroke="#38bdf8"
            stroke-width="1.6"
            opacity="0.95"
          />
          <path
            v-if="geometry.innerPath"
            :d="geometry.innerPath"
            fill="none"
            stroke="#a78bfa"
            stroke-width="1.6"
            opacity="0.95"
          />
          <path v-if="geometry.lanePath" :d="geometry.lanePath" fill="none" stroke="#22c55e" stroke-width="1.2" opacity="0.75" />
          <!-- 官方路线（灰虚线）在最上层，方便与上面三圈对照 -->
          <path
            v-if="geometry.routePath"
            :d="geometry.routePath"
            fill="none"
            stroke="#94a3b8"
            stroke-width="1.6"
            stroke-dasharray="5 4"
          />
          <!-- 本次轨迹：加一圈白色描边（dark 底上细线太容易糊在一起） -->
          <path :d="geometry.trajPath" fill="none" stroke="#ffffff" stroke-width="3.4" opacity="0.35" />
          <path :d="geometry.trajPath" fill="none" stroke="#f59e0b" stroke-width="1.8" />
          <circle :cx="geometry.start.x" :cy="geometry.start.y" r="4.5" fill="#f59e0b" stroke="#ffffff" stroke-width="1.5" />
        </svg>
        <div class="text-caption text-medium-emphasis mt-2">
          <template v-if="geometry.outerPath">
            蓝实线 = 你描的跑道外圈　紫线 = 内圈　绿线 = 所选第 {{ geometry.laneNo }} 道<br />
          </template>
          灰虚线 = 官方路线（{{ geometry.routePoints }} 点）　橙线 = 本次轨迹（{{ geometry.n }} 点）
          <template v-if="geometry.maxDev !== null">
            　离路线最远 <b>{{ geometry.maxDev.toFixed(1) }} m</b>（P95 {{ geometry.p95 !== null ? geometry.p95.toFixed(1) : '—' }} m）
            —— 越小越"在跑道上"
          </template>
        </div>
        <v-alert
          v-if="geometry.maxDev !== null && geometry.maxDev > 25"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          最大偏离已超过拟合度判据的容差（25 m）：这条轨迹看起来可能"没沿路线跑"。
          <div class="mt-1">
            ⚠️ 但也可能是<b>官方数据偏移较大</b>（实测官方模板与真实跑道可差十几到几十米），一切以实际为准！
          </div>
        </v-alert>
      </template>
      <div v-else class="text-caption text-medium-emphasis">还没有轨迹（先「开始跑步」生成并结算）</div>
    </v-card-text>
  </v-card>
</template>
