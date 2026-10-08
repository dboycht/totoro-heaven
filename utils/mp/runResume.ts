/**
 * 「跨进程续跑」的纯逻辑：**作业落盘该长什么样** + **恢复得太晚就别发**的判据。
 *
 * ## 为什么要有它（2026-10-08 用户要求，接 `防 kill` 重构的两个边界之一）
 * `防 kill` 重构（`server/utils/runSubmitJob.ts`）只解决了"**浏览器**被冻结/关闭不影响"，
 * 而**关掉整个 EXE 进程**作业照样死（单文件免安装、不引入外部服务）⇒ 那笔就白等了。
 * 用户 2026-10-08 要求补上"**进程级续跑**"：重启后能接着跑。
 *
 * ## 🔒 落盘的边界（用户 2026-10-08 拍板，**这是本模块最重要的一条**）
 * 跨进程续跑必须写盘，但**不是什么都写**：
 *   - ❌ **token**：项目红线（任何形态不落盘）；
 *   - ❌ **轨迹点（`points`）**：由**浏览器** `localStorage` 存（沿用「补交轨迹」那套口径），恢复时回传；
 *   - ❌ **学号（`snCode` / `stuNumber`）**：与诊断包的"学号打码"同一套口径，不进磁盘；
 *   - ✅ **只落非个人元数据**：场次号 / 时间口径 / 任务 / 官方线路 / 里程 / 拟合度 / 判定入参（**去掉学号后**）。
 * ⇒ `toPersistedSubmitJob()` 是**唯一出口**：它显式挑字段（不是"删掉几个敏感键"，
 *    这样将来给输入加字段时**默认不会**被写进磁盘），并有 `assertNoSensitiveKeys()` 兜底。
 *
 * ## 恢复得太晚怎么办（用户 2026-10-08 拍板）
 * 用作业里已经带着的 `task.minTime/maxTime`（**复用 `taskRules.toDurationSeconds` 的单位推断**，不另造口径）：
 *   - 还没到原定提交时刻 ⇒ **接着等**；
 *   - 已过原定时刻、且"从开跑到现在"**仍落在任务允许的时长区间内** ⇒ **立即提交**；
 *   - 超出区间 ⇒ **丢弃并如实告知**（不提交 —— 免得留下时间不对的异常记录）。
 *   ⚠️ 任务**没下发**行程区间时，**绝不按某个数字硬判**（E68/E51 的教训：服务端没提的不许自己当要求），
 *   改用**本地宽限** `RESUME_GRACE_SECONDS`（计划时长 + 5 分钟）—— 那是"这次还算是同一趟吗"的本地判断，
 *   **不是**厂商要求；超了就丢弃。
 */
import { normalizePendingPoints } from './pendingDetail'
import { toDurationSeconds } from './taskRules'

/** 落盘文件名（放在 `server/utils/logger.ts` 的 `RUNTIME_DIR` 下，即 `%TEMP%\totoro-heaven-runtime\`） */
export const PERSISTED_SUBMIT_FILE = 'pending-submit.json'

/** 落盘格式版本（将来改结构时靠它判断能不能读） */
export const PERSISTED_SUBMIT_VERSION = 1

/**
 * 落盘作业的最长存活：超过就当作**过期**。
 * 为什么要它：落盘的作业会**挡住新的提交**（同时只允许一次在途）—— 没有期限的话，
 * 用户忘记它就会永远开不了新的（那比"没续跑"更糟）。
 */
export const PERSISTED_SUBMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 任务**没下发**行程区间时的本地宽限（秒）。
 * ⚠️ 这是**本地口径**（"过了这么久，还能算同一趟吗"），**不是**厂商要求 ⇒ 不许拿它去判任务合规。
 */
export const RESUME_GRACE_SECONDS = 300

/**
 * 绝不允许出现在落盘文件里的键名（大小写/下划线不敏感）。
 * 判据来源：用户 2026-10-08 的三选项（token 与轨迹点不落盘、只留非个人元数据）。
 */
