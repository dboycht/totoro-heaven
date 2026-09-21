<template>
  <v-card class="mb-4">
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon color="primary" class="mr-1">mdi-bug-outline</v-icon>
      诊断记录（导出给开发者）
      <v-chip v-if="isRecording" size="small" color="error" variant="tonal" class="ml-2">
        <v-icon start size="small">mdi-record-circle-outline</v-icon>记录中 · 已记录 {{ durationText }}
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
          :disabled="isRecording || exporting"
          @click="startRecording"
        >
          开始记录
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-download"
          :loading="exporting"
          :disabled="!isRecording || exporting"
          @click="finishAndExport"
        >
          结束并导出
        </v-btn>
        <span class="text-body-2 text-medium-emphasis">
          {{
            isRecording
              ? `记录中：已记录 ${durationText}、${timelineTotal} 条操作（点「结束并导出」打包）`
              : '当前未记录。点「开始记录」后再去复现问题。'
          }}
        </span>
      </div>

      <div v-if="exportError" class="text-body-2 text-error mb-3">{{ exportError }}</div>

      <!-- ③ 导出前先看：这个包里会包含什么 + 隐私说明 -->
      <div class="text-body-2 font-weight-bold mb-1">这个包里会包含什么</div>
      <ul class="pl-5 mb-2">
        <li v-for="(m, i) in manifest" :key="i" class="text-body-2">
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

      <!-- ④ 坐标开关 -->
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
      </div>

      <div class="text-caption text-medium-emphasis">
        注意：导出时会把「最近 {{ logDays }} 天」的服务端日志一起打包（由服务端自己读取，不进浏览器）；
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
  DIAG_TIMELINE_MAX,
  assertNoCredentials,
  diagManifestEntries,
  maskId,
  maskName,
  maskPhone,
  tokenFingerprint,
  type DiagSnapshot,
} from '~/utils/mp/diagnostics'
import { TASK_CACHE_KEY, useRealState } from '~/composables/real/state'
// 共享域常量（会话里没写 baseUrl 时的兜底展示值）
import { MP_DEFAULT_BASE_URL } from '~/src/wrappers/MpApiWrapper'
// 路线库的键名/归一化都在纯逻辑层（不自己再声明一份键名）
import { TRACK_LIBRARY_KEY, normalizeLibrary } from '~/utils/mp/trackLibrary'
import type { TrackRouteEntry } from '~/utils/mp/trackLibrary'

const logs = useEventLog()
const showSnackbar = useNotice()
const route = useRoute()
const appConfig = useAppConfig()

const mpSession = useMpSession()
const real = useRealState()
const { task, profile, switches, cameraFlag, cameraFlagLineId, cameraFlagError } = real
const realData = useMpReal()
const gate = realData.gateStatus

/** 导出完成后的提示语（用户要把它连同 zip 一起发出来，所以写全） */
const SUPPORT_EMAIL = 'dboycht@qq.com'

/** 操作说明（**按顺序、可照做**；用户明确要求把它写清楚） */
const STEPS = [
  '点下面的「开始记录」（点完它会一直记着：你在哪个页面、点了什么）。',
  '按顺序复现问题。例：工作台点「读取真实账号与任务」→ 进「跑步」看线路下拉里有没有线路 → 进「跑道编辑」描一条并保存 → 回到「跑步」再点「真实提交」。',
  '回到本页点「结束并导出」，浏览器会下载一个 zip。',
  `把下载到的 zip 发到 ${SUPPORT_EMAIL}，附一句你遇到的症状（例如：研究生院看不到线路可选）。`,
]

// ---- 记录状态 ----
const includeGeometry = ref(true)
const exporting = ref(false)
const exportError = ref('')
const startedAtMs = ref(0)
const durationSeconds = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

const isRecording = computed(() => startedAtMs.value > 0)

const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}
const durationText = computed(() => formatDuration(durationSeconds.value))

