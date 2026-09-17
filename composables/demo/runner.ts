/**
 * 【演示态 + 跑步机】跑步引擎：`useDemoRunner()`（计时 / 轨迹 / 拟合度 / 结算）
 *
 * 跑步过程是**真实计算**的：轨迹由 `generateCorridorRoute` 生成、拟合度由
 * `calculateRouteSimilarity` 计算、里程/配速/自洽校验由 `buildRunStats` 产出 —— 只是
 * 位置推进用「模拟倍速」代替真实 GPS，因此可以在几十秒内跑完 3km。
 * 真实提交（`sunRunExercises` 等）在 `composables/useMpReal.ts`，本文件的 `finish()` 只生成本地报文预览。
 *
 * 共享状态一律从 `demo/state.ts`（`useState('mpDemoXxx')` 是跨文件同一个引用）与
 * `demo/records.ts` 的返回值传入；依赖方向：本文件 → {`./state`, `./records`}（单向，**不反向**）。
 * ⚠️ 传进来的 ref 与 `useState` 拿到的是同一个对象，所以 `run.value = ...` 这类赋值照旧对全局生效。
 */
import { calculateRouteSimilarity } from '~/utils/mp/routeSimilarity'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import { buildRunStats, buildTimeFields } from '~/utils/mp/runData'
import { buildScoreDetailRequest, buildScoreRequest } from '~/utils/mp/submitPayload'
import { evaluateRunAgainstTask } from '~/utils/mp/taskRules'
import { newRunSeed, planRealisticRun, type RunPlan } from '~/utils/mp/realism'
import { toSubmitRunType, type MpScoreDetailRequest, type MpScoreRequest } from '~/src/mp/types'
import { DEMO_PASS_POINTS, demoScantronId } from '~/src/mp/demo'
import { DEMO_STEP_M, FREE_RUN_CAP_KM, REAL_STEP_M, TICK_MS, createRunState, type DemoStateApi } from './state'
import type { DemoRecordsApi } from './records'

/** 跑步计时器放在模块级：整个应用只有一个（多个组件调用 useMpDemo 不会各起一个） */
let timer: ReturnType<typeof setInterval> | null = null
let lastFitAt = 0

export function useDemoRunner(state: DemoStateApi, recordsApi: DemoRecordsApi) {
  const { demoMode, task, lines, run, session } = state
  const { records, persistRecords } = recordsApi

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

    // ⚠️ 成绩报文与真实提交**同一构造器**（2026-09-17 B 轮统一）：演示预览不再手抄 18 字段，
    //    否则真包口径一变，预览不会跟着变 —— 那正是 E33「预览与实发不一致」的同类风险。
    //    构造器内部已按真包口径写死 `steps: ''`、`fitDegree` 两位小数、`flag: '1'`。
    const scoreRequest: MpScoreRequest = buildScoreRequest(
      {
        snCode: stuNumber,
        schoolCode,
        task: task.value,
        line: {
          pointId: run.value.lineId || 'demo-line',
          // ⚠️ `DEMO_LINES` 里没有 taskId；真包里 `taskId` 取线路的 taskId（实测两者同值），
          //    这里显式补上，保持预览与真实提交一致。
          taskId: task.value.taskId ?? '',
          pointName: '',
          pointList: run.value.officialRoute ?? [],
        },
        km: distanceKm,
        durationSeconds,
        fitDegree,
        points: points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
        token,
        scantronId,
        startMs: endedAtMs - durationSeconds * 1000,
        endMs: endedAtMs,
      },
      { runType: submitRunType },
    )

    // 轨迹明细预览：与真实提交**同一构造器**（3 字段 + 每点带 time），避免预览与实发不一致。
    // 该构造器只用到 points/startMs/durationSeconds/scantronId/token，其余字段是占位。
    const detailRequest: MpScoreDetailRequest = buildScoreDetailRequest({
      snCode: stuNumber,
      schoolCode,
      task: task.value,
      line: { pointId: run.value.lineId || 'demo-line', taskId: task.value.taskId ?? '', pointName: '', pointList: [] },
      km: distanceKm,
      durationSeconds,
      fitDegree,
      points: points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
      token,
      scantronId,
      startMs: endedAtMs - durationSeconds * 1000,
      endMs: endedAtMs,
    })

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

  return {
    start,
    pause,
    resume,
    tick,
    stopTimer,
    syncProgress,
    refreshFitDegree,
    visiblePoints,
    finish,
    reset,
    paceText,
    progress,
  }
}