export const FORBIDDEN_PERSIST_KEYS = [
  'token',
  'authorization',
  'facebase64',
  'sncode',
  'stunumber',
  'points',
  'pointlist',
  'sunrunpathpointlist',
] as const

/** 落盘的作业上下文（**显式去掉** `snCode` / `points` / `token` —— 由客户端在恢复时补交） */
export interface PersistedSubmitContext {
  schoolCode: string
  task: unknown
  line: unknown
  paperId: string
  km: number
  durationSeconds: number
  fitDegree: number
  runType: 0 | 1
}

/**
 * 挂起作业的**非敏感摘要**：服务端 `GET /api/local/run/submit/status` 回给界面渲染
 * 「继续提交」卡片用的那几个字段。
 *
 * ⚠️ **为什么这个形状放在算法层**（而不是 `server/utils/runSubmitJob.ts`）：
 * 它是**服务端与界面共用的线上形状**，而分层纪律（`HANDOVER.md` §3.1 / 守卫 R6）规定
 * **装配层不得直接 import `server/`** ⇒ 放这里，两边都只依赖算法层。
 * 🔒 只含场次号/里程/线路名/时间口径 —— **不含 token、不含轨迹点、不含学号**。
 */
export interface SuspendedJobSummary {
  id: string
  scantronId: string
  km: number
  lineName: string
  runTypeLabel: string
  /** 作业开始时刻（毫秒） */
  startedAt: number
  /** 报备时长（秒） */
  plannedSeconds: number
  /** 原定提交时刻 `HH:mm`（展示用） */
  targetClock: string
  /** 人话摘要（进界面；不含 markdown） */
  summary: string
}

/** 落盘作业的完整形状（`server/utils/runSubmitJob.ts` 的 `RunSubmitJobInput` 去掉敏感项） */
export interface PersistedSubmitJob {
  version: number
  /** 作业 id（与内存里那份一致；恢复时要对得上） */
  id: string
  /** 作业开始时刻（毫秒）—— ≈ `getRunBegin` 返回那一刻，报文 `startTime` 用它 */
  startedAt: number
  /** 报备时长（秒）—— 原定"等这么久再提交" */
  plannedSeconds: number
  /** 服务端场次号 */
  scantronId: string
  /** 多租户基址（学校自有域；空串=共享域）—— 非个人 */
  baseUrl: string
  context: PersistedSubmitContext
  /**
   * 判定入参（`getSunrunArch` 的 body）——**已去掉 `snCode`/`stuNumber`**：
   * 剩下的 `monthId`/`termId`/`paperId`/分页 都是非个人的，恢复时由客户端补回学号。
   */
  verdictRequest: Record<string, unknown>
  meta: { km: number; lineName: string; runTypeLabel: string }
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 把键名归一化后比对（`snCode` / `sn_code` / `SNCODE` 都算同一个） */
const keyToken = (k: string): string => k.replace(/[_\-\s]/g, '').toLowerCase()

/**
 * 兜底断言：对象（含嵌套）里**不许**出现敏感键。
 * `toPersistedSubmitJob()` 已经显式挑字段，这里是**第二道闸** —— 将来有人图省事把整个 input 传进来会被它拦下。
 */
export function assertNoSensitiveKeys(value: unknown, path = '$'): void {
  const forbidden = new Set(FORBIDDEN_PERSIST_KEYS.map((k) => keyToken(k)))
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      // 数组本身可能是轨迹点列（`points` 已经在键名层被拦），这里只看元素里的对象键
      v.forEach((item, i) => walk(item, `${p}[${i}]`))
      return
    }
    if (!isObj(v)) return
    for (const [k, child] of Object.entries(v)) {
      if (forbidden.has(keyToken(k))) {
        throw new Error(`落盘作业里不允许出现敏感键「${k}」（位置 ${p}.${k}）——见 utils/mp/runResume.ts 的落盘边界`)
      }
      walk(child, `${p}.${k}`)
    }
  }
  walk(value, path)
}

