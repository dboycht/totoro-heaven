/**
 * 【跑步机 + 演示数据注入】小程序线三页流程的共享状态与跑步模拟
 *
 * ⚠️ 这个 composable 名字叫 Demo，但**它同时是真实链路的跑步引擎**：
 *    `useMpReal` 通过 `setTask` / `setLines` 把**真实任务与真实线路**注入进来，
 *    计时、轨迹生成（`generateCorridorRoute`）、拟合度、结算自检都由本文件提供。
 *
 * **1.1.3 起演示改为「按需功能」**：
 *   - 默认 `demoMode=false`、`task=null`、`lines=[]`、`records=[]` —— **默认界面没有任何假数据**；
 *   - 只有显式调用 `enableDemo()` 才载入 `src/mp/demo.ts` 的假任务/假线路/假开关（用于试界面与报文）；
 *   - 真实链路进入时请调用 `disableDemo()`。
 *
 * 跑步过程是**真实计算**的：轨迹由 `generateCorridorRoute` 生成、拟合度由
 * `calculateRouteSimilarity` 计算、里程/配速/自洽校验由 `buildRunStats` 产出 —— 只是
 * 位置推进用「模拟倍速」代替真实 GPS，因此可以在几十秒内跑完 3km。
 * 真实提交（`sunRunExercises` 等）在 `composables/useMpReal.ts`，本文件的 `finish()` 只生成本地报文预览。
 */
import { calculateRouteSimilarity, type LatLng } from '~/utils/mp/routeSimilarity'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import { buildRunStats, buildTimeFields } from '~/utils/mp/runData'
import { evaluateRunAgainstTask, type TaskCheckResult } from '~/utils/mp/taskRules'
import { newRunSeed, planRealisticRun, type RunPlan } from '~/utils/mp/realism'
import { toSubmitRunType, type MpRunLine, type MpRunRecord, type MpScoreDetailRequest, type MpScoreRequest, type MpSunrunTask, type MpUserInfo } from '~/src/mp/types'
import {
  DEMO_ARCH_SUMMARY,
  DEMO_CLIENT,
  DEMO_LINES,
  DEMO_PASS_POINTS,
  DEMO_SESSION,
  DEMO_SWITCHES,
  DEMO_TASK,
  DEMO_TERM,
  demoScantronId,
} from '~/src/mp/demo'

export type RunStatus = 'idle' | 'running' | 'paused' | 'finished'

/** 演示用的采样步长（米）：2000 点太多，20m 足够展示算法；真实提交建议 2m */
export const DEMO_STEP_M = 20

/** 真实提交用的采样步长（米）：3m ≈ 1Hz GPS（3 m/s × 1s），与 9-14 实测口径一致 */
export const REAL_STEP_M = 3

/** 自由跑演示的里程上限（真实自由跑由用户手动结束） */
const FREE_RUN_CAP_KM = 5

/** 真实时间的 tick 间隔（毫秒）与模拟秒换算基数 */
const TICK_MS = 100

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

