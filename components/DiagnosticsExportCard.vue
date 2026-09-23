<template>
  <v-card class="mb-4">
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon color="primary" class="mr-1">mdi-bug-outline</v-icon>
      诊断记录（导出给开发者）
      <v-chip v-if="isRecording" size="small" color="error" variant="tonal" class="ml-2">
        <v-icon start size="small">mdi-record-circle-outline</v-icon>记录中 · 已记录 {{ durationText }}
      </v-chip>
      <v-chip v-else-if="lastFinished" size="small" color="primary" variant="tonal" class="ml-2">
        <v-icon start size="small">mdi-archive-check-outline</v-icon>上次记录已结束 · 可导出
      </v-chip>
      <v-chip v-if="serverOk === false" size="small" color="warning" variant="tonal" class="ml-2">
        <v-icon start size="small">mdi-lan-disconnect</v-icon>读不到服务端记录状态（未按记录窗口导出）
      </v-chip>
    </v-card-title>

    <v-card-text>
      <!-- ① 操作说明（按顺序照做即可） -->
      <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
        <div class="font-weight-bold mb-1">怎么操作（照着做就行）</div>
        <ol class="pl-5 mb-0">
          <li v-for="(step, i) in STEPS" :key="i" class="text-body-2">{{ step }}</li>
        </ol>
      </v-alert>

      <!-- ② 两个按钮：互斥；导出中禁用 -->
      <div class="d-flex flex-wrap align-center ga-2 mb-3">
        <v-btn
          color="error"
          variant="flat"
          prepend-icon="mdi-record-rec"
          :loading="starting"
          :disabled="isRecording || exporting || starting"
          @click="startRecording"
        >
          开始记录
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-download"
          :loading="exporting"
          :disabled="!canExport || exporting"
          @click="finishAndExport"
        >
          结束并导出
        </v-btn>
        <span class="text-body-2 text-medium-emphasis">
          {{
            superseded
              ? '本页这一次记录已作废（服务端的窗口被别的标签页换掉了）：导出按钮已禁用，免得把别人的区间当成你的。要重来就在本页重新点「开始记录」。'
              : isRecording
                ? `记录中：已记录 ${durationText}、${timelineTotal} 条操作（点「结束并导出」打包）`
                : lastFinished
                  ? '上次记录已结束（窗口封存在服务端）：点「结束并导出」按那一段取数据打包。'
                  : '当前未记录。点「开始记录」后再去复现问题。'
          }}
        </span>
      </div>

      <!-- 记录窗口的存活范围（如实写明） -->
      <div class="text-caption text-medium-emphasis mb-3">
        记录窗口记录在<b>服务端</b>（不在这个页面里）：只要本程序还在运行，切页、刷新、关掉浏览器再打开都<b>不中断</b>记录，
        时长按服务端记下的开始时刻补算；<b>关掉本程序再启动就是新的一次运行、从「未记录」开始</b>（不会继承上一次的窗口）。
        导出只取这段窗口内的服务端日志与操作时间线（最多 {{ DIAG_TIMELINE_MAX }} 条，超出时保留最早
        {{ DIAG_TIMELINE_HEAD_KEEP }} 条 + 最新若干条，并在包里写明）。
        <span v-if="windowStartedText">本次窗口：{{ windowStartedText }} 开始。</span>
      </div>

      <!-- 只结束、先不导出（用户可能想先停下、过会儿再导）——走同一个 stop 接口，窗口仍保留在服务端 -->
      <div v-if="isRecording" class="mb-3">
        <v-btn size="small" variant="tonal" color="primary" :disabled="exporting || stopping" :loading="stopping" @click="stopOnly">
          只结束记录（先不导出）
        </v-btn>
        <span class="text-caption text-medium-emphasis ml-2">结束后的窗口会保留在服务端，随时可以再点「结束并导出」。</span>
      </div>

      <!-- 窗口被别的标签页换掉：导出已禁用，并给一条"重来"的明确动作（审计 B4 加强） -->
      <v-alert v-if="superseded" type="error" variant="tonal" density="comfortable" class="mb-3">
        本页这一次记录已经作废：服务端的记录窗口被换成了 {{ serverWindow?.id || '（无）' }}（本页原来是 {{ myWindowId }}）。
        多半是另一个标签页点了「开始记录」—— 同一个程序里同时只有一个记录窗口。
        <div class="mt-2">
          <v-btn size="small" color="error" variant="flat" :disabled="starting || exporting" :loading="starting" @click="startRecording">
            在本页重新开始记录
          </v-btn>
        </div>
      </v-alert>

      <!-- 🆕 2026-09-22（审计 B8）：服务端状态相关的提示必须真的显示出来 ——
           以前 serverMessage 写了 5 处、模板从不渲染，失败原因用户根本看不见（只有标题旁一个小 chip） -->
      <v-alert v-if="serverMessage" :type="serverOk === false ? 'error' : 'warning'" variant="tonal" density="comfortable" class="mb-3">
        {{ serverMessage }}
      </v-alert>

      <div v-if="exportError" class="text-body-2 text-error mb-3">{{ exportError }}</div>

      <!-- ③ 导出前先看：这个包里会包含什么 + 隐私说明 -->
      <div class="text-body-2 font-weight-bold mb-1">这个包里会包含什么</div>
      <ul class="pl-5 mb-2">
        <li v-for="(m, i) in manifestPreview" :key="i" class="text-body-2">
          <span class="text-medium-emphasis">{{ i + 1 }}.</span>
          <b>{{ m.name }}</b> —— {{ m.note }}
        </li>
      </ul>
      <v-alert :type="includeGeometry ? 'warning' : 'success'" variant="tonal" density="comfortable" class="mb-3">
        <span v-if="includeGeometry">
          隐私说明：包内不含 token 明文（只留长度与前后各 4 位用于核对），学号与姓名已掩码；
          因为上方的开关是打开的，所以包含你描过的跑道与任务的坐标。
        </span>
        <span v-else>
          隐私说明：包内不含 token 明文（只留长度与前后各 4 位用于核对），学号与姓名已掩码；
          因为上方的开关是关闭的，所以不含跑道与任务的坐标。
        </span>
      </v-alert>

      <!-- ④ 坐标开关（随窗口一起保存在服务端；记录中也能改，改完立刻同步到服务端窗口） -->
      <v-switch
        v-model="includeGeometry"
        color="primary"
        density="compact"
        hide-details
        :disabled="exporting"
        label="包含跑道/任务坐标（关掉后包内不含经纬度，只保留点数）"
      />
      <div class="text-caption text-medium-emphasis mb-2">
        关掉这项后：轨迹拟合度之类的坐标证据就没有了，开发者只能看结构与点数。
        <span v-if="isRecording">记录中也可以改 —— 改动会同步保存到服务端窗口，刷新后不会悄悄回到默认值。</span>
        <span v-else-if="geometrySyncError" class="text-warning">{{ geometrySyncError }}</span>
      </div>

      <div class="text-caption text-medium-emphasis">
        注意：导出时按上面那个记录窗口取服务端日志一起打包（由服务端自己读取，不进浏览器）。
        若本页手里的窗口与服务端当前窗口对不上（例如程序重启过、或另一个标签页换了窗口），
        导出会被拦下并告诉你怎么重来 —— 不会悄悄把最近 {{ logDays }} 天的全量日志当成你这一次记录发出去。
        导出的文件名形如 totoro-diagnostics-{{ fileNameSample }}.zip。
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
/**
 * 「诊断记录（导出给开发者）」卡片（2026-09-21 新增）
 *
 * 放在「数据 → 日志」页里（`components/LogsView.vue` 引它），**不新建页面**：
 * 新页面要改导航接线、容易触发守卫问题。
 *
 * 三件事：
 *   ① 把「怎么操作」写清楚（用户明确要求，见 STEPS）；
 *   ② 采集一份**已脱敏**的快照（结构 = `utils/mp/diagnostics.ts` 的 `DiagSnapshot`）；
 *   ③ POST 到 `DIAG_EXPORT_PATH`，拿回 zip 二进制并触发浏览器保存。
 *
 * 🔴 隐私红线（与契约层同一口径）：
 *   · **token 明文绝不进快照**：只放 `hasToken` 与 `tokenFingerprint()`（长度 + 前后各 4 位）；
 *   · 学号 / 姓名一律走 `maskId()` / `maskName()`；
 *   · 快照落盘前再跑一次契约层的 `assertNoCredentials()` —— 命中就**拒发**并把原因显示出来；
 *   · 时间线只取 `at / level / cat / text` 四个字段，**不带**事件日志的 `data`（那里可能藏细节）。
 */
