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
import { PENDING_DETAIL_MAX_POINTS, normalizePendingPoints } from './pendingDetail'
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
  /**
   * 🆕 2026-10-10（E76 修复）：线路对象里**官方线路点列的点数**（`line.pointList.length`；无线路 = 0）。
   *
   * 为什么只留"个数"：`sunRunExercises.sunrunPathPointList` **逐字取自** `line.pointList`
   * （`utils/mp/submitPayload.ts` 的唯一构造器），而"点列不落盘"是用户 2026-10-08 拍板的边界
   * ⇒ 点本身由**浏览器**在恢复时补交，磁盘上只留这个**非个人**的数字，
   * 用来核验"补交回来的就是首发那一份"（数量对不上就拒绝续跑，绝不硬发残缺报文）。
   * 取 `-1` = **不知道**（旧版文件/被手改），同样按"不硬发"处理。
   */
  linePointCount: number
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
  /**
   * 0 阳光跑 / 1 自由跑（**非个人**）。
   * ⚠️ 它必须在这里：续跑跑完后若"轨迹没交上"，界面要记一笔待补交的欠账，
   * 而补交时要按**同一种跑法**重发明细（自由跑与阳光跑的口径不同）—— 拿不到它就只能瞎猜。
   */
  runType: 0 | 1
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

/**
 * 🔴 2026-10-10（E76 修复）：把**不该落盘的键**从对象树里剔除（返回深拷贝，**不改入参**）。
 *
 * 为什么必须有它：`context.task` / `context.line` 是**厂商原样对象**，而厂商在任务里带一个
 * **字面键 `token`（实测值恒为字符串 `"null"`）**、在线路里带 `pointList`
 * ⇒ 光靠 `assertNoSensitiveKeys()` 去"断言"，会把**合法数据**判成违规并**抛错**。
 * 2026-10-10 实测事故（E76）正是如此：真实提交在 `startRunSubmitJob()` 里抛 500，
 * 作业已登记却永不启动 ⇒ 僵尸作业 + 一直挡住后续提交。
 *
 * 正确口径：**能落盘的照写，越界的键一律剔除**；断言降级为"剔除漏了"的第二道闸。
 */
export function stripForbiddenKeysDeep(value: unknown): unknown {
  const forbidden = new Set(FORBIDDEN_PERSIST_KEYS.map((k) => keyToken(k)))
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((item) => walk(item))
    if (!isObj(v)) return v
    const out: Record<string, unknown> = {}
    for (const [k, child] of Object.entries(v)) {
      if (forbidden.has(keyToken(k))) continue
      out[k] = walk(child)
    }
    return out
  }
  return walk(value)
}

/** 线路对象里"官方线路点列"的点数（`line.pointList.length`；读不到就是 0） */
export function linePointCountOf(line: unknown): number {
  if (!isObj(line)) return 0
  return Array.isArray(line.pointList) ? line.pointList.length : 0
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
      /**
       * ⚠️ 两个**厂商原样对象**必须先剔除越界键再落盘（`stripForbiddenKeysDeep`）——
       * 厂商在任务里带 `token`（值 "null"）、在线路里带 `pointList`（E76）。
       * 剔除只影响"写进磁盘的那一份"，**不影响发给厂商的报文**（报文用的是内存里的原件）。
       */
      task: stripForbiddenKeysDeep(input.context.task),
      line: stripForbiddenKeysDeep(input.context.line),
      paperId: str(input.context.paperId),
      km: num(input.context.km),
      durationSeconds: num(input.context.durationSeconds),
      fitDegree: num(input.context.fitDegree),
      runType: input.context.runType === 1 ? 1 : 0,
      /** 点列本身不落盘，只留个数（**必须在剔除之前数**，剔除后就没有 `pointList` 了） */
      linePointCount: linePointCountOf(input.context.line),
    },
    verdictRequest: stripForbiddenKeysDeep(stripVerdictIdentity(input.verdictRequest)) as Record<string, unknown>,
    meta: {
      km: num(input.meta.km),
      lineName: str(input.meta.lineName),
      runTypeLabel: str(input.meta.runTypeLabel),
    },
  }
  /**
   * 第二道闸：剔除之后**再断言**。它现在只可能抓到"将来有人往 job 里加了带越界键的新字段"
   * （那确实是漏剔），不会再被厂商原样数据误伤 —— 这正是 E76 的修法。
   */
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
        /** 缺失/坏值 = `-1` = **不知道**（旧版文件）⇒ 续跑时按"不硬发"处理 */
        linePointCount: Number.isFinite(num(c.linePointCount)) ? num(c.linePointCount) : -1,
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
 * 而这几样里只有浏览器有 ⇒ 恢复时由浏览器回传：
 *   · `points`（用户轨迹点）；· `linePointList`（**官方线路点列**，🆕 2026-10-10 E76）；· `snCode`。
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
  /**
   * 🆕 2026-10-10（E76 修复）：**官方线路点列**（= 首发时 `line.pointList` 的原样副本）。
   *
   * 为什么第四样也得由浏览器带着：`sunRunExercises.sunrunPathPointList` **逐字取自**它
   * （`utils/mp/submitPayload.ts`），而"点列不落服务端磁盘"是用户拍板的边界
   * ⇒ 不给浏览器留一份，续跑就只能发出 `sunrunPathPointList: []` 的**残缺报文**（改了提交口径）。
   * ⚠️ **逐字保留**：厂商原样是**字符串坐标**（`"32.032922"`），转成数字就改了报文。
   */
  linePointList: unknown[]
  /** 落盘时刻 */
  at: number
}

