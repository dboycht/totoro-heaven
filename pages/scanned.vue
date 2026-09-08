<template>
  <div>
    <template v-if="loading">
      <v-progress-circular indeterminate color="primary" />
    </template>

    <template v-else-if="!session?.token">
      <v-alert type="warning" variant="tonal">请先扫码登录</v-alert>
      <v-btn color="primary" class="mt-4" to="/">返回首页</v-btn>
    </template>

    <template v-else>
      <v-table density="compact" class="mb-6 mt-4 rounded border-thin">
        <tbody>
          <tr>
            <th class="text-left text-medium-emphasis w-32">学校</th>
            <td>{{ session.campusName }}</td>
          </tr>
          <tr>
            <th class="text-left text-medium-emphasis">学院</th>
            <td>{{ session.collegeName }}</td>
          </tr>
          <tr>
            <th class="text-left text-medium-emphasis">学号</th>
            <td>{{ session.stuNumber }}</td>
          </tr>
          <tr>
            <th class="text-left text-medium-emphasis">姓名</th>
            <td>{{ session.stuName }}</td>
          </tr>
        </tbody>
      </v-table>

      <v-divider class="mb-4" />

      <div class="text-h6 mb-2">选择跑步模式</div>
      <v-row>
        <v-col cols="12" md="6">
          <v-card
            :variant="mode === 'sunshine' ? 'elevated' : 'outlined'"
            :color="mode === 'sunshine' ? 'primary' : undefined"
            class="cursor-pointer"
            @click="chooseMode('sunshine')"
          >
            <v-card-text class="text-center">
              <v-icon size="48" class="mb-2">mdi-map-marker-path</v-icon>
              <div class="text-subtitle-1 font-weight-bold">阳光跑</div>
              <div class="text-caption text-medium-emphasis">固定路线 · 扫码运行</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="6">
          <v-card
            :variant="mode === 'free' ? 'elevated' : 'outlined'"
            :color="mode === 'free' ? 'primary' : undefined"
            class="cursor-pointer"
            @click="chooseMode('free')"
          >
            <v-card-text class="text-center">
              <v-icon size="48" class="mb-2">mdi-run-fast</v-icon>
              <div class="text-subtitle-1 font-weight-bold">自由跑</div>
              <div class="text-caption text-medium-emphasis">自定义距离与时间</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- 阳光跑 -->
      <template v-if="paper && mode === 'sunshine'">
        <v-select
          v-model="selectedRoute"
          :items="paper.runPointList"
          item-title="pointName"
          item-value="pointId"
          variant="underlined"
          label="路线"
          class="mt-2"
        />
        <div class="d-flex align-center ga-2">
          <v-btn variant="outlined" color="primary" :prepend-icon="'mdi-gesture'" @click="randomRoute">
            随机路线
          </v-btn>
          <v-btn
            class="ml-auto"
            color="primary"
            :append-icon="'mdi-arrow-right'"
            :to="selectedRoute ? `/run/${encodeURIComponent(selectedRoute)}` : undefined"
            :disabled="!selectedRoute"
          >
            开始跑步
          </v-btn>
        </div>

        <v-alert
          v-if="selectedRouteInfo"
          type="info"
          variant="tonal"
          class="mt-4"
          density="compact"
        >
          <div>路线：{{ selectedRouteInfo.pointName }}</div>
          <div>官方里程：{{ paper?.mileage }} km｜时限：{{ paper?.minTime }}–{{ paper?.maxTime }} 分钟</div>
          <div>途经点：{{ selectedRouteInfo.pointList?.length ?? 0 }}</div>
        </v-alert>

        <!-- 路线地图预览 -->
        <div v-if="selectedRouteInfo?.pointList?.length" class="mt-4">
          <ClientOnly>
            <TotoroMap
              :polylines="[selectedRouteInfo.pointList]"
              :markers="selectedRouteInfo.pointList.map((p, i) => ({ ...p, color: i === 0 ? '#FF5252' : i === selectedRouteInfo.pointList.length - 1 ? '#FF5252' : '#4CAF50' }))"
              :height="320"
            />
          </ClientOnly>
          <p class="text-caption text-medium-emphasis mt-1">地图仅为路线展示，不等于最终提交轨迹</p>
        </div>
      </template>

      <!-- 自由跑 -->
      <template v-if="mode === 'free'">
        <div>
          <v-btn color="primary" :append-icon="'mdi-arrow-right'" to="/freerun">开始自由跑</v-btn>
        </div>
        <v-alert type="info" variant="tonal" class="mt-4" density="compact">
          自由跑功能可自定义跑步距离（0.5–20 km）和目标时间，系统会自动模拟真实的跑步数据（含速度、配速、步数等）。
          数据提交到龙猫服务器，与阳光跑记录分开管理。
        </v-alert>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { TotoroApiWrapper } from '~/src/wrappers/TotoroApiWrapper'
import { useSession } from '~/composables/useSession'
import { useSunRunPaper } from '~/composables/useSunRunPaper'
import { createDebugPaper } from '~/utils/debugData'

definePageMeta({ title: '跑步模式' })

const { session, basicReq, isDebug } = useSession()
const router = useRouter()
const globalPaper = useSunRunPaper()

const mode = ref<'sunshine' | 'free'>('sunshine')
const selectedRoute = ref('')
const loading = ref(true)
const paper = ref<null | {
  message?: string
  mileage?: number
  minTime?: number
  maxTime?: number
  scantronId?: string
  ifHasRun?: string
  runPointList?: { pointId: string; pointName: string; pointList: { longitude: string; latitude: string }[] }[]
}>(null)

const selectedRouteInfo = computed(() =>
  paper.value?.runPointList?.find((p) => p.pointId === selectedRoute.value),
)

const chooseMode = (m: 'sunshine' | 'free') => {
  mode.value = m
  selectedRoute.value = ''
}

const randomRoute = () => {
  const list = paper.value?.runPointList
  if (list?.length) selectedRoute.value = list[Math.floor(Math.random() * list.length)]!.pointId
}

onMounted(async () => {
  if (!session.value?.token) {
    router.replace('/')
    return
  }
  if (isDebug.value) {
    // 调试模式：跳过扫码与真实试卷请求，直接展示本地模拟数据
    paper.value = globalPaper.value ?? createDebugPaper()
    globalPaper.value = paper.value
    loading.value = false
    return
  }
  try {
    const res = await TotoroApiWrapper.getSunRunPaper({
      token: session.value.token,
      campusId: session.value.campusId,
      schoolId: session.value.schoolId,
      stuNumber: session.value.stuNumber,
    })
    paper.value = res as typeof paper.value
    globalPaper.value = res as typeof paper.value
  } catch (e) {
    console.error('Failed to load sun run paper:', e)
  } finally {
    loading.value = false
  }
})
</script>