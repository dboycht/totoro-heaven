<template>
  <!--
    「截断调试」面板（2026-11-28 用户要求："你把那个截断搞一个调试按钮，我要看一下你这个截断的对吗？"）
    · 三条线：灰 = 原始点列（全量）、绿 = 最终提交的轨迹、红 = 被裁掉的尾巴；
    · 下面逐条列「可判定的自检项」（判据函数在 `utils/mp/realPath.ts` 的 `realPathPlanChecks`，与单测同源），
      不靠"看着像"，每项都给数字。
  -->
  <v-dialog :model-value="modelValue" max-width="760" scrollable @update:model-value="(v) => emit('update:modelValue', v)">
    <v-card>
      <v-card-title class="d-flex align-center ga-2 pt-4">
        <v-icon color="primary">mdi-bug-outline</v-icon>
        <span>截断 / 重采样自检</span>
        <v-spacer />
        <v-chip size="x-small" variant="tonal">{{ entryName || '真实路径' }}</v-chip>
      </v-card-title>
      <v-card-text>
        <div v-if="!plan" class="text-body-2 text-medium-emphasis">没有可看的计划（先选一条真实路径预设）。</div>
        <template v-else>
          <!-- 数字速览 -->
          <div class="text-caption mb-2">
            原始 <b>{{ plan.originalKm.toFixed(3) }} km</b>（{{ plan.sourcePoints }} 点）
            → 重采样 <b>{{ plan.resampledKm.toFixed(3) }} km</b>（{{ plan.sampledPoints }} 点）
            → 裁掉末尾 <b>{{ Math.round(plan.trimEndM) }} m</b>
            ⇒ 最终 <b>{{ plan.finalKm.toFixed(3) }} km</b>（{{ plan.points.length }} 点）
            <span class="text-medium-emphasis">· 要求里程 {{ requiredKm.toFixed(2) }} km</span>
          </div>

          <!-- 三条线：灰=原始 / 绿=最终 / 红=被裁掉的尾巴 -->
          <svg :viewBox="`0 0 ${W} ${H}`" class="w-100 mb-1" style="background: #161616; border-radius: 6px">
            <!-- 画序很关键（2026-11-28 实测）：真实跑的轨迹是「闭环」轮廓，被裁的尾巴与前面跑过的路重合 ⇒
                 红线必须最后画、且用更粗的线宽，否则会被绿线盖住、看着"没裁"。灰线同理改成宽一点的低透明"晕圈"。 -->
            <polyline :points="rawLine" fill="none" stroke="#888" stroke-width="7" stroke-opacity="0.35" stroke-linecap="round" />
            <polyline :points="finalLine" fill="none" stroke="#4caf50" stroke-width="2.5" stroke-linecap="round" />
            <polyline :points="cutLine" fill="none" stroke="#ef5350" stroke-width="5" stroke-linecap="round" />
            <circle :cx="startPt.x" :cy="startPt.y" r="5" fill="#42a5f5" />
            <circle :cx="finalEndPt.x" :cy="finalEndPt.y" r="5" fill="#4caf50" />
            <circle v-if="cutStartPt" :cx="cutStartPt.x" :cy="cutStartPt.y" r="5" fill="#ef5350" />
          </svg>
          <div class="text-caption text-medium-emphasis mb-4">
            蓝点 = 起点（与原始一致）· 绿点 = 最终终点 · 红点 = 从哪儿开始被裁 · <span style="color: #ef5350">红线</span>就是裁掉的那段
          </div>

          <!-- 自检项 -->
          <v-table density="compact" class="bg-transparent">
            <tbody>
              <tr v-for="(c, i) in checks" :key="`c-${i}`">
                <td style="width: 34px" class="text-center">
                  <v-icon v-if="c.ok" color="success" size="18">mdi-check-circle</v-icon>
                  <v-icon v-else color="error" size="18">mdi-close-circle</v-icon>
                </td>
                <td class="text-body-2" style="width: 40%">{{ c.label }}</td>
                <td class="text-caption text-medium-emphasis">{{ c.detail }}</td>
              </tr>
            </tbody>
          </v-table>

          <!-- 首尾坐标对比（最硬的一条：起点必须一模一样） -->
          <div class="text-caption mt-3">
            <div>起点（原始 / 最终）：{{ coordText(rawPoints[0]) }} ／ {{ coordText(plan.points[0]) }}</div>
            <div>终点（原始 / 最终）：{{ coordText(rawPoints[rawPoints.length - 1]) }} ／ {{ coordText(plan.points[plan.points.length - 1]) }}</div>
          </div>
        </template>
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn color="primary" variant="flat" @click="emit('update:modelValue', false)">关闭</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * 哑组件：只画。数据来自 `run.realPathPlan`（引擎与界面同源的那一份），
 * 判据来自纯函数 `realPathPlanChecks`（有单测）。
 */