/** 从判定入参里**去掉学号**（保留其余非个人字段） */
export function stripVerdictIdentity(raw: unknown): Record<string, unknown> {
  if (!isObj(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    const t = keyToken(k)
    if (t === 'sncode' || t === 'stunumber' || t === 'token' || t === 'authorization') continue
    out[k] = v
  }
  return out
}

/** 恢复时把学号补回判定入参（`buildVerdictRequest` 的原口径同时写 `stuNumber` 与 `snCode`） */
export function withVerdictIdentity(stripped: Record<string, unknown>, snCode: string): Record<string, unknown> {
  return { ...stripped, stuNumber: snCode, snCode }
}

/**
 * ⭐ **落盘的唯一出口**：从作业输入里**显式挑**字段（默认安全：新加的输入字段不会被写进磁盘）。
 * @param input 形状与 `RunSubmitJobInput` 一致（这里用结构化最小类型，免得把服务端类型引到算法层）
 */
export function toPersistedSubmitJob(input: {
  id: string
  startedAt: number
  plannedSeconds: number
  scantronId: string
  baseUrl?: string
  context: {
    schoolCode: string
    task: unknown
    line: unknown
    paperId: string
    km: number
    durationSeconds: number
    fitDegree: number
    runType: 0 | 1
  }
  verdictRequest: unknown
  meta: { km: number; lineName: string; runTypeLabel: string }
}): PersistedSubmitJob {
  const job: PersistedSubmitJob = {
    version: PERSISTED_SUBMIT_VERSION,
    id: str(input.id),
    startedAt: num(input.startedAt),
    plannedSeconds: num(input.plannedSeconds),
    scantronId: str(input.scantronId),
    baseUrl: str(input.baseUrl),
    context: {
      schoolCode: str(input.context.schoolCode),
      task: input.context.task,
      line: input.context.line,
      paperId: str(input.context.paperId),
      km: num(input.context.km),
      durationSeconds: num(input.context.durationSeconds),
      fitDegree: num(input.context.fitDegree),
      runType: input.context.runType === 1 ? 1 : 0,
    },
    verdictRequest: stripVerdictIdentity(input.verdictRequest),
    meta: {
      km: num(input.meta.km),
      lineName: str(input.meta.lineName),
      runTypeLabel: str(input.meta.runTypeLabel),
    },
  }
  assertNoSensitiveKeys(job)
  return job
}

/** 从磁盘读到的原始文本解析成落盘作业；**任何坏数据一律 null（绝不抛）** */
export function parsePersistedSubmitJob(raw: unknown): PersistedSubmitJob | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const o = JSON.parse(raw) as unknown
    if (!isObj(o)) return null
    if (num(o.version) !== PERSISTED_SUBMIT_VERSION) return null
    const id = str(o.id)
    const scantronId = str(o.scantronId)
    const startedAt = num(o.startedAt)
    const plannedSeconds = num(o.plannedSeconds)
    if (!id || !scantronId) return null
    if (!Number.isFinite(startedAt) || startedAt <= 0) return null
    if (!Number.isFinite(plannedSeconds) || plannedSeconds <= 0) return null
    if (!isObj(o.context)) return null
    const c = o.context
    const km = num(c.km)
    const durationSeconds = num(c.durationSeconds)
    if (!Number.isFinite(km) || km <= 0) return null
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
    const meta = isObj(o.meta) ? o.meta : {}
    const job: PersistedSubmitJob = {
      version: PERSISTED_SUBMIT_VERSION,
      id,
      startedAt,
      plannedSeconds,
      scantronId,
      baseUrl: str(o.baseUrl),
      context: {
        schoolCode: str(c.schoolCode),
        task: c.task,
        line: c.line,
        paperId: str(c.paperId),
        km,
        durationSeconds,
        fitDegree: Number.isFinite(num(c.fitDegree)) ? num(c.fitDegree) : 0,
        runType: num(c.runType) === 1 ? 1 : 0,
      },
      verdictRequest: isObj(o.verdictRequest) ? o.verdictRequest : {},
      meta: {
        km: Number.isFinite(num(meta.km)) ? num(meta.km) : km,
        lineName: str(meta.lineName),
        runTypeLabel: str(meta.runTypeLabel),
      },
    }
    // 读回来也要过一遍闸：磁盘上的文件可能是**旧版本/被手改过**的
    assertNoSensitiveKeys(job)
    return job
  } catch {
    return null
  }
}

