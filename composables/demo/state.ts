/**
 * 【演示态 + 跑步机】共享状态的**唯一来源**（`useMpDemo` 结构整理）
 *
 * 为什么拆分**不需要**自己造单例/工厂：本链路的状态**全部**用 Nuxt 的
 * `useState('mpDemoXxx', ...)` 声明 —— 同一个 key 在**任何地方**调用 `useState`
 * 拿到的都是**同一个共享引用**。所以这里把 key（含成绩记录的 `mpDemoRecords`）集中声明，
 * `demo/records.ts` 与 `demo/runner.ts` 各取所需即可。
 *
 * ⚠️ 改 key 名等于改共享契约：`demo/records.ts` 与 `demo/runner.ts` 会立刻读/写不到同一份状态。
 *
 * 依赖方向：`useMpDemo.ts` → {`demo/records`, `demo/runner`} → 本文件（单向）；
 * `runner.ts` 可以依赖 `records.ts`（`finish()` 要写记录），本文件**不**依赖它们 ——
 * `clearLocalData` / `logout` 需要的两个跨文件动作由组装器注入（见 `DemoStateHooks`）。
 *
 * ⚠️ 这个 composable 名字叫 Demo，但**它同时是真实链路的跑步引擎**：
 *    `useMpReal` 通过 `setTask` / `setLines` 把**真实任务与真实线路**注入进来，
 *    计时、轨迹生成（`generateCorridorRoute`）、拟合度、结算自检都由这条链路提供。
 *
 * **1.1.3 起演示改为「按需功能」**：
 *   - 默认 `demoMode=false`、`task=null`、`lines=[]`、`records=[]` —— **默认界面没有任何假数据**；
 *   - 只有显式调用 `enableDemo()` 才载入 `src/mp/demo.ts` 的假任务/假线路/假开关（用于试界面与报文）；
 *   - 真实链路进入时请调用 `disableDemo()`。
 */
import type { MpRunLine, MpScoreDetailRequest, MpScoreRequest, MpSunrunTask } from '~/src/mp/types'
import type { LatLng } from '~/utils/mp/routeSimilarity'
import type { RunPlan } from '~/utils/mp/realism'
import type { TaskCheckResult } from '~/utils/mp/taskRules'
import { DEMO_LINES, DEMO_SWITCHES, DEMO_TASK } from '~/src/mp/demo'

export type RunStatus = 'idle' | 'running' | 'paused' | 'finished'

/** 演示用的采样步长（米）：2000 点太多，20m 足够展示算法；真实提交建议 2m */
export const DEMO_STEP_M = 20

/** 真实提交用的采样步长（米）：3m ≈ 1Hz GPS（3 m/s × 1s），与 9-14 实测口径一致 */
export const REAL_STEP_M = 3

/** 自由跑演示的里程上限（真实自由跑由用户手动结束） */
export const FREE_RUN_CAP_KM = 5

/** 真实时间的 tick 间隔（毫秒）与模拟秒换算基数 */
export const TICK_MS = 100

export interface DemoRunState {
  status: RunStatus
  /** 0 阳光跑 / 1 自由跑（即提交口径） */
  runType: 0 | 1
  lineId: string
  targetKm: number
  /** 目标配速（秒/公里）——真实感规划后的本次实际配速（非整分钟） */
  paceSecPerKm: number
  /** 本次真实感规划（超跑里程 / 配速 / 预计时长） */
  plan: RunPlan | null
  /** 模拟倍速：1 / 10 / 60 / 600 */
  speed: number
  elapsedS: number
  distanceM: number
  /** 完整轨迹（开跑时一次性生成） */
  points: { latitude: string; longitude: string }[]
  /** 已推进到的点数（用于「实时」拟合度） */
  visibleCount: number
  officialRoute: LatLng[]
  fitDegree: number
  passPoints: { all: number; done: number; notPassed: number }
  /** 结束后的提交报文预览与判定 */
  result: DemoRunResult | null
  error: string
}

export interface DemoRunResult {
  km: number
  durationSeconds: number
  fitDegree: number
  scoreRequest: MpScoreRequest
  detailRequest: MpScoreDetailRequest
  check: TaskCheckResult
  /** `buildRunStats` 的自洽校验问题（空数组 = 自洽） */
  statsProblems: string[]
  /** 本地估算的步数（实测口径提交 ""，这里只作对照展示） */
  estimatedSteps: number
  stepsSubmitted: string
}

