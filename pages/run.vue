<template>
  <div>
    <v-alert v-if="!isLoggedIn" type="warning" variant="tonal" density="comfortable" class="mb-4">
      未建立会话 —— 回到 <NuxtLink to="/">工作台</NuxtLink> 填 token 并「读取真实账号与任务」，或点「只用演示数据」。
    </v-alert>

    <v-card class="mb-4" variant="tonal">
      <v-card-text class="d-flex align-center flex-wrap ga-3 py-2">
        <v-btn-toggle v-model="mode" mandatory divided variant="outlined" density="comfortable">
          <v-btn value="demo" prepend-icon="mdi-flask-outline">演示模式</v-btn>
          <v-btn value="real" prepend-icon="mdi-cellphone-link">真实模式（南航）</v-btn>
        </v-btn-toggle>
        <v-chip v-if="mode === 'real'" :color="realReady ? 'success' : 'warning'" size="small" variant="tonal">
          <v-icon start size="14">{{ realReady ? 'mdi-database-check-outline' : 'mdi-alert-outline' }}</v-icon>
          {{ realReady ? `真实任务：${activeTask.paperName}` : '未读取真实数据（请回工作台）' }}
        </v-chip>
        <v-chip v-else color="accent" size="small" variant="tonal">
          <v-icon start size="14">mdi-flask-outline</v-icon>
          演示数据（不发任何请求）
        </v-chip>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">
          支持范围：仅{{ SUPPORTED_SCHOOL_NAME }}（{{ SUPPORTED_SCHOOL_CODE }}）
        </span>
      </v-card-text>
    </v-card>

    <v-row>
      <v-col cols="12" md="8">
        <v-card>
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            {{ activeTask.paperName }}
            <v-chip size="small" variant="tonal" :color="statusColor">{{ statusText }}</v-chip>
            <v-spacer />
            <v-chip v-if="run.plan && run.status !== 'idle'" size="small" variant="tonal" color="info">
              本次计划 {{ run.plan.targetKm }} km · {{ formatDuration(run.plan.durationSeconds) }} ·
              {{ formatPace(run.paceSecPerKm) }}/km
            </v-chip>
          </v-card-title>
          <v-card-subtitle>
            目标 {{ activeTask.mileage }} km · 拟合度阈值 {{ activeTask.fitDegree }} · 有效期 {{ formatTaskPeriod(activeTask) }}
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

            <v-progress-linear :model-value="progress * 100" height="10" rounded color="primary" class="mt-4" />
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
              label="配速策略（基线，实际会±3%浮动）"
              density="comfortable"
              :disabled="isBusy"
              class="mb-3"
            />

            <div class="d-flex flex-column ga-2">
              <v-btn v-if="run.status === 'idle' || run.status === 'finished'" color="primary" block prepend-icon="mdi-play" @click="start">
                开始跑步
              </v-btn>
              <v-btn v-if="run.status === 'running'" color="warning" block prepend-icon="mdi-pause" @click="pause">暂停</v-btn>
              <v-btn v-if="run.status === 'paused'" color="primary" block prepend-icon="mdi-play" @click="resume">继续</v-btn>
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
              <v-btn v-if="run.status !== 'idle'" variant="text" block prepend-icon="mdi-refresh" @click="reset">重置</v-btn>
            </div>

            <v-alert v-if="run.error" type="error" variant="tonal" density="compact" class="mt-3">{{ run.error }}</v-alert>
            <v-alert v-if="mode === 'real' && !realReady" type="warning" variant="tonal" density="compact" class="mt-3">
              真实模式还没读到任务：回<NuxtLink to="/">工作台</NuxtLink>粘贴 token → 点「读取真实账号与任务」。
            </v-alert>
            <v-alert type="info" variant="tonal" density="compact" class="mt-3">
              位置推进用「模拟倍速」代替真实 GPS；轨迹、拟合度、里程/配速都是<b>真实算法</b>算出来的
              （{{ mode === 'real' ? '真实模式 3m/点 ≈1Hz' : '演示 20m/点' }}）；
              里程会**略超**任务要求、配速**非整分钟**，拟合度含"GPS 精度下降期" → 数值不是整数（避免一眼假）。
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
        <div class="text-caption text-medium-emphasis mb-3">
          口径说明：<b>硬性</b> = 本地能确定判的（参与预判）；<b>待实测</b> = 单位/语义尚未验证的项，只提示、<b>不阻断</b>。
          步数提交值 <code>"{{ run.result.stepsSubmitted }}"</code>（照实测真包口径）。
        </div>

        <!-- ===== 真实提交（仅南航；真实模式） ===== -->
        <v-divider class="my-3" />
        <div class="d-flex align-center flex-wrap ga-2 mb-2">
          <v-btn
            color="error"
            variant="flat"
            prepend-icon="mdi-cloud-upload-outline"
            :disabled="mode !== 'real' || !realReady || run.status !== 'finished' || phase === 'waiting' || phase === 'submitting'"
            @click="confirmOpen = true"
          >
            真实提交（南航）
          </v-btn>
          <v-btn
            v-if="result?.scantronId"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-clipboard-check-outline"
            @click="fetchVerdict()"
          >
            查询判定
          </v-btn>
          <v-chip v-if="phase !== 'idle'" size="small" variant="tonal" :color="phaseColor">{{ phaseMessage }}</v-chip>
        </div>

        <v-alert v-if="mode !== 'real'" type="info" variant="tonal" density="compact">
          当前是演示模式：只生成报文预览，<b>不会真提交</b>。要真提交请切到「真实模式」并先在工作台读取真实任务。
        </v-alert>
        <v-alert v-else-if="!realReady" type="warning" variant="tonal" density="compact">
          真实模式未就绪：先在工作台读取真实账号与任务。
        </v-alert>

        <v-alert v-if="phase === 'waiting'" type="info" variant="tonal" class="mt-2">
          <div class="d-flex align-center ga-3">
            <v-progress-circular indeterminate size="22" />
            <div>
              <div class="font-weight-bold">正在真实等待：还剩 {{ formatDuration(remainingSeconds) }}</div>
              <div class="text-caption">
                为保证 <code>endTime - startTime</code> 与服务器观测一致（避免"秒级完成长距离"的破绽），
                提交前必须真等够报备时长。可以切到别的页面，倒计时会继续。
              </div>
            </div>
          </div>
        </v-alert>

        <v-alert
          v-if="result"
          :type="result.scoreOk ? 'success' : 'error'"
          variant="tonal"
          class="mt-2"
        >
          <div class="font-weight-bold">提交结果：{{ result.scoreMessage }}</div>
          <div class="text-caption">
            scantronId={{ result.scantronId }} ·
            轨迹：{{ result.detailOk === undefined ? '未提交（成绩未成功，按源码不发）' : result.detailOk ? '已提交' : '失败：' + result.detailMessage }}
          </div>
          <div v-if="result.verdictText" class="text-body-2 mt-1">★ 判定：{{ result.verdictText }}</div>
        </v-alert>

        <v-expansion-panels variant="accordion" class="mt-3">
          <v-expansion-panel title="sunRunExercises 提交报文（18 字段）">
            <v-expansion-panel-text>
              <div class="d-flex justify-end mb-1">
                <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy(run.result.scoreRequest)">复制</v-btn>
              </div>
              <pre class="json-box">{{ pretty(run.result.scoreRequest) }}</pre>
            </v-expansion-panel-text>
          </v-expansion-panel>
          <v-expansion-panel title="sunRunExercisesDetail 轨迹报文">
            <v-expansion-panel-text>
              <div class="text-caption text-medium-emphasis mb-1">
                共 {{ run.result.detailRequest.pointList.length }} 个轨迹点（此处只预览前 3 个）
              </div>
              <pre class="json-box">{{ pretty(detailPreview) }}</pre>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>
    </v-card>

    <!-- 真实提交确认框 -->
    <v-dialog v-model="confirmOpen" max-width="620">
      <v-card>
        <v-card-title class="d-flex align-center">
          <v-icon color="error" class="mr-2">mdi-alert-outline</v-icon>
          确认真实提交？
        </v-card-title>
        <v-card-text>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            这会在你的账号上**真实生成一条成绩**（会计入本学期的跑步次数）。请确认下列数值无误。
          </v-alert>
          <v-list density="compact">
            <v-list-item title="线路" :subtitle="selectedLineName" prepend-icon="mdi-map-marker-path" />
            <v-list-item title="里程" :subtitle="`${run.result?.km.toFixed(2)} km（任务要求 ${activeTask.mileage} km）`" prepend-icon="mdi-map-marker-distance" />
            <v-list-item title="时长 / 配速" :subtitle="`${formatDuration(run.result?.durationSeconds ?? 0)} · ${formatPace(Math.round((run.result?.durationSeconds ?? 1) / Math.max(0.01, run.result?.km ?? 1)))}/km`" prepend-icon="mdi-timer-outline" />
            <v-list-item title="拟合度" :subtitle="`${run.result?.fitDegree.toFixed(2)}（阈值 ${activeTask.fitDegree}）`" prepend-icon="mdi-chart-bell-curve" />
            <v-list-item title="自检" :subtitle="run.result?.check.pass ? '硬性项全部通过' : '存在不通过项，建议先修正'" prepend-icon="mdi-clipboard-check-outline" />
            <v-list-item
              title="提交前需真实等待"
              :subtitle="`${formatDuration(run.result?.durationSeconds ?? 0)}（保证时间线一致）`"
              prepend-icon="mdi-timer-sand"
            />
          </v-list>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">取消</v-btn>
          <v-btn color="error" variant="flat" prepend-icon="mdi-cloud-upload-outline" @click="doRealSubmit">确认提交</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { formatTaskPeriod } from '~/utils/mp/taskRules'