/** 落盘作业是否已过期（超过 `PERSISTED_SUBMIT_MAX_AGE_MS`） */
export function isPersistedJobExpired(job: PersistedSubmitJob, now: number): boolean {
  return now - job.startedAt > PERSISTED_SUBMIT_MAX_AGE_MS
}

export type ResumeAction = 'wait' | 'submit' | 'discard'

export interface ResumeDecision {
  action: ResumeAction
  /** `action='wait'` 时要再等多久（毫秒）；其它情况为 0 */
  waitMs: number
  /** 从开跑到"现在"的秒数（`action='submit'` 时报文里的时长就用它） */
  elapsedSeconds: number
  /** 人话原因（进日志与界面；**不含 markdown 标记**） */
  reason: string
}

const mmss = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds))
  const two = (n: number) => String(n).padStart(2, '0')
  return `${Math.floor(s / 60)} 分 ${two(s % 60)} 秒`
}

/**
 * ⭐ 恢复判据（**唯一出口**，服务端与单测都走它）。
 * 见文件头的"恢复得太晚怎么办"。
 */
export function decideResume(opts: {
  startedAt: number
  plannedSeconds: number
  now: number
  /** 任务本体（读 `minTime`/`maxTime`） */
  task: unknown
}): ResumeDecision {
  const startedAt = num(opts.startedAt)
  const plannedSeconds = num(opts.plannedSeconds)
  const now = num(opts.now)
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000))
  const targetAt = startedAt + plannedSeconds * 1000

  // ① 还没到原定提交时刻 ⇒ 接着等（这正是"关掉几分钟就重启"的常见情形）
  if (now < targetAt) {
    const waitMs = targetAt - now
    return {
      action: 'wait',
      waitMs,
      elapsedSeconds,
      reason: `还没到原定提交时刻（还差约 ${Math.ceil(waitMs / 1000)} 秒）⇒ 接着等完再提交`,
    }
  }

  // ② 已过原定时刻：看"从开跑到现在"是否仍落在任务允许的时长区间内
  const task = isObj(opts.task) ? opts.task : {}
  const minSeconds = toDurationSeconds(task.minTime as number | string | undefined)
  const maxSeconds = toDurationSeconds(task.maxTime as number | string | undefined)

  if (minSeconds !== undefined || maxSeconds !== undefined) {
    const lower = Math.min(minSeconds ?? 0, maxSeconds ?? Number.POSITIVE_INFINITY)
    const upper = Math.max(minSeconds ?? 0, maxSeconds ?? Number.POSITIVE_INFINITY)
    if (elapsedSeconds >= lower && elapsedSeconds <= upper) {
      return {
        action: 'submit',
        waitMs: 0,
        elapsedSeconds,
        reason: `恢复时距开跑 ${mmss(elapsedSeconds)}，仍落在任务允许的时长区间内 ⇒ 立即提交`,
      }
    }
    return {
      action: 'discard',
      waitMs: 0,
      elapsedSeconds,
      reason:
        `恢复时距开跑 ${mmss(elapsedSeconds)}，已超出任务允许的时长区间` +
        `（${mmss(lower)} ~ ${mmss(upper)}）⇒ 不提交（免得留下时间不对的异常记录）`,
    }
  }

  // ③ 任务没下发行程区间 ⇒ 用**本地宽限**（绝不按某个数字硬判成"任务要求"）
  const graceLimit = plannedSeconds + RESUME_GRACE_SECONDS
  if (elapsedSeconds <= graceLimit) {
    return {
      action: 'submit',
      waitMs: 0,
      elapsedSeconds,
      reason: `任务未下发行程区间，按本地宽限（计划 ${mmss(plannedSeconds)} + 5 分钟）判定仍算同一趟 ⇒ 立即提交`,
    }
  }
  return {
    action: 'discard',
    waitMs: 0,
    elapsedSeconds,
    reason:
      `任务未下发行程区间，且已超本地宽限（计划 ${mmss(plannedSeconds)} + 5 分钟）` +
      `⇒ 不提交（免得留下时间不对的异常记录）`,
  }
}

