<template>
  <div>
    <v-alert type="info" variant="flat" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-map-marker-radius-outline</v-icon>签到区域编辑
      </div>
      <div class="text-body-2">
        为<b>每个签到点位</b>设置"提交时坐标怎么来"。默认策略是"<b>走到圈里、停在偏内一点的位置</b>"
        （而不是围着点位圆心均匀撒点 —— 那是最容易被看出是程序的特征）。
        <br />⚠️ 这里改的是<b>坐标这一项</b>的生成方式；"是否到场"这件事在提交时就已经跳过了（见「早操签到」页的说明）。
        点位标识（任务号 / 点位号 / 二维码）<b>一律原样</b>，本页不涉及。
      </div>
    </v-alert>

    <v-alert v-if="status !== 'ready'" type="warning" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">需要先读到签到任务</div>
      <div class="text-body-2">
        点位（中心坐标 / 圈半径）来自服务端下发 —— 先在工作台登录并读取真实数据，或到「早操签到」页点「重新读取」。
        <span v-if="status === 'unavailable'">当前账号返回"无需签到"（{{ unavailableMessage }}）。</span>
      </div>
    </v-alert>

    <v-card v-if="status === 'ready' && task">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <span class="text-subtitle-1">签到点位（{{ task.signPointList.length }} 个）</span>
        <v-chip size="small" variant="tonal">围栏 {{ task.offsetRange || '—' }} m</v-chip>
        <v-chip size="small" variant="tonal" color="primary">窗口 {{ task.startTime }}–{{ task.endTime }}</v-chip>
        <v-spacer />
        <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" :loading="reloading" @click="reload">重新读取任务</v-btn>
      </v-card-title>
      <v-card-text>
        <v-row dense>
          <v-col v-for="pt in task.signPointList" :key="pt.pointId" cols="12" lg="6">
            <v-card variant="outlined" class="h-100">
              <v-card-title class="d-flex align-center ga-2 text-body-1">
                <span>{{ pt.pointName || '未命名点位' }}</span>
                <v-chip size="x-small" variant="tonal">{{ pt.pointId }}</v-chip>
                <v-chip v-if="isCustomized(pt.pointId)" size="x-small" color="success" variant="tonal">已自定义</v-chip>
                <v-spacer />
                <v-btn size="x-small" variant="text" @click="resetPoint(pt.pointId)">恢复默认</v-btn>
              </v-card-title>
              <v-card-text>
                <div class="d-flex flex-wrap ga-4">
                  <!-- 可视化：外圈=围栏；内二圈=落点带；点=最近一次采样分布 -->
                  <svg :viewBox="`0 0 ${SV} ${SV}`" :width="SV" :height="SV" class="zone-svg">
                    <circle :cx="SV / 2" :cy="SV / 2" :r="px(task.offsetRange)" fill="none" stroke="#666" stroke-dasharray="4 3" />
                    <circle :cx="SV / 2" :cy="SV / 2" :r="px(effOuter(pt.pointId))" fill="#42a5f5" fill-opacity="0.10" stroke="#42a5f5" stroke-opacity="0.5" />
                    <circle :cx="SV / 2" :cy="SV / 2" :r="px(effInner(pt.pointId))" fill="none" stroke="#42a5f5" stroke-opacity="0.5" stroke-dasharray="3 3" />
                    <circle v-for="(s, i) in previewOf(pt.pointId)" :key="i" :cx="SV / 2 + s.x" :cy="SV / 2 + s.y" r="1.6" fill="#ffb300" fill-opacity="0.85" />
                    <circle :cx="SV / 2" :cy="SV / 2" r="2.4" fill="#e53935" />
                    <text :x="SV / 2 + 4" :y="SV / 2 - 4" fill="#e53935" font-size="9">点位中心</text>
                  </svg>

                  <div style="min-width: 240px; flex: 1">
                    <v-switch
                      :model-value="!draftOf(pt.pointId).disabled"
                      density="compact"
                      hide-details
                      color="primary"
                      label="启用区域策略"
                      @update:model-value="(v: unknown) => patch(pt.pointId, { disabled: !v })"
                    />
                    <div class="text-caption text-medium-emphasis mb-1">
                      关掉 ⇒ 提交时直接用服务端下发的点位坐标（不做任何偏移）。
                    </div>

                    <div class="text-caption mt-2">落点距离：{{ pct(draftOf(pt.pointId).innerFraction) }} ~ {{ pct(draftOf(pt.pointId).outerFraction) }} × 可用半径</div>
                    <v-slider
                      :model-value="draftOf(pt.pointId).innerFraction"
                      :min="0"
                      :max="0.9"
                      :step="0.05"
                      density="compact"
                      hide-details
                      thumb-label
                      label="内侧比例"
                      @update:model-value="(v: number) => patch(pt.pointId, { innerFraction: v })"
                    />
                    <v-slider
                      :model-value="draftOf(pt.pointId).outerFraction"
                      :min="0.05"
                      :max="0.95"
                      :step="0.05"
                      density="compact"
                      hide-details
                      thumb-label
                      label="外侧比例"
                      @update:model-value="(v: number) => patch(pt.pointId, { outerFraction: v })"
                    />

                    <div class="text-caption mt-2">可用半径上限：{{ draftOf(pt.pointId).radiusM === null ? `自动（跟随服务端 ${task.offsetRange} m）` : `${draftOf(pt.pointId).radiusM} m` }}</div>
                    <v-slider
                      :model-value="radiusSlider(pt.pointId)"
                      :min="0"
                      :max="1000"
                      :step="10"
                      density="compact"
                      hide-details
                      thumb-label
                      label="半径上限（1000=自动）"
                      @update:model-value="(v: number) => patch(pt.pointId, { radiusM: v >= 1000 ? null : v })"
                    />

                    <div class="text-caption mt-2">进场方向：{{ draftOf(pt.pointId).approachBearingDeg === null ? '每次随机' : `${Math.round(draftOf(pt.pointId).approachBearingDeg!)}°` }}，每次扰动 ±{{ Math.round(draftOf(pt.pointId).bearingJitterDeg) }}°</div>
                    <v-slider
                      :model-value="bearingSlider(pt.pointId)"
                      :min="0"
                      :max="360"
                      :step="5"
                      density="compact"
                      hide-details
                      thumb-label
                      label="方向偏置（360=每次随机）"
                      @update:model-value="(v: number) => patch(pt.pointId, { approachBearingDeg: v >= 360 ? null : v })"
                    />
                    <v-slider
                      :model-value="draftOf(pt.pointId).bearingJitterDeg"
                      :min="0"
                      :max="180"
                      :step="5"
                      density="compact"
                      hide-details
                      thumb-label
                      label="方向扰动 ±°"
                      @update:model-value="(v: number) => patch(pt.pointId, { bearingJitterDeg: v })"
                    />

                    <div class="text-caption mt-2">定位噪声 σ = {{ draftOf(pt.pointId).gpsSigmaM }} m</div>
                    <v-slider
                      :model-value="draftOf(pt.pointId).gpsSigmaM"
                      :min="0"
                      :max="30"
                      :step="1"
                      density="compact"
                      hide-details
                      thumb-label
                      label="GPS 噪声 σ（米）"
                      @update:model-value="(v: number) => patch(pt.pointId, { gpsSigmaM: v })"
                    />

                    <v-alert type="info" variant="tonal" density="compact" class="mt-2">
                      <div class="text-caption">
                        采样 {{ PREVIEW_N }} 次：距中心 <b>{{ statsOf(pt.pointId).minM.toFixed(0) }} ~ {{ statsOf(pt.pointId).maxM.toFixed(0) }} m</b>
                        （均值 {{ statsOf(pt.pointId).meanM.toFixed(0) }} m）
                        <span v-if="statsOf(pt.pointId).maxM > Number(task.offsetRange || 0) + 0.5" class="text-error">
                          ⚠️ 有样本超出围栏（不应发生）
                        </span>
                      </div>
                    </v-alert>
                  </div>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 「签到区域编辑」页（2026-09-20）
 *
 * 目的：把"提交时坐标怎么生成"从"围着圆心均匀撒点"改成**像人走过去站定**的分布，
 * 并让每个点位可以单独调（东操场/西操场入口方向不同，落点偏好也不同）。
 *
 * 口径（与「早操签到」页一致，别在这儿偷偷改）：
 *   · **点位标识（taskId/pointId/qrCode）一律原样**，本页只影响坐标；
 *   · **绝不越出服务端下发的 `offsetRange` 围栏**（纯逻辑层有最终夹紧，且有单测钉住）；
 *   · 配置存本机（`mp_mornsign_zone_v1`），**不上传任何地方**；提交时由本机服务端读用。
 */