const stopTimer = () => {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

/** 开始走秒（失败后要继续记录时也要重新走，否则界面显示"记录中"而计时停住 —— 自相矛盾） */
const startTimer = () => {
  stopTimer()
  timer = setInterval(() => {
    durationSeconds.value = Math.round((Date.now() - startedAtMs.value) / 1000)
  }, 1000)
}

const startRecording = () => {
  startedAtMs.value = Date.now()
  durationSeconds.value = 0
  exportError.value = ''
  startTimer()
  logs.log('info', 'ui', '开始记录诊断（接下来请按顺序复现问题）')
  showSnackbar('已开始记录：请去复现问题，回来点「结束并导出」', 'success')
}

onBeforeUnmount(stopTimer)

// ---- 「这个包里会包含什么」（与服务端 manifest 共用同一个纯函数） ----
const manifest = computed(() =>
  diagManifestEntries({
    logNames: [`（服务端附带最近 ${DIAG_LOG_DAYS} 天，由服务端自动列入）`],
    includeGeometry: includeGeometry.value,
  }),
)
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
const COORD_KEYS = new Set(['latitude', 'longitude', 'lat', 'lng', 'pointList', 'sunrunPathPointList', 'routeItudes'])

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
const DIGIT_RUN = /\d{8,18}/g
const maskDigitRun = (s: string): string =>
  s.replace(DIGIT_RUN, (m) => (/^1\d{10}$/.test(m) ? maskPhone(m) : maskId(m)))

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

// ---- 时间线（只取最后 DIAG_TIMELINE_MAX 条；只带 at/level/cat/text 四个字段） ----
const timelineTotal = computed(() => logs.entries.value.length)

/**
 * @param pairs 敏感原值对照表（`sensitivePairs()` 的结果；在此处传入而不是函数内取，
 *              这样"同一份快照里所有文本用同一张表"这件事在代码上一眼可见）
 */
function timelineOf(pairs: { raw: string; masked: string }[]): DiagSnapshot['timeline'] {
  const tail = logs.entries.value.slice(-DIAG_TIMELINE_MAX)
  return tail.map((e) => ({
    at: String(e.t ?? ''),
    level: String(e.level ?? 'info') as LogLevel | string,
    cat: String(e.cat ?? ''),
    // ⚠️ 文案过一遍身份脱敏：日志的 msg 是自由文本，可能整句带着学号/姓名
    text: redactText(String(e.msg ?? ''), pairs),
  }))
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
  const rawTask: Record<string, unknown> | null = (() => {
    const payload = readJson(TASK_CACHE_KEY)
    if (!isPlainObject(payload)) return null
    const t = payload.task
    return isPlainObject(t) ? t : null
  })()
  // 敏感原值对照表：**同一份快照里的所有文本共用这一张**（时间线文案 + 任务原文）
  const pairs = sensitivePairs()
  /** 进包的任务原文：按开关剥坐标（关掉时）+ 剥 token 字段 + 掩掉文本里的学号/姓名 */
  const taskForExport = rawTask === null ? null : redactSensitive(stripTokens(stripGeometry(rawTask)), pairs)

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
    timeline: timelineOf(pairs),
  }
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

const finishAndExport = async () => {
  if (!isRecording.value || exporting.value) return
  exporting.value = true
  exportError.value = ''
  durationSeconds.value = Math.round((Date.now() - startedAtMs.value) / 1000)
  stopTimer()
  logs.log('info', 'ui', '结束记录诊断，开始导出')

  try {
    const snapshot = buildSnapshot()
    // ① 红线自检：快照里若出现凭证样式，**拒发**并说明原因（宁可没包，也不能漏 token）
    const check = assertNoCredentials([JSON.stringify(snapshot)])
    if (!check.ok) {
      exportError.value = `已阻止导出：快照里检测到疑似凭证（${check.hits.join('、')}）。请把这条情况告诉开发者，不要上传任何文件。`
      logs.log('error', 'ui', '诊断导出被红线自检拦下', { hits: check.hits })
      // 没有导出成功 ⇒ 仍处在记录中：把走秒接着跑，用户可以继续复现后重试
      startTimer()
      return
    }

    // ② POST 到服务端（用原生 fetch 而不是 $fetch：需要 responseType='blob' + 读响应头）
    const res = await fetch(DIAG_EXPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    })
    if (!res.ok) {
      exportError.value = `导出失败：${await humanReason(res)}`
      logs.log('error', 'ui', '诊断导出失败', { status: res.status })
      startTimer()
      return
    }
    const blob = await res.blob()
    const name = fileNameFromHeader(res.headers.get('content-disposition')) || suggestedFileName()
    saveBlob(blob, name)
    logs.log('info', 'ui', '诊断包已导出', { file: name, bytes: blob.size, timeline: snapshot.timeline.length })
    exportError.value = ''
    startedAtMs.value = 0
    durationSeconds.value = 0
    showSnackbar(`已导出 ${name}（约 ${Math.max(1, Math.round(blob.size / 1024))} KB）—— 请发到 ${SUPPORT_EMAIL}`, 'success', { timeout: 8000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    exportError.value = `导出失败：${msg}`
    logs.log('error', 'ui', '诊断导出异常', { message: msg })
    startTimer()
  } finally {
    exporting.value = false
  }
}
</script>
