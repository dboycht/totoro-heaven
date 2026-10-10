/**
 * 服务端提交作业（**防 kill**）：把"真实等待 + 成绩提交 + 轨迹明细 + 读判定"搬进 Node 进程。
 *
 * ## 为什么要有它（2026-10-07 用户实测事故 + 用户口径）
 * 改造前整条编排都在**前端** `composables/real/submit.ts` 里跑：那个"真实等待 19 分钟"是
 * **浏览器定时器**，两次写请求也由页面发出。于是：
 *   · 后台标签页被节流 ⇒ 提交比预定晚了约 12 分钟（实测：20:21:38 建场次 → 20:53:41 才提交）；
 *   · 页面被 Edge 冻结/丢弃 ⇒ 编排断在"成绩成功、明细还没发"之间 ⇒ **云端成绩有效、却没有轨迹**（`ERROR.md` E71）。
 * 用户 2026-10-07 明确要求：**"防 kill …… 下次运行的时候在那个终端也显示进度，前端只是展示，
 * 不作为一种步进的过程"**。所以：
 *   ① 编排搬到这里（Node 进程，浏览器关不关都不影响）；
 *   ② **每一步都同时写进终端与当天的服务端日志**（`logInfo/logWarn/logError` → `%TEMP%\totoro-heaven-runner\logs`）；
 *   ③ 前端只做两件事：**启动作业** + **轮询状态来展示**（它不再推进任何一步）。
 *
 * ## 边界（必须如实说）
 * 1. **token 由作业在内存里持有**（只在本进程内、只在本作业存续期间；**绝不落盘、绝不进日志** ——
 *    `logger` 按字段名与"形似 token"双重脱敏）。这是继「早操签到提交」之后**第二处服务端写操作**，
 *    与它同一套纪律：**由用户点一次发起一次**，没有定时器、没有后台重试、不批量。
 * 2. ✅ **进程级续跑已做（2026-10-08 用户要求）**：关掉整个 EXE 也能接着跑 ——
 *    在途作业会以**非敏感元数据**落盘（`%TEMP%\totoro-heaven-runtime\pending-submit.json`），
 *    重启后进入 `suspended`，**由用户点「继续提交」**才发（token / 学号 / 轨迹点由浏览器补交，**不进磁盘**）。
 *    恢复得太晚会**作废而不是硬发**（判据 `utils/mp/runResume.ts` 的 `decideResume()`）。
 *    ✅ 同轮还补了**中途叫停**（`abortRunSubmitJob`，只在"没发出任何写请求"的阶段允许）。
 * 3. 报文**不是这里构造的**：成绩 18 字段与明细 3 字段仍由 `utils/mp/submitPayload.ts` 的
 *    唯一构造器产出（客户端算好后传进来）⇒ **提交口径一字未变**，本文件只负责"按顺序发出去"。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MP_ENDPOINTS } from '../../src/mp/endpoints'
import { judgeMpResponse, looksLikeTokenExpired, unwrapMpResponse } from '../../src/mp/envelope'
import { classifyWriteOutcome, outcomeIsSuccess, writeOutcomeMessage, type WriteOutcome } from '../../utils/mp/writeOutcome'
import { SUBMIT_PROGRESS, submitProgressLine, type SubmitProgressLine } from '../../utils/mp/submitProgress'
import { buildScoreDetailRequest, buildScoreRequest } from '../../utils/mp/submitPayload'
import {
  PERSISTED_SUBMIT_FILE,
  checkResumeLinePoints,
  decideResume,
  isPersistedJobExpired,
  parsePersistedSubmitJob,
  resumeSummaryText,
  targetClock,
  toPersistedSubmitJob,
  withLinePoints,
  withVerdictIdentity,
  type PersistedSubmitJob,
  type SuspendedJobSummary,
} from '../../utils/mp/runResume'
import { RUNTIME_DIR, logError, logInfo, logWarn } from './logger'

/** 落盘作业的文件路径（`%TEMP%\totoro-heaven-runtime\pending-submit.json`；`TOTORO_LOG_DIR` 不影响它） */
const PERSISTED_SUBMIT_PATH = join(RUNTIME_DIR, PERSISTED_SUBMIT_FILE)

export type RunSubmitPhase =
  | 'idle'
  | 'waiting'
  | 'scoring'
  | 'detail'
  | 'verdict'
  | 'done'
  | 'error'
  /** 🆕 2026-10-08：进程重启后**发现了上次没跑完的作业**，正等用户点「继续提交」 */
  | 'suspended'
  /** 🆕 2026-10-08：用户主动**中途叫停**（还没发出任何写请求） */
  | 'aborted'
  /** 🆕 2026-10-08：恢复得太晚（超出任务允许的时长区间）⇒ **作废、不提交** */
  | 'discarded'

