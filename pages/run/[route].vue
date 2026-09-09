<template>
  <div>
    <v-card class="pa-6">
      <v-card-title class="d-flex align-center justify-space-between">
        <span>已选择路径 {{ routeInfo?.pointName }}</span>
        <v-chip color="primary" variant="tonal"> {{ paper?.mileage }} km </v-chip>
      </v-card-title>

      <p class="text-body-1 mt-2 text-medium-emphasis">
        请再次确认是否跑步：开跑时会向龙猫服务器发送请求，所以请尽量不要在开跑后取消。
      </p>

      <!-- 路线与模拟轨迹地图预览 -->
      <div v-if="routeInfo?.pointList?.length" class="mt-2">
        <ClientOnly>
          <TotoroMap
            :polylines="[routeInfo.pointList, mockRoute]"
            :markers="routeInfo.pointList.map((p, i) => ({ ...p, color: i === 0 ? '#FF5252' : '#4CAF50' }))"
            :height="340"
          />
        </ClientOnly>
        <p v-if="mockRoute.length" class="text-caption text-medium-emphasis mt-1">
          红点为官方打卡路线，橙色线为本次模拟轨迹（约 {{ paper?.mileage }} km）
        </p>
      </div>

      <template v-if="!running && !startedAt">
        <!-- 补跑模式（测试） -->
        <v-card variant="tonal" color="warning" class="my-4">
          <v-card-text>
            <div class="d-flex align-center">
              <v-checkbox
                v-model="backfillMode"
                label="补跑模式（测试）"
                density="compact"
                hide-details
                color="warning"
              />
              <v-btn
                v-if="backfillMode"
                size="small"
                variant="text"
                color="primary"
                class="ml-auto"
                :loading="backfillLoading"
                @click="reloadBackfill"
              >
                刷新日期
              </v-btn>
            </div>
            <BackfillPicker
              v-if="backfillMode"
              ref="backfillPickerRef"
              v-model="backfillDate"
              class="mt-2"
            />
          </v-card-text>
        </v-card>

        <v-btn
          color="primary my-4"
          :append-icon="'mdi-run'"
          size="large"
          :disabled="isDebug || !routeInfo"
          @click="startRun"
        >
          {{ isDebug ? '调试模式 · 提交已禁用' : routeInfo ? '确认开始' : '未找到路线，请返回重选' }}
        </v-btn>
      </template>

      <template v-if="running">
        <div class="d-flex align-center justify-space-between text-h5 my-4">
          <span>{{ formatMs(elapsedMs) }}</span>
          <span>/ {{ formatMs(totalMs) }}</span>
          <span class="text-subtitle-1 text-medium-emphasis">{{ progressPercent }}%</span>
        </div>
        <v-progress-linear
          v-if="totalMs"
          color="primary"
          :model-value="progressPercent"
          class="mt-2"
          height="12"
        />
        <p class="text-caption text-medium-emphasis mt-2">
          跑步进行中，请勿关闭页面…
        </p>
      </template>

      <template v-if="!running && startedAt">
        <v-alert type="success" variant="tonal">跑步已完成！成绩已提交到龙猫服务器。</v-alert>
        <v-btn color="primary" class="mt-4" to="/records">查看记录</v-btn>
      </template>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { TotoroApiWrapper } from '~/src/wrappers/TotoroApiWrapper'
import { useSession } from '~/composables/useSession'
import { useSunRunPaper, type RunPoint } from '~/composables/useSunRunPaper'
import { generateRoute } from '~/utils/generateRoute'
import { buildRunRequest } from '~/utils/runRequest'

definePageMeta({ title: '跑步执行' })

const route = useRoute()
const { session, basicReq, isDebug } = useSession()
const paper = useSunRunPaper()
const routePointId = computed(() => String(route.params.route ?? ''))

const routeInfo = computed<RunPoint | undefined>(() =>
  paper.value?.runPointList?.find((p) => p.pointId === routePointId.value),
)

// 模拟轨迹预览（供地图可视化；与实际提交一致）
const mockRoute = computed(() => {
  const r = routeInfo.value
  const mileage = paper.value?.mileage
  if (!r?.pointList?.length || !mileage) return []
  try {
    return generateRoute(mileage, r).mockRoute
  } catch {
    return r.pointList
  }
})

const running = ref(false)
const startedAt = ref(0)
const endTime = ref(0)
const elapsedMs = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

// 补跑模式（测试）：将记录归属到历史日期（未验证服务端是否接受）
const backfillMode = ref(false)
const backfillDate = ref('')
const backfillPickerRef = ref<{ reload: () => Promise<void> } | null>(null)
const backfillLoading = ref(false)
async function reloadBackfill() {
  if (!backfillPickerRef.value) return
  backfillLoading.value = true
  try { await backfillPickerRef.value.reload() } finally { backfillLoading.value = false }
}
const todayStr = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
})
const backfillFirstDay = computed(() => backfillDate.value.split(',').map((s) => s.trim()).find(Boolean) || '')

const totalMs = computed(() => Math.max(0, endTime.value - startedAt.value))
const progressPercent = computed(() =>
  totalMs.value ? Math.min(100, Math.round((elapsedMs.value / totalMs.value) * 100)) : 0,
)

function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600).toString().padStart(2, '0')
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0')
  const sec = (s % 60).toString().padStart(2, '0')
  return `${h}:${m}:${sec}`
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (running.value) {
    e.preventDefault()
    e.returnValue = '跑步还未完成，确定要离开吗？'
  }
}

async function startRun() {
  if (isDebug.value) return // 调试模式禁止提交
  const routePoint = routeInfo.value
  if (!routePoint || !paper.value || !session.value) return

  const { req, endTime: w } = await buildRunRequest({
    distance: paper.value.mileage ?? 0,
    routeId: routePoint.pointId,
    taskId: routePoint.taskId || routePoint.pointId,
    token: session.value.token!,
    schoolId: session.value.schoolId,
    stuNumber: session.value.stuNumber!,
    phoneNumber: session.value.phoneNumber,
    minTime: paper.value.minTime ?? 0,
    maxTime: paper.value.maxTime ?? 0,
    targetDate: backfillMode.value ? backfillFirstDay.value || undefined : undefined,
  })

  startedAt.value = Date.now()
  endTime.value = w.getTime()
  running.value = true

  timer = setInterval(() => {
    elapsedMs.value = Date.now() - startedAt.value
  }, 500)

  window.addEventListener('beforeunload', onBeforeUnload)

  await TotoroApiWrapper.getRunBegin({
    campusId: session.value.campusId,
    schoolId: session.value.schoolId,
    stuNumber: session.value.stuNumber,
    token: session.value.token,
  })

  const remaining = endTime.value - Date.now()
  setTimeout(async () => {
    try {
      const D = await TotoroApiWrapper.sunRunExercises(req)
      const S = generateRoute(paper.value?.mileage ?? 0, routePoint)
      await TotoroApiWrapper.sunRunExercisesDetail({
        pointList: S.mockRoute,
        scantronId: (D as { scantronId?: string }).scantronId || '',
        breq: basicReq.value,
      })
    } catch (e) {
      console.error('submit run failed:', e)
    } finally {
      running.value = false
      if (timer) clearInterval(timer)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, Math.max(0, remaining))
}

onMounted(() => {
  if (!session.value?.token) navigateTo('/')
})
</script>