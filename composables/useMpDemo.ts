/**
 * 【演示】小程序线三页流程的共享状态与跑步模拟
 *
 * 设计原则：**页面只用它，替换数据源时不动页面**（接入点见 `src/mp/demo.ts` 文件头）。
 * 真实数据进来后，本文件的 `login()` / `start()` / `finish()` 三处换成真接口即可：
 *   - 登录 → `MpApiWrapper.resolveSchoolBaseUrl` + token 录入 / 微信 code 换 token
 *   - 开跑 → `getSunrunPaper`（任务约束）+ `getRunBegin`（scantronId）
 *   - 提交 → `saveScores` + `saveScoreDetail`（现在只生成本地报文预览，不发网络请求）
 *
 * 跑步过程是**真实计算**的：轨迹由 `generateCorridorRoute` 生成、拟合度由
 * `calculateRouteSimilarity` 计算、里程/配速/自洽校验由 `buildRunStats` 产出 —— 只是
 * 位置推进用「模拟倍速」代替真实 GPS，因此可以在几十秒内跑完 3km。
 */
import { calculateRouteSimilarity, type LatLng } from '~/utils/mp/routeSimilarity'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import { buildRunStats, buildTimeFields } from '~/utils/mp/runData'
import { evaluateRunAgainstTask, type TaskCheckResult } from '~/utils/mp/taskRules'
import { toSubmitRunType, type MpRunRecord, type MpScoreDetailRequest, type MpScoreRequest, type MpUserInfo } from '~/src/mp/types'
import {
  DEMO_ARCH_SUMMARY,
  DEMO_CLIENT,
  DEMO_LINES,
  DEMO_PASS_POINTS,
  DEMO_RECORDS,
  DEMO_SESSION,
  DEMO_SWITCHES,
  DEMO_TASK,
  DEMO_TERM,
  demoScantronId,
} from '~/src/mp/demo'

export type RunStatus = 'idle' | 'running' | 'paused' | 'finished'

/** 演示用的采样步长（米）：2000 点太多，20m 足够展示算法；真实提交建议 2m */
export const DEMO_STEP_M = 20

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
  /** 演示目标配速（秒/公里），默认 5'30" */
  paceSecPerKm: number
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
  lineId: DEMO_LINES[0]?.pointId ?? '',
  targetKm: Number(DEMO_TASK.mileage),
  paceSecPerKm: 330,
  speed: 60,
  elapsedS: 0,
  distanceM: 0,
  points: [],
  visibleCount: 0,
  officialRoute: DEMO_LINES[0]?.pointList ?? [],
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

  /** 演示模式：默认开；接入真实 token 后可置 false */
  const demoMode = useState('mpDemoMode', () => true)
  const task = useState('mpDemoTask', () => DEMO_TASK)
  const switches = useState('mpDemoSwitches', () => DEMO_SWITCHES)
  const run = useState<DemoRunState>('mpDemoRun', createRunState)
  const records = useState<MpRunRecord[]>('mpDemoRecords', () => {
    if (import.meta.client) {
      try {
        const raw = localStorage.getItem(RECORDS_KEY)
        if (raw) return JSON.parse(raw) as MpRunRecord[]
      } catch {
        /* 忽略损坏的本地缓存 */
      }
    }
    return [...DEMO_RECORDS]
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
    const line = DEMO_LINES.find((item) => item.pointId === run.value.lineId) ?? DEMO_LINES[0]
    if (!line) {
      run.value.error = '演示线路缺失'
      return
    }
    const targetKm = run.value.runType === 0 ? Number(task.value.mileage) || 3 : FREE_RUN_CAP_KM
    try {
      const generated = generateCorridorRoute(line.pointList, { targetKm, stepM: DEMO_STEP_M, seed: 20260914 })
      run.value = {
        ...createRunState(),
        status: 'running',
        runType: run.value.runType,
        lineId: line.pointId,
        paceSecPerKm: run.value.paceSecPerKm,
        speed: run.value.speed,
        targetKm,
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

    const endedAtMs = Date.now()
    const durationSeconds = Math.max(1, Math.round(run.value.elapsedS))
    const distanceKm = run.value.distanceM / 1000
    const points = visiblePoints()
    const fitDegree = points.length >= 2 ? calculateRouteSimilarity(run.value.officialRoute, points) : 0

    const submitRunType = toSubmitRunType(run.value.runType === 0 ? 0 : 2)
    const stats = buildRunStats({ distanceKm, durationSeconds, runType: submitRunType })
    // 自洽：startTime = 结束时刻 - 模拟时长（真实跑步时二者本就是同一时刻）
    const timeFields = buildTimeFields(endedAtMs - durationSeconds * 1000, endedAtMs)
    const scantronId = demoScantronId(new Date(endedAtMs))
    const token = session.value?.token || DEMO_SESSION.token
    const stuNumber = (session.value?.userInfo?.snCode as string) || DEMO_SESSION.userInfo.snCode
    const schoolCode = (session.value?.userInfo?.schoolCode as string) || DEMO_SESSION.userInfo.schoolCode

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
    records.value = [...DEMO_RECORDS]
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
    return {
      requireNumber: DEMO_ARCH_SUMMARY.requireNumber,
      passed,
      invalid,
      totalMileage: totalMileage.toFixed(2),
    }
  })

  return {
    // 状态
    session,
    isLoggedIn,
    demoMode,
    task,
    switches,
    run,
    records,
    term: DEMO_TERM,
    stats,
    progress,
    paceText,
    // 动作
    login,
    logout,
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