import type { LogLevel } from '~/utils/mp/logFormat'
import {
  DIAG_EXPORT_PATH,
  DIAG_LOG_DAYS,
  DIAG_LOG_DIR,
  DIAG_RECORD_GEOMETRY_PATH,
  DIAG_RECORD_PATH,
  DIAG_RECORD_START_PATH,
  DIAG_RECORD_STOP_PATH,
  DIAG_TIMELINE_HEAD_KEEP,
  DIAG_TIMELINE_MAX,
  assertNoCredentials,
  diagManifestEntries,
  diagTimelineInWindow,
  diagWindowMatch,
  maskId,
  maskName,
  maskPhone,
  maskDigitRuns,
  tokenFingerprint,
  type DiagLastKnown,
  type DiagSnapshot,
  type DiagWindow,
} from '~/utils/mp/diagnostics'
import { TASK_CACHE_KEY, useRealState } from '~/composables/real/state'
// 🆕 2026-09-22（issue #12）：任务形状一行摘要（"下发了线路没有 / 下发了拟合度阈值没有"）进诊断包
import { taskShapeLine } from '~/utils/mp/taskShape'
// 共享域常量（会话里没写 baseUrl 时的兜底展示值）
import { MP_DEFAULT_BASE_URL } from '~/src/wrappers/MpApiWrapper'
// 路线库的键名/归一化都在纯逻辑层（不自己再声明一份键名）
import { TRACK_LIBRARY_KEY, normalizeLibrary } from '~/utils/mp/trackLibrary'
import type { TrackRouteEntry } from '~/utils/mp/trackLibrary'
// 🆕 2026-09-22：任务本体可能被"缓存包装 / API 信封"包了几层 —— 取值判据在纯逻辑层（有单测）
import { extractTaskFromCachePayload, looksLikeTask } from '~/utils/mp/realCache'
// 🆕 2026-09-22：「最近一次成功读取时的状态」（纯诊断证据，**不参与放行判断**）
import { buildLastKnown, lastKnownSummary, readLastKnown } from '~/utils/mp/diagLastKnown'
// 🆕 2026-09-22（审计可疑 6）：坐标字段名**只有一份**（与服务端剥 respBody 坐标共用）
import { COORD_KEYS } from '~/utils/mp/responseRecord'

const logs = useEventLog()
const showSnackbar = useNotice()
const route = useRoute()
const appConfig = useAppConfig()

const mpSession = useMpSession()
const real = useRealState()
const { task, profile, switches, cameraFlag, cameraFlagLineId, cameraFlagError } = real
/**
 * 🆕（审计 B7）演示模式标记：演示数据**不该**被当成本机真实读取的证据（老实现没传它 ⇒ 会被记成 `ready`）。
 * `demoMode` 由 `useMpDemo()` 持有（`composables/demo/state.ts`；`useRealState()` 不导出它）。
 */
const demo = useMpDemo()
const demoActive = demo.demoMode
const realData = useMpReal()
const gate = realData.gateStatus

/** 导出完成后的提示语（用户要把它连同 zip 一起发出来，所以写全） */
const SUPPORT_EMAIL = 'dboycht@qq.com'

/** 操作说明（**按顺序、可照做**；用户明确要求把它写清楚） */
const STEPS = [
  '点下面的「开始记录」（点完它会一直记着：你在哪个页面、点了什么；中途切到别的页面不会中断记录）。',
  '按顺序复现问题。例：工作台点「读取真实账号与任务」→ 进「跑步」看线路下拉里有没有线路 → 进「跑道编辑」描一条并保存 → 回到「跑步」再点「真实提交」。',
  '回到本页点「结束并导出」，浏览器会下载一个 zip。',
  `把下载到的 zip 发到 ${SUPPORT_EMAIL}，附一句你遇到的症状（例如：研究生院看不到线路可选）。`,
]

// ---- 记录状态（🆕 2026-09-22：**服务端锚定的记录窗口**） ----
/**
 * 🔴 为什么不再用页面内存态（含 `useState`）—— issue #12 的两次返工：
 *
 * · 第一版用组件局部 `ref`：点「开始记录」→ 去别的页面复现 → 组件**卸载**再回来时归零，
 *   用户**无法「结束并导出」**（原话："记录好像被重置了，又变成点击开始记录了"）；
 * · 第二版改用 `useState`：**切页**不丢了，但**刷新浏览器就丢** —— 用户随后明确纠正：
 *   "刷新为什么会丢？我们要做的是**软件层面上的所有服务进行记录**"、
 *   "要求他的生命周期是基于我们运行的 exe 的，而不是刷新一下的实例"。
 *
 * 现在的口径：窗口由**服务端**持有（`server/utils/diagSession.ts`，进程内存为主 + `diagnostics/session.json` 为辅），
 * 且带**进程实例标识**。本组件只做三件事：
 *   ① `onMounted` 时 `GET /api/local/diagnostics/record` **恢复**状态与"已记录多久"（时长按服务端 `startedAt` 算）；
 *   ② 按钮调 `start` / `stop` 接口；③ 导出前先 `stop`（封存窗口）再采集快照。
 * ⇒ 刷新页面 / 切页 / 关掉浏览器再打开，只要 EXE 还在跑就仍在记录；**关掉 EXE 再启动从零开始**。
 */
/** 服务端窗口（`recording:true` = 正在记录；`false` = 已封存，"最近一次"仍可用于导出） */
const serverWindow = useState<DiagWindow | null>('diagServerWindow', () => null)
/** 服务端算好的"已记录多少秒"（刷新后靠它补算，不归零） */
const serverElapsed = ref(0)
/** `null` = 还没问到；`false` = 服务端读不到（此时导出会被拦下并提示，不再静默降级） */
const serverOk = ref<boolean | null>(null)
/**
 * 🆕（审计 B2）服务端**进程实例标识**：随快照一起上报，让服务端能区分
 * "窗口被别的标签页换掉了"与"本程序重启过"（两种提示语对用户更贴切）。
 */
const serverInstanceId = ref('')
const serverMessage = ref('')
/**
 * 🆕 2026-09-23 **响应原文留档（captures）的占用**：用户要求"响应原文必须完整可分析"，
 * 原文单独成文件存在本机 `captures/` 目录；这几个数由 `GET /api/local/diagnostics/record` 捎回来，
 * 用于「这个包里会包含什么」那一行如实报出"现在攒了多少、占多大、预算多大、淘汰过几份"。
 */
const captureFiles = ref(0)
const captureUsedBytes = ref(0)
const captureBudgetBytes = ref(0)
const captureDroppedFiles = ref(0)
const captureDroppedBytes = ref(0)
/**
 * 坐标开关：**以服务端窗口里的为准**（刷新后从服务端读回）。
 * 用一个局部 ref 承接 `v-switch` 的 v-model，再 watch 它 PATCH 到服务端（见下面的两个 watch）。
 */
const includeGeometry = ref(true)
/** 最近一次试图同步坐标开关失败的原因（只在**不再记录**时显示，避免刷屏） */
const geometrySyncError = ref('')
const starting = ref(false)
/** 「只结束记录（先不导出）」进行中 */
const stopping = ref(false)
/**
 * `exporting` / `exportError` 仍放 `useState`：它们描述的是**这一次导出**而不是"这一次组件挂载"，
 * 留在局部会在导出途中切页时留下两种坏状态（按钮不再禁用 ⇒ 能重复点出两个 zip；报错原因随组件消失）。
 */
const exporting = useState('diagExporting', () => false)
const exportError = useState('diagExportError', () => '')
const windowStartedText = ref('')

let timer: ReturnType<typeof setInterval> | null = null
/**
 * 🆕 2026-09-22（审计 B4）：**轮询服务端窗口状态**的定时器。
 *
 * 为什么必须有它（原先注释写着"onMounted 与轮询都走它"，但**其实没有轮询**）：
 * 服务端只有**一个**窗口，而"开始记录"没有守卫 ⇒ 另一个标签页点「开始记录」会**直接覆盖**它；
 * 本页却还显示着旧窗口/"上次记录已结束 · 可导出"，用户点导出才发现不对（这时服务端已按 409 拒了，
 * 但界面**事先**就该如实反映"记录被换掉了"）。轮询让界面自己先跟上真相。
 */
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 本实例是否还活着：导出/请求是异步的，切页后旧实例不能再起一个**没人清**的定时器 */
let alive = true
/**
 * 一次请求的**上限耗时**（审计 B7）：服务端"接住不回"时，没有超时会让按钮**永久 loading/禁用**
 * （用户只能刷新页面）。诊断是辅助功能，宁可超时报失败也不能把界面锁死。
 */
const REQ_TIMEOUT_MS = 30_000
/** 读状态是轻量 GET：给它更短的超时（8 秒），别让"服务端没起"这种常见情况拖住界面 */
const POLL_TIMEOUT_MS = 8_000
/** 窗口状态轮询间隔 */
const POLL_INTERVAL_MS = 10_000
/** 是否已经成功读回过一次服务端状态（用来区分"首次恢复"与"轮询发现变了"） */
let stateLoadedOnce = false
/**
 * 🆕 2026-09-22：「最近一次成功读取时的状态」的**界面态**（用于预览文案）。
 * 采集口只有一处（`captureLastKnown()`），挂载时先读一次 `localStorage`（刷新后仍能显示上次的证据）。
 */
const lastKnownForPreview = ref<DiagLastKnown | null>(null)
/**
 * 🔴（审计 B4 的实测加强版）**本页这一次记录**的窗口 id。
 *
 * 为什么不能把"服务端当前窗口"直接当成"我要导的那一段"（真实浏览器实测抓到）：
 * 另一个标签页点「开始记录」会把服务端那个**唯一**的窗口覆盖掉；本页的轮询如果只是
 * "把服务端窗口收下来"（`applyWindow`），那么用户点「结束并导出」时服务端窗口**确实**等于快照里那个
 * ⇒ 409 闸门不会触发、`X-Diag-Window` 也一致 ⇒ **导出的却是另一次记录的区间**（用户毫不知情）。
 * 所以这里把"本页这一次记录"单独记下来：**只有服务端窗口 = 它时才允许导出**。
 */