import { pathLengthM, realPathPlanChecks, type RealPathGeometryPlan, type RealPathPoint } from '~/utils/mp/realPath'

const props = defineProps<{
  modelValue: boolean
  plan: RealPathGeometryPlan | null
  requiredKm: number
  rawPoints: RealPathPoint[]
  entryName?: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const W = 900
const H = 520

/** 统一投影：把经度按中纬度余弦缩放（等距圆柱近似），再等比塞进 viewBox */
const project = (points: RealPathPoint[]) => {
  const all = points.length ? points : [{ latitude: 0, longitude: 0 }]
  const lats = all.map((p) => p.latitude)
  const lngs = all.map((p) => p.longitude)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180)
  const kx = Math.cos(midLat)
  const spanX = Math.max(1e-9, (maxLng - minLng) * kx)
  const spanY = Math.max(1e-9, maxLat - minLat)
  const pad = 24
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY)
  const offX = (W - spanX * scale) / 2
  const offY = (H - spanY * scale) / 2
  return (p: RealPathPoint) => ({
    x: offX + (p.longitude - minLng) * kx * scale,
    y: offY + (maxLat - p.latitude) * scale,
  })
}

const toPolyline = (pt: (p: RealPathPoint) => { x: number; y: number }, list: RealPathPoint[]) =>
  list.map((p) => {
    const q = pt(p)
    return `${q.x.toFixed(1)},${q.y.toFixed(1)}`
  }).join(' ')

/** 三条线共用同一个投影（以原始点列为基准，保证三条线在同一坐标系里） */
const proj = computed(() => project(props.rawPoints.length ? props.rawPoints : (props.plan?.sampled ?? [])))
const rawLine = computed(() => toPolyline(proj.value, props.rawPoints))
const finalLine = computed(() => toPolyline(proj.value, props.plan?.points ?? []))
/** 被裁掉的尾巴：从"最后一个保留点"到"重采样终点"（含起头那一点，红线才接得上绿线） */
const cutPoints = computed(() => {
  const plan = props.plan
  if (!plan || plan.skipped) return []
  const kept = plan.points.length
  return plan.sampled.slice(Math.max(0, kept - 1))
})
const cutLine = computed(() => toPolyline(proj.value, cutPoints.value))

const startPt = computed(() => proj.value(props.rawPoints[0] ?? { latitude: 0, longitude: 0 }))
const finalEndPt = computed(() => proj.value(props.plan?.points[props.plan.points.length - 1] ?? { latitude: 0, longitude: 0 }))
const cutStartPt = computed(() => (cutPoints.value.length ? proj.value(cutPoints.value[0]!) : null))

const checks = computed(() => realPathPlanChecks(props.plan, { requiredKm: props.requiredKm, rawPoints: props.rawPoints }))

const coordText = (p?: RealPathPoint) => (p ? `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}` : '—')

/** 供调试：把三段的实际长度也算出来（界面上以 checks 的数字为准，这里只放在控制台） */
if (import.meta.dev) {
  watchEffect(() => {
    const plan = props.plan
    if (!plan) return
    console.debug('[realpath-debug] 长度', {
      raw: pathLengthM(props.rawPoints).toFixed(2),
      sampled: pathLengthM(plan.sampled).toFixed(2),
      final: pathLengthM(plan.points).toFixed(2),
      cut: pathLengthM(cutPoints.value).toFixed(2),
    })
  })
}
</script>