<template>
  <div>
    <v-alert v-if="!isLoggedIn" type="warning" variant="tonal" density="comfortable" class="mb-4">
      未建立会话 —— 回到 <NuxtLink to="/">工作台</NuxtLink> 填 token 并点「读取真实账号与任务」。
    </v-alert>

    <v-card class="mb-4" variant="tonal">
      <v-card-text class="d-flex align-center flex-wrap ga-3 py-2">
        <v-chip :color="realReady ? 'success' : demoMode ? 'accent' : 'warning'" size="small" variant="tonal">
          <v-icon start size="14">{{ realReady ? 'mdi-database-check-outline' : 'mdi-alert-outline' }}</v-icon>
          {{ realReady ? `真实任务：${activeTask?.paperName ?? ''}` : '未读取真实数据' }}
        </v-chip>
        <v-chip v-if="demoMode" color="accent" size="small" variant="tonal">
          <v-icon start size="14">mdi-flask-outline</v-icon>
          演示数据（不发任何请求）
        </v-chip>
        <v-spacer />
        <!-- 演示是「按需功能」：只在没有真实任务时提供一个入口，不再作为顶层模式 -->
        <v-btn v-if="!realReady" size="small" variant="text" prepend-icon="mdi-flask-outline" @click="doEnableDemo">
          载入演示数据
        </v-btn>
        <span v-if="realReady" class="text-caption text-medium-emphasis">
          学校：{{ realProfile?.schoolName ?? '—' }}（{{ realProfile?.schoolCode ?? '—' }}）
        </span>
      </v-card-text>
    </v-card>

    <v-row>
      <v-col cols="12" md="8">
        <v-card>
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            {{ activeTask?.paperName ?? '（未载入任务）' }}
            <v-chip size="small" variant="tonal" :color="statusColor">{{ statusText }}</v-chip>
            <v-spacer />
            <v-chip v-if="run.plan && run.status !== 'idle'" size="small" variant="tonal" color="info">
              本次计划 {{ run.plan.targetKm }} km · {{ formatDuration(run.plan.durationSeconds) }} ·
              {{ formatPace(run.paceSecPerKm) }}/km
            </v-chip>
          </v-card-title>
          <v-card-subtitle v-if="activeTask">
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
              item-title="title"
              item-value="value"
              label="线路（按校区自动分组，本校区优先）"
              density="comfortable"
              :disabled="isBusy"
              class="mb-2"
            />
            <!-- 跨校区提示：选了别的校区的线路（按坐标判定，不看名称） -->
            <v-alert v-if="crossCampusWarning" type="warning" variant="tonal" density="compact" class="mb-2">
              {{ crossCampusWarning }}
            </v-alert>
            <div v-if="routeGroups.clusters.length > 1" class="text-caption text-medium-emphasis mb-2">
              {{ routeGroups.note }}
            </div>
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
              <v-btn
                v-if="run.status === 'idle' || run.status === 'finished'"
                color="primary"
                block
                prepend-icon="mdi-play"
                :disabled="!activeTask"
                @click="start"
              >
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
            <v-alert v-if="!realReady && !demoMode" type="warning" variant="tonal" density="compact" class="mt-3">
              还没读到任务：回<NuxtLink to="/">工作台</NuxtLink>粘贴 token → 点「读取真实账号与任务」；
              或点上方「载入演示数据」只试界面与报文（不发请求）。
            </v-alert>
            <v-alert type="info" variant="tonal" density="compact" class="mt-3">
              位置推进用「模拟倍速」代替真实 GPS；轨迹、拟合度、里程/配速都是<b>真实算法</b>算出来的
              （{{ demoMode ? '演示 20m/点' : '真实 3m/点 ≈1Hz' }}）；
              里程会<b>略超</b>任务要求、配速<b>非整分钟</b>，拟合度含"GPS 精度下降期" → 数值不是整数（避免一眼假）。
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

        <!-- ===== 真实提交 ===== -->
        <v-divider class="my-3" />
        <div class="d-flex align-center flex-wrap ga-2 mb-2">
          <v-btn
            color="error"
            variant="flat"
            prepend-icon="mdi-cloud-upload-outline"
            :disabled="!realReady || run.status !== 'finished' || phase === 'waiting' || phase === 'submitting' || !gateStatus.allow"
            @click="confirmOpen = true"
          >
            真实提交
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

        <v-alert v-if="!realReady" type="info" variant="tonal" density="compact">
          尚未读取真实数据：先在<NuxtLink to="/">工作台</NuxtLink>粘贴 token 并点「读取真实账号与任务」。
          演示数据只能用于试界面与报文预览，<b>不会</b>真实提交。
        </v-alert>
        <v-alert v-else-if="!realReady" type="warning" variant="tonal" density="compact">
          真实数据未就绪：先在工作台读取真实账号与任务。
        </v-alert>
        <!-- ⛔ 开跑前门禁：三个否决项任一开启（或状态未知）→ 从源头阻止创建场次 -->
        <v-alert
          v-else-if="!gateStatus.allow"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-2"
        >
          <div class="font-weight-bold">已阻止真实提交（不会创建场次）</div>
          <div class="text-body-2">{{ gateStatus.reason }}</div>
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
            这会在你的账号上<b>真实生成一条成绩</b>（会计入本学期的跑步次数）。请确认下列数值无误。
          </v-alert>
          <v-list density="compact">
            <v-list-item title="线路" :subtitle="selectedLineName" prepend-icon="mdi-map-marker-path" />
            <v-list-item title="里程" :subtitle="`${run.result?.km.toFixed(2)} km（任务要求 ${activeTask?.mileage ?? '—'} km）`" prepend-icon="mdi-map-marker-distance" />
            <v-list-item title="时长 / 配速" :subtitle="`${formatDuration(run.result?.durationSeconds ?? 0)} · ${formatPace(Math.round((run.result?.durationSeconds ?? 1) / Math.max(0.01, run.result?.km ?? 1)))}/km`" prepend-icon="mdi-timer-outline" />
            <v-list-item title="拟合度" :subtitle="`${run.result?.fitDegree.toFixed(2)}（阈值 ${activeTask?.fitDegree ?? '—'}）`" prepend-icon="mdi-chart-bell-curve" />
            <v-list-item title="自检" :subtitle="run.result?.check.pass ? '硬性项全部通过' : '存在不通过项，建议先修正'" prepend-icon="mdi-clipboard-check-outline" />
            <v-list-item
              title="开跑前门禁（人脸 / 抽查 / 摄像头杆）"
              :subtitle="gateStatus.allow ? '三项均关闭或无阻碍，可开跑' : gateStatus.reason"
              prepend-icon="mdi-shield-check-outline"
            />
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
import { useMpDemo } from '~/composables/useMpDemo'
import { useMpReal } from '~/composables/useMpReal'
import { groupRoutesByCampus, toSelectItems, warnForSelection } from '~/utils/mp/routeGroups'

