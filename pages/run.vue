<template>
  <div>
    <v-alert v-if="!isLoggedIn" type="warning" variant="tonal" density="comfortable" class="mb-4">
      未建立会话 —— 回到 <NuxtLink to="/">工作台</NuxtLink> 点「演示登录」。
    </v-alert>

    <v-row>
      <v-col cols="12" md="8">
        <v-card>
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            {{ task.paperName }}
            <v-chip size="small" variant="tonal" :color="statusColor">{{ statusText }}</v-chip>
            <v-spacer />
            <v-chip size="small" variant="tonal" color="accent">演示模式 · 不发请求</v-chip>
          </v-card-title>
          <v-card-subtitle>
            目标 {{ task.mileage }} km · 拟合度阈值 {{ task.fitDegree }} · 有效期 {{ formatTaskPeriod(task) }}
          </v-card-subtitle>
          <v-card-text>
            <v-row dense>
              <v-col cols="6" sm="3">
                <div class="text-caption text-medium-emphasis">已跑里程</div>
                <div class="text-h5 font-weight-bold">{{ (run.distanceM / 1000).toFixed(2) }}<span class="text-body-2"> km</span></div>
              </v-col>
              <v-col cols="6" sm="3">
                <div class="text-caption text-medium-emphasis">已用时长</div>
                <div class="text-h5 font-weight-bold">{{ formatDuration(run.elapsedS) }}</div>
              </v-col>
              <v-col cols="6" sm="3">
                <div class="text-caption text-medium-emphasis">平均配速</div>
                <div class="text-h5 font-weight-bold">{{ paceText }}</div>
              </v-col>
              <v-col cols="6" sm="3">
                <div class="text-caption text-medium-emphasis">拟合度（自算）</div>
                <div class="text-h5 font-weight-bold" :class="fitClass">{{ run.fitDegree.toFixed(2) }}</div>
              </v-col>
            </v-row>

            <v-progress-linear
              :model-value="progress * 100"
              height="10"
              rounded
              color="primary"
              class="mt-4"
            />
            <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
              <span>{{ (progress * 100).toFixed(1) }}% / 目标 {{ run.targetKm }} km</span>
              <span>轨迹点 {{ run.visibleCount }} / {{ run.points.length }}</span>
            </div>

            <v-row dense class="mt-4">
              <v-col cols="4">
                <v-card variant="tonal" color="info">
                  <v-card-text class="text-center py-2">
                    <div class="text-caption">应过点</div>
                    <div class="text-h6">{{ run.passPoints.all }}</div>
                  </v-card-text>
                </v-card>
              </v-col>
              <v-col cols="4">
                <v-card variant="tonal" color="success">
                  <v-card-text class="text-center py-2">
                    <div class="text-caption">已过点</div>
                    <div class="text-h6">{{ run.passPoints.done }}</div>
                  </v-card-text>
                </v-card>
              </v-col>
              <v-col cols="4">
                <v-card variant="tonal" color="warning">
                  <v-card-text class="text-center py-2">
                    <div class="text-caption">未过点</div>
                    <div class="text-h6">{{ run.passPoints.notPassed }}</div>
                  </v-card-text>
                </v-card>
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1">开跑设置</v-card-title>
          <v-card-text>
            <v-btn-toggle v-model="run.runType" mandatory divided variant="outlined" class="mb-3" :disabled="isBusy">
              <v-btn :value="0" prepend-icon="mdi-white-balance-sunny">阳光跑</v-btn>
              <v-btn :value="1" prepend-icon="mdi-run">自由跑</v-btn>
            </v-btn-toggle>

            <v-select
              v-model="run.lineId"
              :items="lineItems"
              item-title="label"
              item-value="value"
              label="线路"
              density="comfortable"
              :disabled="isBusy"
              class="mb-2"
            />
            <v-select
              v-model="run.speed"
              :items="speedItems"
              item-title="label"
              item-value="value"
              label="模拟倍速（演示用）"
              density="comfortable"
              :disabled="run.status === 'running'"
              class="mb-2"
            />
            <v-select
              v-model="run.paceSecPerKm"
              :items="paceItems"
              item-title="label"
              item-value="value"
              label="目标配速"
              density="comfortable"
              :disabled="isBusy"
              class="mb-3"
            />

            <div class="d-flex flex-column ga-2">
              <v-btn
                v-if="run.status === 'idle' || run.status === 'finished'"
                color="primary"
                block
                prepend-icon="mdi-play"
                @click="start"
              >
                开始跑步
              </v-btn>
              <v-btn v-if="run.status === 'running'" color="warning" block prepend-icon="mdi-pause" @click="pause">
                暂停
              </v-btn>
              <v-btn v-if="run.status === 'paused'" color="primary" block prepend-icon="mdi-play" @click="resume">
                继续
              </v-btn>
              <v-btn
                v-if="run.status === 'running' || run.status === 'paused'"
                color="error"
                block
                variant="tonal"
                prepend-icon="mdi-flag-checkered"
                @click="finish"
              >
                结束并结算
              </v-btn>
              <v-btn v-if="run.status !== 'idle'" variant="text" block prepend-icon="mdi-refresh" @click="reset">
                重置
              </v-btn>
            </div>

            <v-alert v-if="run.error" type="error" variant="tonal" density="compact" class="mt-3">
              {{ run.error }}
            </v-alert>
            <v-alert type="info" variant="tonal" density="compact" class="mt-3">
              位置推进用「模拟倍速」代替真实 GPS；轨迹、拟合度、里程/配速都是<b>真实算法</b>算出来的
              （采样 {{ DEMO_STEP_M }}m/点，真实提交建议 2m）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-card v-if="run.result" class="mt-4">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon :color="run.result.check.pass ? 'success' : 'error'" class="mr-2">
          {{ run.result.check.pass ? 'mdi-check-decagram' : 'mdi-alert-circle-outline' }}
        </v-icon>
        结算（本地预判）
        <v-chip :color="run.result.check.pass ? 'success' : 'error'" variant="flat" size="small">
          {{ run.result.check.pass ? '预计合格' : '预计不合格' }}
        </v-chip>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">
          {{ run.result.km.toFixed(2) }} km · {{ formatDuration(run.result.durationSeconds) }} ·
          拟合度 {{ run.result.fitDegree.toFixed(2) }}
        </span>
      </v-card-title>
      <v-card-text>
        <v-table density="compact" class="mb-3">
          <thead>
            <tr>
              <th style="width: 140px">校验项</th>
              <th>实际情况</th>
              <th style="width: 90px">结论</th>
              <th style="width: 90px">口径</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in run.result.check.items" :key="item.key">
              <td>{{ item.label }}</td>
              <td class="text-body-2">{{ item.detail }}</td>
              <td>
                <v-icon v-if="item.ok === true" color="success" size="18">mdi-check</v-icon>
                <v-icon v-else-if="item.ok === false" :color="item.confidence === 'hard' ? 'error' : 'warning'" size="18">
                  {{ item.confidence === 'hard' ? 'mdi-close' : 'mdi-alert-outline' }}
                </v-icon>
                <v-icon v-else color="warning" size="18">mdi-help</v-icon>
              </td>
              <td>
                <v-chip size="x-small" variant="tonal" :color="confidenceColor(item.confidence)">
                  {{ confidenceText(item.confidence) }}
                </v-chip>
              </td>
            </tr>
          </tbody>
        </v-table>
        <div v-if="run.result.check.problems.length" class="text-body-2 text-error mb-2">
          硬性不通过：{{ run.result.check.problems.join('；') }}
        </div>
        <div v-if="run.result.statsProblems.length" class="text-body-2 text-warning mb-2">
          自洽校验告警：{{ run.result.statsProblems.join('；') }}
        </div>
        <div class="text-body-2 text-medium-emphasis mb-3">
          步数：提交值 <code>"{{ run.result.stepsSubmitted }}"</code>（照抄实测真包口径 —— 源码全工程无赋值）；
          本地估算 {{ run.result.estimatedSteps }} 步（备选口径，待确认服务端是否强校验）。
        </div>
        <div class="text-caption text-medium-emphasis mb-3">
          口径说明：<b>硬性</b> = 本地能确定判的（参与预判）；<b>待实测</b> = 单位/语义尚未验证
          （配速、时长、生效时段），只提示、<b>不阻断</b> —— 9-14 拿到真实约束后按实测校准。
        </div>

        <v-expansion-panels variant="accordion">
          <v-expansion-panel title="sunRunExercises 提交报文（18 字段）">
            <v-expansion-panel-text>
              <div class="d-flex justify-end mb-1">
                <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy(run.result.scoreRequest)">
                  复制
                </v-btn>
              </div>
              <pre class="json-box">{{ pretty(run.result.scoreRequest) }}</pre>
            </v-expansion-panel-text>
          </v-expansion-panel>
          <v-expansion-panel title="sunRunExercisesDetail 轨迹报文">
            <v-expansion-panel-text>
              <div class="d-flex justify-end mb-1">
                <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy(run.result.detailRequest)">
                  复制
                </v-btn>
              </div>
              <div class="text-caption text-medium-emphasis mb-1">
                共 {{ run.result.detailRequest.pointList.length }} 个轨迹点（此处只预览前 3 个）
              </div>
              <pre class="json-box">{{ pretty(detailPreview) }}</pre>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <v-btn class="mt-3" color="secondary" variant="tonal" prepend-icon="mdi-format-list-bulleted" to="/records">
          去记录页看这条成绩
        </v-btn>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { DEMO_LINES } from '~/src/mp/demo'
