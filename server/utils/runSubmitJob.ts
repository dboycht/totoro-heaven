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
 * 2. **关掉整个 EXE 进程时作业也会死**（单文件免安装、不允许引入外部服务）⇒ 本作业**只保证
 *    "浏览器标签页被冻结/关闭不影响"**；"进程级续跑"是下一轮的事（落盘作业 + 启动续跑）。
 * 3. 报文**不是这里构造的**：成绩 18 字段与明细 3 字段仍由 `utils/mp/submitPayload.ts` 的
 *    唯一构造器产出（客户端算好后传进来）⇒ **提交口径一字未变**，本文件只负责"按顺序发出去"。
 */
import { MP_ENDPOINTS } from '../../src/mp/endpoints'
import { judgeMpResponse, looksLikeTokenExpired, unwrapMpResponse } from '../../src/mp/envelope'
import { classifyWriteOutcome, outcomeIsSuccess, writeOutcomeMessage, type WriteOutcome } from '../../utils/mp/writeOutcome'
import { SUBMIT_PROGRESS, submitProgressLine, type SubmitProgressLine } from '../../utils/mp/submitProgress'
import { buildScoreDetailRequest, buildScoreRequest } from '../../utils/mp/submitPayload'
import { logError, logInfo, logWarn } from './logger'

export type RunSubmitPhase = 'idle' | 'waiting' | 'scoring' | 'detail' | 'verdict' | 'done' | 'error'

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
}

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
    },
    input: null,
    io: null,
    timer: null,
  }
}

/** 模块级单例（与 `tokenScanState` 同一套做法：整个进程只有一次提交在途） */
let state: InternalState = freshState()

export function getRunSubmitJobView(): RunSubmitJobView {
  return { ...state.view, progress: [...state.view.progress] }
}

export function isRunSubmitJobActive(): boolean {
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
  if (state.view.active) {
    return { ok: false, message: `已有一次提交在途（阶段：${state.view.phase}）——请等它跑完再用`, id: state.view.id }
  }
  if (!input.token) return { ok: false, message: '缺少会话 token（请先在「工作台」取 token）', id: '' }
  const id = `run-${Date.now().toString(36)}`
  state = freshState()
  state.view.id = id
  state.view.active = true
  state.view.phase = 'waiting'
  state.view.startedAt = Date.now()
  state.input = input
  state.io = isDryRun() ? dryRunIo() : proxyIo(origin, input)
  const planned = isDryRun() ? 3 : Math.max(1, Math.round(input.plannedSeconds))
  state.view.remainingSeconds = planned
  void runJob(id, planned).catch((err) => {
    // 兜底：编排里任何未捕获异常都不许让状态悬着（否则前端会一直轮询）
    finish('error', `提交作业异常：${err instanceof Error ? err.message : String(err)}`)
  })
  return { ok: true, message: '已开始（进度会同时打在服务端终端；页面只负责展示）', id }
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
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function runJob(id: string, planned: number): Promise<void> {
  const input = state.input
  const io = state.io
  if (!input || !io) return
  const scantronId = String(input.scantronId ?? '')
  const meta = input.meta
  const jobStartedAt = state.view.startedAt
  push('step', SUBMIT_PROGRESS.begin(meta.lineName, meta.runTypeLabel))
  push('ok', SUBMIT_PROGRESS.beginOk(scantronId))
  push('step', SUBMIT_PROGRESS.wait(planned, meta.km))

  // ② 真实等待：**服务端计时器**（不受浏览器节流；页面前端只读 remainingSeconds 显示）
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

  /**
   * ⭐ 报文在这一刻才构造（`endMs` = 现在）：这样 `endTime` 落在**真正发出请求**的时刻上，
   * 与改造前"前端在等待结束后构造"完全同口径；而 `startMs` 用作业开始时刻（≈ `getRunBegin` 返回那一刻）。
   */
  const submittedAt = Date.now()
  const submitContext = {
    snCode: input.context.snCode,
    schoolCode: input.context.schoolCode,
    task: input.context.task as never,
    line: input.context.line as never,
    paperId: input.context.paperId,
    km: input.context.km,
    durationSeconds: planned,
    fitDegree: input.context.fitDegree,
    points: input.context.points,
    token: input.token,
    scantronId,
    startMs: jobStartedAt,
    endMs: submittedAt,
  }
  const scoreRequest = buildScoreRequest(submitContext, { runType: input.context.runType })
  const detailRequest = buildScoreDetailRequest(submitContext)
  const usedTime = usedTimeText(planned)
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
