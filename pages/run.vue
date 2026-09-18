<template>
  <div>
    <RunGateNotice :gate-status="gateStatus" :is-logged-in="isLoggedIn" />

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
        <RunMetricsCard
          :active-task="activeTask"
          :run="run"
          :status-text="statusText"
          :status-color="statusColor"
          :pace-text="paceText"
          :fit-class="fitClass"
          :progress="progress"
        />
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
                :disabled="!activeTask || !libEntries.length || !activeLines.length"
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
      <!-- 路线来源（2026-09-18 收紧）：**只列你描好的路线**，并以它的几何为基准生成轨迹 -->
      <v-alert v-if="hasConfigured" type="success" variant="tonal" density="compact" class="mt-3">
        只列出你在「跑道编辑」里配置好的 <b>{{ libEntries.length }}</b> 条路线 —— 轨迹以<b>你描的真跑道</b>为基准生成；
        官方模板只作对照（提交时服务端的拟合度仍按官方模板算）。
      </v-alert>
      <v-alert v-else-if="activeLinesRaw.length" type="warning" variant="tonal" density="compact" class="mt-3">
        <div class="font-weight-bold">还没有可用的跑道：请先描一条。</div>
        <div class="text-body-2 mt-1">
          本版<b>只会用你自己描的跑道</b>生成轨迹（官方模板偏差十几米，不再作为生成基准）。
          去「<b>跑道编辑</b>」选一条线路 → 「快速定位」→ 沿卫星图描外圈 → 「按外圈自动生成内圈」→ 保存（本机）。
          保存后回到本页，这条线路就会出现在下面的下拉框里。
        </div>
        <div class="mt-2">
          <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-vector-polyline" to="/track-editor">
            去「跑道编辑」描一条
          </v-btn>
        </div>
      </v-alert>

      <v-alert v-if="!realReady && !demoMode" type="warning" variant="tonal" density="compact" class="mt-3">
              还没读到任务：回<NuxtLink to="/">工作台</NuxtLink>粘贴 token → 点「读取真实账号与任务」；
              或点上方「载入演示数据」只试界面与报文（不发请求）。
              <!-- 刷新后默认不自动恢复缓存，这里给显式入口 -->
              <div v-if="hasCachedTask" class="d-flex flex-wrap ga-2 mt-2">
                <v-btn size="small" variant="tonal" prepend-icon="mdi-history" @click="doRestoreCached">
                  恢复上次任务{{ cachedTaskLabel ? `（${cachedTaskLabel}）` : '' }}
                </v-btn>
              </div>
            </v-alert>
            <v-alert type="info" variant="tonal" density="compact" class="mt-3">
              位置推进用「模拟倍速」代替真实 GPS；轨迹、拟合度、里程/配速都是<b>真实算法</b>算出来的
              （{{ demoMode ? '演示 20m/点' : '真实 3m/点 ≈1Hz' }}）；
              里程会<b>略超</b>任务要求、配速<b>非整分钟</b>，拟合度含"GPS 精度下降期" → 数值不是整数（避免一眼假）。
            </v-alert>
            <!-- 用户要求（2026-09-15）：把"模拟配速"的性质说清楚，避免误以为它本身就是最终结果 -->
            <v-alert type="warning" variant="tonal" density="compact" class="mt-2">
              <b>「模拟倍速 / 配速策略」不是最终结果</b> —— 它们只决定<b>本地如何生成这次的轨迹数据</b>
              （里程/时长/配速/拟合度都按任务约束算出来）。
              正确顺序是：<b>先「开始跑步」生成并结算出数据</b> → 看下方自检表 → 再点「<b>真实提交</b>」。
              提交的数值就是自检表里那一组（提交前还会再按报备时长真实等待）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <RunSelfCheckCard :run="run">
      <!-- ⚠️ 本段是<b>插槽内容</b>：它必须与自检表处在<b>同一张卡</b>里 ——
           拆分前「结算表 + 真实提交」就是一张卡、一个 v-card-text；
           先前拆成两张卡会多出一层边框与间距（已由结构对照脚本抓出并修正）。 -->
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

      <!-- 未读到真实任务时的提示（演示模式不算——它本来就不是真实数据） -->
      <v-alert v-if="!realReady && !demoMode" type="info" variant="tonal" density="compact">
        尚未读取真实数据：先在<NuxtLink to="/">工作台</NuxtLink>粘贴 token 并点「读取真实账号与任务」。
        演示数据只能用于试界面与报文预览，<b>不会</b>真实提交。
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
        <div v-if="cameraFlagError" class="text-caption mt-1">读取异常：{{ cameraFlagError }}</div>
        <!-- 线路开关读取失败/切换线路后未重查 → 给一个显式重试入口（不必刷新页面） -->
        <v-btn
          v-if="gateStatus.blockedBy === 'camera_unknown'"
          size="small"
          variant="tonal"
          class="mt-2"
          prepend-icon="mdi-refresh"
          @click="retryCameraFlag()"
        >
          重新读取该线路的开关
        </v-btn>
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
            <!-- 用户要求：等待期间明确提醒三条 -->
            <div class="text-body-2 mt-2 font-weight-bold">
              ⛔ 等待期间请勿在<b>任意端</b>登录「龙猫」相关账号；🚫 请勿关闭此网页/程序；⏳ 请等到倒计时结束。
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

      <RunPayloadPreview :run="run" />
    </RunSelfCheckCard>

    <!-- 轨迹预览（矢量、离线）：看"有没有贴着官方路线走 / 有没有跑在自己描的跑道两圈之间"
         —— 1.1.9 起把**本机路线库的内外圈 + 所选车道线**一起画出来（几何与真实提交同源）
         —— 并按"一圈多长"把轨迹**拆成每圈一色**（多圈同色会糊成一条粗带，用户反馈过）
         ⚠️ `:lapLengthM` **必须用 camelCase 绑定**（不要写 :lap-length）：
            Vue 解析 prop 时走 `camelize(属性名)`，而 `camelize('lap-length')` = `lapLength`
            ≠ 组件声明的 `lapLengthM`（**末尾那个大写 M 丢失**）⇒ 该 prop 被**静默丢弃**（=undefined）；
            **dev 与生产都会丢**（dev 只是额外给一条 warning）。详见 ERROR.md E48。 -->
    <RunTrajectoryPreview
      :points="run.points"
      :route="selectedLine?.pointList ?? []"
      :fit-degree="run.fitDegree"
      :track-entries="libEntries"
      :line-id="run.lineId"
      :lapLengthM="run.lapLengthM"
      :lapDriftM="run.lapDriftM"
    />

    <!-- 真实提交确认框 -->
    <v-dialog v-model="confirmOpen" max-width="620">
      <v-card>
        <v-card-title class="d-flex align-center">
          <v-icon color="error" class="mr-2">mdi-alert-outline</v-icon>
          确认真实提交？
        </v-card-title>
        <v-card-text>
          <!-- 🔴 用户要求（2026-09-15）：提交时明确弹出三条警告 -->
          <v-alert type="error" variant="flat" density="comfortable" class="mb-3">
            <div class="font-weight-bold">提交前请务必确认以下三条</div>
            <ol class="text-body-2 pl-4 mt-1 mb-0">
              <li><b>请勿在任意端登录「龙猫」相关账号</b>（手机 / 电脑 / 其他浏览器都别登）——避免会话被顶掉或触发风控；</li>
              <li><b>请勿关闭此网页或本程序</b>——提交与真实等待都发生在这里，关掉就中断了；</li>
              <li><b>请等待倒计时结束</b>（约 20 分钟），期间<b>不要刷新页面</b>。</li>
            </ol>
          </v-alert>
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
              :subtitle="gateStatus.blockedBy === 'night' ? '夜间停用：只能模拟与预览，不能真实提交' : gateStatus.allow ? '三项均关闭或无阻碍，可开跑' : gateStatus.reason"
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
import { formatDuration, formatPace } from '~/utils/mp/runData'
import { useMpDemo } from '~/composables/useMpDemo'
import { useMpReal } from '~/composables/useMpReal'
import { logInfo, logWarn } from '~/composables/useEventLog'
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
  restoreCachedTask,
  hasCachedTask,
  cachedTaskLabel,
  persistSelectedLine,
  gateStatus,
  cameraFlagError,
  retryCameraFlag,
} = useMpReal()
const showSnackbar = useNotice()

