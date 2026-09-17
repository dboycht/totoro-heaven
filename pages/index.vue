<template>
  <div>
    <!-- 🌙 夜间停用（22:30~06:00，用户要求）：最显眼位置提示，只读功能不受影响 -->
    <v-alert
      v-if="gateStatus.blockedBy === 'night'"
      type="warning"
      variant="flat"
      density="comfortable"
      class="mb-4"
    >
      <div class="font-weight-bold">🌙 夜间停用时段（22:30~06:00）</div>
      <div class="text-body-2">
        为避免不必要的麻烦，此时间段<b>已停止开跑与提交</b>；读取账号 / 取 token / 看记录与日志仍然可用。
        请在每天 <b>06:00 之后</b>再开始跑步。
      </div>
      <div class="text-caption mt-1">{{ gateStatus.reason }}</div>
    </v-alert>

    <!-- 🔔 版本提示 + 立即检测（组件内自带：有新版本→报警；连不上 GitHub→提示；正常→常驻行）-->
    <UpdateNotice />

    <v-alert type="info" variant="flat" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-shield-check-outline</v-icon>
      </template>
      <div class="font-weight-bold">支持范围：共享域 + 无风控校验的学校（运行时自动判定）</div>
      <div class="text-body-2">
        只要同时满足两点即可使用：<br />
        ① 学校与南航<b>共享同一个 API 域</b>（<code>wxxcx.xtotoro.com</code>）——
        独立域/学校专属小程序的学校<b>不支持</b>（那等于另一套后端）；<br />
        ② 该校<b>未开启</b>开场人脸 / 随机抽查 / 摄像头杆校验 ——
        任一开启时门禁会<b>在创建场次前阻止</b>，不会留下无效记录。<br />
        <span class="text-caption">
          当前 {{ verifiedSchoolText }}（我们实测验证过判分口径）；其他学校可以直接用，
          但判分口径未经验证 → 首次提交后请看「记录」页核对是否判为「有效」。
        </span>
      </div>
    </v-alert>

    <v-alert type="info" variant="tonal" class="mb-4" density="comfortable">
      <template #prepend>
        <v-icon>mdi-rocket-launch-outline</v-icon>
      </template>
      <div class="font-weight-bold">使用方式：粘贴 token → 自动读取 → 选线路开跑</div>
      <div class="text-body-2">
        <b>真实流程</b>：把真实 token 粘进来 → 点「读取真实账号与任务」→ 自动校验 token、识别学校、
        读取<b>真实任务约束与真实线路</b> → 在「阳光跑」页选线路开跑（提交前会先过<strong>开跑前门禁</strong>并自检）。<br />
        <b>演示</b>：只是想先看界面/报文、不想碰真实账号时，点「载入演示数据」——数据来自
        <code>src/mp/demo.ts</code>，<b>不发任何网络请求</b>，也不会真实提交。
      </div>
      <div class="mt-2">
        <v-btn size="small" variant="tonal" prepend-icon="mdi-school-outline" @click="guideOpen = true">
          查看上手教程
        </v-btn>
      </div>
    </v-alert>

    <v-row>
      <v-col cols="12" md="6">
        <HomeTokenCard
          v-model:manual-token="manualToken"
          :is-logged-in="isLoggedIn"
          :real-status="realStatus"
          :real-error="realError"
          :is-real-session="isRealSession"
          :token-scan-state="tokenScanState"
          :has-cached-task="hasCachedTask"
          :cached-task-label="cachedTaskLabel"
          :real-task="realTask"
          @load-real="doLoadReal"
          @token-scan="doTokenScan"
          @enable-demo="doEnableDemo"
          @logout="doLogout"
          @clear-all="confirmClearOpen = true"
          @restore-cached="doRestoreCached"
          @clear-cached="clearCachedTask()"
        />
      </v-col>

      <v-col cols="12" md="6">
        <HomeProfileCard
          :real-profile-masked="realProfileMasked"
          :real-status="realStatus"
          :real-school-notice="realSchoolNotice"
          :real-switches="realSwitches"
          :camera-flag="cameraFlag"
          :gate-status="gateStatus"
          :camera-flag-error="cameraFlagError"
          @load-real="doLoadReal"
          @retry-camera-flag="retryCameraFlag()"
        />
      </v-col>
    </v-row>

    <v-row class="mt-1">
      <v-col cols="12" md="6">
        <HomeTaskLines
          :active-task="activeTask"
          :route-groups="routeGroups"
          :line-names="lineNames"
          :using-real-task="usingRealTask"
        />
      </v-col>

      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            <v-icon color="accent" class="mr-2">mdi-rocket-launch-outline</v-icon>
            下一步
          </v-card-title>
          <v-card-text>
            <ol class="text-body-2 mb-3 pl-4">
              <li>粘真实 token → 点「<b>读取真实账号与任务</b>」（自动校验 token、识别学校）</li>
              <li>进「<b>阳光跑</b>」页（真实数据已就绪后即为真实链路）</li>
              <li>选线路 → 开始跑步（模拟倍速跑完）→ 看自检 → 点「<b>真实提交</b>」</li>
              <li>提交那一刻会<b>真实等待</b>报备时长（保证时间线一致），完成后自动读判定</li>
            </ol>
            <div class="d-flex flex-column ga-2">
              <v-btn color="primary" block prepend-icon="mdi-run" :disabled="!isLoggedIn && !demoMode" to="/run">进入阳光跑</v-btn>
              <v-btn color="secondary" block variant="tonal" prepend-icon="mdi-format-list-bulleted" to="/records">
                查看记录
              </v-btn>
            </div>
            <v-alert v-if="!isLoggedIn && !demoMode" type="info" variant="tonal" density="compact" class="mt-3">
              先填 token 并读取真实数据，或点「载入演示数据」只试界面（不发请求）。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- 清空本机数据 确认框 -->
    <v-dialog v-model="confirmClearOpen" max-width="460">
      <v-card>
        <v-card-title class="d-flex align-center">
          <v-icon color="warning" class="mr-2">mdi-broom</v-icon>
          清空本机数据？
        </v-card-title>
        <v-card-text>
          这会清掉：<b>会话（token）</b>、<b>上次读取的任务缓存</b>、<b>本机成绩记录</b>、演示数据。
          清完后界面回到全新状态，需要重新粘贴 token 再读取。<b>不会</b>影响学校服务端已有的成绩。
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmClearOpen = false">取消</v-btn>
          <v-btn color="warning" variant="flat" prepend-icon="mdi-broom" @click="doClearAll">确认清空</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 首次启动教程（用户要求：第一次启动弹教程） -->
    <v-dialog v-model="guideOpen" max-width="640" persistent>
      <v-card>
        <v-card-title class="d-flex align-center">
          <v-icon color="primary" class="mr-2">mdi-school-outline</v-icon>
          三步上手（第一次使用请看这里）
        </v-card-title>
        <v-card-text>
          <ol class="text-body-2 pl-4">
            <li class="mb-2">
              <b>打开电脑版微信</b>并登录（本软件只能从<b>电脑版</b>微信里取 token，手机端取不到）。
            </li>
            <li class="mb-2">
              <b>用手机微信打开「龙猫体育锻炼」（龙猫校园）小程序</b>，确认已登录、能看到阳光跑页面。
            </li>
            <li class="mb-2">
              在手机上点右上角「<b>…</b>」→ 选择「<b>在电脑上打开</b>」→ 电脑微信会弹出小程序窗口，<b>保持开着别关</b>。
              <span class="text-medium-emphasis">（若电脑微信里已能直接搜到该小程序，也可直接在电脑上打开。）</span>
            </li>
            <li class="mb-2">
              回到本页，点「<b>一键获取 token</b>」→ 自动登录并读取你的任务与线路（约 5 秒）。
            </li>
            <li class="mb-2">
              进「<b>阳光跑</b>」→ 选线路 → 「开始跑步」（本地生成数据并结算）→ 看自检表 → 点「<b>真实提交</b>」→
              <b>等到倒计时结束</b>（约 20 分钟：别关页面、别刷新、别在别的端登录账号）。
            </li>
          </ol>
          <v-alert type="info" variant="tonal" density="compact" class="mt-2">
            token 只有<b>几天</b>有效期。过期时软件会提示：在小程序里<b>退出登录 → 用学号+姓名重新登录</b>，
            回到本页再点一次「一键获取 token」即可。
            <br />（等价且更稳的做法：在微信里删除该小程序 → 重新打开 → 登录。两者都会解除微信绑定，请确认记得学号。）
          </v-alert>
          <v-alert type="warning" variant="tonal" density="compact" class="mt-2">
            <b>请始终使用最新版本</b>（当前 v{{ appVersion }}）：每次发版都会修 bug、跟进校方与小程序的变化；
            旧版本可能无法使用，甚至产生<b>无效记录</b>。
            <a :href="releasesUrl" target="_blank" rel="noopener" class="text-primary">查看最新版</a>
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn variant="text" prepend-icon="mdi-radar" @click="doTokenScanAndCloseGuide">知道了，立即获取 token</v-btn>
          <v-spacer />
          <v-btn color="primary" variant="flat" @click="closeGuide">知道了</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { VERIFIED_SCHOOLS } from '~/utils/mp/schoolGate'