const { isLoggedIn, task, run, progress, paceText, start, pause, resume, finish, reset, demoMode, enableDemo } = useMpDemo()
const {
  profile: realProfile,
  task: realTask,
  status: realStatus,
  phase,
  phaseMessage,
  remainingSeconds,
  result,
  applyToRunner,
  submitRealRun,
  fetchVerdict,
  restoreTaskFromCache,
  persistSelectedLine,
  gateStatus,
} = useMpReal()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

const confirmOpen = ref(false)

const realReady = computed(() => realStatus.value === 'ready' && Boolean(realTask.value))
/** 当前生效的任务：真实任务优先，其次演示任务（默认都为空 = 未载入） */
const activeTask = computed(() => realTask.value ?? task.value)
/** 当前线路集（真实/演示任务都自带 runPointList） */
const activeLines = computed(() => activeTask.value?.runPointList ?? [])
const isBusy = computed(() => run.value.status === 'running' || run.value.status === 'paused')

/** 载入演示数据（按需功能，不发任何请求） */
const doEnableDemo = () => {
  enableDemo()
  showSnackbar('已载入演示数据（假数据，不发请求）', 'info')
}

const statusText = computed(() => ({ idle: '待开始', running: '跑步中', paused: '已暂停', finished: '已结算' })[run.value.status])
const statusColor = computed(() => ({ idle: 'info', running: 'success', paused: 'warning', finished: 'primary' })[run.value.status])
const phaseColor = computed(
  () => ({ idle: 'info', begin: 'info', waiting: 'info', submitting: 'warning', done: 'success', error: 'error' })[phase.value],
)

const fitClass = computed(() => {
  const threshold = Number(activeTask.value?.fitDegree ?? 0.6)
  if (run.value.fitDegree >= threshold) return 'text-success'
  return run.value.fitDegree > 0 ? 'text-warning' : ''
})

/** 线路下拉（真实/演示都由当前生效任务提供；按坐标校区分组，本校区优先） */
const routeGroups = computed(() => groupRoutesByCampus(activeLines.value, realProfile.value?.campusName))
const lineItems = computed(() => toSelectItems(routeGroups.value))
/** 选了其他校区线路时的提示（未跨校区为空串） */
const crossCampusWarning = computed(() => warnForSelection(routeGroups.value, run.value.lineId))
const selectedLineName = computed(() => activeLines.value.find((l) => l.pointId === run.value.lineId)?.pointName ?? '—')

// 线路集变化后校正选中项：
//   - 已选线路仍在新列表里 → **保持不动**（不覆盖用户选择，也不覆盖服务器/缓存给的默认）；
//   - 未选或已选线路消失 → 落到分组默认（本校区第一条）。
watch(
  () => routeGroups.value,
  (g) => {
    if (!g.ordered.length) return
    const stillValid = g.ordered.some((r) => String(r.line.pointId) === String(run.value.lineId))
    if (!stillValid && g.defaultLineId) run.value.lineId = g.defaultLineId
  },
  { immediate: true },
)

// 用户换线路 → 写回任务缓存（刷新页面后保持所选线路）
watch(
  () => run.value.lineId,
  (id) => {
    if (id) persistSelectedLine()
  },
)

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

/** 页面挂载：回填缓存任务；若已有真实会话则尝试注入真实数据 */
onMounted(() => {
  restoreTaskFromCache()
  applyToRunner()
})

/** 真实提交：确认后走 useMpReal 的完整流程（门禁 → 开跑 → 真实等待 → 提交 → 读判定） */
const doRealSubmit = async () => {
  confirmOpen.value = false
  // 门禁失守直接返回（不调 getRunBegin，避免创建场次后才发现被拦）
  if (!gateStatus.value.allow) {
    showSnackbar(gateStatus.value.reason || '当前不允许真实提交', 'error')
    return
  }
  const r = run.value.result
  const line = activeLines.value.find((l) => l.pointId === run.value.lineId)
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
