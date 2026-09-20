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
            <!-- 当前跑法由 URL（分组内的小标签）决定：只做**说明**，切换用上方标签或顶部导航 -->
            <div class="d-flex align-center flex-wrap ga-2 mb-2">
              <v-icon size="small" color="primary">{{ isFreeRun ? 'mdi-run' : 'mdi-white-balance-sunny' }}</v-icon>
              <!-- ⚠️ 用 `text-no-wrap`：此前"当前模式：自由跑"在窄列里被拆成两行（"自由/跑"），很难看 -->
              <span class="text-body-2 font-weight-bold text-no-wrap">当前模式：{{ isFreeRun ? '自由跑' : '阳光跑' }}</span>
              <span class="text-caption text-medium-emphasis">（切换用上方标签）</span>
            </div>

            <!-- ⚠️ 自由跑的**提交口径**（2026-09-18 按厂商源码落地，**不能改**）：
                 厂商在自由跑时 `0==runType && (取线路)` 根本不执行 ⇒ paperId/lineId 都是空串、
                 不带任务号、也不需要打卡/自查那三项开关校验。
                 ⚠️ 但**本机生成轨迹仍要一条几何**（且只允许用你自己描的跑道，见 runner.start 的注释），
                 所以 2026-09-20 起自由跑**也能选线路** —— 选的只是"本地用哪条几何"，
                 **提交报文里依旧不带 lineId/paperId**（`buildScoreRequest` 的 freeRun 分支强制为空，
                 与此处的选择无关；有单测钉住这一点）。 -->
            <v-alert v-if="isFreeRun" type="info" variant="tonal" density="compact" class="mb-2">
              自由跑<b>不带任务号、不校验打卡开关、不计入阳光跑成绩</b>（与小程序一致）。
              下面选的线路<b>只决定本机用哪条几何生成轨迹</b>（仍然只允许用你自己描过的跑道），
              <b>不会</b>被写进提交报文 —— 提交时线路标识一律为空。
              到里程上限或你点「结束并结算」即止。
            </v-alert>
            <v-select
              v-model="run.lineId"
              :items="lineItems"
              item-title="title"
              item-value="value"
              :label="isFreeRun ? '线路（只影响本地轨迹几何）' : '线路（按校区自动分组，本校区优先）'"
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
                :disabled="!canStart"
                @click="doStart"
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
              <!-- ⚠️ 提交进行中（等报备时长/正在提交）时**禁止重置**：否则会把自己正在等待的
                   那笔提交从界面上抹掉（审计 #2），用户就看不到进度与结果了。 -->
              <v-btn
                v-if="run.status !== 'idle'"
                variant="text"
                block
                prepend-icon="mdi-refresh"
                :disabled="submitInFlight"
                @click="reset"
              >
                重置
              </v-btn>
              <div v-if="submitInFlight" class="text-caption text-warning">
                ⚠️ 真实提交正在进行（{{ phaseMessage }}）——<b>请勿关闭程序或离开本页</b>，等待结束会自动提交。
              </div>
            </div>

            <v-alert v-if="run.error" type="error" variant="tonal" density="compact" class="mt-3">{{ run.error }}</v-alert>
      <!-- 路线来源（2026-09-18 收紧）：**只列你描好的路线**，并以它的几何为基准生成轨迹 -->
      <v-alert v-if="hasConfigured" type="success" variant="tonal" density="compact" class="mt-3">
        只列出你在「跑道编辑」里配置好的 <b>{{ configuredForTask }}</b> 条路线 —— 轨迹以<b>你描的真跑道</b>为基准生成；
        官方模板只作对照（提交时服务端的拟合度仍按官方模板算）。
      </v-alert>
      <v-alert v-else-if="libEntriesNotForTask" type="warning" variant="tonal" density="compact" class="mt-3">
        <div class="font-weight-bold">本机有 {{ libTotal }} 条跑道，但都不属于当前任务的线路。</div>
        <div class="text-body-2 mt-1">
          本版<b>只会用你自己描的跑道</b>生成轨迹，而路线库是<b>按线路</b>存的 —— 当前任务的线路你还没描过。
          去「<b>跑道编辑</b>」把线路切到这条任务的线路 → 「快速定位」→ 沿卫星图描外圈 → 「按外圈自动生成内圈」→ 保存（本机）。
        </div>
        <div class="mt-2">
          <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-vector-polyline" to="/track-editor">
            去「跑道编辑」描一条
          </v-btn>
        </div>
      </v-alert>
      <v-alert v-else-if="activeLinesRaw.length" type="warning" variant="tonal" density="compact" class="mt-3">
        <div class="font-weight-bold">还没有可用的跑道：请先描一条。</div>
        <div class="text-body-2 mt-1">
          本版<b>只会用你自己描的跑道</b>生成轨迹（官方模板偏差十几米，不再作为生成基准）——
          <b>阳光跑与自由跑都是这个口径</b>。
          去「<b>我的场地 → 跑道编辑</b>」选一条线路 → 「快速定位」→ 沿卫星图描外圈 → 「按外圈自动生成内圈」→ 保存（本机）。
          保存后回到本页，这条线路就会出现在下面的下拉框里。
        </div>
        <div class="mt-2">
          <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-vector-polyline" to="/field/track-editor">
            去「跑道编辑」描一条
          </v-btn>
        </div>
      </v-alert>

      <v-alert v-if="!realReady && !demoMode" type="warning" variant="tonal" density="compact" class="mt-3">
              还没读到任务：回<NuxtLink to="/">工作台</NuxtLink>粘贴 token → 点「读取真实账号与任务」；
              或点上方「载入演示数据」只试界面与报文（不发请求）。
              <!-- 刷新后默认不自动恢复缓存，这里给显式入口（2026-09-18：恢复 = 重建会话 + 自动读取） -->
              <div v-if="hasCachedTask" class="d-flex flex-wrap ga-2 mt-2">
                <v-btn size="small" variant="tonal" prepend-icon="mdi-history" @click="doRestoreCached">
                  {{ cacheHasToken ? '恢复上次会话（重建会话并读取）' : '恢复上次会话（用 token 读取）' }}
                </v-btn>
                <span v-if="cacheTokenMask" class="text-caption align-self-center">
                  已保存 token <code>{{ cacheTokenMask }}</code>
                </span>
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
          <!-- ⚠️ 2026-09-19 审计 S2：确认按钮原先**没有 disabled/loading** ⇒ 双击会发两次
               `getRunBegin`（服务端开两个场次），而 `submitRealRun()` 内部的 `waitTimer` 是闭包单变量，
               第二次调用会把第一次的计时器清掉 ⇒ 第一次的 Promise 永不 resolve。
               这里加锁只是第一层，真正兜底在 `submitRealRun()` 的入口互斥（见 real/submit.ts）。 -->
          <v-btn variant="text" :disabled="submitInFlight" @click="confirmOpen = false">取消</v-btn>
          <v-btn
            color="error"
            variant="flat"
            prepend-icon="mdi-cloud-upload-outline"
            :disabled="submitInFlight"
            :loading="submitInFlight"
            @click="doRealSubmit"
          >
            确认提交
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { formatDuration, formatPace } from '~/utils/mp/runData'
import { useMpDemo } from '~/composables/useMpDemo'
import { useMpReal } from '~/composables/useMpReal'
import { logError, logInfo, logWarn } from '~/composables/useEventLog'
import { groupRoutesByCampus, toSelectItems, warnForSelection } from '~/utils/mp/routeGroups'