const myWindowId = ref('')
/** 服务端窗口已经不是本页这一次记录了（被另一个标签页换掉 / 程序重启）⇒ 禁止导出并说明原因 */
const superseded = computed(() => Boolean(myWindowId.value) && (serverWindow.value?.id ?? '') !== myWindowId.value)
/** 一次请求的超时信号（`AbortSignal.timeout` 在目标浏览器里可用；不支持时返回 undefined，行为退回"没有超时"） */
const timeoutSignal = (ms: number): AbortSignal | undefined => {
  const t = (AbortSignal as { timeout?: (n: number) => AbortSignal })?.timeout
  return typeof t === 'function' ? t(ms) : undefined
}

const isRecording = computed(() => Boolean(serverWindow.value?.recording))
const lastFinished = computed(() => Boolean(serverWindow.value && !serverWindow.value.recording))
/** 有没有可导出的窗口（**必须是本页这一次记录的窗口**，见 `superseded`） */
const canExport = computed(() => Boolean(serverWindow.value) && !superseded.value)

const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}
const durationText = computed(() => formatDuration(serverElapsed.value))

/**
 * 🆕 2026-09-23 字节数的人话显示（captures 体量提示用）。
 * 口径：B / KB / MB / GB，保留 1 位小数（够用且不啰嗦）；负数与非有限值一律按 0。
 */