import { groupRoutesByCampus } from '~/utils/mp/routeGroups'
import { logError, logInfo, logWarn } from '~/composables/useEventLog'
import { DEMO_SESSION } from '~/src/mp/demo'

const { isLoggedIn, task, session, logout, demoMode, enableDemo } = useMpDemo()
const {
  profileMasked: realProfileMasked,
  task: realTask,
  status: realStatus,
  error: realError,
  switches: realSwitches,
  cameraFlag,
  loadRealData,
  applyToRunner,
  restoreCachedTask,
  hasCachedTask,
  cachedTaskLabel,
  clearCachedTask,
  clearAllLocalData,
  gateStatus,
  schoolNotice: realSchoolNotice,
  cameraFlagError,
  retryCameraFlag,
} = useMpReal()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

/** 已验证学校名单（登记表仅用于"判分口径是否实测过"的提示） */
const verifiedSchoolText = computed(() => {
  const list = VERIFIED_SCHOOLS.filter((s) => s.verified).map((s) => `「${s.schoolName}」（${s.schoolCode}）`)
  return list.length ? `已验证判分口径的学校：${list.join('、')}` : '目前还没有实测验证过的学校'
})

const manualToken = ref('')
const confirmClearOpen = ref(false)

// 版本提示（用 UpdateNotice 组件；这里只取教程弹窗要用的两个值）
const { appVersion, releasesUrl } = useUpdateCheck()

