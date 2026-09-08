<template>
  <div>
    <v-row>
      <v-col cols="12" md="7">
        <v-card class="pa-4">
          <v-card-title class="d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            自由跑
          </v-card-title>
          <v-card-subtitle>自定义您的跑步距离与目标时间，系统将自动生成真实的跑步数据。</v-card-subtitle>

          <v-card-text>
            <!-- 路线选择（可选，复用阳光跑任务路线，让记录在 App 端显示） -->
            <div class="text-subtitle-2 mb-1">选择路线（选填）</div>
            <v-select
              v-model="selectedRoute"
              :items="availableRoutes"
              item-title="pointName"
              item-value="pointId"
              variant="outlined"
              label="跑步路线"
              :loading="loadingRoutes"
              :disabled="!availableRoutes.length"
              clearable
              :hint="routeHint"
              persistent-hint
            >
              <template #prepend-item>
                <v-list-item @click="selectRandomRoute">
                  <template #prepend>
                    <v-icon icon="mdi-shuffle-variant" />
                  </template>
                  <v-list-item-title>随机选择路线</v-list-item-title>
                </v-list-item>
                <v-divider class="mt-2" />
              </template>
            </v-select>
            <p v-if="selectedRouteInfo" class="text-caption text-medium-emphasis mt-1">
              已选择: {{ selectedRouteInfo.pointName }}（{{ paper?.mileage }} km 官方路线）
            </p>

            <!-- 轨迹地图预览 -->
            <div v-if="!distanceError && distance > 0" class="mt-2">
              <TotoroMap
                :polylines="previewRoute.length ? [previewRoute] : []"
                :markers="selectedRouteInfo?.pointList?.length ? selectedRouteInfo.pointList.map((p, i) => ({ ...p, color: i === 0 ? '#FF5252' : '#4CAF50' })) : undefined"
                :height="280"
              />
              <p class="text-caption text-medium-emphasis mt-1">
                {{ previewHint }}
              </p>
            </div>

            <v-divider class="my-3" />

            <!-- 预置模板 -->
            <div class="text-subtitle-2 mb-1">快速模板</div>
            <v-chip-group v-model="preset" mandatory>
              <v-chip v-for="item in presets" :key="item.key" :value="item.key" filter>
                {{ item.name }}
              </v-chip>
            </v-chip-group>
            <v-alert v-if="activePreset" type="info" variant="tonal" density="compact" class="mt-2 mb-3">
              {{ activePreset.desc }}
            </v-alert>

            <v-text-field v-model.number="distance" label="跑步距离 (km)" type="number" min="0.5" max="20" step="0.1" />
            <v-alert v-if="distanceError" type="error" variant="tonal" density="compact" class="mb-3">
              {{ distanceError }}
            </v-alert>

            <v-radio-group v-model="paceMode" inline>
              <v-radio label="按平均速度" value="speed" />
              <v-radio label="按目标时间" value="time" />
            </v-radio-group>

            <v-row>
              <v-col v-if="paceMode === 'speed'" cols="12">
                <v-text-field v-model.number="speed" label="平均速度 (km/h)" type="number" min="3" max="25" step="0.1" suffix="km/h" />
              </v-col>
              <v-col v-else cols="12">
                <v-text-field v-model.number="targetMinutes" label="目标时间 (分钟)" type="number" min="1" max="300" step="1" suffix="分钟" hint="留空将根据合理速度自动计算" persistent-hint />
              </v-col>
            </v-row>
            <v-alert v-if="paceError" type="error" variant="tonal" density="compact" class="mb-3">
              {{ paceError }}
            </v-alert>

            <!-- 预计数据预览 -->
            <v-card v-if="preview" variant="tonal" class="mt-2">
              <v-card-text>
                <div class="text-subtitle-2 mb-2">预计跑步数据</div>
                <v-row dense>
                  <v-col cols="6" sm="3">
                    <div class="text-caption">平均速度</div>
                    <div class="text-h6">{{ preview.avgSpeed }} km/h</div>
                  </v-col>
                  <v-col cols="6" sm="3">
                    <div class="text-caption">平均配速</div>
                    <div class="text-h6">{{ preview.avgPace }}</div>
                  </v-col>
                  <v-col cols="6" sm="3">
                    <div class="text-caption">预计卡路里</div>
                    <div class="text-h6">{{ preview.calorie }} kcal</div>
                  </v-col>
                  <v-col cols="6" sm="3">
                    <div class="text-caption">预计步数</div>
                    <div class="text-h6">{{ preview.steps }} 步</div>
                  </v-col>
                </v-row>
              </v-card-text>
            </v-card>

            <v-expansion-panels class="mt-3">
              <v-expansion-panel>
                <v-expansion-panel-title>
                  <v-icon class="mr-2">mdi-tune</v-icon>
                  高级设置（模拟数据随机扰动）
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <v-row>
                    <v-col cols="12" md="4">
                      <v-text-field v-model.number="varyDistanceKm" label="距离变化 ±km" type="number" min="0" max="2" step="0.1" />
                    </v-col>
                    <v-col cols="12" md="4">
                      <v-text-field v-model.number="varySpeedKmh" label="速度变化 ±km/h" type="number" min="0" max="10" step="0.5" />
                    </v-col>
                    <v-col cols="12" md="4">
                      <v-text-field v-model.number="varyTimeMin" label="时间变化 ±分钟" type="number" min="0" max="20" step="1" />
                    </v-col>
                  </v-row>
                  <p class="text-caption text-medium-emphasis">
                    为了模拟真实跑步的差异，每次提交时参数将按上述范围随机变化。
                  </p>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-card-text>

          <v-card-actions>
            <v-btn color="primary" :append-icon="'mdi-send'" :loading="running" :disabled="isDebug" size="large" @click="startFreeRun">
              {{ isDebug ? '调试模式 · 提交已禁用' : '开始自由跑' }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>

      <!-- 批量 -->
      <v-col cols="12" md="5">
        <v-card class="pa-4">
          <v-card-title class="d-flex align-center">
            <v-icon color="accent" class="mr-2">mdi-layers-triple</v-icon>
            批量跑步
          </v-card-title>
          <v-card-subtitle>多次自由跑（沿用上方所选路线），每次随机化参数模拟真实变化。</v-card-subtitle>

          <v-card-text>
            <v-text-field v-model.number="batchCount" label="跑步次数 (1-10)" type="number" min="1" max="10" step="1" />
            <v-text-field
              v-model.number="batchInterval"
              label="间隔时间 (分钟)"
              type="number"
              min="1"
              max="60"
              step="1"
              :hint="batchInterval < 5 ? '间隔时间较短，可能被检测为异常行为，建议至少 5 分钟' : undefined"
              persistent-hint
            />
            <v-alert v-if="batchTimeHint" type="warning" variant="tonal" density="compact" class="mb-2">
              {{ batchTimeHint }}
            </v-alert>
            <v-btn color="accent" :append-icon="'mdi-play'" :loading="running" :disabled="isDebug || !isLoggedIn" @click="startBatch">
              {{ isDebug ? '调试模式 · 提交已禁用' : '开始批量执行' }}
            </v-btn>
          </v-card-text>
        </v-card>

        <v-card v-if="progress.length" class="pa-4 mt-4">
          <v-card-title class="text-subtitle-1">执行进度</v-card-title>
          <v-progress-circular v-if="running" indeterminate color="primary" size="24" class="mr-2" />
          <span class="text-body-2">
            {{ doneCount }}/{{ progress.length }} · 成功 {{ successCount }} · 失败 {{ failureCount }}
          </span>
          <v-table density="compact" class="mt-3">
            <thead>
              <tr>
                <th>#</th>
                <th>状态</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in progress" :key="item.index">
                <td>{{ item.index + 1 }}</td>
                <td>
                  <v-chip v-if="item.status === 'success'" color="success" size="small">成功</v-chip>
                  <v-chip v-else-if="item.status === 'failed'" color="error" size="small">失败</v-chip>
                  <v-chip v-else color="info" size="small">排队</v-chip>
                </td>
                <td class="text-caption">
                  {{ item.recordId ? `记录ID: ${item.recordId}` : item.error }}
                </td>
              </tr>
            </tbody>
          </v-table>
          <v-btn v-if="!running && failureCount" color="error" variant="outlined" class="mt-3" @click="retryFailed">
            重试失败项
          </v-btn>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import type { FreeRunData } from '~/src/wrappers/TotoroApiWrapper'
import { TotoroApiWrapper } from '~/src/wrappers/TotoroApiWrapper'
import { useSession } from '~/composables/useSession'
import { useSunRunPaper, type RunPoint } from '~/composables/useSunRunPaper'
import { createDebugPaper } from '~/utils/debugData'
import { generateRoute } from '~/utils/generateRoute'

definePageMeta({ title: '自由跑' })

const { session, isLoggedIn, isDebug, basicReq } = useSession()
const paper = useSunRunPaper()

// ---------- 路线 ----------
const loadingRoutes = ref(false)
const selectedRoute = ref<string>()

const availableRoutes = computed<RunPoint[]>(() => paper.value?.runPointList || [])
const selectedRouteInfo = computed<RunPoint | undefined>(() =>
  availableRoutes.value.find((r) => r.pointId === selectedRoute.value),
)
const routeHint = computed(() => {
  if (loadingRoutes.value) return '正在加载路线数据…'
  if (!availableRoutes.value.length) return '未加载到路线数据，将使用默认圆形路线'
  return '选择阳光跑任务路线，可让记录在 App 端正常显示'
})

const selectRandomRoute = () => {
  if (availableRoutes.value.length) {
    selectedRoute.value = availableRoutes.value[Math.floor(Math.random() * availableRoutes.value.length)]!.pointId
  }
}

async function ensurePaper() {
  if (paper.value?.runPointList?.length) return
  if (!session.value?.token) return
  if (isDebug.value) {
    paper.value = createDebugPaper() as unknown as typeof paper.value
    return
  }
  loadingRoutes.value = true
  try {
    const res = await TotoroApiWrapper.getSunRunPaper({
      token: session.value.token,
      campusId: session.value.campusId,
      schoolId: session.value.schoolId,
      stuNumber: session.value.stuNumber,
    })
    paper.value = res as typeof paper.value
  } catch (e) {
    console.warn('Failed to load sunRunPaper:', e)
  } finally {
    loadingRoutes.value = false
  }
}

// ---------- 模板 & 参数 ----------
const presets = [
  { key: 'easy', name: '轻松跑', distance: 3, speed: 7, desc: '适合日常锻炼，轻松完成的跑步' },
  { key: 'standard', name: '标准跑', distance: 5, speed: 10, desc: '标准强度的跑步训练，适合提升体能' },
  { key: 'challenge', name: '挑战跑', distance: 10, speed: 12.5, desc: '高强度的挑战性跑步' },
]
const preset = ref('standard')
const activePreset = computed(() => presets.find((p) => p.key === preset.value))

// 点击模板 -> 将模板的距离/速度回填到表单（原版行为）
watch(preset, (key) => {
  const t = presets.find((p) => p.key === key)
  if (!t) return
  distance.value = t.distance
  speed.value = t.speed
  paceMode.value = 'speed'
  targetMinutes.value = undefined
})

const distance = ref(5)
const speed = ref(10)
const targetMinutes = ref<number>()
const paceMode = ref<'speed' | 'time'>('speed')

// 高级随机化
const varyDistanceKm = ref(0.5)
const varySpeedKmh = ref(0.5)
const varyTimeMin = ref(2)

const batchCount = ref(3)
const batchInterval = ref(10)

const running = ref(false)
const progress = ref<{ index: number; status: 'wait' | 'success' | 'failed'; recordId?: string; error?: string }[]>([])
const pendingData = ref<IItem[]>([])

const doneCount = computed(() => progress.value.filter((p) => p.status !== 'wait').length)
const successCount = computed(() => progress.value.filter((p) => p.status === 'success').length)
const failureCount = computed(() => progress.value.filter((p) => p.status === 'failed').length)

const distanceError = computed(() => {
  if (!distance.value || distance.value < 0.5) return '距离不能小于 0.5 km'
  if (distance.value > 20) return '距离不能超过 20 km'
  return ''
})

const paceError = computed(() => {
  if (!session.value?.token) return '请先登录'
  if (paceMode.value === 'speed' && (!speed.value || speed.value < 3 || speed.value > 25)) {
    return speed.value < 3 ? '平均速度不能低于 3 km/h' : '平均速度不能超过 25 km/h'
  }
  if (paceMode.value === 'time' && targetMinutes.value !== undefined && (!targetMinutes.value || targetMinutes.value <= 0)) {
    return '时间必须大于 0'
  }
  return ''
})

const batchTimeHint = computed(() => {
  const baseSpeed = resolveBaseSpeed()
  const baseDurMin = baseSpeed ? Math.ceil((distance.value / baseSpeed) * 60) : 15
  const totalMin = batchCount.value * baseDurMin + batchCount.value * batchInterval.value
  if (totalMin > 6 * 60) return `批量总时间将超过 ${Math.round(totalMin / 60)} 小时，考虑减少次数或缩短间隔时间`
  return ''
})

// ---------- 数据生成（沿用原版公式） ----------
const simpleHash = (str: string): string => {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  const hexHash = Math.abs(hash).toString(16).padStart(8, '0')
  return (hexHash + hexHash + hexHash + hexHash).substring(0, 32)
}

const formatPace = (avgSpeed: number): string => {
  const paceMinutes = 60 / avgSpeed
  const minutes = Math.floor(paceMinutes)
  const seconds = Math.round((paceMinutes - minutes) * 60)
  return seconds >= 60 ? `${minutes + 1}:00` : `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const metForSpeed = (speed: number): number => {
  if (speed < 5) return 3.5
  if (speed < 8) return 7
  if (speed < 12) return 9.8
  if (speed < 16) return 12.3
  return 15.3
}

const generateDeviceInfo = (stuNumber: string): string => {
  const hash = simpleHash(stuNumber + 'device')
  const versions = ['10', '11', '12', '13', '14']
  const models = ['SM-G973F', 'Pixel 6', 'Mi 11', 'OnePlus 9', 'HUAWEI P40']
  const vIdx = parseInt(hash.substring(16, 17), 16) % versions.length
  const mIdx = parseInt(hash.substring(17, 18), 16) % models.length
  return `Android ${versions[vIdx]}; ${models[mIdx]}; ${hash.substring(0, 16)}`
}

interface IItem extends FreeRunData {
  routeId?: string
  taskId?: string
}

/** 解析基础速度：按速度模式取输入值；按时间模式由距离/时间推算；时间留空用默认 8 km/h（原版行为） */
const resolveBaseSpeed = (): number => {
  if (paceMode.value === 'speed') return speed.value
  if (targetMinutes.value) return distance.value / (targetMinutes.value / 60)
  return 8
}

const buildSingle = (runIdxOffset: number, presetSpeed?: number): IItem => {
  const stuNumber = session.value?.stuNumber as string
  const baseSpeed = presetSpeed ?? resolveBaseSpeed()

  // 距离/速度随机扰动（原版 ±0.09km / ±0.15km/h，批量范围更大）
  let finalDistance = distance.value
  let finalSpeed = baseSpeed
  if (batchCountActive.value) {
    finalDistance += (Math.random() - 0.5) * 2 * varyDistanceKm.value
    finalSpeed += (Math.random() - 0.5) * 2 * varySpeedKmh.value
  } else {
    finalDistance += (Math.random() - 0.5) * 0.18
    finalSpeed += (Math.random() - 0.5) * 0.3
  }
  finalDistance = Math.max(0.5, Math.min(20, +finalDistance.toFixed(2)))
  finalSpeed = Math.max(3, Math.min(25, +finalSpeed.toFixed(2)))

  let duration = (finalDistance / finalSpeed) * 3600
  if (batchCountActive.value) duration += (Math.random() - 0.5) * 2 * varyTimeMin.value * 60
  duration = Math.round(duration)
  const avgSpeed = +(finalDistance / (duration / 3600)).toFixed(2)

  const startMs = Date.now() + runIdxOffset * 1000
  const start = new Date(startMs)
  const end = new Date(startMs + duration * 1000)
  const stepsPerKm = 1200 + (Math.random() - 0.5) * 100
  const steps = Math.round(finalDistance * stepsPerKm)
  const calorie = Math.round(metForSpeed(avgSpeed) * 65 * (duration / 3600))

  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    duration,
    distance: finalDistance,
    avgSpeed,
    steps,
    calorie: String(calorie),
    avgPace: formatPace(avgSpeed),
    mac: simpleHash(stuNumber),
    deviceInfo: generateDeviceInfo(stuNumber),
    routeId: selectedRouteInfo.value?.pointId,
    taskId: selectedRouteInfo.value?.taskId,
    stuNumber,
    token: session.value!.token as string,
  } as unknown as IItem
}

const batchCountActive = ref(false)

const preview = computed(() => {
  if (!distance.value) return null
  try {
    const s = resolveBaseSpeed()
    if (!s || s < 3 || s > 25) return null
    const duration = (distance.value / s) * 3600
    return {
      avgSpeed: s.toFixed(1),
      avgPace: formatPace(s),
      calorie: Math.round(metForSpeed(s) * 65 * (duration / 3600)).toString(),
      steps: Math.round(distance.value * 1200).toString(),
    }
  } catch {
    return null
  }
})

// ---------- 提交（三步链路：getRunBegin → submit → 轨迹 detail） ----------
const generateCircleRoute = (distanceKm: number): { longitude: string; latitude: string }[] => {
  const centerLat = 39.9042
  const centerLng = 116.4074
  const numPoints = Math.max(10, Math.floor(distanceKm * 10))
  const radiusDeg = distanceKm / (2 * Math.PI) / 111
  const points: { longitude: string; latitude: string }[] = []
  for (let i = 0; i <= numPoints; i++) {
    const angle = (2 * Math.PI * i) / numPoints
    const offset = (Math.random() - 0.5) * 0.0001
    points.push({
      latitude: (centerLat + radiusDeg * Math.sin(angle) + offset).toFixed(6),
      longitude: (centerLng + radiusDeg * Math.cos(angle) + offset).toFixed(6),
    })
  }
  return points
}

const buildRoutePoints = (distanceKm: number): { longitude: string; latitude: string }[] => {
  const route = selectedRouteInfo.value
  if (route?.pointList?.length) {
    try {
      return generateRoute(distanceKm, route).mockRoute
    } catch {
      /* fallthrough */
    }
  }
  return generateCircleRoute(distanceKm)
}

// 地图预览：基于当前距离生成将提交的轨迹
const previewRoute = computed(() => {
  const d = distance.value
  if (!d || d < 0.5) return []
  try {
    return buildRoutePoints(d)
  } catch {
    return []
  }
})
const previewHint = computed(() =>
  selectedRouteInfo.value?.pointList?.length
    ? `在「${selectedRouteInfo.value.pointName}」路线上按 ${distance.value} km 生成的模拟轨迹（红点为打卡点）`
    : `默认圆形模拟轨迹（未选路线），约 ${distance.value} km；选路线可让记录在 App 端正常显示`,
)

async function submitOne(data: IItem): Promise<{ recordId?: string; error?: string }> {
  try {
    // 第 0 步：通知服务器开始跑步（原版保留）
    await TotoroApiWrapper.getRunBegin({
      campusId: basicReq.value.campusId,
      schoolId: basicReq.value.schoolId,
      stuNumber: basicReq.value.stuNumber,
      token: basicReq.value.token,
    })

    // 第 1 步：提交成绩
    const res = await TotoroApiWrapper.submitFreeRun(data)
    const scantronId = (res as { scantronId?: string }).scantronId
      || (res.data as { recordId?: string } | undefined)?.recordId
    if (res.status !== '00') {
      return { error: (res.message as string) || '服务器返回错误' }
    }
    const recordId = scantronId || (res.data as { recordId?: string } | undefined)?.recordId || ''

    // 第 2 步：上传轨迹（记录在 App 端可见的关键步骤）
    if (scantronId) {
      try {
        const points = buildRoutePoints(data.distance)
        await TotoroApiWrapper.sunRunExercisesDetail({
          pointList: points,
          scantronId,
          breq: basicReq.value,
        })
      } catch (e) {
        console.warn('Route detail submit failed (main record still OK):', e)
      }
    }
    return { recordId }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

async function runList(dataList: IItem[]) {
  const concurrency = 2
  const results = Array.from({ length: dataList.length }, (_, i) => ({ index: i, status: 'wait' as const }))
  progress.value = results
  pendingData.value = dataList

  for (let i = 0; i < dataList.length; i += concurrency) {
    const chunk = dataList.slice(i, i + concurrency)
    await Promise.all(
      chunk.map(async (data, idx) => {
        const gi = i + idx
        if (gi > 0) {
          await new Promise((r) => setTimeout(r, 1200)) // 错峰提交，降低限流风险
        }
        const r = await submitOne(data)
        progress.value[gi] = r.recordId
          ? { index: gi, status: 'success', recordId: r.recordId }
          : { index: gi, status: 'failed', error: r.error }
      }),
    )
  }
}

async function startFreeRun() {
  if (!isLoggedIn.value) return
  if (distanceError.value || paceError.value) return
  running.value = true
  try {
    batchCountActive.value = false
    const list = [buildSingle(1)]
    await runList(list)
  } finally {
    running.value = false
  }
}

async function startBatch() {
  if (!isLoggedIn.value) return
  if (batchCount.value < 1 || batchCount.value > 10) return
  if (distanceError.value || paceError.value) return
  running.value = true
  progress.value = []
  try {
    batchCountActive.value = true
    const presetSpeed = activePreset.value?.speed
    const list: IItem[] = []
    for (let i = 0; i < batchCount.value; i++) {
      list.push(buildSingle(i * batchInterval.value * 60, presetSpeed))
    }
    await runList(list)
  } finally {
    batchCountActive.value = false
    running.value = false
  }
}

async function retryFailed() {
  const failedIdx = progress.value.filter((p) => p.status === 'failed').map((p) => p.index)
  const retryList = failedIdx.map((i) => pendingData.value[i]!).filter(Boolean)
  if (!retryList.length) return
  running.value = true
  try {
    await runList(retryList)
  } finally {
    running.value = false
  }
}

onMounted(async () => {
  if (!session.value?.token) navigateTo('/')
  await ensurePaper()
})
</script>