const formatBytes = (n: number): string => {
  const b = Number.isFinite(n) && n > 0 ? n : 0
  if (b < 1024) return `${Math.round(b)} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const stopTimer = () => {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * "到此刻为止记录了多少秒"——**唯一算法**：基准来自服务端（`GET`/`stop` 的 `elapsedSeconds`，刷新后不归零），
 * 之后每秒**由服务端的 `startedAtMs` 重新推算**（而不是 `+1`）。
 *
 * 为什么不是简单 `+1`（实测小坑）：后台标签页里 `setInterval` 会被浏览器节流到几十秒一次，
 * `+1` 会让界面时长**越走越慢**（与包里的 `durationSeconds` 对不上）；按 `startedAtMs` 推算则永远追平。
 * 同一台机器上浏览器与服务端时钟同源，所以这个推算不需要任何时区/漂移修正。
 */
const startTimer = () => {
  stopTimer()
  if (!alive || !isRecording.value || !serverWindow.value) return
  timer = setInterval(() => {
    const win = serverWindow.value
    if (!win || !win.recording) return
    serverElapsed.value = Math.max(serverElapsed.value, Math.round((Date.now() - win.startedAtMs) / 1000))
  }, 1000)
}

/** 把服务端返回的窗口写进本地状态（`null` = 本次运行没有窗口 ⇒ 显示"未记录"） */
const applyWindow = (win: DiagWindow | null, elapsedSeconds: number): void => {
  serverWindow.value = win
  serverElapsed.value = Math.max(0, Math.floor(elapsedSeconds || 0))
  if (win) includeGeometry.value = win.includeGeometry
  windowStartedText.value = win ? new Date(win.startedAtMs).toLocaleString() : ''
  startTimer()
}

/**
 * 读服务端状态。`onMounted` 与**每 `POLL_INTERVAL_MS` 一次的轮询**都走它（审计 B4：以前只有挂载读一次）。
 * ⚠️ 失败**不抛错、不阻塞**（服务端没起来时页面仍要能看）：标记 `serverOk=false`，
 * 界面上明说"读不到服务端记录状态"（`serverMessage` 现在**真的会渲染**出来）。
 */
async function refreshRecordState(): Promise<void> {
  try {
    const res = await fetch(DIAG_RECORD_PATH, { headers: { Accept: 'application/json' }, signal: timeoutSignal(POLL_TIMEOUT_MS) })
    if (!res.ok) {
      serverOk.value = false
      serverMessage.value = `读取服务端记录状态失败：HTTP ${res.status}`
      return
    }
    const data = (await res.json()) as { window?: unknown; elapsedSeconds?: unknown; serverInstance?: unknown; captures?: unknown }
    const win = isDiagWindow(data?.window) ? data.window : null
    const inst = (data?.serverInstance ?? null) as { instanceId?: unknown } | null
    if (typeof inst?.instanceId === 'string') serverInstanceId.value = inst.instanceId
    /** 🆕 响应原文留档的占用（给「这个包里会包含什么」那一行用；读不到就保持上一次的值） */
    const cap = (data?.captures ?? null) as { files?: unknown; usedBytes?: unknown; budgetBytes?: unknown; droppedFiles?: unknown; droppedBytes?: unknown } | null
    if (cap && typeof cap.files === 'number') {
      captureFiles.value = cap.files
      captureUsedBytes.value = typeof cap.usedBytes === 'number' ? cap.usedBytes : 0
      captureBudgetBytes.value = typeof cap.budgetBytes === 'number' ? cap.budgetBytes : 0
      captureDroppedFiles.value = typeof cap.droppedFiles === 'number' ? cap.droppedFiles : 0
      captureDroppedBytes.value = typeof cap.droppedBytes === 'number' ? cap.droppedBytes : 0
    }
    /**
     * 🆕（审计 B4）轮询到的窗口与界面手里那个"变了"时**如实提示**，让用户在导出**之前**就知道，
     * 而不是等导出被 409 拒。首次读回（刷新/切页回来）不算"变了"，正常恢复即可、不吓唬用户。
     */
    const prevId = serverWindow.value?.id ?? ''
    const nextId = win?.id ?? ''
    if (stateLoadedOnce && prevId !== nextId) {
      if (!nextId) {
        serverMessage.value = `服务端现在没有记录窗口了（之前是 ${prevId}）—— 多半是本程序重启过（重启后从零开始）。请重新点「开始记录」再复现一次。`
      } else if (!prevId) {
        // 首次之后才出现窗口：只可能是别处开了记录；本页**不**认领它（免得导出别人的区间）
        serverMessage.value = `服务端出现了一个新的记录窗口 ${nextId}（多半是另一个标签页点了「开始记录」）—— 它不是你这一页的记录，本页不会拿它导出。要记录就在本页重新点「开始记录」。`
      } else {
        serverMessage.value = `记录窗口已被换掉：之前是 ${prevId}，现在是 ${nextId} —— 多半是另一个标签页点了「开始记录」。本页这一次记录已经作废（导出按钮已禁用，避免把别人的区间当成你的）。要重来就在本页重新点「开始记录」。`
      }
      logs.log('warn', 'ui', '诊断记录：界面手里的窗口与服务端不一致（已按服务端刷新，且本页记录标记为已作废）', { prevId, nextId })
    }
    stateLoadedOnce = true
    /**
     * ⚠️ 这里只更新"服务端现在是什么"（标题芯片/时长用），**不更新 `myWindowId`**：
     * 本页这一次记录的窗口只有两处会变 —— 用户在本页点「开始记录」、或本页首次挂载时恢复服务端已有的窗口。
     * 否则轮询会把"别人的窗口"悄悄认领成本页的，导出就打到另一次记录的区间上了（实测抓到）。
     */
    if (!myWindowId.value && nextId) myWindowId.value = nextId
    applyWindow(win, typeof data?.elapsedSeconds === 'number' ? data.elapsedSeconds : 0)
    serverOk.value = true
  } catch (err) {
    serverOk.value = false
    const msg = err instanceof Error ? err.message : String(err)
    serverMessage.value = /abort|timeout/i.test(msg)
      ? `读取服务端记录状态超时（${Math.round(POLL_TIMEOUT_MS / 1000)} 秒）—— 本程序可能卡住了。`
      : `读取服务端记录状态失败：${msg}`
  }
}

/** 服务端返回的窗口结构自检（`DiagWindow` 的形状；服务端那边由白名单重建保证，这里再挡一层） */
function isDiagWindow(v: unknown): v is DiagWindow {
  return (
    Boolean(v) &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as DiagWindow).id === 'string' &&
    typeof (v as DiagWindow).startedAtMs === 'number' &&
    typeof (v as DiagWindow).recording === 'boolean'
  )
}

/** 调一个"改服务端窗口"的 POST/PATCH 接口（统一错误处理：失败只提示，不影响导出） */
async function callRecordApi(url: string, method: 'POST' | 'PATCH', body?: Record<string, unknown>): Promise<DiagWindow | null | undefined> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      // 审计 B7：没有超时会让"开始/结束"按钮永久 loading（服务端接住不回时只能刷新页面）
      signal: timeoutSignal(REQ_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as { ok?: unknown; session?: unknown }
    if (data?.ok === false) return null
    return isDiagWindow(data?.session) ? data.session : null
  } catch {
    // 网络层失败/超时：调用方会提示"服务端没回应"；记录本身仍在服务端（**不能**因为一次请求失败就清掉状态）
    return undefined
  }
}

const startRecording = async () => {
  if (starting.value || isRecording.value) return
  starting.value = true
  exportError.value = ''
  try {
    const win = await callRecordApi(DIAG_RECORD_START_PATH, 'POST', { includeGeometry: includeGeometry.value })
    if (win === undefined) {
      exportError.value = '开始记录失败：服务端没有回应（请确认本程序还在运行）。已按本机方式记录这次操作。'
      // 服务端不可用时**如实**标记：界面不假装"正在记录"（否则用户以为在记、其实导出时什么窗口都没有）
      serverOk.value = false
      serverMessage.value = '开始记录失败：服务端没有回应。'
      logs.log('error', 'ui', '开始诊断记录失败（服务端没有回应）')
      return
    }
    if (win === null) {
      exportError.value = '开始记录失败：服务端没有返回记录窗口。'
      logs.log('error', 'ui', '开始诊断记录失败（服务端未返回窗口）')
      return
    }
    applyWindow(win, 0)
    // 🆕（审计 B4 加强）本页这一次记录的窗口 = 刚建的这个；之后轮询到别的窗口只会提示、不会认领
    myWindowId.value = win.id
    serverOk.value = true
    serverMessage.value = ''
    logs.log('info', 'ui', `开始记录诊断（服务端窗口 ${win.id}，接下来请按顺序复现问题）`)
    showSnackbar('已开始记录（服务端窗口）：刷新/切页都不中断，回来点「结束并导出」', 'success', { timeout: 6000 })
  } finally {
    starting.value = false
    startTimer()
  }
}

/**
 * 「只结束记录（先不导出）」：把窗口**封存**在服务端（`recording:false` + `endedAt`），但不采集快照、不下载 zip。
 * 用途：用户想先停下（例如已经复现完了，但要先看看别的东西再导），或只想确认"记了多久"。
 * 封存的窗口**保留**在服务端 —— 「结束并导出」照样能用它，直到下一次点「开始记录」覆盖它。
 */
const stopOnly = async () => {
  if (stopping.value || exporting.value || !isRecording.value) return
  stopping.value = true
  try {
    const sealed = await callRecordApi(DIAG_RECORD_STOP_PATH, 'POST')
    /**
     * ⚠️ `null`（服务端**明确**回了"没有窗口"）与 `undefined`（没回应/超时）必须分开处置（审计 B2/B7）：
     * 以前两者都被静默吞掉，用户点了"结束"却什么都没发生，之后导出还会打到"无窗口"的服务端。
     */
    if (sealed === null) {
      const msg = serverWindow.value?.id
        ? `结束记录失败：服务端说"没有窗口"（本页还以为是 ${serverWindow.value.id}）—— 多半是本程序重启过，或另一个标签页把它换掉了。请刷新页面后重新记录。`
        : '结束记录失败：服务端说"没有窗口"（这次运行还没点过「开始记录」？）。'
      exportError.value = msg
      serverMessage.value = msg
      logs.log('error', 'ui', '结束诊断记录失败（服务端没有窗口）', { clientWindowId: serverWindow.value?.id ?? '' })
      return
    }
    if (sealed === undefined) {
      const msg = `结束记录失败：服务端 ${Math.round(REQ_TIMEOUT_MS / 1000)} 秒内没有回应（超时会自动结束等待，可重试）。`
      exportError.value = msg
      serverMessage.value = msg
      logs.log('error', 'ui', '结束诊断记录失败（服务端没有回应/超时）')
      return
    }
    // 「已记录多久」以服务端算出的为准（本地走秒只到这一刻，封存后不再增长）
    applyWindow(sealed, Math.max(serverElapsed.value, Math.round((sealed.endedAtMs - sealed.startedAtMs) / 1000)))
    exportError.value = ''
    serverMessage.value = ''
    logs.log('info', 'ui', `诊断记录已结束（窗口 ${sealed.id} 已封存，未导出）`)
    showSnackbar('已结束记录（窗口保存在服务端）：随时可以点「结束并导出」', 'success', { timeout: 6000 })
  } finally {
    stopping.value = false
  }
}

// 挂载（含**刷新后重新挂载**）时：先把服务端状态读回来（"已记录多久"由服务端给，不归零），再走秒 + 起轮询
onMounted(() => {
  /** 🆕 刷新后先把"最近已知状态"从 localStorage 读回来（预览要能显示上次读到过什么） */
  lastKnownForPreview.value = readLastKnown()
  void refreshRecordState()
  startTimer()
  // 🆕（审计 B4）轮询：另一个标签页换了窗口 / 服务端重启了，界面要在**导出之前**就跟上真相
  if (pollTimer === null) {
    pollTimer = setInterval(() => {
      if (!alive) return
      void refreshRecordState()
    }, POLL_INTERVAL_MS)
  }
})
onBeforeUnmount(() => {
  alive = false
  stopTimer()
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

/**
 * 坐标开关 ⇄ 服务端窗口的双向同步（记录中也允许改）：
 *   · 用户拨开关 ⇒ PATCH 到服务端窗口（这样刷新后读回来的还是用户的选择）；
 *   · 服务端窗口里的值变了（刚 start / 刚读回） ⇒ 同步到界面开关。
 * 两个 watch 都带"值相同就 return"的短路，否则会互相触发成环。
 *
 * 为什么值得做（而不"只在开始前选、记录中禁用"）：开关**只影响导出那一刻的采集**
 * （快照里是否带几何），中途改主意完全合理；而只读本地 ref 的话，刷新后开关会**悄悄回到默认值** ——
 * 导出内容与用户看到的不一致，那才是更坏的结果。
 */
watch(includeGeometry, (v) => {
  if (!serverWindow.value || serverWindow.value.includeGeometry === v) return
  void callRecordApi(DIAG_RECORD_GEOMETRY_PATH, 'PATCH', { includeGeometry: v }).then((win) => {
    if (win && win.includeGeometry === v) {
      serverWindow.value = win
      geometrySyncError.value = ''
      return
    }
    geometrySyncError.value = '坐标开关没能同步到服务端窗口（导出仍按界面上的选择采集，但刷新后可能回到服务端那份）。'
  })
})
watch(
  () => serverWindow.value?.includeGeometry,
  (v) => {
    if (typeof v === 'boolean' && v !== includeGeometry.value) includeGeometry.value = v
  },
)

// ---- 「这个包里会包含什么」（与服务端 manifest 共用同一个纯函数） ----
/**
 * ⚠️ 这里**故意不编造日志文件名**（审计 B8）：原先写的是
 * `logNames: ['（服务端按记录窗口筛选后列入，最多最近 3 天）']` —— 那不是文件名，展示出来像一条真日志。
 * 真实文件名只有服务端读过日志之后才知道，所以预览里只列"清单/快照/窗口"这几条稳定项，
 * 日志那一项由下面这条说明统一交代（与 `export.post.ts` 里 `logNote` 的口径一致）。
 */
const manifest = computed(() =>
  diagManifestEntries({
    logNames: [],
    includeGeometry: includeGeometry.value,
    logNote: serverWindow.value ? `只收录记录窗口 ${serverWindow.value.id} 内的日志行（真实文件名由服务端在包内清单里写明）` : '本次运行没有记录窗口 ⇒ 服务端会按最近若干天全量收录（包内清单里会写明）',
    window: serverWindow.value ? { id: serverWindow.value.id, startedAt: serverWindow.value.startedAt, endedAt: serverWindow.value.endedAt } : null,
  }),
)
/** 预览里额外补两条说明（`diagManifestEntries` 没有日志文件名时不会自己列） */
const manifestPreview = computed(() => {
  const items = manifest.value.slice()
  const at = items.findIndex((e) => e.name === '(说明)')
  items.splice(at < 0 ? items.length : at, 0, ...[
    {
      name: `${DIAG_LOG_DIR}/app-<日期>.log`,
      note: serverWindow.value
        ? `服务端文件日志，只保留记录窗口 ${serverWindow.value.id} 内的行（由服务端读取并筛选，最多回看 ${DIAG_LOG_DAYS} 天）`
        : `服务端文件日志：本次运行没有记录窗口 ⇒ 服务端按最近 ${DIAG_LOG_DAYS} 天全量收录并在包内清单写明`,
    },
    /**
     * 🆕 2026-09-22「全记录」（用户原话）：如实告诉用户"日志里现在多了什么、脱敏到哪一步"。
     * 这一条必须与 `utils/mp/responseRecord.ts` 的落盘口径逐句对应（脱敏四步那条链）。
     *
     * ⚠️ 文案里**不许出现 markdown 星号**（Vue 不渲染 markdown，用户会看到字面的 `**`）——
     * 审计 B11 实测这里漏过；`tests/mp/uiText.test.ts` 现在也会扫本组件的 note 字面量。
     */
    {
      name: `（日志内容说明：每个请求的 respShape / respBody / unpack）`,
      note:
        '服务端日志现在包含每个上游请求的响应结构摘要（顶层与嵌套键名、数组长度、状态码）与脱敏后的响应内容' +
        '（单条最多 32 KB，超出会按字节预算逐键填充并在 note 里注明截断与原始大小）；' +
        '响应里不含 token 明文（按字段名掩码 + 凭证样式串只留长度），学号/姓名/手机号已打码；' +
        `${includeGeometry.value ? '坐标（经纬度）会随响应内容一起记录（上面的开关是打开的）' : '坐标（经纬度）已在导出时按上面的开关剔除'}` +
        '——注意：服务端日志始终会记录坐标（除非导出时按上面这个开关剔除），' +
        '所以关掉开关的含义是"导出包里不含坐标"，而不是"本机不再记录坐标"；' +
        '若上游响应是"负载藏在信封里"的形状，还会写明 `unpack: suspect: <建议路径>`。',
    },
    /**
     * 🆕 2026-09-23 **响应完整原文**（captures）—— 用户原话：
     * 「裁剪的话要是有重要数据不就无法获得了？……主要是我们拿到数据进行分析」
     * ⇒ 每个请求的**完整**响应正文单独留档进包（已脱敏，**不裁单条**）；体积由本机总量预算 + 淘汰兜。
     * ⚠️ 文案里不许出现 markdown 星号（有守卫扫本组件的 note 字面量）。
     */
    {
      name: `（响应完整原文：${captureFiles.value} 份 / ${formatBytes(captureUsedBytes.value)}）`,
      note:
        `包含每个请求的完整响应原文（已脱敏；不做单条裁剪，便于直接拿去做分析），放在包内 captures/ 目录下，` +
        `每份都带一个同名 .meta.json（本机时间、端点、状态码、耗时、字节数、是否裁剪）。` +
        `本机累计 ${captureFiles.value} 份、约占 ${formatBytes(captureUsedBytes.value)}` +
        `${captureBudgetBytes.value ? `（总量预算 ${formatBytes(captureBudgetBytes.value)}，超出时按最旧先淘汰并记账）` : ''}；` +
        `${includeGeometry.value ? '坐标（经纬度）会随原文一起收录（上面的开关是打开的）' : '坐标已在导出时按上面的开关从这些原文里逐份剔除（文本响应的坐标无法逐字段剥离，会原样保留）'}。` +
        `${captureDroppedFiles.value ? `本机曾因预算淘汰过 ${captureDroppedFiles.value} 份（约 ${formatBytes(captureDroppedBytes.value)}），清单里列了文件名。` : ''}` +
        '与日志的区别：日志里的响应内容是"小而可读"的摘要（便于扫一眼），要完整数据看这里的原文。',
    },
    /**
     * 🆕 2026-09-22（用户原话："你刚刚说刷新后就丢了，我们直接丢之前记录下来不行吗"）：
     * 如实说明包里多了"最近一次成功读取时的状态"，并且明确写出它不用于放行 ——
     * 否则维护者可能拿它当"当前能不能提交"的依据（那正是最危险的误用）。
     */
    {
      name: `（最近已知状态：${lastKnownForPreview.value ? '有' : '无'}）`,
      note: lastKnownForPreview.value
        ? `包含最近一次成功读取时的状态（含开跑开关原值、摄像头杆 flag、当时的门禁终值）：${lastKnownSummary(lastKnownForPreview.value)} ` +
          '—— 这是历史证据，用于排查"读到过什么、后来为什么跑不了"；它不代表当前是否可提交，真实提交前必须重新读取（开关可能已变）。'
        : '这次快照里没有「最近已知状态」（本机还没成功读取过真实账号与任务，或那份记录已被清空）—— 读取成功后会自动记下。',
    },
  ])
  return items
})
const logDays = DIAG_LOG_DAYS

// ---- 小工具 ----
/** 读一个字符串字段（数组/对象一律当空） */
const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null || typeof v === 'object' ? '' : String(v))

/** 读一个数字字段；不是有限数就 null（契约里 km / 阈值都允许 null） */
const parseNum = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 读 localStorage 里的 JSON（不存在/损坏一律 null；**不抛错**） */
const readJson = (key: string): unknown => {
  if (!import.meta.client) return null
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

// ---- ④ 坐标剔除：关掉开关时，把任务 raw 里的坐标字段剥掉，**其它字段一个都不动** ----
/**
 * 需要剔除的字段名（**只认坐标本体**，不含 `pointId` / `pointName` / `pointCount` 这类描述性字段）：
 *   · `latitude` / `longitude`：单点坐标（实测 `pointList[i]` 就是这两个键）；
 *   · `lat` / `lng`：备用拼写（别的实现可能用短名）；
 *   · `pointList` / `sunrunPathPointList`：坐标点数组（线路点列、提交用的官方点列）；
 *   · `routeItudes`：厂商源码里"分号分隔的坐标串"（字段名拼写如此，见 `_mp-analyze/深挖`）。
 *
 * ⚠️ `runPointList` **不在**名单里：它是"线路列表"，剥掉它等于抹掉"任务里到底有几条线路"这个
 *    最关键的证据（issue #12 的问题恰恰是"没有线路可选"）。所以只剥**坐标本体**，保留线路条目。
 */
/**
 * 🔴 2026-09-22 审计（可疑 6）：名单**只有一份**，定义在 `utils/mp/responseRecord.ts`（服务端剥 `respBody`
 * 坐标用的是同一份）。这里 import 进来 —— 原先界面自己抄了一份、注释却写"同一份名单"，
 * 两边各改一边时"关掉坐标开关"就会只剥掉一半（隐私开关半失效）。
 */

/** 递归剥掉坐标字段（返回**新对象**，不改原对象；非对象原样返回） */
function stripGeometry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripGeometry(v))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (COORD_KEYS.has(k)) continue
    out[k] = stripGeometry(v)
  }
  return out
}

/** 兜底：万一任务 JSON 里混进了 token 字段，也一并剥掉（只按坐标名单剥是不够的） */
const TOKEN_KEYS = new Set(['token', 'accessToken', 'access_token', 'authorization', 'auth'])
function stripTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripTokens(v))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (TOKEN_KEYS.has(k)) continue
    out[k] = stripTokens(v)
  }
  return out
}

// ---- 🔴 身份脱敏：把"本机事件日志的自由文本"等**任意值**里的学号/姓名/手机号也掩掉 ----
/**
 * 为什么还要这一层（2026-09-21 实测抓到）：本机事件日志的 `msg` 是**自由文本**，
 * 里面可能整句写着身份信息 —— 实测灌入一条 `读到学生档案 ${学号} ${姓名}` 的日志后，
 * 快照的 `timeline[].text` 就把**原始学号与姓名原样带了进去**（日志自身只按"字段名"脱敏，
 * 对 `msg` 这种字符串不做处理）⇒ 直接违反"学号/姓名一律掩码"的红线。
 *
 * 判据（可执行）：把**档案里的敏感原值**当作查找表，在任意结构的字符串里逐字替换成掩码形式。
 *   · 学号 → `maskId()` 的结果（`2021101234` → `20******34`）
 *   · 姓名 → `maskName()` 的结果（`张小明` → `张**`）
 *   · 手机号 → `maskPhone()` 的结果
 * 另外用一条**数字形态兜底**（8~18 位纯数字 ≥ 8 位 ⇒ 掩码）：同学号可能以别的拼写出现在错误文案里
 * （例："未找到用户 2021101234"），只靠"原值替换"会漏。手机号形态（11 位、1 开头）走 maskPhone 口径。
 *
 * ⚠️ 这层只做"就地替换"，**不改任何字段名、不删任何字段**；值里没有敏感原值时原样返回。
 */
/**
 * 数字兜底掩码走**契约层的纯函数** `maskDigitRuns()`（`utils/mp/diagnostics.ts`，有单测）——
 * 它顺带把诊断**记录窗口 id** 排除在外：实测抓到过 `w-20260922-130240-c41da2` 被当学号掩成
 * `w-20****22-130240-c41da2`，那样维护者就没法把时间线与窗口/日志区间对上了。
 */
const maskDigitRun = (s: string): string => maskDigitRuns(s)

/** 从档案里取"必须掩掉的敏感原值 → 掩码后"的对照表（值太短的字符串不做替换，避免误伤普通文本） */
function sensitivePairs(): { raw: string; masked: string }[] {
  const prof = profile.value
  const userInfo = mpSession.userInfo.value
  const pairs: { raw: string; masked: string }[] = []
  const add = (raw: unknown, masked: string) => {
    const v = String(raw ?? '').trim()
    if (v.length >= 2 && v !== masked && !pairs.some((p) => p.raw === v)) pairs.push({ raw: v, masked })
  }
  const snCode = prof?.snCode || userInfo?.snCode
  const studentName = prof?.studentName || userInfo?.studentName || userInfo?.name
  add(snCode, maskId(snCode))
  add(studentName, maskName(studentName))
  const phone = userInfo?.phone
  add(phone, maskPhone(phone))
  // 长的先替换：学号若被包在更长的串里，先替长的不会破坏短的匹配
  return pairs.sort((a, b) => b.raw.length - a.raw.length)
}

/** 递归把任意值里的敏感原值换成掩码（返回**新值**，不改原对象） */
function redactSensitive(value: unknown, pairs: { raw: string; masked: string }[]): unknown {
  if (typeof value === 'string') {
    let s = value
    for (const p of pairs) s = s.split(p.raw).join(p.masked)
    return maskDigitRun(s)
  }
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, pairs))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = redactSensitive(v, pairs)
  return out
}

/** 掩掉一段自由文本里的身份信息（时间线文案用） */
const redactText = (text: string, pairs: { raw: string; masked: string }[]): string => {
  let s = String(text ?? '')
  for (const p of pairs) s = s.split(p.raw).join(p.masked)
  return maskDigitRun(s)
}

// ---- 任务摘要（字段名以**真实任务 JSON** 为准，见 `src/mp/models.ts` 的 `MpSunrunTask`） ----
/**
 * 真实任务对象的键是 `taskId` / `paperName` / `mileage` / `fitDegree` / `startDate` / `endDate` /
 * `runPointList`（9-14 实测 + `src/mp/demo.ts` 的 DEMO_TASK 逐字对齐）。契约里的字段名
 * （`paperId` / `taskName` / `km` / `fitDegreeThreshold` / `validFrom` / `validTo`）是**通用叫法**，
 * 所以这里做一次显式映射，并给一个"另一个拼写也在"的兜底读取，避免任务 JSON 换拼写时读成空。
 */
const readFirst = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function taskSummaryOf(rawTask: Record<string, unknown> | null): DiagSnapshot['task']['summary'] {
  if (!rawTask) {
    return {
      paperId: '',
      paperName: '',
      taskName: '',
      km: null,
      fitDegreeThreshold: null,
      validFrom: '',
      validTo: '',
      runPointListCount: 0,
      // 没有任务时不写形状摘要（空串 = "没有任务"，避免 `route=free(0)` 被误读成"这个任务没下发线路"）
      shapeLine: '',
    }
  }
  const list = rawTask.runPointList
  return {
    paperId: asText(readFirst(rawTask, ['taskId', 'paperId'])),
    paperName: asText(readFirst(rawTask, ['paperName', 'name'])),
    // 真实任务 JSON 里只有 paperName —— taskName 取同一个值（契约要求有这一项）
    taskName: asText(readFirst(rawTask, ['taskName', 'paperName'])),
    km: parseNum(readFirst(rawTask, ['mileage', 'km'])),
    fitDegreeThreshold: parseNum(readFirst(rawTask, ['fitDegree', 'fitDegreeThreshold'])),
    validFrom: asText(readFirst(rawTask, ['startDate', 'validFrom'])),
    validTo: asText(readFirst(rawTask, ['endDate', 'validTo'])),
    runPointListCount: Array.isArray(list) ? list.length : 0,
    /**
     * 🆕 2026-09-22（issue #12）：`route=line(2) fit=required(0.6)` 这种一行摘要 ——
     * **与门禁/自检用的是同一个纯函数**（`utils/mp/taskShape.ts`，有单测），
     * 所以排障时"界面为什么这样判"与"包里写了什么"必然一致。
     */
    shapeLine: taskShapeLine(rawTask),
  }
}

function taskLineSummaries(rawTask: Record<string, unknown> | null): DiagSnapshot['task']['lines'] {
  const list = rawTask && Array.isArray(rawTask.runPointList) ? rawTask.runPointList : []
  const topTaskId = rawTask ? asText(readFirst(rawTask, ['taskId', 'paperId'])) : ''
  return list.filter(isPlainObject).map((l) => {
    const points = Array.isArray(l.pointList) ? l.pointList : []
    return {
      pointId: asText(l.pointId),
      pointName: asText(l.pointName),
      pointCount: points.length,
      taskId: asText(l.taskId) || topTaskId,
      campusName: asText(readFirst(l, ['campusName', 'schoolCampusName'])),
    }
  })
}

// ---- 路线库（localStorage `mp_track_library_v1`，键名与归一化都来自纯逻辑层） ----
function trackLibraryOf(includeGeo: boolean): DiagSnapshot['trackLibrary'] {
  const entries = normalizeLibrary(readJson(TRACK_LIBRARY_KEY), String(appConfig.version ?? '未知'))
  return {
    count: entries.length,
    includeGeometry: includeGeo,
    entries: entries.map((e: TrackRouteEntry) => ({
      lineId: String(e.lineId ?? ''),
      lineName: String(e.lineName ?? ''),
      outerPoints: Array.isArray(e.outer) ? e.outer.length : 0,
      innerPoints: Array.isArray(e.inner) ? e.inner.length : 0,
      createdAt: String(e.createdAt ?? ''),
      updatedAt: e.updatedAt,
      appVersion: e.appVersion,
      laneNo: e.laneNo,
      laneCount: e.laneCount,
      hasStartPoint: Boolean(e.start),
      ...(includeGeo ? { geometry: { outer: e.outer, inner: e.inner, ...(e.start?.point ? { startPoint: e.start.point } : {}) } } : {}),
    })),
  }
}

// ---- 时间线（🆕 **按记录窗口过滤** + `DIAG_TIMELINE_MAX` 上限兜底；只带 at/level/cat/text 四个字段） ----
/** 事件日志总条数（界面显示"记了多少条操作"用；导出的是**窗口内**那些） */
const timelineTotal = computed(() => logs.entries.value.length)

/**
 * 按窗口过滤 + 截断，**判据全在契约层的纯函数里**（`diagTimelineInWindow()`，有单测）——
 * 界面、服务端核对用的是同一份口径，避免"界面说 120 条、包里 87 条"这种对不上的情况。
 *
 * 为什么不再"只取最近 `DIAG_TIMELINE_MAX` 条"：长记录会把**最早**那段（含「开始记录」本身）挤掉，
 * 而那一段恰恰说明"从哪一步开始不对劲"。现在超上限时保留**最早 20 条 + 最新若干条**，并在 manifest 写明。
 */
function timelineOf(pairs: { raw: string; masked: string }[]): { items: DiagSnapshot['timeline']; stats: ReturnType<typeof diagTimelineInWindow>['stats'] } {
  const mapped = logs.entries.value.map((e) => ({
    at: String(e.t ?? ''),
    level: String(e.level ?? 'info') as LogLevel | string,
    cat: String(e.cat ?? ''),
    // ⚠️ 文案过一遍身份脱敏：日志的 msg 是自由文本，可能整句带着学号/姓名
    text: redactText(String(e.msg ?? ''), pairs),
  }))
  const win = serverWindow.value
  const filtered = diagTimelineInWindow(mapped, win ? { startedAtMs: win.startedAtMs, endedAtMs: win.recording ? 0 : win.endedAtMs } : null)
  return { items: filtered.items, stats: filtered.stats }
}

// ---- 采集快照（逐字段对齐 `DiagSnapshot`） ----
function buildSnapshot(): DiagSnapshot {
  const includeGeo = includeGeometry.value
  const now = new Date()
  const session = mpSession.session.value
  const userInfo = mpSession.userInfo.value
  const prof = profile.value

  /**
   * 读原始任务 JSON（localStorage 缓存里的 `task`，**token 在同一个负载的另一个字段上、不在 task 里**）。
   * ⚠️ 返回的 raw 就是**原始对象**（未经剥离）—— 摘要在它上面算，按开关剥离只作用于 `raw` 那一个字段。
   * 若先在 raw 上剥坐标再算摘要，关掉开关时 `pointCount` 会全变 0，"到底下发了几条线路、每条几个点"
   * 这条最关键的证据就没了（关开关不等于把证据清零）。
   */
  /**
   * 🔴 2026-09-22（真实用户诊断包暴露的**我们自己的** bug）：取任务本体。
   *
   * 故障：此前只做 `payload.task` 一层读取。真实用户的缓存里 `task` 是**API 响应信封**
   * （`{code, data:{runPointList:[…]}, sunrunTaskList:[…]}`）⇒ 顶层 `runPointList` 读成 0 条，
   * `shapeLine` 得出 `route=free(0)` 的错误结论，"任务到底有没有线路"这个核心证据被读反。
   *
   * 现在的口径（顺序即优先级）：
   *   ① **内存里的真实任务**（`useMpReal()` 的 `task`，即 `composables/real/data.ts` 里那份，最可信）；
   *   ② 缓存：`extractTaskFromCachePayload()`（纯函数、有单测）——
   *      先 `cache.task`（兼容"旧缓存直接存任务"），再逐层解 `data/obj/body` 与任务数组，
   *      每层都要求"看起来像任务"才收。
   *
   * `raw` 里写的就是**这个任务对象**（不是信封、不是包装），摘要/线路/`shapeLine` 全部基于它，
   * 三者因此必然自洽；取自哪里另记 `taskSource` 进 manifest 便于排查。
   */
  const { rawTask, taskSource } = ((): { rawTask: Record<string, unknown> | null; taskSource: string } => {
    // ① 内存里的真实任务（最可信；`buildSnapshot` 只在浏览器里跑，那里 `task` 就是 `paper.data`）
    if (isPlainObject(task.value) && looksLikeTask(task.value)) {
      return { rawTask: task.value as unknown as Record<string, unknown>, taskSource: 'memory(useMpReal.task)' }
    }
    // ② 缓存（可能被包了好几层：`{at,task}` 包装、或 `{code,data}` 信封）
    const payload = readJson(TASK_CACHE_KEY)
    if (!isPlainObject(payload)) return { rawTask: null, taskSource: 'none' }
    const r = extractTaskFromCachePayload(payload)
    return { rawTask: r.task, taskSource: r.task ? r.source : 'none' }
  })()
  // 敏感原值对照表：**同一份快照里的所有文本共用这一张**（时间线文案 + 任务原文）
  const pairs = sensitivePairs()
  /** 进包的任务原文：按开关剥坐标（关掉时）+ 剥 token 字段 + 掩掉文本里的学号/姓名 */
  const taskForExport = rawTask === null ? null : redactSensitive(stripTokens(stripGeometry(rawTask)), pairs)
  /** 时间线：按**记录窗口**过滤 + 上限兜底（判据在契约层纯函数里） */
  const timeline = timelineOf(pairs)
  const win = serverWindow.value
  /**
   * 🆕 2026-09-22（用户原话："刷新后就丢了，我们直接丢之前记录下来不行吗"）：
   * **最近一次成功读取时的状态** —— 用**当前实时状态**重建一份用于**显示**（实时有值就是"刚刚读到"，
   * 实时为空就退回 `localStorage` 里那份历史证据）。
   *
   * 🔴 闸门复验修正：这里**只读不写**（`captureLastKnown()` 内部不再 `saveLastKnown()`）。
   * 老实现"顺带写回 localStorage"会把 17:10 那份**好证据**覆盖成"有 task、无 switches"的新记录
   * （连 `at` 都被盖成导出时刻）—— 正是这条功能要救的现场。**写点只有一个**：
   * `composables/real/data.ts` 的 `loadRealData()` 成功读取之后。
   *
   * 🔴 **不参与任何放行判断**（门禁只认实时 `switches`/`cameraFlag`），这一点写在 `diagLastKnown.ts` 文件头。
   */
  const lastKnown = captureLastKnown()

  return {
    collectedAt: now.toISOString(),
    collectedAtMs: now.getTime(),
    appVersion: String(appConfig.version ?? 'dev'),
    userAgent: import.meta.client ? String(navigator.userAgent ?? '') : '',
    route: String(route.fullPath ?? ''),
    session: {
      hasToken: Boolean(mpSession.token.value),
      tokenFingerprint: tokenFingerprint(mpSession.token.value),
      baseUrl: String(session?.baseUrl ?? MP_DEFAULT_BASE_URL),
      schoolCode: String(prof?.schoolCode ?? userInfo?.schoolCode ?? ''),
      schoolName: String(prof?.schoolName ?? userInfo?.schoolName ?? ''),
      campusId: String(prof?.campusId ?? userInfo?.schoolCampusCode ?? ''),
      campusName: String(prof?.campusName ?? userInfo?.schoolCampusName ?? ''),
      // 🔴 学号 / 姓名只以掩码形式进快照（契约层的掩码工具是唯一出口）
      snCode: maskId(prof?.snCode ?? userInfo?.snCode ?? ''),
      studentName: maskName(prof?.studentName ?? userInfo?.studentName ?? userInfo?.name ?? ''),
    },
    task: {
      present: Boolean(rawTask),
      /** 🆕 任务本体取自哪里（`memory(useMpReal.task)` / `cache.task` / `cache.data(obj,runPointList)` / `none`） */
      source: taskSource,
      // 摘要与线路清单**永远**从原始对象算（含点数）——与坐标开关无关
      summary: taskSummaryOf(rawTask),
      lines: taskLineSummaries(rawTask),
      raw: taskForExport,
    },
    trackLibrary: trackLibraryOf(includeGeo),
    gate: {
      allow: typeof gate.value?.allow === 'boolean' ? gate.value.allow : null,
      reason: String(gate.value?.reason ?? ''),
      blockedBy: String(gate.value?.blockedBy ?? ''),
      switches: switches.value,
      cameraFlag: cameraFlag.value,
      cameraFlagLineId: String(cameraFlagLineId.value ?? ''),
      cameraFlagError: String(cameraFlagError.value ?? ''),
    },
    timeline: timeline.items,
    /** 🆕 这一次时间线的账（服务端会复算核对；维护者据此判断"是没操作还是被截断"） */
    timelineStats: timeline.stats,
    /** 🆕 这一份快照是**为哪个窗口**采集的（服务端会与它自己那份核对，不一致会**拒绝导出**并说明原因） */
    window: win ? { id: win.id, startedAt: win.startedAt, endedAt: win.endedAt, includeGeometry: win.includeGeometry } : null,
    /** 🆕 采集时界面见过的服务端实例（服务端据此把提示语写准："程序重启过" vs "窗口被换掉"） */
    serverInstanceId: serverInstanceId.value,
    /**
     * 🆕 2026-09-22：**最近一次成功读取时的状态**（含开关原值 / 摄像头杆 flag / 当时的门禁终值）。
     * 专门用来回答"他读到过什么、后来为什么跑不了"这类现场问题（刷新会丢实时态，这份不会）。
     * 🔴 它**不参与放行判断**；真实提交前必须重新读取（开关可能已变）。
     */
    lastKnown,
  }
}

/**
 * 采集「最近已知状态」：**当前实时态优先**（实时有值 = 刚刚读到），实时为空则退回 `localStorage` 里那份历史证据。
 * 🔴 **只读不写**（闸门复验修正）：写点只有一个 —— `composables/real/data.ts` 成功读取之后。
 * 这里若"顺带写回"，会把 17:10 那份好证据覆盖成"有 task、无 switches"的导出时刻记录（见下面的说明）。
 *
 * 🔴 2026-09-22 审计 B7（**正是这条功能要救的现场**）：
 * 老实现**每次都写盘**，于是"刷新后导出"会把 17:10 那份**好证据**（开关均无阻碍）覆盖成
 * "有 task、无 switches"的新记录 —— 连 `at` 都被盖成导出时刻、`gateAllow` 记成
 * `false / camera_unknown / 尚未选择跑步线路`（**与用户真实经历相反**）。
 * 现在：**只读不写**（写盘只在 `composables/real/data.ts` 真实读取成功那一刻发生）。
 * 拿到实时态时**只用它显示**（比旧值新、更准），但**绝不落盘覆盖**历史证据。
 *
 * 另外补齐 `lineId` / `lineRequired` / `demoMode`（老实现没传 ⇒ 演示数据会被记成 `ready`、
 * 当时的门禁终值会因为"没选线路"而算成 `camera_unknown`）。
 */
function captureLastKnown(): DiagLastKnown | null {
  const stored = readLastKnown()
  const session = mpSession.session.value
  const userInfo = mpSession.userInfo.value
  const prof = profile.value
  const rawTask = isPlainObject(task.value) ? (task.value as unknown as Record<string, unknown>) : null
  const lineId = String(cameraFlagLineId.value || '')
  const built = buildLastKnown({
    task: rawTask,
    schoolCode: String(prof?.schoolCode ?? userInfo?.schoolCode ?? ''),
    schoolName: String(prof?.schoolName ?? userInfo?.schoolName ?? ''),
    campusId: String(prof?.campusId ?? userInfo?.schoolCampusCode ?? ''),
    campusName: String(prof?.campusName ?? userInfo?.schoolCampusName ?? ''),
    snCode: String(prof?.snCode ?? userInfo?.snCode ?? ''),
    studentName: String(prof?.studentName ?? userInfo?.studentName ?? userInfo?.name ?? ''),
    phone: String(userInfo?.phone ?? ''),
    hasToken: Boolean(mpSession.token.value ?? session?.token),
    switches: switches.value,
    cameraFlag: cameraFlag.value,
    cameraFlagLineId: lineId,
    cameraFlagError: String(cameraFlagError.value ?? ''),
    lineId,
    // 任务没下发线路 ⇒ 门禁那条"未选线路"不拦（与真实提交口径一致，别把历史值算错）
    lineRequired: rawTask ? (Array.isArray(rawTask.runPointList) ? rawTask.runPointList.length > 0 : false) : undefined,
    demoMode: demoActive.value,
  })
  /**
   * 显示口径：**实时比已存"更新"且"证据更完整"时才用它**，否则用历史那份（它才是"读到过"的真正记录）。
   * "更完整"= 开关或摄像头杆是实时读到的（实时什么都没有时 `buildLastKnown` 返回 null）。
   */
  const live: DiagLastKnown | null = built && (built.switches || built.cameraFlag !== null) ? built : null
  const picked = live && (!stored || live.atMs >= stored.atMs) ? live : stored
  lastKnownForPreview.value = picked
  return picked
}

// ---- 落盘（触发浏览器保存） ----
const pad2 = (n: number) => String(n).padStart(2, '0')
/** 本地生成的文件名（响应头给了 Content-Disposition 就用响应头的） */
const suggestedFileName = (): string => {
  const d = new Date()
  return `totoro-diagnostics-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.zip`
}
const fileNameSample = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`
})