// ---------- 首次启动教程（用户要求：第一次启动弹教程） ----------
const GUIDE_KEY = 'totoro_guide_seen_v1'
const guideOpen = ref(false)
const closeGuide = () => {
  guideOpen.value = false
  try {
    localStorage.setItem(GUIDE_KEY, '1')
  } catch {
    /* 忽略隐私模式等写入失败 */
  }
}
/** 教程里的"立即获取 token"：关教程并直接开始一键获取 */
const doTokenScanAndCloseGuide = () => {
  closeGuide()
  void doTokenScan()
}

const isRealSession = computed(() => Boolean(session.value?.token) && !session.value?.token?.startsWith('demo-'))
/** 跑步页当前用的是真实任务还是演示任务 */
const usingRealTask = computed(() => Boolean(realTask.value))
const activeTask = computed(() => realTask.value ?? task.value)
const lineNames = computed(() => (activeTask.value?.runPointList ?? []).map((line) => line.pointName).join('、') || '—')

/** 线路按校区分组（与跑步页同一套纯函数；用本人校区名识别本校区簇） */
const routeGroups = computed(() =>
  groupRoutesByCampus(activeTask.value?.runPointList ?? [], realProfileMasked.value?.campusName),
)

onMounted(() => {
  // 首次启动弹教程（用户要求）；已看过则不再自动弹，可用页面上的「查看教程」再打开
  try {
    if (!localStorage.getItem(GUIDE_KEY)) guideOpen.value = true
  } catch {
    /* 忽略隐私模式等读取失败 */
  }
  // 版本检测由 <UpdateNotice> 组件在挂载时发起（含「立即检测」）
})

/** 载入演示数据（按需功能：只在"没有真实数据、只想看界面"时用） */
const doEnableDemo = () => {
  enableDemo()
  showSnackbar('已载入演示数据（假数据，不发请求）。读取真实数据时会自动退出演示。', 'info')
}

/** 真实链路：用 token 建会话 → 读账号 + 任务 + 线路 + 开关（成功后自动退出演示） */
const doLoadReal = async () => {
  const token = manualToken.value.trim()
  if (token) {
    session.value = {
      token,
      baseUrl: session.value?.baseUrl ?? DEMO_SESSION.baseUrl,
      userInfo: session.value?.userInfo,
    }
  }
  const ok = await loadRealData()
  if (ok) {
    // loadRealData() 内部已 applyToRunner()（定选线 + 退出演示 + 触发摄像头杆开关读取），此处不再重复注入
    const t = realTask.value!
    showSnackbar(`真实数据已就绪：${t.paperName}（${t.runPointList?.length ?? 0} 条线路）`, 'success')
  } else {
    showSnackbar(realError.value || '读取失败', 'error')
  }
}

