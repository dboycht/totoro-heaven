<template>
  <div class="totoro-map-wrapper">
    <div class="totoro-map" :style="{ height: height + 'px' }" ref="el"></div>
    <div v-if="tileFailed" class="tile-warning text-caption">
      <v-icon size="14" class="mr-1">mdi-image-off-outline</v-icon>地图底图加载失败（轨迹/路线仍可显示）
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch, ref, shallowRef, nextTick } from 'vue'

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

const tileProviders = [
  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attrib: '&copy; OpenStreetMap' },
  { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attrib: '&copy; OpenStreetMap' },
  { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attrib: '&copy; OSM &copy; CARTO' },
]
const tileIdx = ref(0)
const tileFailed = ref(false)

async function addTileLayer() {
  if (!map) return
  const L = (await import('leaflet')).default
  const p = tileProviders[tileIdx.value]!
  try {
    const layer = L.tileLayer(p.url, { attribution: p.attrib, maxZoom: 19 })
    layer.on('tileerror', () => {
      // 当前源失败，自动切下一个
      if (tileIdx.value >= tileProviders.length - 1) {
        tileFailed.value = true
        return
      }
      tileIdx.value += 1
      if (map) {
        map.eachLayer((l) => {
          if ('_url' in l) map.removeLayer(l)
        })
        void addTileLayer()
      }
    })
    layer.addTo(map)
  } catch {
    /* ignore */
  }
}

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
  }
  const L = (await import('leaflet')).default
  // 清理旧瓦片层后重挂（避免重复）
  map.eachLayer((l) => {
    if (l instanceof L.TileLayer) map!.removeLayer(l)
  })
  tileIdx.value = 0
  tileFailed.value = false
  void addTileLayer()

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
  // 确保容器已挂载到 DOM（延迟到 nextTick，避免 Map container not found）
  await nextTick()
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
.totoro-map-wrapper {
  position: relative;
  width: 100%;
}
.totoro-map {
  width: 100%;
  border-radius: 8px;
  overflow: hidden;
  z-index: 0;
}
.tile-warning {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 400;
  background: rgba(0, 0, 0, 0.6);
  color: #ffd54f;
  padding: 4px 8px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}
.totoro-map :deep(.leaflet-container) {
  height: 100%;
  width: 100%;
  font-family: inherit;
}
</style>