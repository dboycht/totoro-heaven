/**
 * 【真实链路】共享状态的**唯一来源**（`useMpReal` 结构整理：只读/写拆分，1.1.7）
 *
 * 为什么拆分**不需要**自己造单例/工厂：本链路的状态**全部**用 Nuxt 的
 * `useState('mpRealXxx', ...)` 声明 —— 同一个 key 在**任何地方**调用 `useState`
 * 拿到的都是**同一个共享引用**。所以这里把 key 集中声明一次，
 * `real/data.ts`（只读）与 `real/submit.ts`（写）各取所需即可。
 *
 * ⚠️ 改 key 名等于改共享契约：`real/data.ts` 与 `real/submit.ts` 会立刻读/写不到同一份状态。
 */
import type { MpSunrunTask } from '~/src/mp/types'
// 🆕 2026-09-21（E：自由跑入口标灰）：键名与"是不是未开通"的判据都在纯逻辑层（单一来源）
import { FREE_RUN_UNSUPPORTED_KEY } from '~/utils/mp/freeRun'
// 🆕 2026-10-07（用户要求）：服务端说"今日该任务次数已达上限"时的标记（键名/解析/跨天判定都在纯逻辑层）
import { DAILY_QUOTA_KEY, localDateKey, parseQuotaMark, type DailyQuotaMark } from '~/utils/mp/dailyQuota'
// 🆕 2026-10-07（实测事故）：待补交的轨迹明细（键名/解析/文案都在纯逻辑层）
import { PENDING_DETAIL_KEY, parsePendingDetail, serializePendingDetail, type PendingDetail } from '~/utils/mp/pendingDetail'
// 🆕 2026-10-08（用户要求，防 kill 的第二个边界）：跨进程续跑 ——
//   · `pendingResume`：**浏览器侧**要补交的那三样（轨迹点/学号/作业 id；**token 不在这里**，现从会话取）
//   · `suspendedJob`：服务端"上次没跑完的作业"的**非敏感摘要**（界面据此渲染「继续提交」卡片）
import {
  PENDING_SUBMIT_RESUME_KEY,
  parsePendingResume,
  serializePendingResume,
  type PendingResumePayload,
  type SuspendedJobSummary,
} from '~/utils/mp/runResume'
// 🆕 2026-09-21：提交过程清单的行类型（清单本体从 `real/submit.ts` 的局部 ref 提上来做单例）
import type { SubmitProgressLine } from '~/utils/mp/submitProgress'

/**
 * 学生档案（`GetStudentInfoByToken` 读到的本人信息）。
 * 📌 2026-09-18：曾为"缓存补存账号"短暂移到契约层 `src/mp/models.ts`；
 * 缓存精简为"任务 + 选线"后**已搬回这里**（只有真实链路用它，契约层不再需要）。
 */
export interface MpRealProfile {
  snCode: string
  studentName: string
  schoolCode: string
  schoolName: string
  /** 校区（实测是中文名，如「天目湖」；同时作为 getSunrunPaper 的 campusId） */
  campusId: string
  campusName: string
  className: string
}

export type RealPhase = 'idle' | 'begin' | 'waiting' | 'submitting' | 'done' | 'error'

export interface RealSubmitResult {
  scantronId: string
  startedAt: number
  submittedAt: number
  scoreOk: boolean
  scoreMessage: string
  detailOk?: boolean
  detailMessage?: string
  /** 提交的报文（脱敏：token 已替换，仅用于界面展示/排错） */
  scoreRequestMasked?: Record<string, unknown>
  /** 读回的归档记录 */
  record?: Record<string, unknown> | null
  verdictText?: string
  /**
   * 🆕 2026-09-21（冗余加固）：这次提交的**结局**四态 —— 界面据此区分"成功 / 超时但已核实入库 /
   * **结果未知** / 确定失败"。原先界面只能看 `scoreOk` 二分，会把"结果未知"渲染成**红色失败**并写
   * "成绩未成功"，与文案自相矛盾（审计 B3）。
   */
  scoreOutcome?: 'ok' | 'timeout-landed' | 'timeout-unknown' | 'failed'
}

export const TASK_CACHE_KEY = 'mp_real_task_v1'