const doLogout = () => {
  logout()
  logInfo('real', '清除会话（token 已移除）')
  showSnackbar('会话已清除', 'info')
}

/** 恢复"上次读取的任务"（刷新后默认不自动恢复，这是显式入口） */
const doRestoreCached = () => {
  if (restoreCachedTask()) showSnackbar('已恢复上次读取的任务（含当时选中的线路）', 'success')
  else showSnackbar('没有可恢复的任务', 'warning')
}

/** 一键清空本机数据（会话 + 任务缓存 + 记录） */
const doClearAll = () => {
  clearAllLocalData()
  manualToken.value = ''
  confirmClearOpen.value = false
  showSnackbar('已清空本机数据：会话 / 任务缓存 / 本机记录（服务端成绩不受影响）', 'info')
}

// ---------- 一键获取 token（扫 PC 微信小程序进程内存 → 服务端验活 → 自动写入会话） ----------
const tokenScanState = reactive({ running: false, phase: 'idle' as 'idle' | 'scanning' | 'validating' | 'ready' | 'error', message: '', masked: '' })
let scanTimer: ReturnType<typeof setInterval> | null = null
const stopScanPolling = () => {
  if (scanTimer !== null) {
    clearInterval(scanTimer)
    scanTimer = null
  }
}
onUnmounted(stopScanPolling)

const doTokenScan = async () => {
  if (tokenScanState.running) return
  tokenScanState.running = true
  tokenScanState.phase = 'scanning'
  tokenScanState.message = '正在启动扫描器…'
  logInfo('token', '点击「一键获取 token」')
  try {
    const started = await $fetch<{ ok: boolean; nonce?: string; message?: string }>('/api/local/token-scan/start', {
      method: 'POST',
    })
    if (!started?.ok || !started.nonce) throw new Error(started?.message || '启动扫描失败')
    const nonce = started.nonce
    tokenScanState.message = started.message || '正在扫描微信小程序进程内存…'
    const startedAt = Date.now()

    stopScanPolling()
    scanTimer = setInterval(() => {
      void (async () => {
        try {
          const st = await $fetch<{
            phase: 'idle' | 'scanning' | 'validating' | 'ready' | 'error'
            message?: string
            token?: string
            masked?: string
            fingerprint?: string
            candidates?: number
          }>(`/api/local/token-scan/status?nonce=${encodeURIComponent(nonce)}`)

          tokenScanState.phase = st.phase
          tokenScanState.message = st.message || ''

          if (st.phase === 'ready' && st.token) {
            stopScanPolling()
            tokenScanState.masked = st.masked || ''
            // 写入会话（只存本机 localStorage）；随后自动读取真实数据
            session.value = { token: st.token, baseUrl: session.value?.baseUrl ?? DEMO_SESSION.baseUrl, userInfo: session.value?.userInfo }
            tokenScanState.running = false
            logInfo('token', 'token 就绪，已写入会话', {
              masked: st.masked,
              fingerprint: st.fingerprint,
              candidates: st.candidates,
            })
            showSnackbar(`已获取 token（${st.masked}），正在读取真实数据…`, 'success')
            await doLoadReal()
          } else if (st.phase === 'error' || st.phase === 'idle') {
            stopScanPolling()
            tokenScanState.running = false
            logWarn('token', `取 token 失败：${st.message ?? ''}`, { phase: st.phase })
          } else if (Date.now() - startedAt > 70_000) {
            stopScanPolling()
            tokenScanState.phase = 'error'
            tokenScanState.message = '扫描超时：请确认电脑版微信已打开并登录小程序，然后重试'
            tokenScanState.running = false
            logWarn('token', '取 token 超时（70 秒）')
          }
        } catch {
          /* 本地端点偶发失败 → 下一轮继续 */
        }
      })()
    }, 1200)
  } catch (err) {
    tokenScanState.phase = 'error'
    tokenScanState.message = err instanceof Error ? err.message : '启动扫描失败'
    tokenScanState.running = false
    logError('token', '启动扫描失败', { message: tokenScanState.message })
  }
}
</script>