import { formatDuration, formatPace } from '~/utils/mp/runData'
import { DEMO_STEP_M, useMpDemo } from '~/composables/useMpDemo'
import { SUPPORTED_SCHOOL_CODE, SUPPORTED_SCHOOL_NAME, useMpReal } from '~/composables/useMpReal'

const { isLoggedIn, task, lines, run, progress, paceText, start, pause, resume, finish, reset } = useMpDemo()
const {
  task: realTask,
  realLines,
  status: realStatus,
  phase,
  phaseMessage,
  remainingSeconds,
  result,
  loadRealData,
  applyToRunner,
  submitRealRun,
  fetchVerdict,
  restoreTaskFromCache,
} = useMpReal()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

const mode = ref<'demo' | 'real'>('demo')
const confirmOpen = ref(false)

const realReady = computed(() => realStatus.value === 'ready' && Boolean(realTask.value))
const activeTask = computed(() => (mode.value === 'real' && realTask.value ? realTask.value : task.value))
const isBusy = computed(() => run.value.status === 'running' || run.value.status === 'paused')

const statusText = computed(() => ({ idle: '待开始', running: '跑步中', paused: '已暂停', finished: '已结算' })[run.value.status])
const statusColor = computed(() => ({ idle: 'info', running: 'success', paused: 'warning', finished: 'primary' })[run.value.status])
const phaseColor = computed(
  () => ({ idle: 'info', begin: 'info', waiting: 'info', submitting: 'warning', done: 'success', error: 'error' })[phase.value],
)