import { formatDuration } from '~/utils/mp/runData'
import { formatTaskPeriod } from '~/utils/mp/taskRules'
import { DEMO_STEP_M, useMpDemo } from '~/composables/useMpDemo'

const { isLoggedIn, task, run, progress, paceText, start, pause, resume, finish, reset } = useMpDemo()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

const isBusy = computed(() => run.value.status === 'running' || run.value.status === 'paused')

const statusText = computed(
  () =>
    ({ idle: '待开始', running: '跑步中', paused: '已暂停', finished: '已结算' })[run.value.status],
)
const statusColor = computed(
  () => ({ idle: 'info', running: 'success', paused: 'warning', finished: 'primary' })[run.value.status],
)

const fitClass = computed(() => {
  const threshold = Number(task.value.fitDegree ?? 0.6)
  if (run.value.fitDegree >= threshold) return 'text-success'
  return run.value.fitDegree > 0 ? 'text-warning' : ''
})

const lineItems = DEMO_LINES.map((line) => ({ value: line.pointId, label: line.pointName }))
const speedItems = [
  { value: 1, label: '1× 实时（3km 约 16 分钟）' },
  { value: 10, label: '10×（约 100 秒）' },
  { value: 60, label: '60×（约 17 秒）' },
  { value: 600, label: '600×（约 2 秒，看结果用）' },
]
const paceItems = [
  { value: 270, label: `4'30" /km` },
  { value: 300, label: `5'00" /km` },
  { value: 330, label: `5'30" /km` },
  { value: 360, label: `6'00" /km` },
]

const detailPreview = computed(() => {
  const detail = run.value.result?.detailRequest
  if (!detail) return null
  return { ...detail, pointList: detail.pointList.slice(0, 3) }
})

const pretty = (value: unknown) => JSON.stringify(value, null, 2)

const copy = async (value: unknown) => {
  try {
    await navigator.clipboard.writeText(pretty(value))
    showSnackbar('已复制到剪贴板', 'success')
  } catch {
    showSnackbar('复制失败（浏览器未授权剪贴板）', 'warning')
  }
}

const confidenceText = (value: string) =>
  ({ hard: '硬性', inferred: '待实测', info: '仅展示' })[value] ?? value
const confidenceColor = (value: string) =>
  ({ hard: 'success', inferred: 'warning', info: 'info' })[value] ?? 'info'

// 说明：离开本页不停表 —— 跑步在后台继续（到里程自动结算并写入记录），与真实跑步一致。
</script>

<style scoped>
.json-box {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: #101418;
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