export const createRunState = (): DemoRunState => ({
  status: 'idle',
  runType: 0,
  lineId: '',
  targetKm: 0,
  paceSecPerKm: 360,
  plan: null,
  speed: 60,
  elapsedS: 0,
  distanceM: 0,
  points: [],
  visibleCount: 0,
  officialRoute: [],
  fitDegree: 0,
  passPoints: { all: 4, done: 0, notPassed: 4 },
  result: null,
  error: '',
})

/** 演示模式的成绩记录（localStorage 持久化，便于刷新后仍在） */
export const RECORDS_KEY = 'mp_demo_records'

/**
 * `clearLocalData` / `logout` 要用的两个**跨文件**动作：它们分别住在 `demo/records.ts`
 * （清记录）与 `demo/runner.ts`（停计时器），而那两个文件反过来要读本文件的 ref
 * （`records` 要 `demoMode`、`runner` 要 `task`/`lines`/`run`）——
 * 本文件若直接 import 它们就会形成循环依赖，所以由组装器（`useMpDemo.ts`）注入。
 * 传进来的闭包**只在用户真正触发 clearLocalData / logout 时求值**，
 * 那时 records / runner 早已构造完毕（不会踩到"暂时性死区"）。
 */
export interface DemoStateHooks {
  /** 清空成绩记录并落盘（= `demo/records.ts` 的 `resetRecords`） */
  resetRecords: () => void
  /** 停止跑步计时器（= `demo/runner.ts` 的 `stopTimer`） */
  stopRunTimer: () => void
}

export function useDemoState(hooks: DemoStateHooks) {
  const { session, clearSession, isLoggedIn } = useMpSession()

  /**
   * 演示模式开关：**默认关**（1.1.3+）。
   * 演示不再是页面的顶层模式，而是"试界面/试报文"的**按需功能**：只有显式调用 `enableDemo()` 才载入假数据。
   */
  const demoMode = useState('mpDemoMode', () => false)
  /** 当前任务（**默认为空**：真实任务由 useMpReal 注入；演示任务由 enableDemo 注入） */
  const task = useState<MpSunrunTask | null>('mpDemoTask', () => null)
  /** 当前线路集（同上，默认为空数组） */
  const lines = useState<MpRunLine[]>('mpDemoLines', () => [])
  /** 当前学校的开跑开关（**默认 null = 未读取**；由 enableDemo 或真实链路注入） */
  const switches = useState<Record<string, string> | null>('mpDemoSwitches', () => null)
  const run = useState<DemoRunState>('mpDemoRun', createRunState)

  /**
   * **载入演示数据**（唯一的演示入口）：填假任务 / 假线路 / 假开关并打开演示开关。
   * 只用于"不接触真实账号也能看界面与报文"；**不发任何网络请求**。
   */
  const enableDemo = () => {
    demoMode.value = true
    setTask(DEMO_TASK)
    setLines(DEMO_LINES)
    switches.value = { ...DEMO_SWITCHES }
    run.value = createRunState()
  }

  /** 退出演示（例如开始读真实数据时调用） */
  const disableDemo = () => {
    demoMode.value = false
  }

  /**
   * **清空本机数据**：任务 / 线路 / 开关 / 跑步机状态 / 本机记录 全部归零，并退出演示。
   * （会话 token 由调用方决定是否清 —— `useMpReal.clearAllLocalData()` 会一并清掉。）
   * 目的：让"刷新/重置后是干净状态"，不再把上次读到的任务一直摊在界面上。
   */
  const clearLocalData = () => {
    demoMode.value = false
    task.value = null
    lines.value = []
    switches.value = null
    run.value = createRunState()
    hooks.resetRecords()
  }

  /** 注入真实任务（1.1.2 真实模式）：替换演示约束，跑步自检/轨迹生成都按真实值走 */
  const setTask = (next: MpSunrunTask) => {
    task.value = next
  }

  /**
   * 注入真实线路（1.1.2 真实模式）：替换演示假环线。
   * ⚠️ 1.1.3 起**不再在这里盲选第一条** —— 选线交给调用方（`useMpReal.applyToRunner` 的
   *     "缓存 → 校区名 → 坐标分组默认" 三级优先级）与跑步页的校正 watch，避免此处覆盖面更优的选择。
   */
  const setLines = (next: MpRunLine[]) => {
    lines.value = next
  }

  const logout = () => {
    hooks.stopRunTimer()
    clearSession()
    run.value = createRunState()
  }

  return {
    session,
    isLoggedIn,
    demoMode,
    task,
    lines,
    switches,
    run,
    enableDemo,
    disableDemo,
    clearLocalData,
    setTask,
    setLines,
    logout,
  }
}

/** `useDemoState()` 的返回类型（供 `demo/runner.ts` 声明形参，避免把整个 state 再摊一遍） */
export type DemoStateApi = ReturnType<typeof useDemoState>