import { sampleDistribution, ZONE_LIMITS, type MornSignZone } from '~/utils/mp/mornSignZone'

const { task: state, status, loadMornSignTask } = useMpMorningSign()
const zoneLib = useMornSignZone()
const showSnackbar = useNotice()

const norm = computed(() => state.value)
const task = computed(() => (norm.value?.kind === 'ok' ? norm.value.task : null))
const unavailableMessage = computed(() => (norm.value?.kind === 'unavailable' ? norm.value.message : ''))

const SV = 150
const PREVIEW_N = 160

/** 本页的"草稿"：改滑杆立刻写盘并重算预览（点位数量很少，代价可忽略） */
const drafts = ref<Record<string, MornSignZone>>({})

const ensureDraft = (pointId: string) => {
  if (!drafts.value[pointId]) drafts.value[pointId] = zoneLib.get(pointId)
  return drafts.value[pointId]!
}
const draftOf = (pointId: string) => ensureDraft(pointId)
const patch = (pointId: string, part: Partial<MornSignZone>) => {
  const next = { ...draftOf(pointId), ...part }
  drafts.value = { ...drafts.value, [pointId]: next }
  const ok = zoneLib.set(pointId, next)
  if (!ok) showSnackbar('配置只存在内存里（本机存储写入失败）', 'warning')
}
const isCustomized = (pointId: string) => zoneLib.customizedIds.value.includes(pointId)
const resetPoint = (pointId: string) => {
  zoneLib.resetToDefault(pointId)
  drafts.value = { ...drafts.value, [pointId]: zoneLib.get(pointId) }
  showSnackbar('已恢复默认策略', 'info')
}