const fitClass = computed(() => {
  const threshold = Number(activeTask.value.fitDegree ?? 0.6)
  if (run.value.fitDegree >= threshold) return 'text-success'
  return run.value.fitDegree > 0 ? 'text-warning' : ''
})

/** 线路下拉：真实模式用真实线路，演示模式用演示线路 */
const lineItems = computed(() =>
  (mode.value === 'real' ? realLines.value : lines.value).map((line) => ({
    value: line.pointId,
    label: `${line.pointName}（${line.pointList?.length ?? 0} 点）`,
  })),
)
const selectedLineName = computed(() => {
  const list = mode.value === 'real' ? realLines.value : lines.value
  return list.find((l) => l.pointId === run.value.lineId)?.pointName ?? '—'
})

const speedItems = [
  { value: 1, label: '1× 实时（3.4km 约 21 分钟）' },
  { value: 10, label: '10×（约 2 分钟）' },
  { value: 60, label: '60×（约 21 秒）' },
  { value: 600, label: '600×（约 2 秒，看结果用）' },
]
/** 配速策略（真实学生的常见区间；实际会 ±3% 浮动并夹紧到任务窗口） */
const paceItems = [
  { value: 330, label: `5'30" /km（较快）` },
  { value: 360, label: `6'00" /km（常规）` },
  { value: 390, label: `6'30" /km（轻松）` },
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

const confidenceText = (value: string) => ({ hard: '硬性', inferred: '待实测', info: '仅展示' })[value] ?? value
const confidenceColor = (value: string) => ({ hard: 'success', inferred: 'warning', info: 'info' })[value] ?? 'info'

/** 切到真实模式时，把真实任务/线路注入跑步机；未就绪则尝试加载 */
const onModeChange = async (next: 'demo' | 'real') => {
  if (next !== 'real') return
  applyToRunner()
  if (!realTask.value && isLoggedIn.value) await loadRealData()
  applyToRunner()
}

watch(mode, (next) => void onModeChange(next))

onMounted(() => {
  restoreTaskFromCache()
  applyToRunner()
})

/** 真实提交：确认后走 useMpReal 的完整流程（开跑 → 真实等待 → 提交 → 读判定） */
const doRealSubmit = async () => {
  confirmOpen.value = false
  const r = run.value.result
  const line = (mode.value === 'real' ? realLines.value : lines.value).find((l) => l.pointId === run.value.lineId)
  if (!r || !line) {
    showSnackbar('缺少线路或结算数据', 'error')
    return
  }
  const out = await submitRealRun({
    line,
    points: run.value.points,
    km: r.km,
    fitDegree: r.fitDegree,
    plannedSeconds: r.durationSeconds,
  })
  if (out?.scoreOk) {
    showSnackbar('真实提交成功，正在读判定…', 'success')
    await fetchVerdict(out.scantronId)
  } else if (out) {
    showSnackbar(`真实提交失败：${out.scoreMessage}`, 'error')
  } else {
    showSnackbar(phaseMessage.value || '真实提交未完成', 'error')
  }
}
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
