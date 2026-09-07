<template>
  <div>
    <v-row>
      <v-col cols="12" md="7">
        <v-card class="pa-4">
          <v-card-title class="d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            自由跑
          </v-card-title>
          <v-card-subtitle>自定义您的跑步距离和速度，系统将自动生成真实的跑步数据。</v-card-subtitle>

          <v-card-text>
            <!-- 预置 -->
            <div class="text-subtitle-2 mb-1">选择预置</div>
            <v-chip-group v-model="preset" mandatory>
              <v-chip v-for="item in presets" :key="item.key" :value="item.key" filter>
                {{ item.name }}
              </v-chip>
            </v-chip-group>
            <v-alert v-if="activePreset" type="info" variant="tonal" density="compact" class="mt-2 mb-3">
              {{ activePreset.desc }}
            </v-alert>

            <v-divider class="my-3" />

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
                <v-text-field v-model.number="targetMinutes" label="目标时间 (分钟)" type="number" min="1" max="240" step="1" suffix="分钟" />
              </v-col>
            </v-row>
            <v-alert v-if="paceError" type="error" variant="tonal" density="compact" class="mb-3">
              {{ paceError }}
            </v-alert>

            <v-expansion-panels>
              <v-expansion-panel>
                <v-expansion-panel-title>
                  <v-icon class="mr-2">mdi-tune</v-icon>
                  高级设置（模拟数据随机扰动）
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <v-row>
                    <v-col cols="12" md="4">
                      <v-text-field v-model.number="varyDistancePct" label="距离变化 ±%" type="number" min="0" max="50" step="1" />
                    </v-col>
                    <v-col cols="12" md="4">
                      <v-text-field v-model.number="varySpeedKmh" label="速度变化 ±km/h" type="number" min="0" max="10" step="0.5" />
                    </v-col>
                    <v-col cols="12" md="4">
                      <v-text-field v-model.number="varyTimeMin" label="时间变化 ±分钟" type="number" min="0" max="60" step="1" />
                    </v-col>
                  </v-row>
                  <p class="text-caption text-medium-emphasis">
                    为了模拟真实跑步的变化，每次提交时参数将按上述范围随机变化。
                  </p>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </v-card-text>

          <v-card-actions>
            <v-btn color="primary" :append-icon="'mdi-send'" :loading="running" size="large" @click="startFreeRun">
              开始自由跑
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
          <v-card-subtitle>多次自由跑，系统将自动为每次生成不同的参数，模拟真实的跑步变化。</v-card-subtitle>

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
            <v-btn color="accent" :append-icon="'mdi-play'" :loading="running" :disabled="!isLoggedIn" @click="startBatch">
              开始批量执行
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

definePageMeta({ title: '自由跑' })

const { session, isLoggedIn } = useSession()

const gauss = (min: number, max: number) => min + Math.random() * (max - min)

const distance = ref(2.5)
const speed = ref(10)
const targetMinutes = ref(15)
const paceMode = ref<'speed' | 'time'>('speed')

const preset = ref('standard')
const presets = [
  { key: 'easy', name: '轻松跑', speed: 7, desc: '轻松锻炼，轻松完成的跑步' },
  { key: 'standard', name: '标准跑', speed: 10, desc: '标准强度的跑步练习，适合提升体能' },
  { key: 'challenge', name: '挑战跑', speed: 14, desc: '高强度的跑步练习，挑战你的极限' },
]
const activePreset = computed(() => presets.find((p) => p.key === preset.value))

const varyDistancePct = ref(10)
const varySpeedKmh = ref(1.5)
const varyTimeMin = ref(2)

const batchCount = ref(3)
const batchInterval = ref(10)

const running = ref(false)
const progress = ref<{ index: number; status: 'wait' | 'success' | 'failed'; recordId?: string; error?: string }[]>([])
const pendingData = ref<FreeRunData[]>([])

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
  if (paceMode.value === 'time' && (!targetMinutes.value || targetMinutes.value <= 0)) {
    return '时间必须大于 0'
  }
  return ''
})

const batchTimeHint = computed(() => {
  const totalMin = batchCount.value * (targetMinutes.value || 15) + batchCount.value * batchInterval.value
  if (totalMin > 6 * 60) return `批量总时间将超过 ${Math.round(totalMin / 60)} 小时，考虑减少次数或缩短间隔时间`
  return ''
})

function buildSingle(runIdxOffset = 0, presetSpeed?: number): FreeRunData {
  const startMs = Date.now() + runIdxOffset * 1000
  const baseSpeed = presetSpeed ?? (paceMode.value === 'speed' ? speed.value : distance.value / ((targetMinutes.value || 15) / 60))

  // 随机扰动：速度、距离、时间
  const s = baseSpeed + gauss(-varySpeedKmh.value, varySpeedKmh.value)
  const dist = distance.value * (1 + gauss(-varyDistancePct.value / 100, varyDistancePct.value / 100))
  let duration = (dist / (Math.max(3, Math.min(25, s)) / 3600)) + gauss(-varyTimeMin.value * 60, varyTimeMin.value * 60)
  duration = Math.max(60, Math.round(duration))
  const avgSpeed = +(dist / (duration / 3600)).toFixed(2)

  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(startMs + duration * 1000).toISOString(),
    duration,
    distance: +dist.toFixed(2),
    avgSpeed,
    steps: 1000 + Math.floor(Math.random() * 800),
    stuNumber: session.value!.stuNumber as string,
    token: session.value!.token as string,
  }
}

async function submitOne(data: FreeRunData): Promise<{ recordId?: string; error?: string }> {
  try {
    const res = await TotoroApiWrapper.submitFreeRun(data)
    const recordId = (res.data as { recordId?: string } | undefined)?.recordId
    return recordId ? { recordId } : { error: 'No data returned from server' }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

async function runList(dataList: FreeRunData[]) {
  const concurrency = 2
  const results = Array.from({ length: dataList.length }, (_, i) => ({ index: i, status: 'wait' as const }))
  progress.value = results
  pendingData.value = dataList

  for (let i = 0; i < dataList.length; i += concurrency) {
    const chunk = dataList.slice(i, i + concurrency)
    await Promise.all(
      chunk.map(async (data, idx) => {
        const gi = i + idx
        const r = await submitOne(data)
        if (r.recordId) {
          progress.value[gi] = { index: gi, status: 'success', recordId: r.recordId }
        } else {
          progress.value[gi] = { index: gi, status: 'failed', error: r.error }
        }
      }),
    )
  }
}

async function startFreeRun() {
  if (distanceError.value || paceError.value) return
  running.value = true
  try {
    const list = [buildSingle(1)]
    await runList(list)
  } finally {
    running.value = false
  }
}

async function startBatch() {
  if (batchCount.value < 1 || batchCount.value > 10) return
  if (distanceError.value || paceError.value) return
  running.value = true
  progress.value = []
  try {
    const presetSpeed = activePreset.value?.speed
    const list: FreeRunData[] = []
    for (let i = 0; i < batchCount.value; i++) {
      list.push(buildSingle(i * batchInterval.value * 60, presetSpeed))
    }
    await runList(list)
  } finally {
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
</script>