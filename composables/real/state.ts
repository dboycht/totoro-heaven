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

  // 「上次读取的任务」缓存的界面状态（**刷新后不再自动回填**；只作为可选的显式恢复入口）
  const cacheAt = useState('mpRealCacheAt', () => 0)
  const cachePaperName = useState('mpRealCachePaper', () => '')
  const cacheLineId = useState('mpRealCacheLine', () => '')

  const phase = useState<RealPhase>('mpRealPhase', () => 'idle')
  const phaseMessage = useState('mpRealPhaseMessage', () => '')
  const remainingSeconds = useState('mpRealRemaining', () => 0)
  const result = useState<RealSubmitResult | null>('mpRealResult', () => null)

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
    cacheAt,
    cachePaperName,
    cacheLineId,
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    clockTick,
  }
}