/** 恢复卡片的人话摘要（**不含 markdown 标记**：用户可见文本有守卫） */
export function resumeSummaryText(job: PersistedSubmitJob, now: number): string {
  return (
    `有一笔提交还没跑完就被关掉了：场次 ${job.scantronId}，` +
    `${job.meta.km.toFixed(2)} km / ${mmss(job.plannedSeconds)}` +
    `${job.meta.lineName ? `，线路 ${job.meta.lineName}` : ''}。` +
    `它原本应该在 ${targetClock(job)} 提交。` +
    `点「继续这笔提交」才会真的发出去（只在你点的时候发一次，不自动重试）；` +
    `如果重启得太晚、已经超出任务允许的时长，它会如实告诉你并作废，不会硬发。`
  )
}

/** 原定提交时刻 → `HH:mm`（只给界面看，别拿它当判据） */
export function targetClock(job: PersistedSubmitJob): string {
  const t = new Date(job.startedAt + job.plannedSeconds * 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(t.getHours())}:${two(t.getMinutes())}`
}

// ---------- 浏览器侧：续跑要补交的那三样（**token 不在这里** —— 它随时从会话取） ----------

/**
 * `localStorage` 键：续跑所需的**浏览器侧**数据（作业跑完/叫停/作废即删）。
 *
 * 为什么要放浏览器：用户 2026-10-08 拍板"**轨迹点不落服务端磁盘**"（沿用「补交轨迹」那套口径），
 * 而那三样里 `points` 只有浏览器有 ⇒ 恢复时由浏览器回传。
 * `token` **不进这里**（它在 `mp_session` 里，现取现用，少一份副本少一个泄漏面）。
 */
export const PENDING_SUBMIT_RESUME_KEY = 'mp_pending_submit_v1'

export interface PendingResumePayload {
  /** 对应的服务端作业 id（必须对得上，免得把 A 的轨迹塞给 B） */
  jobId: string
  scantronId: string
  /** 作业开始时刻（毫秒；与落盘那份同源，用作交叉校验） */
  startedAt: number
  /** 学号（"判定入参"里被剥掉的那部分，恢复时补回） */
  snCode: string
  /** 那次真正要发的轨迹点（**逐点重现**靠它） */
  points: { latitude: number; longitude: number }[]
  /** 落盘时刻 */
  at: number
}

/** 从 `localStorage` 读到的原始文本解析；**坏数据一律 null（绝不抛）** */
export function parsePendingResume(raw: unknown): PendingResumePayload | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const o = JSON.parse(raw) as unknown
    if (!isObj(o)) return null
    const jobId = str(o.jobId)
    const scantronId = str(o.scantronId)
    const startedAt = num(o.startedAt)
    if (!jobId || !scantronId) return null
    if (!Number.isFinite(startedAt) || startedAt <= 0) return null
    const points = normalizePendingPoints(o.points)
    if (!points) return null
    return {
      jobId,
      scantronId,
      startedAt,
      snCode: str(o.snCode),
      points,
      at: Number.isFinite(num(o.at)) ? num(o.at) : 0,
    }
  } catch {
    return null
  }
}

/**
 * 序列化（**显式挑字段**，不是 `JSON.stringify(payload)` 透传）。
 * 为什么：透传时调用方多塞一个 `token` 就会**静默落盘**（单测正是这么抓到的）⇒
 * 与 `toPersistedSubmitJob()` 同一套"默认安全"原则：新加的字段默认**不会**被写出去。
 */
export function serializePendingResume(p: PendingResumePayload): string {
  return JSON.stringify({
    jobId: str(p.jobId),
    scantronId: str(p.scantronId),
    startedAt: num(p.startedAt),
    snCode: str(p.snCode),
    points: (Array.isArray(p.points) ? p.points : []).map((pt) => ({
      latitude: num((pt as { latitude?: unknown })?.latitude),
      longitude: num((pt as { longitude?: unknown })?.longitude),
    })),
    at: num(p.at),
  })
}