export function useRealState() {
  const profile = useState<MpRealProfile | null>('mpRealProfile', () => null)
  const task = useState<MpSunrunTask | null>('mpRealTask', () => null)
  const status = useState<'idle' | 'loading' | 'ready' | 'error'>('mpRealStatus', () => 'idle')
  const error = useState('mpRealError', () => '')
  const loadedAt = useState('mpRealLoadedAt', () => 0)
  /** 人脸 / 抽查开关（selectSunRunStartConfiguration 的 body）—— 一票否决项，实测值直接展示 */
  const switches = useState<Record<string, string> | null>('mpRealSwitches', () => null)
  /** 所选线路是否启用摄像头杆（getCameraConfig 的 body.flag）—— ⚠️ 这是**按线路**下发的 */
  const cameraFlag = useState<boolean | null>('mpRealCameraFlag', () => null)
  /** 上面那个 flag 对应的线路 id（避免切线路后显示旧线路的值） */
  const cameraFlagLineId = useState('mpRealCameraFlagLine', () => '')
  /** 读取摄像头杆开关失败/异常时的原因（界面展示；空串=无异常） */
  const cameraFlagError = useState('mpRealCameraFlagErr', () => '')

  /**
   * 🆕 2026-09-21（E：自由跑入口标灰）：**本机已知该校/该账号未开通「自由跑任务」**。
   * 服务端拒绝过一次就记住（持久化），下次开跑前把自由跑的真实提交入口标灰并说明原因；
   * 同时给"仍要试一次"的出口（`clearFreeRunUnsupported`）—— 不挡开通了的学校。
   * 初值从 localStorage 读（`FREE_RUN_UNSUPPORTED_KEY`），与 `mp_free_run_km` 同一套薄壳做法。
   */
  const freeRunUnsupported = useState<boolean>('mpFreeRunUnsupported', () => {
    if (import.meta.client) {
      try {
        return localStorage.getItem(FREE_RUN_UNSUPPORTED_KEY) === '1'
      } catch {
        /* ignore */
      }
    }
    return false
  })
  const markFreeRunUnsupported = () => {
    freeRunUnsupported.value = true
    if (import.meta.client) {
      try {
        localStorage.setItem(FREE_RUN_UNSUPPORTED_KEY, '1')
      } catch {
        /* ignore */
      }
    }
  }
  const clearFreeRunUnsupported = () => {
    freeRunUnsupported.value = false
    if (import.meta.client) {
      try {
        localStorage.removeItem(FREE_RUN_UNSUPPORTED_KEY)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 🆕 2026-10-07（用户要求）：**服务端说"今日该任务次数已达上限"** 的标记。
   *
   * 实测：同一任务当天已真实提交成功过一笔后，再提交会被 `getRunBegin` 拒绝
   * （原话 `该任务次数今日已达上限!`）—— 这是**服务端按"任务 + 当天"的配额**，当天再试仍会被拒。
   * 所以照「自由跑未开通」那套：**记住今天**，下次开跑前把入口标灰并说明原因，同时留「仍要试一次」出口。
   *
   * ⚠️ 与 `freeRunUnsupported` 的一处**有意不同**：这里**不在"退出登录/清空本机数据"时清除** ——
   *    它表达的是"服务端今天的配额用完了"，既不是凭据也不是用户数据，而且跨天会**自动失效**
   *    （判定走 `isQuotaMarkActive` 的日期比较，不依赖任何清理动作）。
   */
  const dailyQuotaMark = useState<DailyQuotaMark | null>('mpDailyQuotaMark', () => {
    if (import.meta.client) {
      try {
        return parseQuotaMark(localStorage.getItem(DAILY_QUOTA_KEY))
      } catch {
        /* ignore */
      }
    }
    return null
  })
  const markDailyQuotaReached = (message: string, paperId: string) => {
    const mark: DailyQuotaMark = {
      date: localDateKey(),
      paperId: String(paperId ?? ''),
      message: String(message ?? ''),
    }
    dailyQuotaMark.value = mark
    if (import.meta.client) {
      try {
        localStorage.setItem(DAILY_QUOTA_KEY, JSON.stringify(mark))
      } catch {
        /* ignore */
      }
    }
  }
  const clearDailyQuotaMark = () => {
    dailyQuotaMark.value = null
    if (import.meta.client) {
      try {
        localStorage.removeItem(DAILY_QUOTA_KEY)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 🆕 2026-10-07（实测事故）：**「待补交的轨迹明细」** —— 成绩提交成功、但轨迹明细还没发出去时的那笔欠账。
   *
   * 事故现场：`sunRunExercises` 提交成功（20:53:41，耗时 13.8 s），紧随其后的
   * `sunRunExercisesDetail` **一个请求都没发**（日志里该端点出现次数 = 0）——
   * 因为切换标签页后 Edge 冻结/丢弃了页面，成绩响应刚回来、还没走到"发明细"那一步，JS 上下文就没了。
   * 后果与 **E33** 同族：**云端成绩有效、却没有轨迹**（详情页地图空白）。
   *
   * 旧实现**完全不落盘** ⇒ 页面一死，"这笔还欠一条轨迹"就没人知道了。
   * 现在：成绩成功 ⇒ **发明细之前**先把这笔欠账（含轨迹点本体）落盘；明细成功 ⇒ 清掉；
   * 页面重启后若还欠着，跑步页会提示并可**由用户点一次补交一次**（不自动重试）。
   *
   * ⚠️ 与"凭据"无关（不含 token）⇒ 不在退出登录/清空数据时清除；但它**必须**在明细成功后清掉，
   *    否则界面会一直提示一笔已经交上的轨迹。
   */
  const pendingDetail = useState<PendingDetail | null>('mpPendingDetail', () => {
    if (import.meta.client) {
      try {
        return parsePendingDetail(localStorage.getItem(PENDING_DETAIL_KEY))
      } catch {
        /* ignore */
      }
    }
    return null
  })
  const savePendingDetail = (detail: PendingDetail) => {
    pendingDetail.value = detail
    if (import.meta.client) {
      try {
        localStorage.setItem(PENDING_DETAIL_KEY, serializePendingDetail(detail))
      } catch {
        /* ignore：写不进去也不影响本次提交（只是失去"重启后还能补交"这一层保护） */
      }
    }
  }
  const clearPendingDetail = () => {
    pendingDetail.value = null
    if (import.meta.client) {
      try {
        localStorage.removeItem(PENDING_DETAIL_KEY)
      } catch {
        /* ignore */
      }
    }
  }
  /** 补交尝试后如实记账（次数 + 上次失败原因），别假装没试过 */
  const patchPendingDetail = (patch: { attempts?: number; lastError?: string }) => {
    const cur = pendingDetail.value
    if (!cur) return
    savePendingDetail({
      ...cur,
      ...(typeof patch.attempts === 'number' ? { attempts: patch.attempts } : {}),
      ...(typeof patch.lastError === 'string' ? { lastError: patch.lastError } : {}),
    })
  }

  /**
   * 🆕 2026-10-08（用户要求）：**跨进程续跑**用到的两份状态。
   *
   * ## `pendingResume`（浏览器侧，落 `localStorage`）
   * 用户拍板的落盘边界是"**轨迹点不落服务端磁盘**"（沿用「补交轨迹」那套口径）⇒
   * 那三样里只有浏览器有 `points`，恢复时由浏览器回传。
   *   · 作业**启动成功那一刻**写入；作业跑完 / 叫停 / 作废时清除；
   *   · 🔒 **不含 token**（它在 `mp_session` 里，现取现用 —— 少一份副本少一个泄漏面）。
   *
   * ## `suspendedJob`（服务端摘要，**不落 localStorage**）
   * 每次读 `GET /api/local/run/submit/status` 时由服务端给（那是"磁盘上到底有没有一笔没跑完"的**唯一真值**）；
   * 界面据此渲染「继续提交 / 作废」卡片。**刷新后由一次状态查询重新填上**，不自己存一份（避免与磁盘不一致）。
   */
  const pendingResume = useState<PendingResumePayload | null>('mpPendingResume', () => {
    if (import.meta.client) {
      try {
        return parsePendingResume(localStorage.getItem(PENDING_SUBMIT_RESUME_KEY))
      } catch {
        /* ignore */
      }
    }
    return null
  })
  const savePendingResume = (p: PendingResumePayload) => {
    pendingResume.value = p
    if (import.meta.client) {
      try {
        localStorage.setItem(PENDING_SUBMIT_RESUME_KEY, serializePendingResume(p))
      } catch {
        /* ignore：写不进去只失去"重启后可续跑"这一层保护，不影响本次提交 */
      }
    }
  }
  const clearPendingResume = () => {
    pendingResume.value = null
    if (import.meta.client) {
      try {
        localStorage.removeItem(PENDING_SUBMIT_RESUME_KEY)
      } catch {
        /* ignore */
      }
    }
  }
  const suspendedJob = useState<SuspendedJobSummary | null>('mpSuspendedJob', () => null)

  // 「上次读取的会话」缓存的界面状态（**刷新后不再自动回填**；只作为可选的显式恢复入口）
  const cacheAt = useState('mpRealCacheAt', () => 0)
  const cachePaperName = useState('mpRealCachePaper', () => '')
  /**
   * 缓存里**是否存了 token**（「恢复」能否真正重建会话的依据；2026-09-18 加）。
   * 只存布尔与掩码，界面据此决定文案；**绝不把完整 token 放进界面状态**。
   */
  const cacheHasToken = useState('mpRealCacheHasToken', () => false)
  const cacheTokenMask = useState('mpRealCacheTokenMask', () => '')
  /**
   * 🆕 2026-09-22（真实用户实测）：**本次页面加载时"任务是从本机缓存自动恢复的"** ——
   * 值是那次读取的时刻（毫秒）；0 = 不是恢复来的（内存里本来就有 / 用户显式读取过）。
   *
   * 用途：跑步页据此显示"已从本机缓存恢复（最近一次读取于 HH:mm）"，
   * 并说明**开跑开关（人脸/抽查）与摄像头杆不在缓存里** ⇒ 要真实提交得点一次「重新读取」。
   * ⚠️ 一旦真的联网读取成功（`loadRealData`）或清空本机数据，这个标记必须复位 ——
   * 否则界面会一直挂着"恢复来的"这句话，与事实不符。
   */
  const restoredAt = useState('mpRealRestoredAt', () => 0)

  const phase = useState<RealPhase>('mpRealPhase', () => 'idle')
  const phaseMessage = useState('mpRealPhaseMessage', () => '')
  const remainingSeconds = useState('mpRealRemaining', () => 0)
  const result = useState<RealSubmitResult | null>('mpRealResult', () => null)
  /**
   * 🆕 2026-09-21：**提交过程清单**（真实提交的六步打点，界面「提交过程」面板直接渲染它）。
   *
   * 原先它是 `real/submit.ts` 里的**局部 `ref`** ⇒ 而导出它的 `useMpRealSubmit()` 有多个调用点，
   * 每个调用点各拿一份**互相独立**的清单，于是：
   *   · 换页 / 切走再回来，「提交过程」面板会**重来**（上一次的过程凭空丢失）；
   *   · 工作台的「清空本机数据」**清不掉**它，可能残留上一次提交的过程。
   * 提到这里用 `useState` 后：同一 key 在任何地方都是**同一个共享引用**（换页不丢），
   * 也能被 `real/data.ts` 的 `clearAllLocalData()` 复位（清空数据能清）。
   */
  const submitProgress = useState<SubmitProgressLine[]>('mpRealSubmitProgress', () => [])

  /**
   * 时钟 tick（每 30 秒）：**只**用于让"夜间停用（22:30~06:00）"这类与时间有关的门禁自动刷新，
   * 不参与任何成绩/拟合度判定（判定仍只看任务的里程/配速/拟合度/时段那几个字段）。
   * （每 30 秒的定时器在只读侧 `real/data.ts` 里随组件挂载/卸载启动与停止。）
   */
  const clockTick = useState('mpRealClockTick', () => Date.now())

  return {
    profile,
    task,
    status,
    error,
    loadedAt,
    switches,
    cameraFlag,
    cameraFlagLineId,
    cameraFlagError,
    // 🆕 2026-09-21：自由跑入口标灰（服务端拒绝过一次就记住；可清除）
    freeRunUnsupported,
    markFreeRunUnsupported,
    clearFreeRunUnsupported,
    // 🆕 2026-10-07：今日该任务次数已满（服务端 getRunBegin 拒绝过一次就记住；跨天自动失效，可清除）
    dailyQuotaMark,
    markDailyQuotaReached,
    clearDailyQuotaMark,
    // 🆕 2026-10-07（实测事故）：待补交的轨迹明细（成绩成功即落盘；明细成功后清除）
    pendingDetail,
    savePendingDetail,
    clearPendingDetail,
    patchPendingDetail,
    // 🆕 2026-10-08（用户要求，防 kill 的第二个边界）：跨进程续跑
    pendingResume,
    savePendingResume,
    clearPendingResume,
    suspendedJob,
    cacheAt,
    cachePaperName,
    cacheHasToken,
    cacheTokenMask,
    /** 🆕 2026-09-22：本次加载的任务是不是"从本机缓存自动恢复"来的（0 = 不是） */
    restoredAt,
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    // 🆕 2026-09-21：提交过程清单（从 submit.ts 的局部 ref 提上来做单例，这样换页不丢、清空数据能清）
    submitProgress,
    clockTick,
  }
}