/**
 * 官方线路点列的归一化：**只做形状体检 + 浅拷贝，绝不改造数值**。
 * - 允许**空数组**（服务端未下发线路的任务，首发报文里就是 `[]`）；
 * - 每一项必须是对象且 `latitude`/`longitude` 能读成有限数（number 或数字字符串）；
 * - ⚠️ **不转数字、不裁字段**：报文要逐字重现首发那一份。
 */
export function normalizeLinePoints(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > PENDING_DETAIL_MAX_POINTS) return null
  const finiteLike = (v: unknown): boolean =>
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  const out: unknown[] = []
  for (const item of raw) {
    if (!isObj(item)) return null
    if (!finiteLike(item.latitude) || !finiteLike(item.longitude)) return null
    out.push({ ...item })
  }
  return out
}

/**
 * 🆕 2026-10-10（E76 修复）：续跑前核验"浏览器补交的官方线路点列"是不是**首发那一份**。
 *
 * 判据只有一条：**点数与落盘时记下的个数一致** —— 磁盘上没有点本身（边界如此），只能核个数。
 * 返回 `''` = 通过；否则是**人话**拒绝原因（进界面与日志；不许含 markdown 标记）。
 * ⚠️ 宁可拒绝也不硬发：`sunrunPathPointList` 是提交口径的一部分（`ERROR.md` E37）。
 */
export function checkResumeLinePoints(job: PersistedSubmitJob, supplied: unknown): string {
  const expected = num(job?.context?.linePointCount)
  if (!Number.isFinite(expected) || expected < 0) {
    return '这是一份旧版落盘作业，无法确认当时的官方线路点列 ⇒ 不硬发（可以点「作废」放弃它，或重新跑一次）'
  }
  const list =
    /**
     * ⚠️ `undefined` / `null` = "载荷里没有这个字段"（**加它之前**写的浏览器载荷）⇒ 按**空点列**处理：
     * 首发真的是空的（服务端未下发线路的任务）就照常续跑；真丢了点列则由下面那句**数量核验**拦住。
     * 而**畸形**（不是数组 / 点坐标读不出数）仍然当场拒绝 —— 那是"数据坏了"，不是"没有"。
     */
    supplied === undefined || supplied === null ? [] : normalizeLinePoints(supplied)
  if (list === null) {
    return '浏览器里那份「官方线路点列」已不可用（本机数据被清过或被改坏）⇒ 不继续这笔提交（否则会发出缺线路点的报文）；可以点「作废」放弃它'
  }
  if (list.length !== expected) {
    return (
      `浏览器里那份「官方线路点列」与落盘记录对不上（落盘记 ${expected} 个点，本机有 ${list.length} 个）` +
      `⇒ 不继续这笔提交（免得发出与首发不一致的报文）；可以点「作废」放弃它`
    )
  }
  return ''
}

/** 把浏览器补交的官方线路点列**原样装回**线路对象（`line` 为空/点列不可用 ⇒ 原样返回） */
export function withLinePoints(line: unknown, supplied: unknown): unknown {
  const list = normalizeLinePoints(supplied)
  if (!isObj(line) || list === null) return line
  return { ...line, pointList: list }
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
    /**
     * ⚠️ **加这个字段之前写的**老载荷里没有它 ⇒ 按**空**处理，交给服务端的数量核验去判：
     * 首发真的是空的（服务端未下发线路的任务）就照常续跑；真丢了点列则会被 `checkResumeLinePoints()` 拒掉。
     */
    const linePointList = o.linePointList === undefined ? [] : normalizeLinePoints(o.linePointList)
    if (linePointList === null) return null
    return {
      jobId,
      scantronId,
      startedAt,
      snCode: str(o.snCode),
      points,
      linePointList,
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
    /** 官方线路点列：**原样**写出（厂商字符串坐标不许被改写成数字） */
    linePointList: (Array.isArray(p.linePointList) ? p.linePointList : []).map((item) =>
      item && typeof item === 'object' && !Array.isArray(item) ? { ...(item as Record<string, unknown>) } : item,
    ),
    at: num(p.at),
  })
}