const createRunState = (): DemoRunState => ({
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
const RECORDS_KEY = 'mp_demo_records'

/** 跑步计时器放在模块级：整个应用只有一个（多个组件调用 useMpDemo 不会各起一个） */
let timer: ReturnType<typeof setInterval> | null = null
let lastFitAt = 0

export function useMpDemo() {
  const { session, setSession, clearSession, isLoggedIn } = useMpSession()

  /**
   * 演示模式开关：**默认关**（1.1.3+）。
   * 演示不再是页面的顶层模式，而是"试界面/试报文"的**按需功能**：只有显式调用 `enableDemo()` 才载入假数据。
   */
  const demoMode = useState('mpDemoMode', () => false)
  /** 当前任务（**默认为空**：真实任务由 useMpReal 注入；演示任务由 enableDemo 注入） */
  const task = useState<MpSunrunTask | null>('mpDemoTask', () => null)
  /** 当前线路集（同上，默认为空数组） */
  const lines = useState<MpRunLine[]>('mpDemoLines', () => [])
  const switches = useState('mpDemoSwitches', () => DEMO_SWITCHES)
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

  /** 注入真实任务（1.1.2 真实模式）：替换演示约束，跑步自检/轨迹生成都按真实值走 */
  const setTask = (next: MpSunrunTask) => {
    task.value = next
  }

  /** 注入真实线路（1.1.2 真实模式）：替换演示假环线 */
  const setLines = (next: MpRunLine[]) => {
    lines.value = next
    if (run.value.status === 'idle' && !next.some((l) => l.pointId === run.value.lineId)) {
      run.value.lineId = next[0]?.pointId ?? ''
    }
  }

  /** 成绩记录（**默认空**；演示记录由「载入演示数据」写入，真实记录由结算/接口写入） */
  const records = useState<MpRunRecord[]>('mpDemoRecords', () => {
    if (import.meta.client) {
      try {
        const raw = localStorage.getItem(RECORDS_KEY)
        if (raw) return JSON.parse(raw) as MpRunRecord[]
      } catch {
        /* 忽略损坏的本地缓存 */
      }
    }
    return []
  })

  const persistRecords = () => {
    if (import.meta.client) {
      try {
        localStorage.setItem(RECORDS_KEY, JSON.stringify(records.value))
      } catch {
        /* 忽略配额错误 */
      }
    }
  }

  /** 演示登录：写入假会话（真实登录走 token 录入 / 微信 code 换 token） */
  const login = (overrides: Partial<MpUserInfo> = {}) => {
    setSession({
      token: DEMO_SESSION.token,
      baseUrl: DEMO_SESSION.baseUrl,
      userInfo: { ...DEMO_SESSION.userInfo, ...overrides },
    })
  }

  const logout = () => {
    stopTimer()
    clearSession()
    run.value = createRunState()
  }

  // ---------- 跑步模拟 ----------

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** 当前应当展示的轨迹点（渐进显示，模拟真实上报过程） */
  const visiblePoints = (): { latitude: string; longitude: string }[] => run.value.points.slice(0, run.value.visibleCount)

  const refreshFitDegree = (force = false) => {
    const now = Date.now()
    if (!force && now - lastFitAt < 300) return
    lastFitAt = now
    const points = visiblePoints()
    if (points.length < 2) {
      run.value.fitDegree = 0
      return
    }
    run.value.fitDegree = calculateRouteSimilarity(run.value.officialRoute, points)
  }

  const syncProgress = () => {
    const total = run.value.points.length
    const target = run.value.targetKm * 1000
    const ratio = target > 0 ? Math.min(1, run.value.distanceM / target) : 0
    run.value.visibleCount = Math.max(1, Math.min(total, Math.ceil(ratio * total)))
    const done = Math.min(run.value.passPoints.all, Math.floor(ratio * run.value.passPoints.all))
    run.value.passPoints = { all: run.value.passPoints.all, done, notPassed: run.value.passPoints.all - done }
  }

  const tick = () => {
    if (run.value.status !== 'running') return
    const simulatedSeconds = (TICK_MS / 1000) * run.value.speed
    const metersPerSecond = 1000 / run.value.paceSecPerKm
    run.value.elapsedS += simulatedSeconds
    run.value.distanceM += simulatedSeconds * metersPerSecond

    const targetM = run.value.targetKm * 1000
    // 阳光跑到任务里程即停；自由跑演示到上限即停（真实自由跑由用户手动结束）
    if (run.value.distanceM >= targetM) {
      run.value.distanceM = targetM
      syncProgress()
      finish()
      return
    }
    syncProgress()
    refreshFitDegree()
  }

  /** 开始（生成整条轨迹，与真实提交用的是同一套算法） */
  const start = () => {
    if (!task.value) {
      run.value.error = '尚未载入任务（请先在工作台「读取真实账号与任务」，或「载入演示数据」试界面）'
      return
    }
    const line = lines.value.find((item) => item.pointId === run.value.lineId) ?? lines.value[0]
    if (!line) {
      run.value.error = '线路缺失（真实模式请先在「工作台」读取真实任务与线路）'
      return
    }
    const isRealLine = !demoMode.value
    const isSunRun = run.value.runType === 0

    // 真实感规划：里程**略超**任务要求（2%~9%）、配速**非整分钟**且夹紧在任务窗口内。
    // 这样提交的数值是 3.41km / 20:34 / 6'02" 这种，而不是 3.20 / 16:00 / 5'00"（一眼假）。
    const plan: RunPlan = isSunRun
      ? planRealisticRun({
          requiredKm: Number(task.value.mileage) || 3,
          minSpeedKmh: task.value.minSpeed,
          maxSpeedKmh: task.value.maxSpeed,
          minMinutes: task.value.minTime,
          maxMinutes: task.value.maxTime,
          basePaceSecPerKm: run.value.paceSecPerKm,
          seed: newRunSeed(),
        })
      : {
          targetKm: FREE_RUN_CAP_KM,
          paceSecPerKm: run.value.paceSecPerKm,
          overshootRatio: 0,
          durationSeconds: 0,
        }

    try {
      // 演示用 20m 采样（点少、页面轻）；真实模式用 3m（≈1Hz GPS，与真实提交口径一致）
      // drift:true → 叠加"GPS 精度下降期"，拟合度自然落到 0.9x（不是满分 1.00）
      const generated = generateCorridorRoute(line.pointList, {
        targetKm: plan.targetKm,
        stepM: isRealLine ? REAL_STEP_M : DEMO_STEP_M,
        drift: true,
        seed: newRunSeed(),
      })
      const actualKm = Number(generated.km)
      run.value = {
        ...createRunState(),
        status: 'running',
        runType: run.value.runType,
        lineId: line.pointId,
        paceSecPerKm: plan.paceSecPerKm,
        plan: { ...plan, targetKm: actualKm, durationSeconds: Math.round(actualKm * plan.paceSecPerKm) },
        speed: run.value.speed,
        // 以"轨迹真实累计长度"为准（两位小数、非整数值），而不是任务要求里的整数
        targetKm: actualKm,
        points: generated.points,
        visibleCount: 1,
        officialRoute: line.pointList,
        passPoints: { all: DEMO_PASS_POINTS.length, done: 0, notPassed: DEMO_PASS_POINTS.length },
      }
      lastFitAt = 0
      refreshFitDegree(true)
      stopTimer()
      timer = setInterval(tick, TICK_MS)
    } catch (err) {
      run.value.error = err instanceof Error ? err.message : '轨迹生成失败'
    }
  }

  const pause = () => {
    if (run.value.status !== 'running') return
    run.value.status = 'paused'
    stopTimer()
  }

  const resume = () => {
    if (run.value.status !== 'paused') return
    run.value.status = 'running'
    stopTimer()
    timer = setInterval(tick, TICK_MS)
  }

  /** 结束并结算：生成本地提交报文 + 判分自检 + 写入记录（**不发网络请求**） */
  const finish = () => {
    stopTimer()
    if (run.value.status === 'finished' || run.value.points.length < 2) return
    if (!task.value) return

    const endedAtMs = Date.now()
    const distanceKm = run.value.distanceM / 1000
    // 时长由「实际里程 × 本次配速」推出（配速非整分钟 → 时长自然落到 20:34 这种）
    const durationSeconds = Math.max(1, Math.round(distanceKm * run.value.paceSecPerKm))
    run.value.elapsedS = durationSeconds
    const points = visiblePoints()
    const fitDegree = points.length >= 2 ? calculateRouteSimilarity(run.value.officialRoute, points) : 0

    const submitRunType = toSubmitRunType(run.value.runType === 0 ? 0 : 2)
    const stats = buildRunStats({ distanceKm, durationSeconds, runType: submitRunType })
    // 自洽：startTime = 结束时刻 - 模拟时长（真实跑步时二者本就是同一时刻）
    const timeFields = buildTimeFields(endedAtMs - durationSeconds * 1000, endedAtMs)
    const scantronId = demoScantronId(new Date(endedAtMs))
    // ⚠️ 这里只生成"报文预览"，**不再回落演示凭据**（1.1.3：没有真实会话就留空，避免预览里出现假 token）
    const token = session.value?.token ?? ''
    const stuNumber = (session.value?.userInfo?.snCode as string) ?? ''
    const schoolCode = (session.value?.userInfo?.schoolCode as string) ?? ''

    // 实测真包里 steps 恒为 ""（源码全工程无赋值）→ 照抄该口径；估算值只作对照展示
    const stepsSubmitted = ''

    const scoreRequest: MpScoreRequest = {
      scantronId,
      stuNumber,
      schoolCode,
      runType: submitRunType,
      km: stats.km,
      usedTime: stats.usedTime,
      fitDegree: Number(fitDegree).toFixed(2),
      avgSpeed: stats.avgSpeed,
      steps: stepsSubmitted,
      token,
      version: DEMO_CLIENT.version,
      phoneInfo: DEMO_CLIENT.phoneInfo,
      evaluateDate: timeFields.evaluateDate,
      endTime: timeFields.endTime,
      startTime: timeFields.startTime,
      taskId: run.value.runType === 0 ? task.value.taskId : '',
      sunrunPathPointList: run.value.runType === 0 ? run.value.officialRoute : [],
      flag: '1',
    }

    const detailRequest: MpScoreDetailRequest = {
      pointList: points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
      gyroscope: [],
      accelerometer: [],
      cheatCode: '正常跑步',
      scantronId,
      token,
    }

    const check = evaluateRunAgainstTask({
      task: task.value,
      km: distanceKm,
      durationSeconds,
      fitDegree,
    })

    run.value.status = 'finished'
    run.value.fitDegree = fitDegree
    run.value.distanceM = distanceKm * 1000
    run.value.result = {
      km: distanceKm,
      durationSeconds,
      fitDegree,
      scoreRequest,
      detailRequest,
      check,
      statsProblems: stats.problems,
      estimatedSteps: Number(stats.steps) || 0,
      stepsSubmitted,
    }

    // 写入记录（本地演示；真实环境由服务端判定，这里用自检结果预判）
    records.value = [
      {
        scoreId: scantronId,
        paperId: scoreRequest.taskId,
        runTime: timeFields.evaluateDate,
        startTmie: timeFields.startTime,
        endTmie: timeFields.endTime,
        scorePassType: check.pass ? 1 : 0,
        scorePassRemark: check.pass ? '' : check.problems.join('；'),
        mileage: stats.km,
        usedTime: stats.usedTime,
        trajectorySimilary: scoreRequest.fitDegree,
        runType: submitRunType,
        flag: 2,
      },
      ...records.value,
    ]
    persistRecords()
  }

  const reset = () => {
    stopTimer()
    run.value = createRunState()
  }

  const resetRecords = () => {
    records.value = []
    persistRecords()
  }

  // ---------- 展示用派生值 ----------

  const paceText = computed(() => {
    if (run.value.distanceM < 50) return `0'00"`
    const secPerKm = run.value.elapsedS / (run.value.distanceM / 1000)
    const total = Math.round(secPerKm)
    return `${Math.floor(total / 60)}'${String(total % 60).padStart(2, '0')}"`
  })

  const progress = computed(() => {
    const targetM = run.value.targetKm * 1000
    return targetM > 0 ? Math.min(1, run.value.distanceM / targetM) : 0
  })

  const stats = computed(() => {
    const passed = records.value.filter((r) => Number(r.scorePassType) === 1 || Number(r.scorePassType) === 2).length
    const invalid = records.value.filter((r) => Number(r.scorePassType) === 0).length
    const totalMileage = records.value.reduce((sum, r) => sum + Number(r.mileage || 0), 0)
    // ⚠️ requireNumber 目前来自演示摘要（真实值已由 useMpReal.fetchVerdict 读回记录，但学期要求次数尚未接线）
    const requireNumber = demoMode.value ? DEMO_ARCH_SUMMARY.requireNumber : null
    return {
      requireNumber,
      passed,
      invalid,
      totalMileage: totalMileage.toFixed(2),
    }
  })

  /** 学期信息：演示模式给假值；真实模式暂未接线（界面显示 —） */
  const term = computed(() => (demoMode.value ? DEMO_TERM : null))

  return {
    // 状态
    session,
    isLoggedIn,
    demoMode,
    task,
    lines,
    switches,
    run,
    records,
    term,
    stats,
    progress,
    paceText,
    // 动作
    login,
    logout,
    enableDemo,
    disableDemo,
    setTask,
    setLines,
    start,
    pause,
    resume,
    finish,
    reset,
    resetRecords,
    stopTimer,
    refreshFitDegree,
  }
}