/** 从 Content-Disposition 里取文件名（拿不到就返回空串） */
const fileNameFromHeader = (cd: string | null): string => {
  if (!cd) return ''
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      return star[1]
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  return plain?.[1] ?? ''
}

/**
 * 把失败响应翻成**人话**（服务端可能回 JSON `{ message }`，也可能回纯文本 400/500）。
 * ⚠️ 绝不吞错：拿不到正文时也把 HTTP 状态码显示出来。
 */
async function humanReason(res: Response): Promise<string> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    body = ''
  }
  const trimmed = body.trim()
  if (trimmed) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>
      const msg = json.message ?? json.statusMessage ?? json.error ?? json.msg
      if (typeof msg === 'string' && msg) return `${msg}（HTTP ${res.status}）`
    } catch {
      return `${trimmed.slice(0, 400)}（HTTP ${res.status}）`
    }
    return `${trimmed.slice(0, 400)}（HTTP ${res.status}）`
  }
  return `服务端返回 HTTP ${res.status}（${res.statusText || '没有正文'}）`
}

const saveBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // 立刻移除节点；URL 延后释放（Safari 上过早 revoke 会让下载中断）
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * 「结束并导出」：**先封存窗口、再采集快照、再导出**。
 *
 * 为什么顺序是"先 stop 再采集"（而不是直接导出）：
 *   · 窗口区间必须是**确定**的 —— 否则"点导出之后"的日志会被算进来，而用户点了"结束"却还在记，名不副实；
 *   · 结束时服务端会把"已记录多少秒"一并算好，界面显示与包里的 `recordWindow.durationSeconds` 一致。
 *
 * 🔴 2026-09-22（审计 B2/B4 修）：**任何"窗口对不上"都不许静默继续**。
 *   · `stop` 回 `null`（服务端明确说没有窗口）⇒ **中止导出**并提示重新记录；
 *   · `stop` 超时/没回应 ⇒ 中止导出（此时服务端窗口状态未知，继续导很可能打到"无窗口"路径）；
 *   · `stop` 回来的窗口 id 与本页快照里的不一致 ⇒ 中止导出并要求重采。
 * 另外服务端还有一道 409 闸门（防脚本/老前端绕过），这里读 `X-Diag-Window` 头核对"包里用的就是我这个窗口"。
 */