export interface RunSubmitJobInput {
  /** 会话 token（**只在内存里用**；绝不落盘/进日志） */
  token: string
  /** 多租户基址（学校自有域；缺省=共享域）—— 与前端平时带 `x-mp-upstream` 的口径一致 */
  baseUrl?: string
  /** 报备时长（秒）：真实等待这么久再提交（前端算好传进来） */
  plannedSeconds: number
  /** `getRunBegin` 拿到的场次号（前端拿到后传进来） */
  scantronId: string
  /**
   * 报文上下文的**原件**（前端把 task/line/points 等原样传进来）——
   * ⭐ 报文由**本作业**用同一套唯一构造器（`buildScoreRequest` / `buildScoreDetailRequest`）构造，
   *    因为 `startTime/endTime` 必须落在"服务端真正发出请求"的时刻上（前端算的话会少掉整个等待时长）。
   */
  context: {
    snCode: string
    schoolCode: string
    task: unknown
    line: unknown
    paperId: string
    km: number
    durationSeconds: number
    fitDegree: number
    points: { latitude: number; longitude: number }[]
    runType: 0 | 1
  }
  /** 读判定入参（`getSunrunArch`；前端按 profile/学期算好传进来） */
  verdictRequest: unknown
  /** 只用于进度文案（不参与任何判定） */
  meta: { km: number; lineName: string; runTypeLabel: string }
}

export interface RunSubmitJobResult {
  scoreOk: boolean
  scoreOutcome: WriteOutcome
  scoreMessage: string
  detailOk?: boolean
  detailMessage?: string
  /** 服务端回的"登录态失效"特征（前端据此给"重新登录小程序"的可操作提示） */
  tokenExpired?: boolean
  /** 读回的服务端判定（原样回传，前端照旧渲染） */
  verdict?: Record<string, unknown> | null
  verdictMessage?: string
  scantronId: string
}

export interface RunSubmitJobView {
  id: string
  /** 作业是否在途（前端据此决定"要不要继续轮询"） */
  active: boolean
  phase: RunSubmitPhase
  phaseMessage: string
  progress: SubmitProgressLine[]
  remainingSeconds: number
  startedAt: number
  finishedAt: number
  result: RunSubmitJobResult | null
  /**
   * 🆕 2026-10-08：`phase === 'suspended'` 时带上"这笔是什么"的**非敏感摘要**，
   * 供界面渲染「继续提交」卡片；其它阶段为 `null`。
   * ⚠️ 只有场次号/里程/线路名/时间口径 —— **不含 token、不含轨迹点、不含学号**。
   */
  suspended: SuspendedJobSummary | null
}

/**
 * 挂起作业的**非敏感摘要**（给界面看的）。
 * ⚠️ 形状定义在**算法层** `utils/mp/runResume.ts` —— 它是服务端与界面共用的线上形状，
 * 而分层纪律规定**装配层不得直接 import `server/`**（守卫 R6），放那边两边都能依赖。
 */
export type { SuspendedJobSummary }

/** 出网口径（与前端 `MpApiWrapper` 一致：读 15s / 写 30s；这里只用到写与读） */
const WRITE_TIMEOUT_MS = 30_000

/** 上游调用结果（**可注入**：单测用假 IO，演练模式用假 IO ⇒ 不碰厂商、不产生真记录） */
export interface RunSubmitIo {
  post: (path: string, body: unknown, timeoutMs: number) => Promise<RunSubmitIoResult>
}
export interface RunSubmitIoResult {
  http: number
  /** 上游 JSON（解析失败为 undefined） */
  json: unknown
  /** 是不是"超时"（= 结果未知，不等于失败） */
  timedOut: boolean
  /** 出网层错误文本（超时/网络断） */
  error: string
}

interface InternalState {
  view: RunSubmitJobView
  input: RunSubmitJobInput | null
  io: RunSubmitIo | null
  timer: ReturnType<typeof setInterval> | null
  /** 🆕 落盘作业（进程重启后从磁盘读回来的那份；只在 token 到位后才拿去跑） */
  persisted: PersistedSubmitJob | null
}

const SECONDS_PER_TICK = 1

function freshState(): InternalState {
  return {
    view: {
      id: '',
      active: false,
      phase: 'idle',
      phaseMessage: '',
      progress: [],
      remainingSeconds: 0,
      startedAt: 0,
      finishedAt: 0,
      result: null,
      suspended: null,
    },
    input: null,
    io: null,
    timer: null,
    persisted: null,
  }
}

/** 模块级单例（与 `tokenScanState` 同一套做法：整个进程只有一次提交在途） */
let state: InternalState = freshState()

// ---------- 🆕 2026-10-08：作业落盘（进程级续跑） ----------
// 🔒 落盘**只写非敏感元数据**：唯一出口是纯逻辑层的 `toPersistedSubmitJob()`（显式挑字段 + 内部断言）。
//    token / 轨迹点 / 学号 一律留在这台机器的**内存与浏览器**里，绝不进这个文件。