const { isLoggedIn, task, run, progress, paceText, start, pause, resume, finish, reset, demoMode, enableDemo } = useMpDemo()
const {
  profile: realProfile,
  task: realTask,
  status: realStatus,
  error: realError,
  phase,
  phaseMessage,
  remainingSeconds,
  result,
  applyToRunner,
  submitRealRun,
  fetchVerdict,
  restoreCachedTask,
  hasCachedTask,
  cacheHasToken,
  cacheTokenMask,
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
 *
 * ⚠️ 2026-09-18 发布前审计 M1：**"有没有配置"必须与下拉框同口径**。
 *    库里按 `lineId` 存，本机可能留着**别的任务/演示数据**的条目（例如先用演示数据描了一圈，
 *    再读真实任务）—— 那时旧写法 `libEntries.length > 0` 会显示绿条"只列出你配置好的 N 条路线"，
 *    而下拉框其实是空的、开跑永久灰，且本该出现的"去描一条"警示被 `v-else-if` 吃掉 ⇒ 用户卡死无出路。
 *    判据改为"**当前任务里的线路确有配置**"（`activeLines.length > 0`），并为"库里有条目但都不属于当前任务"
 *    单独给一条带入口的提示。
 */
const { entries: libEntries, load: loadTrackLibrary } = useTrackLibrary()
onMounted(() => loadTrackLibrary())
const configuredIds = computed(() => new Set(libEntries.value.map((e) => String(e.lineId))))
/** 只列"本机路线库里配置过"的线路（**没有兜底**：没配置就是空列表） */
const activeLines = computed(() => activeLinesRaw.value.filter((l) => configuredIds.value.has(String(l.pointId))))
/** 当前任务里**确有配置**的线路数（与下拉框同口径；=0 时不能开跑） */
const configuredForTask = computed(() => activeLines.value.length)
/** 本机路线库总条数（可能全是别的任务/演示数据留下的） */
const libTotal = computed(() => libEntries.value.length)
const hasConfigured = computed(() => configuredForTask.value > 0)
/** 库里有条目、但都不属于当前任务的线路（要给"去为这条线路描一圈"的指引） */
const libEntriesNotForTask = computed(() => libTotal.value > 0 && configuredForTask.value === 0)
/** 本次是自由跑（提交口径：不选线路、不带任务号、不查打卡开关 —— 与小程序一致） */
const isFreeRun = computed(() => run.value.runType !== 0)

/**
 * **标签页按 URL 绑定**：阳光跑与自由跑是同一个分组（「跑步」）里的两个小标签，各自有独立 URL。
 *
 * 为什么这么做：两者**共用同一套跑步引擎与跑步机状态**（`useMpDemo().run` 是跨页面共享的 `useState`）
 * —— 如果复制成两份页面，逻辑会立刻漂移。所以用"两个真实路由 + 同一个引擎"。
 *
 * ⚠️ 2026-09-20 分组重构：路由从 `/run` + `/freerun` 改为 **`/runs/sunrun` + `/runs/freerun`**
 *    （旧 URL 保留为跳转）。**这里不能再靠固定字符串判断**，改成"看路由最后一段"，
 *    这样分组/改名都不会再失效（判据：**路由判定要读"末段 / 参数"，不要 `startsWith('/某个固定前缀')`**）。
 */
const route = useRoute()
const runTab = computed(() => String(route.path ?? '').split('/').filter(Boolean).pop() ?? 'sunrun')
const isFreeTab = computed(() => runTab.value === 'freerun')
/** 当前标签对应的**提交口径**（0 阳光跑 / 1 自由跑）—— 这是唯一权威来源 */
const tabRunType = computed<0 | 1>(() => (isFreeTab.value ? 1 : 0))
/** 正在跑/暂停时不允许改口径（会污染进行中的那一笔） */
const runTypeLocked = computed(() => run.value.status === 'running' || run.value.status === 'paused')
watchEffect(() => {
  const want = tabRunType.value
  if (run.value.runType === want) return
  if (runTypeLocked.value) return // 进行中：先不动，交给 doStart() 兜底
  run.value.runType = want
})

/**
 * ⚠️ **开跑前把口径与当前标签对齐**（2026-09-18 审计 #1 的修复）。
 *
 * 病因：`run.runType` 只是"上一次设置后可能被冻结"的副本 —— `watchEffect` 在 `running/paused` 时跳过改写，
 * 若用户在这期间（或在"已结算"态）从导航切了标签，副本就可能与 URL 不一致；而 `start()` 直接读这个副本，
 * 于是出现"界面是自由跑、实际按阳光跑提交"（带任务号 + 路径点列 + **计入成绩**），
 * 正好违反自由跑的口径（`utils/mp/submitPayload.ts` 的 freeRun 分支）。
 *
 * 修法：**不再依赖那个副本** —— 每次开跑都以**当前标签**为准写回，再交给 runner 生成/结算。
 */
const doStart = () => {
  run.value.runType = tabRunType.value
  start()
}
/**
 * 能不能开跑：**两种跑法都要求"已为当前任务的线路描过跑道"**（用户 2026-09-18 口径：
 * "自由跑我们也需要保证线路的稳健性，所以也是限制在自己做的线路中"）。
 *
 * ⚠️ 与厂商语义的差别（有意为之，写在这里免得后人误改）：
 *   厂商的自由跑 `paperId`/`lineId` 都是空串、**不取线路**（见 `utils/mp/submitPayload.ts` 的注释），
 *   所以"必须描过跑道"**不是厂商要求**，而是**我们本地为了轨迹质量加的约束** ——
 *   自由跑若不描，就只能拿官方模板当形状（偏差十几到几十米），用户要的是"稳健"。
 *
 * ⚠️ 2026-09-20 补充（用户要求"自由跑也要选择路径"）：自由跑现在**也会显示线路下拉**，
 *   但它选的是**本地生成轨迹用哪条几何**，**不是**提交用的线路标识 ——
 *   提交口径**一个字都没变**：自由跑依旧 `runType=1` + 不带任务号 + `paperId`/`lineId` 为空串 +
 *   不发路径点明细（由 `buildScoreRequest` 的 freeRun 分支强制，且有单测钉住）。
 *   判据：**"选线路"这件事只允许影响本地几何；任何把 UI 上的线路选择带进自由跑报文的改动都是错的。**
 */
const canStart = computed(() => configuredForTask.value > 0)
const isBusy = computed(() => run.value.status === 'running' || run.value.status === 'paused')
/**
 * **真实提交正在进行**（等报备时长 / 正在提交）。
 *
 * ⚠️ 2026-09-18 审计 #2：这条链路活在 `phase` 里，而"能不能离开/重置"原先只看 `run.status`
 * （提交期 `run.status` 已是 `finished` ⇒ `isBusy=false`）⇒ 用户可以在倒计时中途点「重置」把
 * 自己正在等待的那笔提交从界面上抹掉（数据不会写坏，但完全失去监督窗口）。
 * 所以"锁"必须**同时看两条轨道**。
 */
const submitInFlight = computed(() => phase.value === 'waiting' || phase.value === 'submitting')

/** 载入演示数据（按需功能，不发任何请求） */
const doEnableDemo = () => {
  enableDemo()
  showSnackbar('已载入演示数据（假数据，不发请求）', 'info')
}

/** 恢复"上次读取的任务"（刷新后默认不自动恢复） */
const doRestoreCached = () => {
  // 这也是"读取数据"（从本机缓存里恢复任务）⇒ 用云式顶部提示（1.1.9 需求①）
  // 2026-09-18：恢复 = **拿本机 token 重新读取一遍**（与工作台同一套语义）
  if (restoreCachedTask()) showSnackbar('正在用本机 token 重新读取…', 'info', { cloud: true })
  else showSnackbar(realError.value || '本机没有可用 token：请回「工作台」点「一键获取 token」', 'warning', { cloud: true })
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
  /**
   * ⚠️ 2026-09-19 审计 S2/S3：这里原先**没有 try/catch**，也没有入口互斥。
   *   · `submitRealRun` 会创建服务端场次（非幂等写），内部一旦抛异常（例如等待期间档案被清空
   *     导致空指针），异常会直接冒到这里 ⇒ 界面**没有任何提示**，`phase` 还可能卡死；
   *   · 双击确认会进两次（按钮已加 disabled，这里再兜一层）。
   * 所以：入口判"已在等待/提交中就忽略"，并整体包 try/catch 把异常变成可读提示。
   */
  if (submitInFlight.value) {
    showSnackbar('正在等待/提交中，请勿重复点击', 'info')
    return
  }
  // 门禁失守直接返回（不调 getRunBegin，避免创建场次后才发现被拦）
  if (!gateStatus.value.allow) {
    logWarn('submit', '点了真实提交但门禁未通过', { blockedBy: gateStatus.value.blockedBy ?? '', reason: gateStatus.value.reason })
    showSnackbar(gateStatus.value.reason || '当前不允许真实提交', 'error')
    return
  }
  const r = run.value.result
  // ⚠️ 自由跑没有线路（厂商口径：自由跑 paperId/lineId 都为空串）⇒ line 允许为空
  const line = isFreeRun.value ? null : (activeLines.value.find((l) => l.pointId === run.value.lineId) ?? null)
  if (!r || (!isFreeRun.value && !line)) {
    showSnackbar(isFreeRun.value ? '缺少结算数据' : '缺少线路或结算数据', 'error')
    return
  }
  logInfo('submit', '用户确认真实提交', {
    runType: r.submitRunType,
    lineId: line?.pointId ?? '(自由跑)',
    km: Number(r.km.toFixed(2)),
    durationSeconds: r.durationSeconds,
    fitDegree: r.fitDegree,
    checkPass: r.check.pass,
    points: r.points.length,
  })
  try {
    const out = await submitRealRun({
      line,
      // 提交口径与预览同源（结果里那份 submitRunType），避免两处各转一次导致口径漂移
      runType: r.submitRunType,
      // ⚠️ 用**实际跑出来的那一段**（自由跑提前结束时，整条 points 会与 km 矛盾）
      points: r.points,
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
      // out === null：可能是被门禁/上下文丢失挡住，也可能是重复点击被忽略 ⇒ 用 phase 的说明兜底
      showSnackbar(phaseMessage.value || '真实提交未完成（未创建场次或已中止）', 'error')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError('submit', '真实提交抛出未捕获异常（已兜住）', { message })
    showSnackbar(`真实提交异常（未完成）：${message}`, 'error')
  }
}
</script>