const confirmOpen = ref(false)

const realReady = computed(() => realStatus.value === 'ready' && Boolean(realTask.value))
/** 当前生效的任务：真实任务优先，其次演示任务（默认都为空 = 未载入） */
const activeTask = computed(() => realTask.value ?? task.value)
/** 当前线路集（真实/演示任务都自带 runPointList） */
const activeLinesRaw = computed(() => activeTask.value?.runPointList ?? [])

/**
 * 本地路线库（用户要求，2026-09-18 收紧为**强制**）：
 * **阳光跑页只列"在跑道编辑里配置好的路线"，并以那条路线的几何为基准生成轨迹。**
 *
 * ⚠️ 2026-09-18 变更（用户实测反馈）：此前"库里为空时先列出全部官方线路"的兜底**已删除** ——
 * 用户的原话是"我们就是要弄新的版本，在下拉框里面选择我们已经编辑好的路径，再以这个路径为基础来进行生成"。
 * 那条兜底会让人**在没配过跑道时直接跑官方模板**（形状偏十几米），而且提示不醒目 ⇒ 容易被当成 bug。
 * 现在：没配置过 ⇒ 下拉框为空、**开跑按钮禁用**，并给出"先去描一条"的明确指引。
 */
const { entries: libEntries, load: loadTrackLibrary } = useTrackLibrary()
onMounted(() => loadTrackLibrary())
const configuredIds = computed(() => new Set(libEntries.value.map((e) => String(e.lineId))))
const hasConfigured = computed(() => libEntries.value.length > 0)
/** 只列"本机路线库里配置过"的线路（**没有兜底**：没配置就是空列表） */
const activeLines = computed(() => activeLinesRaw.value.filter((l) => configuredIds.value.has(String(l.pointId))))
const isBusy = computed(() => run.value.status === 'running' || run.value.status === 'paused')