const finishAndExport = async () => {
  if (!canExport.value || exporting.value) return
  /**
   * 🔴 用 `myWindowId`（本页这一次记录）而不是 `serverWindow.value.id`：
   * 轮询可能已经把"服务端现在是什么"刷新成了别人的窗口，而 `superseded` 会先挡住这种情况；
   * 这里再用 `myWindowId` 兜一层，确保"快照/stop/响应头"三者比的是**同一个**窗口。
   */
  const clientWindowId = myWindowId.value || serverWindow.value?.id || ''
  exporting.value = true
  exportError.value = ''
  serverMessage.value = ''
  stopTimer()
  logs.log('info', 'ui', '结束记录诊断，开始导出')

  try {
    // ① 结束记录（封存窗口，**不导出**）—— 服务端返回的窗口就是本次导出的区间
    const sealed = await callRecordApi(DIAG_RECORD_STOP_PATH, 'POST')
    if (sealed === null || sealed === undefined) {
      const why =
        sealed === null
          ? `服务端说"没有窗口"（本页还以为在记录 ${clientWindowId || '（无）'}）`
          : `服务端 ${Math.round(REQ_TIMEOUT_MS / 1000)} 秒内没有回应（服务端窗口状态未知）`
      exportError.value = `已中止导出：${why} —— 继续导出会打到"没有记录窗口"的服务端，包里可能变成最近 ${DIAG_LOG_DAYS} 天的全量日志（而不是你要发的这一段）。请刷新页面后重新点「开始记录」→ 复现 → 「结束并导出」。`
      serverMessage.value = exportError.value
      logs.log('error', 'ui', '诊断导出已中止（结束记录这一步没拿到确定的窗口）', { sealed: String(sealed), clientWindowId })
      return
    }
    if (sealed.id !== clientWindowId) {
      applyWindow(sealed, Math.max(serverElapsed.value, Math.round((sealed.endedAtMs - sealed.startedAtMs) / 1000)))
      exportError.value = `已中止导出：服务端的记录窗口变过了（本页快照基于 ${clientWindowId || '（无）'}，服务端现在是 ${sealed.id}）—— 多半是另一个标签页点了「开始记录」或本程序重启过。请按当前窗口重新记录一次再导出。`
      serverMessage.value = exportError.value
      logs.log('warn', 'ui', '诊断导出已中止（窗口 id 与本页快照不一致）', { clientWindowId, serverWindowId: sealed.id })
      return
    }
    applyWindow(sealed, Math.max(serverElapsed.value, Math.round((sealed.endedAtMs - sealed.startedAtMs) / 1000)))
    logs.log('info', 'ui', `记录窗口已封存（${sealed.id}），开始采集快照`)

    // ② 采集快照（时间线按窗口过滤；快照里带上窗口 id，服务端会拿它核对）
    const snapshot = buildSnapshot()
    // ③ 红线自检：快照里若出现凭证样式，**拒发**并说明原因（宁可没包，也不能漏 token）
    const check = assertNoCredentials([JSON.stringify(snapshot)])
    if (!check.ok) {
      exportError.value = `已阻止导出：快照里检测到疑似凭证（${check.hits.join('、')}）。请把这条情况告诉开发者，不要上传任何文件。`
      logs.log('error', 'ui', '诊断导出被红线自检拦下', { hits: check.hits })
      return
    }

    // ④ POST 到服务端（用原生 fetch 而不是 $fetch：需要 responseType='blob' + 读响应头）
    const res = await fetch(DIAG_EXPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot }),
      // 审计 B7：导出没有超时会让按钮永久 loading（服务端接住不回时只能刷新页面）
      signal: timeoutSignal(REQ_TIMEOUT_MS),
    })
    if (!res.ok) {
      const reason = await humanReason(res)
      // 服务端的 409 就是"窗口对不上"那道闸门（正常情况下上面已经拦住，这里是防脚本/老前端的兜底）
      exportError.value = res.status === 409
        ? `已中止导出：${reason}`
        : `导出失败：${reason}`
      if (res.status === 409) logs.log('warn', 'ui', '诊断导出被服务端拒（窗口不一致 409）', { clientWindowId })
      else logs.log('error', 'ui', '诊断导出失败', { status: res.status })
      return
    }
    /**
     * 🆕 核对响应头：确认"包里用的窗口"就是本页这一个（服务端 `X-Diag-Window`）。
     * 判据用**与导出前同一份**纯函数 `diagWindowMatch()`（服务端 409 闸门也是它）——
     * 两处口径必须一致，否则一严一松就等于留了个洞。
     * 拿不到头（老服务端/中间层）时不阻断，只在事件日志里留痕。
     *
     * ⚠️ 2026-09-22 终检审计修正：`reportedInstanceId` 必须传**本页快照采集那一刻见过的实例**
     * （也就是 `snapshot.serverInstanceId`），不能传 `serverInstanceId.value`（那是"此刻"的值）——
     * 两个参数喂同一个 ref 会让契约层 `reportedInstance !== instance` 那条判据**恒假**，
     * "本程序重启过"这句提示永远说不出来（只能落成"窗口被换掉"）。
     * 用快照里那个历史值才有意义：服务端重启后 `X-Diag-Window` 若还能对上窗口 id（理论边界），
     * 实例号也会对不上 ⇒ 如实说"重启过"。
     */
    const appliedWindow = res.headers.get('x-diag-window') || ''
    const appliedFlag = res.headers.get('x-diag-window-applied')
    if (appliedWindow && appliedWindow !== 'none') {
      const respMismatch = diagWindowMatch({
        clientWindowId,
        respondedWindowId: appliedWindow,
        /** 服务端**此刻**的实例 */
        serverInstanceId: serverInstanceId.value,
        /** 本页快照采集那一刻见过的实例（历史值，别传"此刻"那个） */
        reportedInstanceId: String(snapshot.serverInstanceId ?? ''),
      })
      if (respMismatch) {
        exportError.value = `导出异常：${respMismatch.detail}。请把这个情况告诉开发者（包里 manifest 的 recordWindow 有完整记录）。`
        logs.log('error', 'ui', '诊断导出响应头里的窗口与本页不一致', { appliedWindow, clientWindowId, reason: respMismatch.reason })
        return
      }
    }
    if (appliedFlag === '0') {
      exportError.value = '导出异常：服务端说这个包没有按记录窗口过滤（manifest 里 recordWindow.applied=false）。请把这个情况告诉开发者。'
      logs.log('error', 'ui', '诊断导出未按窗口过滤（服务端回 X-Diag-Window-Applied: 0）')
      return
    }
    const blob = await res.blob()
    const name = fileNameFromHeader(res.headers.get('content-disposition')) || suggestedFileName()
    saveBlob(blob, name)
    logs.log('info', 'ui', '诊断包已导出', {
      file: name,
      bytes: blob.size,
      window: clientWindowId || '(无)',
      timeline: snapshot.timeline.length,
    })
    exportError.value = ''
    serverMessage.value = ''
    /**
     * ⚠️ 导出成功后**不清空窗口**：窗口已封存为"最近一次"，保留它用户还能再导一次（例如发现漏了步骤）。
     * 界面因此显示"上次记录已结束 · 可导出"；要重新记录就点「开始记录」（会覆盖它）。
     */
    startTimer() // 已结束 ⇒ 内部直接返回，不走来秒
    showSnackbar(`已导出 ${name}（约 ${Math.max(1, Math.round(blob.size / 1024))} KB）—— 请发到 ${SUPPORT_EMAIL}`, 'success', { timeout: 8000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    exportError.value = /abort|timeout/i.test(msg)
      ? `导出失败：${Math.round(REQ_TIMEOUT_MS / 1000)} 秒内没有收到服务端回应（已自动结束等待，可重试）。`
      : `导出失败：${msg}`
    logs.log('error', 'ui', '诊断导出异常', { message: msg })
  } finally {
    exporting.value = false
  }
}
</script>