/** 把在途作业写进磁盘（失败只记警告，**绝不让它影响正在跑的作业**） */
function persistJob(): void {
  const p = state.persisted
  if (!p) return
  try {
    if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true })
    writeFileSync(PERSISTED_SUBMIT_PATH, JSON.stringify(p), 'utf8')
  } catch (err) {
    logWarn('run', '作业落盘失败（续跑能力会缺失，但不影响本次提交）', {
      runId: p.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** 清掉落盘作业（成功 / 叫停 / 作废 / 过期后都要清） */
function clearPersistedJob(): void {
  state.persisted = null
  state.view.suspended = null
  try {
    if (existsSync(PERSISTED_SUBMIT_PATH)) rmSync(PERSISTED_SUBMIT_PATH, { force: true })
  } catch (err) {
    logWarn('run', '清理落盘作业失败', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** 落盘作业 → 界面摘要（**非敏感**） */
function suspendedSummaryOf(p: PersistedSubmitJob): SuspendedJobSummary {
  return {
    id: p.id,
    scantronId: p.scantronId,
    km: p.meta.km,
    lineName: p.meta.lineName,
    runTypeLabel: p.meta.runTypeLabel,
    startedAt: p.startedAt,
    plannedSeconds: p.plannedSeconds,
    runType: p.context.runType,
    targetClock: targetClock(p),
    summary: resumeSummaryText(p, Date.now()),
  }
}

/**
 * 启动时（或首次访问状态时）把上次没跑完的作业读回内存，进入 **`suspended`**（等用户点「继续提交」）。
 * 惰性调用：不放在模块顶层，免得在单测/构建期产生副作用。
 *
 * 三种情况会被**直接清掉**而不是挂起：
 *   ① 文件不存在/坏数据（`parsePersistedSubmitJob` 返回 null）；
 *   ② 已过期（超过 `PERSISTED_SUBMIT_MAX_AGE_MS`）—— 否则它会**永远挡住新的提交**；
 *   ③ 内存里已经有一个在跑的作业（不该发生，但宁可丢掉磁盘那份也不打断在途的）。
 */
function ensurePersistedJobLoaded(): void {
  if (state.persisted || state.view.phase === 'suspended') return
  if (state.view.active) return
  let raw = ''
  try {
    if (!existsSync(PERSISTED_SUBMIT_PATH)) return
    raw = readFileSync(PERSISTED_SUBMIT_PATH, 'utf8')
  } catch (err) {
    logWarn('run', '读取落盘作业失败', { error: err instanceof Error ? err.message : String(err) })
    return
  }
  const job = parsePersistedSubmitJob(raw)
  if (!job) {
    logWarn('run', '落盘作业无法解析（坏数据或旧版本）⇒ 已丢弃', { path: PERSISTED_SUBMIT_PATH })
    clearPersistedJob()
    return
  }
  if (isPersistedJobExpired(job, Date.now())) {
    logInfo('run', '落盘作业已过期（超过 24 小时）⇒ 已丢弃，不再挡住新的提交', {
      runId: job.id,
      scantronId: job.scantronId,
    })
    clearPersistedJob()
    return
  }
  state.persisted = job
  state.view.id = job.id
  state.view.active = true
  state.view.phase = 'suspended'
  state.view.phaseMessage = '发现上次没跑完的提交：它会等你点「继续提交」才发（也可以点「作废」放弃它）'
  state.view.startedAt = job.startedAt
  /**
   * ⚠️ **必须把上一次的痕迹清干净**（本轮探针抓到的真 bug）：
   * 从磁盘读回来的是**一笔新的待办**，而进程内存里可能还留着**上一轮**的
   * `result` / `progress` / `finishedAt`（例如"刚成功跑完一笔 ⇒ 又发现磁盘上还有一笔"）。
   * 不清的话界面会把上一轮的结果当成本次的结果显示出来（看起来像"作废了却还判了有效"）。
   */
  state.view.result = null
  state.view.progress = []
  state.view.finishedAt = 0
  state.view.remainingSeconds = 0
  state.view.suspended = suspendedSummaryOf(job)
  logInfo('run', '发现上次没跑完的提交作业（等待用户决定是否继续）', {
    runId: job.id,
    scantronId: job.scantronId,
    plannedSeconds: job.plannedSeconds,
    target: targetClock(job),
  })
  push('warn', SUBMIT_PROGRESS.suspended(job.scantronId, job.meta.km, targetClock(job)))
}

export function getRunSubmitJobView(): RunSubmitJobView {
  ensurePersistedJobLoaded()
  return { ...state.view, progress: [...state.view.progress] }
}

export function isRunSubmitJobActive(): boolean {
  ensurePersistedJobLoaded()
  return state.view.active
}

export function resetRunSubmitJob(): void {
  if (state.timer) clearInterval(state.timer)
  state = freshState()
}

/**
 * 演练模式：`TOTORO_RUN_DRYRUN=1` 时**不发真实请求**（用假 IO），等待时长也压到 3 秒。
 * 用途：验证 "启动 → 轮询 → 完成" 这条链与终端进度，不碰厂商、不产生任何真记录。
 */
export const isDryRun = (): boolean => process.env.TOTORO_RUN_DRYRUN === '1'

function dryRunIo(): RunSubmitIo {
  /**
   * ⚠️ 演练归档里要回**当前作业的场次号**（`state.input.scantronId`），否则"⑥ 读判定"那一步
   * 永远报"归档里还没找到"，演练就覆盖不到判定写回那条路。
   */
  const scantronId = () => String(state.input?.scantronId ?? 'dryrun')
  return {
    async post(path) {
      if (path.includes('sunRunExercisesDetail')) {
        return { http: 200, json: { status: '00', code: '0', message: '（演练）轨迹提交成功' }, timedOut: false, error: '' }
      }
      if (path.includes('getSunrunArch')) {
        return {
          http: 200,
          json: {
            status: '00',
            code: '0',
            data: [
              {
                scoreId: scantronId(),
                scorePassType: 1,
                mileage: '3.30',
                usedTime: '00:19:32',
                trajectorySimilary: '0.98',
                warnType: 0,
                scorePassRemark: '',
              },
            ],
          },
          timedOut: false,
          error: '',
        }
      }
      return { http: 200, json: { status: '00', code: '0', message: '（演练）提交成功' }, timedOut: false, error: '' }
    },
  }
}

/** 真实 IO：**走我们自己的本机代理**（`origin` = 本机服务的地址族）⇒ SSRF 白名单、日志、captures 全是同一套 */
export function proxyIo(origin: string, input: RunSubmitJobInput): RunSubmitIo {
  return {
    async post(path, body, timeoutMs) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json',
        Authorization: `Bearer ${input.token}`,
      }
      if (input.baseUrl) headers['x-mp-upstream'] = input.baseUrl
      try {
        const res = await fetch(`${origin}/api/mp${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await res.text()
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        return { http: res.status, json, timedOut: false, error: '' }
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        const timedOut = name === 'TimeoutError' || name === 'AbortError'
        return { http: 0, json: undefined, timedOut, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

/**
 * 启动一次提交作业。**立即返回**（前端拿到 id 后开始轮询）；真正的编排在后台跑。
 * ⚠️ 同时只允许一次（在途时直接拒绝）—— 否则会出现两个场次/两笔成绩。
 * @param origin 本机服务地址（按请求实际地址族拼，见 E59）—— 真实 IO 走它自己的代理
 */
export function startRunSubmitJob(input: RunSubmitJobInput, origin: string): { ok: boolean; message: string; id: string } {
  ensurePersistedJobLoaded()
  if (state.view.active) {
    /**
     * ⚠️ 这里**也**会挡住"上次没跑完的作业还挂着"的情形（那种状态 `active=true`、phase=`suspended`）——
     * 这是刻意的：续跑必须由用户先决定（继续 / 作废），否则可能同时存在两笔场次。
     */
    const extra =
      state.view.phase === 'suspended'
        ? '（上次那笔还没跑完：请先点「继续提交」或「作废」）'
        : ''
    return { ok: false, message: `已有一次提交在途（阶段：${state.view.phase}）——请等它跑完再用${extra}`, id: state.view.id }
  }
  if (!input.token) return { ok: false, message: '缺少会话 token（请先在「工作台」取 token）', id: '' }
  const id = `run-${Date.now().toString(36)}`
  state = freshState()
  const startedAt = Date.now()
  state.view.id = id
  state.view.active = true
  state.view.phase = 'waiting'
  state.view.startedAt = startedAt
  state.input = input
  state.io = isDryRun() ? dryRunIo() : proxyIo(origin, input)
  const planned = isDryRun() ? 3 : Math.max(1, Math.round(input.plannedSeconds))
  state.view.remainingSeconds = planned
  /**
   * 🆕 落盘（进程级续跑）：**只写非敏感元数据** —— 走纯逻辑层的唯一出口 `toPersistedSubmitJob()`，
   * 它**不含** token / 轨迹点 / 学号（见 `utils/mp/runResume.ts` 的落盘边界）。
   *
   * 🔴 **2026-10-10（E76）：整段包在 try/catch 里，落盘失败绝不允许拖垮本次提交。**
   * 事故现场：`toPersistedSubmitJob()` 里的一句断言被**厂商原样数据**（任务对象带 `token: "null"`）触发抛错，
   * 而它夹在"作业已登记（`active=true`）"与"`void runJob()`"之间 ⇒
   * HTTP 500 + **僵尸作业**：永远不会提交，却**一直挡住**后续每一次提交。
   * 口径：落盘只服务于"关掉再开机还能接着跑"这层**附加能力**；它坏了，本次提交照常发。
   */
  try {
    state.persisted = toPersistedSubmitJob({
      id,
      startedAt,
      plannedSeconds: planned,
      scantronId: input.scantronId,
      baseUrl: input.baseUrl,
      context: {
        schoolCode: input.context.schoolCode,
        task: input.context.task,
        line: input.context.line,
        paperId: input.context.paperId,
        km: input.context.km,
        durationSeconds: input.context.durationSeconds,
        fitDegree: input.context.fitDegree,
        runType: input.context.runType,
      },
      verdictRequest: input.verdictRequest,
      meta: input.meta,
    })
    persistJob()
  } catch (err) {
    state.persisted = null
    logWarn('run', '作业落盘失败：本次提交照常进行，只是"关掉再开机续跑"这层能力本次不可用', {
      runId: id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  state.view.suspended = null
  void runJob(id, { waitSeconds: planned, durationSeconds: planned }).catch((err) => {
    // 兜底：编排里任何未捕获异常都不许让状态悬着（否则前端会一直轮询）
    finish('error', `提交作业异常：${err instanceof Error ? err.message : String(err)}`)
  })
  return { ok: true, message: '已开始（进度会同时打在服务端终端；页面只负责展示）', id }
}

/**
 * 🆕 2026-10-08：**中途叫停**（用户要求；接 `防 kill` 的第二个边界）。
 *
 * 口径（保守）：
 *   - **只在"还没发出任何写请求"的阶段允许**（`waiting` / `suspended`）——
 *     一旦进入 `scoring`，成绩请求可能已经在路上，那时打断只会**留下半成品**（E71 那种），
 *     所以那种情况**明确拒绝**并说明原因；
 *   - 叫停会**删掉落盘作业**并作废场次（不复用这个场次号、不自动重试）；
 *   - 只清本机这一笔的状态，**不向服务端发任何请求**（也就无从"取消"厂商那边的场次）。
 */
export function abortRunSubmitJob(): { ok: boolean; message: string; phase: RunSubmitPhase } {
  ensurePersistedJobLoaded()
  const phase = state.view.phase
  const abortable: RunSubmitPhase[] = ['waiting', 'suspended']
  if (!abortable.includes(phase)) {
    const message = SUBMIT_PROGRESS.abortRefused(phase)
    logWarn('run', '拒绝叫停（当前阶段不允许）', { runId: state.view.id, phase })
    return { ok: false, message, phase }
  }
  const scantronId = state.persisted?.scantronId || state.input?.scantronId || ''
  push('warn', SUBMIT_PROGRESS.aborting())
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  clearPersistedJob()
  state.input = null
  state.io = null
  state.view.active = false
  state.view.remainingSeconds = 0
  state.view.finishedAt = Date.now()
  /** ⚠️ 清掉可能残留的上一轮结果（否则界面会把旧判定当成这次叫停的结果） */
  state.view.result = null
  setPhase('aborted', SUBMIT_PROGRESS.aborted(scantronId))
  push('warn', SUBMIT_PROGRESS.aborted(scantronId))
  logInfo('run', '提交作业已被用户叫停（未发送任何写请求）', { runId: state.view.id, scantronId, phase })
  return { ok: true, message: '已停止本次提交（没有发送成绩）', phase: 'aborted' }
}

/**
 * 🆕 2026-10-08：**继续上次没跑完的提交**（进程级续跑；用户要求）。
 *
 * 🔒 为什么要有入参：落盘文件里**故意不含** token / 学号 / 轨迹点（用户 2026-10-08 拍板的落盘边界）
 * ⇒ 这三样必须由**浏览器**（它自己有会话与 localStorage）在恢复这一刻补交。
 *
 * 判据走纯逻辑层的 `decideResume()`（**唯一出口**）：
 *   · 还没到原定提交时刻 ⇒ 接着等完再提交；
 *   · 已过原定时刻、且仍落在任务允许的时长区间内 ⇒ 立即提交（时长按真实间隔算）；
 *   · 超出区间 / 任务未下发区间且超本地宽限 ⇒ **作废，不提交**。
 */
export function resumeRunSubmitJob(
  payload: {
    token: string
    snCode: string
    points: { latitude: number; longitude: number }[]
    /** 🆕 2026-10-10（E76）：**官方线路点列**（首发时 `line.pointList` 的原样副本；只有浏览器有） */
    linePointList?: unknown
  },
  origin: string,
): { ok: boolean; message: string; action: 'wait' | 'submit' | 'discard' | '' } {
  ensurePersistedJobLoaded()
  const p = state.persisted
  if (!p || state.view.phase !== 'suspended') {
    return { ok: false, message: '没有"上次没跑完的提交"可以继续（可能已经跑完、被作废，或重启后没读到）', action: '' }
  }
  if (!payload?.token) return { ok: false, message: '缺少会话 token（请先在「工作台」取 token 再点「继续提交」）', action: '' }
  const points = Array.isArray(payload.points) ? payload.points : []
  if (points.length === 0) {
    return {
      ok: false,
      message: '找不到那次跑步的轨迹点（浏览器本机数据被清过）⇒ 无法继续这笔提交；可以点「作废」放弃它',
      action: '',
    }
  }
  /**
   * 🆕 2026-10-10（E76）：**官方线路点列**也必须补齐且数量对得上。
   * 为什么宁可不续跑：`sunrunPathPointList` 逐字取自它（`ERROR.md` E37），
   * 缺了就发出一条**与首发口径不一致**的报文 ⇒ 不如如实拒绝，让用户重新跑一次。
   */
  const lineIssue = checkResumeLinePoints(p, payload.linePointList)
  if (lineIssue) {
    logWarn('run', `续跑被拒（官方线路点列核验不通过）：${lineIssue}`, {
      runId: p.id,
      scantronId: p.scantronId,
      expected: p.context.linePointCount,
    })
    return { ok: false, message: lineIssue, action: '' }
  }

  const now = Date.now()
  const decision = decideResume({
    startedAt: p.startedAt,
    plannedSeconds: p.plannedSeconds,
    now,
    task: (p.context.task as { minTime?: number | string; maxTime?: number | string }) ?? {},
  })

  /** 作废：**不提交**，把原因如实写进状态与日志 */
  if (decision.action === 'discard') {
    clearPersistedJob()
    state.input = null
    state.io = null
    state.view.active = false
    state.view.finishedAt = now
    /** ⚠️ 同上：作废不能留着上一轮的结果 */
    state.view.result = null
    setPhase('discarded', SUBMIT_PROGRESS.discarded(decision.reason))
    push('warn', SUBMIT_PROGRESS.discarded(decision.reason))
    logWarn('run', '续跑判定为"作废"：不提交', {
      runId: p.id,
      scantronId: p.scantronId,
      elapsedSeconds: decision.elapsedSeconds,
      reason: decision.reason,
    })
    return { ok: true, message: decision.reason, action: 'discard' }
  }

  push('ok', SUBMIT_PROGRESS.resumed(decision.reason))
  logInfo('run', `续跑：${decision.reason}`, {
    runId: p.id,
    scantronId: p.scantronId,
    action: decision.action,
    elapsedSeconds: decision.elapsedSeconds,
  })

  /** 组装成正常的作业输入（把客户端补交的三样 —— token / 学号 / 轨迹点 —— 塞回去） */
  const input: RunSubmitJobInput = {
    token: payload.token,
    baseUrl: p.baseUrl || undefined,
    plannedSeconds: p.plannedSeconds,
    scantronId: p.scantronId,
    context: {
      snCode: payload.snCode,
      schoolCode: p.context.schoolCode,
      task: p.context.task,
      /** 🆕 2026-10-10（E76）：官方线路点列**原样装回**（磁盘上没有它，由浏览器刚补交上来） */
      line: withLinePoints(p.context.line, payload.linePointList),
      paperId: p.context.paperId,
      km: p.context.km,
      durationSeconds: p.context.durationSeconds,
      fitDegree: p.context.fitDegree,
      points,
      runType: p.context.runType,
    },
    /** 判定入参：把学号补回（落盘时按隐私口径剥掉了） */
    verdictRequest: withVerdictIdentity(p.verdictRequest, payload.snCode),
    meta: p.meta,
  }
  state.input = input
  state.io = isDryRun() ? dryRunIo() : proxyIo(origin, input)
  state.view.active = true
  state.view.suspended = null
  state.view.finishedAt = 0
  setPhase('waiting', decision.reason)

  /**
   * ⭐ 时长口径：`startMs` 永远是**最初那一刻**（`p.startedAt`，≈ `getRunBegin` 返回时），
   * 所以 `endTime - startTime` 与"真实间隔"一致；`durationSeconds` 取
   *   · `wait` ⇒ 原报备时长（等完后真实间隔恰好也是它）；
   *   · `submit` ⇒ **真实已过秒数**（否则报文里的"用时"会与首尾时刻对不上）。
   */
  const waitSeconds = Math.max(0, Math.round(decision.waitMs / 1000))
  const durationSeconds = decision.action === 'submit' ? decision.elapsedSeconds : p.plannedSeconds
  state.view.remainingSeconds = waitSeconds
  void runJob(p.id, { waitSeconds, durationSeconds }).catch((err) => {
    finish('error', `提交作业异常：${err instanceof Error ? err.message : String(err)}`)
  })
  return { ok: true, message: decision.reason, action: decision.action }
}

/** 追加一条进度（同时进终端/当天日志 + 状态里给前端轮询） */
function push(kind: SubmitProgressLine['kind'], text: string): void {
  state.view.progress.push(submitProgressLine(kind, text))
  const level = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info'
  const payload = { runId: state.view.id, phase: state.view.phase, text }
  if (level === 'error') logError('run', text, payload)
  else if (level === 'warn') logWarn('run', text, payload)
  else logInfo('run', text, payload)
}

function setPhase(phase: RunSubmitPhase, message: string): void {
  state.view.phase = phase
  state.view.phaseMessage = message
}

function finish(phase: 'done' | 'error', message: string): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  setPhase(phase, message)
  state.view.active = false
  state.view.finishedAt = Date.now()
  state.view.remainingSeconds = 0
  /**
   * 🔒 **作业结束立刻丢掉 token**（不再需要，少一个泄漏面）：
   * 结果里只留判定/文案，输入里的 token 与报文一律不留在状态里给前端轮询。
   */
  state.input = null
  state.io = null
  /** 🆕 跑完就**删掉落盘作业**（它只服务于"重启后续跑"，跑完再留着只会挡住下一次提交） */
  clearPersistedJob()
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 跑一次提交编排。
 * @param opts.waitSeconds 还要等多久（首次 = 报备时长；续跑"接着等" = 剩余时间；续跑"立即提交" = 0）
 * @param opts.durationSeconds 报文里的**用时口径**（必须与 `endMs - startMs` 一致，否则首尾对不上）
 */
async function runJob(id: string, opts: { waitSeconds: number; durationSeconds: number }): Promise<void> {
  const input = state.input
  const io = state.io
  if (!input || !io) return
  const planned = Math.max(0, Math.round(opts.waitSeconds))
  const scantronId = String(input.scantronId ?? '')
  const meta = input.meta
  const jobStartedAt = state.view.startedAt
  push('step', SUBMIT_PROGRESS.begin(meta.lineName, meta.runTypeLabel))
  push('ok', SUBMIT_PROGRESS.beginOk(scantronId))
  // 续跑若判定"立即提交"（`planned === 0`）就没有等待这一步，别打一行让人以为还在等
  if (planned > 0) push('step', SUBMIT_PROGRESS.wait(planned, meta.km))

  // ② 真实等待：**服务端计时器**（不受浏览器节流；页面前端只读 remainingSeconds 显示）
  if (planned > 0) {
    const waitStartedAt = Date.now()
    state.timer = setInterval(() => {
      const left = planned - Math.round((Date.now() - waitStartedAt) / 1000)
      state.view.remainingSeconds = Math.max(0, left)
    }, SECONDS_PER_TICK * 1000)
    logInfo('run', `进入真实等待（服务端计时）：${planned} 秒`, { runId: id, minutes: Math.round(planned / 60) })
    await sleep(planned * 1000)
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    state.view.remainingSeconds = 0
    push('ok', SUBMIT_PROGRESS.waitDone())
  }

  /**
   * ⭐ 报文在这一刻才构造（`endMs` = 现在）：这样 `endTime` 落在**真正发出请求**的时刻上，
   * 与改造前"前端在等待结束后构造"完全同口径；而 `startMs` 用作业开始时刻（≈ `getRunBegin` 返回那一刻）。
   * ⚠️ 续跑时 `startMs` 仍是**最初那一刻**（`state.view.startedAt`）⇒ `endTime - startTime` = 真实间隔。
   */
  const submittedAt = Date.now()
  const durationSeconds = Math.max(1, Math.round(opts.durationSeconds))
  const submitContext = {
    snCode: input.context.snCode,
    schoolCode: input.context.schoolCode,
    task: input.context.task as never,
    line: input.context.line as never,
    paperId: input.context.paperId,
    km: input.context.km,
    durationSeconds,
    fitDegree: input.context.fitDegree,
    points: input.context.points,
    token: input.token,
    scantronId,
    startMs: jobStartedAt,
    endMs: submittedAt,
  }
  const scoreRequest = buildScoreRequest(submitContext, { runType: input.context.runType })
  const detailRequest = buildScoreDetailRequest(submitContext)
  const usedTime = usedTimeText(durationSeconds)
  logInfo('run', '等待结束，开始提交成绩（本轮由服务端发出，页面关掉也不影响）', {
    runId: id,
    scantronId,
    km: input.context.km,
    usedTime,
  })

  // ③ 成绩
  setPhase('scoring', '正在提交成绩（sunRunExercises）…')
  const scoreStartedAt = Date.now()
  push('step', SUBMIT_PROGRESS.score(input.context.km, (scoreRequest.sunrunPathPointList ?? []).length, usedTime))
  const scoreRes = await io.post('/wxxcx/sunrun/sunRunExercises', scoreRequest, WRITE_TIMEOUT_MS)
  const scoreMs = Date.now() - scoreStartedAt
  const scoreVerdict = judgeMpResponse(scoreRes.json, MP_ENDPOINTS.saveScores.payload)
  let landed: boolean | null = null
  if (!scoreVerdict.ok && scoreRes.timedOut) {
    // **超时 ≠ 失败**（issue #11）：去归档核实一次（3/8/20 秒递进，与前端同一套口径）
    setPhase('scoring', '提交请求超时，正在向服务端核实是否已入库…')
    logWarn('run', '成绩提交超时（结果未知），开始核实是否已入库', { runId: id, scantronId })
    for (const delay of [3000, 8000, 20000]) {
      await sleep(delay)
      const arch = await io.post('/wxxcx/sunrun/getSunrunArch', input.verdictRequest, WRITE_TIMEOUT_MS)
      const list = (unwrapMpResponse<{ data?: Record<string, unknown>[] }>(arch.json, MP_ENDPOINTS.sunrunArch.payload)?.data ?? []) as Record<string, unknown>[]
      if (list.some((r) => String(r.scoreId) === scantronId)) {
        landed = true
        break
      }
    }
  }
  const outcome = classifyWriteOutcome({ ok: scoreVerdict.ok, timedOut: scoreRes.timedOut }, landed)
  const scoreOk = outcomeIsSuccess(outcome)
  const scoreMessage = outcome === 'ok' ? scoreVerdict.message || '提交成功' : writeOutcomeMessage(outcome, scoreVerdict.message)
  if (outcome === 'ok') push('ok', SUBMIT_PROGRESS.scoreOk(scoreMs))
  else if (outcome === 'timeout-landed') push('ok', SUBMIT_PROGRESS.scoreVerified())
  else if (outcome === 'timeout-unknown') push('warn', SUBMIT_PROGRESS.scoreUnknown())
  else push('error', SUBMIT_PROGRESS.scoreFail(scoreMessage))

  const result: RunSubmitJobResult = {
    scoreOk,
    scoreOutcome: outcome,
    scoreMessage,
    tokenExpired: looksLikeTokenExpired(scoreRes.json),
    scantronId,
  }

  // ④ 轨迹明细（成绩成功 / 超时但已核实入库 时都要发）
  if (scoreOk) {
    setPhase('detail', '成绩已提交，正在提交轨迹明细（sunRunExercisesDetail）…')
    const pointCount = (detailRequest.pointList ?? []).length
    push('step', SUBMIT_PROGRESS.detail(pointCount))
    const detailStartedAt = Date.now()
    const detailRes = await io.post('/wxxcx/platform/recrecord/sunRunExercisesDetail', detailRequest, WRITE_TIMEOUT_MS)
    const detailMs = Date.now() - detailStartedAt
    const detailVerdict = judgeMpResponse(detailRes.json, MP_ENDPOINTS.saveScoreDetail.payload)
    result.detailOk = detailVerdict.ok
    result.detailMessage = detailVerdict.message || (detailVerdict.ok ? '轨迹提交成功' : '轨迹提交失败')
    if (detailVerdict.ok) push('ok', SUBMIT_PROGRESS.detailOk(detailMs))
    else push('error', SUBMIT_PROGRESS.detailFail(result.detailMessage))
    /**
     * ⭐ **这正是 E71 那笔事故的关键一步**：明细的成败现在由**服务端**记账并写进日志，
     * 而不再"只存在于前端执行流的先后顺序里" —— 页面被杀不会让它静默消失。
     */
    logInfo('run', detailVerdict.ok ? '轨迹明细已提交' : '轨迹明细提交失败', {
      runId: id,
      scantronId,
      detail: result.detailMessage,
      points: pointCount,
    })
  } else {
    result.detailMessage =
      outcome === 'timeout-unknown'
        ? '结果未知 → 先不发轨迹（不在未确认的成绩上乱写）；核实到已入库时会自动补交'
        : '成绩未成功 → 按源码行为不发轨迹，也不重试'
    push('warn', SUBMIT_PROGRESS.detailSkipped(result.detailMessage))
  }

  // ⑤ 读判定
  setPhase('verdict', '正在读回判定（getSunrunArch）…')
  const archRes = await io.post('/wxxcx/sunrun/getSunrunArch', input.verdictRequest, WRITE_TIMEOUT_MS)
  const mine = findVerdict(archRes.json, scantronId)
  if (mine) {
    result.verdict = mine
    result.verdictMessage = verdictText(mine)
    push('ok', SUBMIT_PROGRESS.verdictOk(result.verdictMessage))
  } else {
    result.verdict = null
    result.verdictMessage = ''
    push('warn', SUBMIT_PROGRESS.verdictNone())
  }

  state.view.result = result
  const doneText = scoreOk
    ? `提交完成：${scoreMessage}${result.detailOk === true ? '（轨迹已交）' : result.detailOk === false ? '（轨迹未交）' : ''}`
    : `提交未成功：${scoreMessage}`
  finish(scoreOk ? 'done' : 'error', doneText)
  logInfo('run', `作业结束：${doneText}`, { runId: id, scantronId, outcome, detailOk: result.detailOk })
}

/** 归档里按场次号找这一笔（`getSunrunArch` 的负载在 `data[]`） */
function findVerdict(json: unknown, scantronId: string): Record<string, unknown> | null {
  if (!scantronId) return null
  const list = (unwrapMpResponse<{ data?: Record<string, unknown>[] }>(json, MP_ENDPOINTS.sunrunArch.payload)?.data ?? []) as Record<string, unknown>[]
  return list.find((r) => String(r.scoreId) === scantronId) ?? null
}

/** 判定文案（与前端 `submit.ts` 的 `verdictText` 同一口径；那边是 `MP_SCORE_STATUS` 的中文表） */
function verdictText(record: Record<string, unknown>): string {
  return (
    `scorePassType=${record.scorePassType}` +
    (record.scorePassRemark ? ` | 备注：${record.scorePassRemark}` : '') +
    ` | 里程 ${record.mileage} | 用时 ${record.usedTime} | 拟合度 ${record.trajectorySimilary}`
  )
}

/** 用时文案（`HH:mm:ss`，与前端报文口径一致） */
function usedTimeText(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
}