/** 载入演示数据（按需功能，不发任何请求） */
const doEnableDemo = () => {
  enableDemo()
  showSnackbar('已载入演示数据（假数据，不发请求）', 'info')
}

/** 恢复"上次读取的任务"（刷新后默认不自动恢复） */
const doRestoreCached = () => {
  // 这也是"读取数据"（从本机缓存里恢复任务）⇒ 用云式顶部提示（1.1.9 需求①）
  if (restoreCachedTask()) showSnackbar('已恢复上次读取的任务（含当时选中的线路）', 'success', { cloud: true })
  else showSnackbar('没有可恢复的任务', 'warning', { cloud: true })
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
/**
 * 用户在「跑道编辑 → 本地路线库」里改过名 ⇒ 下拉里也显示他起的名字（1.1.9 需求②）。
 * 没改过名时返回 undefined，`toSelectItems` 的行为**逐字不变**。
 */
const customNameOf = (id: string) => libEntries.value.find((e) => String(e.lineId) === String(id))?.customName
const lineItems = computed(() => toSelectItems(routeGroups.value, customNameOf))
/** 选了其他校区线路时的提示（未跨校区为空串） */
const crossCampusWarning = computed(() => warnForSelection(routeGroups.value, run.value.lineId))
const selectedLineName = computed(() => {
  const line = activeLines.value.find((l) => l.pointId === run.value.lineId)
  if (!line) return '—'
  // 改过名就显示改名（用户看的是自己起的名字）；否则保持原来的厂商名口径
  return customNameOf(String(line.pointId))?.trim() || line.pointName || '—'
})
/** 当前选中的线路（含官方路线点列）—— 给「轨迹预览」当参考线用 */
const selectedLine = computed(() => activeLines.value.find((l) => l.pointId === run.value.lineId))

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

// 跑步状态变化 → 记事件日志（开始 / 暂停 / 结算，含结算数值，便于事后核对）
watch(
  () => run.value.status,
  (s, prev) => {
    if (s === prev) return
    const line = activeLines.value.find((l) => l.pointId === run.value.lineId)
    if (s === 'running' && prev === 'idle') {
      logInfo('run', '开始跑步', {
        mode: demoMode.value ? '演示' : '真实',
        lineId: line?.pointId,
        lineName: line?.pointName,
        speed: run.value.speed,
      })
    } else if (s === 'paused') {
      logInfo('run', '暂停', { km: Number((run.value.distanceM / 1000).toFixed(2)) })
    } else if (s === 'running' && prev === 'paused') {
      logInfo('run', '继续', { km: Number((run.value.distanceM / 1000).toFixed(2)) })
    } else if (s === 'finished' && run.value.result) {
      const r = run.value.result
      logInfo('run', '结算完成（本地预判）', {
        km: Number(r.km.toFixed(2)),
        durationSeconds: r.durationSeconds,
        fitDegree: r.fitDegree,
        paceSecPerKm: Math.round(r.durationSeconds / Math.max(0.01, r.km)),
        steps: r.stepsSubmitted,
        hardPass: r.check.pass,
        problems: r.check.problems,
      })
      if (!r.check.pass) logWarn('run', '硬性自检未通过', { problems: r.check.problems })
    }
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

/** 页面挂载：把当前任务（若已有）注入跑步机；**不再自动回填缓存**（刷新后默认干净） */
onMounted(() => {
  applyToRunner()
})

/** 真实提交：确认后走 useMpReal 的完整流程（门禁 → 开跑 → 真实等待 → 提交 → 读判定） */
const doRealSubmit = async () => {
  confirmOpen.value = false
  // 门禁失守直接返回（不调 getRunBegin，避免创建场次后才发现被拦）
  if (!gateStatus.value.allow) {
    logWarn('submit', '点了真实提交但门禁未通过', { blockedBy: gateStatus.value.blockedBy ?? '', reason: gateStatus.value.reason })
    showSnackbar(gateStatus.value.reason || '当前不允许真实提交', 'error')
    return
  }
  const r = run.value.result
  const line = activeLines.value.find((l) => l.pointId === run.value.lineId)
  if (!r || !line) {
    showSnackbar('缺少线路或结算数据', 'error')
    return
  }
  logInfo('submit', '用户确认真实提交', {
    lineId: line.pointId,
    km: Number(r.km.toFixed(2)),
    durationSeconds: r.durationSeconds,
    fitDegree: r.fitDegree,
    checkPass: r.check.pass,
  })
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
