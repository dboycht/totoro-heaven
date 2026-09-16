<template>
  <div>
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
        <v-card height="100%">
          <v-card-title class="d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-account-key-outline</v-icon>
            会话与真实 token
          </v-card-title>
          <v-card-subtitle>真实链路只认 token：留空则走演示数据</v-card-subtitle>
          <v-card-text>
            <v-text-field
              v-model="manualToken"
              label="真实 token（从抓包的 Authorization: Bearer 后面复制）"
              density="comfortable"
              hint="只存本机 localStorage；不打印、不入库、不提交"
              persistent-hint
              class="mb-4"
            />

            <div class="d-flex align-center flex-wrap ga-2 mb-3">
              <v-btn
                color="primary"
                prepend-icon="mdi-cloud-download-outline"
                :loading="realStatus === 'loading'"
                @click="doLoadReal"
              >
                读取真实账号与任务
              </v-btn>
              <v-btn
                color="success"
                prepend-icon="mdi-radar"
                :loading="tokenScanState.running"
                @click="doTokenScan"
              >
                一键获取 token
              </v-btn>
              <v-btn variant="text" prepend-icon="mdi-flask-outline" @click="doEnableDemo">载入演示数据（试界面）</v-btn>
              <v-btn v-if="isLoggedIn" variant="text" prepend-icon="mdi-logout" @click="doLogout">清除会话</v-btn>
              <v-btn variant="text" color="warning" prepend-icon="mdi-broom" @click="confirmClearOpen = true">
                清空本机数据
              </v-btn>
            </div>

            <!-- 一键获取 token 的状态（扫描中 / 验活 / 就绪 / 失败） -->
            <v-alert
              v-if="tokenScanState.phase === 'scanning' || tokenScanState.phase === 'validating'"
              type="info"
              variant="tonal"
              density="compact"
              class="mt-2"
            >
              <div class="d-flex align-center ga-2">
                <v-progress-circular indeterminate size="20" />
                <span>{{ tokenScanState.message }}</span>
              </div>
              <div class="text-caption mt-1">
                请确认：电脑版微信已打开并登录「龙猫体育锻炼」（扫描器只读它自己的进程内存，不需要管理员）。
              </div>
            </v-alert>
            <v-alert v-else-if="tokenScanState.phase === 'ready'" type="success" variant="tonal" density="compact" class="mt-2">
              ✅ 已获取 token：{{ tokenScanState.masked }} —— 会话已写入，正在读取真实数据…
            </v-alert>
            <v-alert v-else-if="tokenScanState.phase === 'error'" type="error" variant="tonal" density="compact" class="mt-2">
              {{ tokenScanState.message }}
              <div class="text-caption mt-1">
                仍不行就回到「抓包粘贴」路线：Fiddler 抓一条 <code>wxxcx.xtotoro.com</code> 请求，把
                <code>Authorization: Bearer …</code> 粘到上面的输入框。
              </div>
            </v-alert>

            <v-chip v-if="isLoggedIn" color="success" variant="tonal" size="small" class="mr-2">
              <v-icon start size="14">mdi-account-check</v-icon>
              真实会话
            </v-chip>
            <v-chip v-if="realStatus === 'ready'" color="success" variant="tonal" size="small">
              <v-icon start size="14">mdi-database-check-outline</v-icon>
              真实任务已就绪
            </v-chip>

            <v-alert v-if="realStatus === 'error'" type="error" variant="tonal" density="compact" class="mt-3">
              {{ realError }}
            </v-alert>
            <v-alert v-else-if="manualToken.trim() && !isRealSession" type="info" variant="tonal" density="compact" class="mt-3">
              已填入 token —— 点「读取真实账号与任务」即可校验并拉取真实数据（自动识别学校；非已验证学校会被拒绝）。
            </v-alert>

            <!-- 上次读取的任务：**刷新后不自动恢复**（默认干净），这里给显式入口 -->
            <v-alert v-if="hasCachedTask && !realTask" type="info" variant="tonal" density="compact" class="mt-3">
              <div class="text-body-2">本机存有<b>上次读取的任务</b>：{{ cachedTaskLabel }}</div>
              <div class="d-flex flex-wrap ga-2 mt-2">
                <v-btn size="small" variant="tonal" prepend-icon="mdi-history" @click="doRestoreCached">
                  恢复上次任务
                </v-btn>
                <v-btn size="small" variant="text" prepend-icon="mdi-delete-outline" @click="clearCachedTask()">
                  忽略并清除
                </v-btn>
              </div>
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="d-flex align-center flex-wrap ga-2">
            <v-icon color="secondary" class="mr-2">mdi-account-details-outline</v-icon>
            真实账号
            <v-spacer />
            <v-btn
              v-if="realStatus === 'ready'"
              size="small"
              variant="text"
              prepend-icon="mdi-refresh"
              :loading="realStatus === 'loading'"
              @click="doLoadReal"
            >
              刷新任务
            </v-btn>
          </v-card-title>
          <v-card-text>
            <template v-if="realProfileMasked">
              <v-list density="compact">
                <v-list-item title="学号 / 姓名" :subtitle="`${realProfileMasked.snCode} · ${realProfileMasked.studentName}`" prepend-icon="mdi-card-account-details-outline" />
                <v-list-item title="学校" :subtitle="realProfileMasked.schoolName" prepend-icon="mdi-school-outline" />
                <v-list-item title="校区（campusId）" :subtitle="realProfileMasked.campusId" prepend-icon="mdi-map-marker-outline" />
                <v-list-item title="班级" :subtitle="realProfileMasked.className || '—'" prepend-icon="mdi-account-group-outline" />
              </v-list>
            </template>
            <v-alert v-else type="info" variant="tonal" density="compact">
              还没读取真实账号。填入 token 后点左侧「读取真实账号与任务」。
            </v-alert>

            <!-- 未验证学校：只提示"判分口径未实测"，不阻断（**读到档案后才显示**，否则还不知道是哪所学校） -->
            <v-alert v-if="realProfileMasked && realSchoolNotice" type="info" variant="tonal" density="compact" class="mt-3">
              {{ realSchoolNotice }}
            </v-alert>

            <v-divider class="my-3" />
            <div class="text-caption text-medium-emphasis mb-2">一票否决项（真实数据读取后自动查）</div>
            <v-list density="compact">
              <v-list-item
                title="开场人脸 sunrunStartFace"
                :subtitle="switchText(realSwitches?.sunrunStartFace, '开启（需实时拍脸）', '关闭')"
                prepend-icon="mdi-camera-outline"
              />
              <v-list-item
                title="随机抽查 sunrunPointRandom"
                :subtitle="switchText(realSwitches?.sunrunPointRandom, '开启（跑动中可能弹脸）', '关闭')"
                prepend-icon="mdi-shuffle-variant"
              />
              <v-list-item
                title="摄像头杆 getCameraConfig.flag"
                :subtitle="cameraFlag === null ? '未读取' : cameraFlag ? '当前选中线路启用（需人到杆附近）' : '当前选中线路未启用'"
                prepend-icon="mdi-video-outline"
              />
            </v-list>
            <v-alert v-if="!gateStatus.allow" type="error" variant="tonal" density="compact" class="mt-2">
              <div class="font-weight-bold">⛔ 开跑前门禁未通过（真实提交会被阻止，不会创建场次）</div>
              <div class="text-body-2">{{ gateStatus.reason }}</div>
              <div v-if="cameraFlagError" class="text-caption mt-1">读取异常：{{ cameraFlagError }}</div>
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
            <v-alert v-else type="success" variant="tonal" density="compact" class="mt-2">
              ✅ 开跑前门禁通过：三项（开场人脸 / 随机抽查 / 摄像头杆）均无阻碍。
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row class="mt-1">
      <v-col cols="12" md="6">
        <v-card height="100%">
          <v-card-title class="text-subtitle-1 d-flex align-center">
            <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
            任务与约束
            <v-chip class="ml-2" size="x-small" :color="usingRealTask ? 'success' : 'accent'" variant="tonal">
              {{ usingRealTask ? '真实' : '演示' }}
            </v-chip>
          </v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item title="任务" :subtitle="activeTask?.paperName ?? '—'" prepend-icon="mdi-clipboard-text-outline" />
              <v-list-item title="目标里程" :subtitle="`${activeTask?.mileage ?? '—'} km`" prepend-icon="mdi-map-marker-distance" />
              <v-list-item title="拟合度阈值" :subtitle="String(activeTask?.fitDegree ?? '—')" prepend-icon="mdi-chart-bell-curve" />
              <v-list-item
                title="速度区间"
                :subtitle="`${activeTask?.minSpeed ?? '—'} ~ ${activeTask?.maxSpeed ?? '—'} km/h`"
                prepend-icon="mdi-speedometer"
              />
              <v-list-item
                title="时长区间"
                :subtitle="`${activeTask?.minTime ?? '—'} ~ ${activeTask?.maxTime ?? '—'} 分钟`"
                prepend-icon="mdi-timer-outline"
              />
              <v-list-item title="有效期" :subtitle="activeTask ? formatTaskPeriod(activeTask) : '—'" prepend-icon="mdi-calendar-range" />
              <!-- 线路：按坐标校区分组展示（本校区在前；跨校区标距离），避免"名称看不出是哪个校区" -->
              <template v-if="routeGroups.clusters.length">
                <v-list-item
                  v-for="c in routeGroups.clusters"
                  :key="c.index"
                  :title="c.label"
                  :subtitle="c.routes.map((r) => r.line.pointName).join('、')"
                  :prepend-icon="c.kind === 'home' ? 'mdi-map-marker-check-outline' : 'mdi-map-marker-distance'"
                />
                <v-list-item
                  v-if="routeGroups.inferred"
                  title="分组提示"
                  :subtitle="routeGroups.note"
                  prepend-icon="mdi-alert-circle-outline"
                />
              </template>
              <v-list-item v-else title="线路" :subtitle="lineNames" prepend-icon="mdi-map-outline" />
            </v-list>
            <v-alert v-if="!usingRealTask" type="warning" variant="tonal" density="compact" class="mt-2">
              当前是<b>演示取值</b>。点「读取真实账号与任务」换成真实约束（自动识别学校）。
            </v-alert>
          </v-card-text>
        </v-card>
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
import { formatTaskPeriod } from '~/utils/mp/taskRules'
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

const switchText = (value: string | undefined, on: string, off: string) =>
  value === undefined ? '未读取' : value === '1' ? on : off

onMounted(() => {
  // 首次启动弹教程（用户要求）；已看过则不再自动弹，可用页面上的「查看教程」再打开
  try {
    if (!localStorage.getItem(GUIDE_KEY)) guideOpen.value = true
  } catch {
    /* 忽略隐私模式等读取失败 */
  }
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
