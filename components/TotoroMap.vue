<template>
  <div class="totoro-map" :style="{ height: height + 'px' }" ref="el"></div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref, shallowRef } from 'vue'

export interface MapPoint {
  longitude: string | number
  latitude: string | number
}

const props = withDefaults(
  defineProps<{
    /** 主要轨迹线（如模拟轨迹/路线点列） */
    polylines?: MapPoint[][]
    /** 打卡点（圆点+标注） */
    markers?: (MapPoint & { label?: string; color?: string })[]
    /** 容器高度 px */
    height?: number
    /** 全部为空时可选的中心点 */
    center?: MapPoint
  }>(),
  { height: 360, center: undefined },
)

let map: import('leaflet').Map | null = null
const el = ref<HTMLElement>()
const layers = shallowRef<import('leaflet').Layer[]>([])

const tileAttrib = '&copy; OpenStreetMap contributors'
// Carto 浅色底图（比默认 OSM 更清爽）
const tileUrl =
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'

function destroyMap() {
  if (map) {
    map.remove()
    map = null
  }
  layers.value = []
}

async function render() {
  if (!el.value) return
  if (!map) {
    await import('leaflet')
    const L = (await import('leaflet')).default
    map = L.map(el.value)
    L.tileLayer(tileUrl, { attribution: tileAttrib, maxZoom: 19 }).addTo(map)
  }
  const L = (await import('leaflet')).default

  layers.value.forEach((l) => map!.removeLayer(l))
  layers.value = []

  const latlng = (p: MapPoint): [number, number] => [Number(p.latitude), Number(p.longitude)]
  const bounds: import('leaflet').LatLngBounds = L.latLngBounds([])

  ;(props.polylines || []).forEach((line, i) => {
    const pts = line.map(latlng)
    const color = ['#FF5252', '#42A5F5', '#66BB6A', '#FFA726'][i % 4]
    const pl = L.polyline(pts, { color, weight: 3, opacity: 0.85 }).addTo(map!)
    layers.value.push(pl)
    pts.forEach((p) => bounds.extend(p))
  })

  const markers = props.markers || []
  const mkIcon =
    typeof L.divIcon === 'function'
      ? (c: string) =>
          L.divIcon({
            className: '',
            html: `<div style="width:14px;height:14px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 0 0 2px ${c}44"></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          })
      : null

  markers.forEach((m) => {
    const ll = latlng(m)
    const color = m.color || '#4CAF50'
    const mm = L.marker(ll, { icon: mkIcon ? mkIcon(color) : undefined })
    if (m.label) mm.bindTooltip(m.label, { permanent: false, direction: 'top' })
    mm.addTo(map!)
    layers.value.push(mm)
    bounds.extend(ll)
  })

  if (props.polylines?.length || markers.length) {
    map!.fitBounds(bounds.pad(0.15))
  } else if (props.center) {
    map!.setView(latlng(props.center), 15)
  } else {
    map!.setView([39.9082, 116.3975], 13) // 默认北京天安门附近
  }
}

onMounted(async () => {
  await render()
})

onBeforeUnmount(destroyMap)

watch(
  () => [props.polylines, props.markers],
  async () => {
    if (map) await render()
  },
  { deep: true },
)
</script>

<style scoped>
.totoro-map {
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
  z-index: 0;
}
.totoro-map :deep(.leaflet-container) {
  height: 100%;
  width: 100%;
  font-family: inherit;
}
</style>