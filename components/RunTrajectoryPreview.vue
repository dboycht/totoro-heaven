<script setup lang="ts">
/**
 * 轨迹预览（**矢量、离线**）：把「官方路线」与「本次轨迹」画成一张小图，并报出"离路线最远多少米"。
 *
 * 为什么是矢量而不是地图底图：
 *   ① 不依赖外网瓦片 —— 离线可用、瓦片挂了也不影响（桌面工具常有网络受限的场景）；
 *   ② 目的是回答"**轨迹有没有贴着官方路线走**"（在不在跑道/路线上），矢量已经能看出来；
 *   ③ 地图瓦片属第三方服务，不宜随产品分发（要底图请走官方 API + key）。
 *
 * ⚠️ 判据提醒：官方拟合度的**容差是 25 m**（5 m 采样 / 25 m 命中）⇒
 *    离路线越近，"在跑道上"越可信；若最远偏离 > 25 m 就会明显像"没沿路线跑"。
 */
const props = defineProps<{
  points: { latitude: string | number; longitude: string | number }[]
  route?: { latitude: string | number; longitude: string | number }[]
  fitDegree?: number | string | null
}>()

const W = 560
const H = 300
const PAD = 16

type P = { lat: number; lng: number }
const toP = (p: { latitude: string | number; longitude: string | number }): P => ({
  lat: Number(p.latitude),
  lng: Number(p.longitude),
})

const view = computed(() => {
  const pts = (props.points ?? []).map(toP).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
  const rt = (props.route ?? []).map(toP).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
  if (pts.length < 2) return null
  const all = [...pts, ...rt]
  const minLat = Math.min(...all.map((p) => p.lat))
  const maxLat = Math.max(...all.map((p) => p.lat))
  const minLng = Math.min(...all.map((p) => p.lng))
  const maxLng = Math.max(...all.map((p) => p.lng))
  const spanLat = Math.max(1e-6, maxLat - minLat)
  const spanLng = Math.max(1e-6, maxLng - minLng)
  const scale = Math.min((W - PAD * 2) / spanLng, (H - PAD * 2) / spanLat)
  const x = (p: P) => PAD + (p.lng - minLng) * scale
  const y = (p: P) => H - PAD - (p.lat - minLat) * scale
  const d = (list: P[]) => list.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ')

  // 偏离统计（米）：等距近似（预览用足够；与真算法同一量级）
  const mPerDegLat = 111320
  const mPerDegLng = 111320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
  const distToRoute = (p: P) => {
    let best = Number.POSITIVE_INFINITY
    for (let i = 1; i < rt.length; i++) {
      const a = rt[i - 1]!
      const b = rt[i]!
      const ax = a.lng * mPerDegLng
      const ay = a.lat * mPerDegLat
      const bx = b.lng * mPerDegLng
      const by = b.lat * mPerDegLat
      const px = p.lng * mPerDegLng
      const py = p.lat * mPerDegLat
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
      <template v-if="view">
        <svg :viewBox="`0 0 ${view.w} ${view.h}`" style="width: 100%; height: auto; background: #0b1220; border-radius: 6px">
          <path
            v-if="view.routePath"
            :d="view.routePath"
            fill="none"
            stroke="#94a3b8"
            stroke-width="1.6"
            stroke-dasharray="5 4"
          />
          <path :d="view.trajPath" fill="none" stroke="#22c55e" stroke-width="1.8" />
          <circle :cx="view.start.x" :cy="view.start.y" r="4.5" fill="#22c55e" stroke="#ffffff" stroke-width="1.5" />
        </svg>
        <div class="text-caption text-medium-emphasis mt-2">
          灰虚线 = 官方路线（{{ view.routePoints }} 点）　绿线 = 本次轨迹（{{ view.n }} 点）
          <template v-if="view.maxDev !== null">
            　离路线最远 <b>{{ view.maxDev.toFixed(1) }} m</b>（P95 {{ view.p95 !== null ? view.p95.toFixed(1) : '—' }} m）
            —— 越小越"在跑道上"
          </template>
        </div>
        <v-alert
          v-if="view.maxDev !== null && view.maxDev > 25"
          type="warning"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          最大偏离已超过拟合度判据的容差（25 m）：这条轨迹看起来可能"没沿路线跑"。
        </v-alert>
      </template>
      <div v-else class="text-caption text-medium-emphasis">还没有轨迹（先「开始跑步」生成并结算）</div>
    </v-card-text>
  </v-card>
</template>