/** 滑杆的"自动/随机"用最大值表示（Vuetify 滑杆没有 null 态） */
const radiusSlider = (pointId: string) => draftOf(pointId).radiusM ?? 1000
const bearingSlider = (pointId: string) => draftOf(pointId).approachBearingDeg ?? 360

/** 可用半径（与服务端一致：自动时用 offsetRange） */
const usableRadius = computed(() => Number(task.value?.offsetRange) || 0)
const effRadius = (pointId: string) => draftOf(pointId).radiusM ?? usableRadius.value
const effInner = (pointId: string) => effRadius(pointId) * draftOf(pointId).innerFraction
const effOuter = (pointId: string) => effRadius(pointId) * draftOf(pointId).outerFraction

/** 米 → SVG 像素（以服务端围栏为外边界） */
const px = (m: number | string) => {
  const r = usableRadius.value || 1
  return (Number(m) || 0) / r * (SV / 2 - 4)
}

/** 采样预览：返回相对圆心的 SVG 偏移（x=东，y=**南**，与 SVG 坐标系一致） */
const previewCache = ref<Record<string, { x: number; y: number }[]>>({})
const statsCache = ref<Record<string, { minM: number; maxM: number; meanM: number }>>({})
const recompute = (pointId: string) => {
  const p = task.value?.signPointList.find((x) => x.pointId === pointId)
  if (!p) return
  const { points, minM, maxM, meanM } = sampleDistribution(
    p.latitude,
    p.longitude,
    usableRadius.value,
    draftOf(pointId),
    PREVIEW_N,
  )
  previewCache.value = {
    ...previewCache.value,
    [pointId]: points.map((s) => {
      const scale = SV / 2 - 4
      const scaleM = usableRadius.value || 1
      const dNorth = (Number(s.latitude) - Number(p.latitude)) * 111_320
      const mPerDegLng = 111_320 * Math.cos((Number(p.latitude) * Math.PI) / 180)
      const dEast = (Number(s.longitude) - Number(p.longitude)) * mPerDegLng
      return { x: (dEast / scaleM) * scale, y: (-dNorth / scaleM) * scale }
    }),
  }
  statsCache.value = { ...statsCache.value, [pointId]: { minM, maxM, meanM } }
}
const previewOf = (pointId: string) => previewCache.value[pointId] ?? []
const statsOf = (pointId: string) => statsCache.value[pointId] ?? { minM: 0, maxM: 0, meanM: 0 }

/** 任务/草稿变化时重算（点位数很少，直接全量重算，简单可靠） */
watch(
  () => [task.value?.signPointList.map((p) => p.pointId).join(','), JSON.stringify(drafts.value), usableRadius.value].join('|'),
  () => {
    for (const p of task.value?.signPointList ?? []) recompute(p.pointId)
  },
  { immediate: true },
)

const pct = (v: number) => `${Math.round(v * 100)}%`

/** 「重新读取任务」按钮的 loading —— ⚠️ 不能直接写 `status === 'loading'`：
 * 外层已经是 `v-if="status === 'ready'"`，TS 会把 status 收窄成 `'ready'`，
 * 于是 `'ready' === 'loading'` 被判为"永不相等"（TS2367）。用独立 ref 表达。 */
const reloading = ref(false)

const reload = async () => {
  reloading.value = true
  try {
    const ok = await loadMornSignTask()
    showSnackbar(ok ? '已重新读取签到任务' : '读取失败（见早操签到页的提示）', ok ? 'success' : 'error')
  } finally {
    reloading.value = false
  }
}

onMounted(() => {
  zoneLib.load()
  if (status.value === 'idle') void loadMornSignTask()
})

useHead({ title: '签到区域编辑 · 龙猫天堂' })
</script>

<style scoped>
.zone-svg {
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 6px;
  flex: 0 0 auto;
}
</style>
