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
import type { LatLng } from '~/utils/mp/routeSimilarity'
import { generateCorridorRoute } from '~/utils/mp/generateRoute'
import { applyStartToLoop, laneLoop, laneRatioFor } from '~/utils/mp/trackEditor'
import { buildRunStats, buildTimeFields } from '~/utils/mp/runData'
import { buildScoreDetailRequest, buildScoreRequest } from '~/utils/mp/submitPayload'
import { evaluateRunAgainstTask, type TaskCheckResult } from '~/utils/mp/taskRules'
// 🆕 2026-09-22（issue #12）：判"任务到底有没有下发线路"（纯函数，与门禁/自检/诊断同源）
import { routeRequirementOf } from '~/utils/mp/taskShape'
// 🆕 2026-09-22「非官方路径绘制」：本机条目带 freeShape 时，几何用它展开（纯模块，与跑道编辑页预览同源）
import { resolveFreePathGeometry } from '~/utils/mp/freePathGeometry'
import { resolveEntryName, type TrackRouteEntry } from '~/utils/mp/trackLibrary'
import { newRunSeed, planRealisticRun, type RunPlan } from '~/utils/mp/realism'
import { toSubmitRunType, type MpRunLine, type MpScoreDetailRequest, type MpScoreRequest } from '~/src/mp/types'
import { DEMO_PASS_POINTS, demoScantronId } from '~/src/mp/demo'
import { DEMO_STEP_M, REAL_STEP_M, TICK_MS, createRunState, type DemoStateApi } from './state'
import type { DemoRecordsApi } from './records'

/** 跑步计时器放在模块级：整个应用只有一个（多个组件调用 useMpDemo 不会各起一个） */
let timer: ReturnType<typeof setInterval> | null = null
let lastFitAt = 0

/**
 * 🆕 2026-09-22（issue #12）：**服务端未下发线路的任务**（自由路线任务，如"研途健行"）的几何来源。
 *
 * 这类任务的 `runPointList` 缺失/为空 ⇒ 线路下拉里**必然没有**服务端线路可选，
 * 但本地生成轨迹**总得有一条几何** —— 用**本机已描的跑道**（用户自己在「跑道编辑」描的真跑道）。
 *
 * ⚠️ 三条口径（避免后人误改）：
 *   ① 这只是**本地几何**：这些 `pointId` 是我们自己描述的路线库键名（多半来自别的任务/线路），
 *      **不是服务端线路标识** ⇒ 绝不允许进提交报文（`lineId` 必须空串，任务号走 `paperId` 兜底）；
 *   ② `pointList: []` —— 本任务**没有官方模板点列**，如实留空（不拿本机坐标冒充服务端线路）；
 *      连带影响：拟合度没有参照线可算（`calculateRouteSimilarity([], …) === 0`），
 *      所以自检里的拟合度一行会显示成"提示"（服务端未下发阈值，`taskRules.ts`）；
 *   ③ 一条都没描 ⇒ 返回空数组，照旧报"还没描过跑道"（我们总得有个几何才能生成轨迹）。
 */
function localTrackLines(entries: TrackRouteEntry[], taskId: string): MpRunLine[] {
  return entries.map((e) => ({
    pointId: String(e.lineId),
    pointName: resolveEntryName(e) || String(e.lineId),
    taskId,
    pointList: [],
  }))
}

/**
 * 🆕 2026-09-22「非官方路径绘制」的几何装配**已搬到纯模块** `utils/mp/freePathGeometry.ts`。
 *
 * 搬家的原因（审计 B1/B2）：
 *   · 这里原来只服务跑步引擎 ⇒ 跑道编辑页的预览**没套同一层变换**（所见非所跑）；
 *   · 原先把几何展开 8 趟 ⇒ 生成器算出的 `lapLengthM` 是"画的圈 × 8"，跑步页圈数报小了倍数。
 * 现在两处都调 `resolveFreePathGeometry()`（趟数恒为 1、圆角关闭、圈型用**保点旋转**），
 * 并且这一段逻辑有离线单测（`tests/mp/freePathGeometry.test.ts`）。
 */
function resolveTrackGeometry(entry: TrackRouteEntry): { geometry: LatLng[]; smooth: boolean } | null {
  /** ① 非官方路径（2026-09-22 新功能）：形状是权威几何来源 */
  const shapeGeometry = resolveFreePathGeometry(entry.freeShape, entry.start ?? null)
  if (shapeGeometry) return { geometry: shapeGeometry.geometry, smooth: shapeGeometry.smooth }
  /** ② 老口径（内外双圈）：逐字保持原行为 */
  if (entry.outer.length >= 3 && entry.inner.length >= 3) {
    // ⚠️ **按这条本地路线里存的"所选道次"**生成 —— 不再随机、不再换道
    //    （2026-09-17 用户确认："缓慢换道"就是车道线看着乱的根因，已删除该功能）
    //
    // 🆕 2026-09-20（1.1.12 需求②）：再套一层**起跑点/绕向**变换（唯一入口
    //    `applyStartToLoop`）—— 生成器永远从几何第 0 点起跑，所以"起跑点"在数据上就是
    //    "按弧长旋转 + 必要时反向"。老数据没有 `start` ⇒ `rotateLoop(loop, 0)` 原样返回，
    //    **逐点与旧版一致**（有单测钉住这条回归保证）。
    return {
      geometry: applyStartToLoop(
        laneLoop(
          { outer: entry.outer, inner: entry.inner },
          laneRatioFor(entry.laneNo ?? 3, entry.laneCount ?? 6),
          240,
        ),
        entry.start ?? null,
      ),
      smooth: true,
    }
  }
  return null
}

export function useDemoRunner(state: DemoStateApi, recordsApi: DemoRecordsApi) {
  const { demoMode, task, lines, run, session, freeRunKm } = state
  const { records, persistRecords } = recordsApi
  /** 本地路线库（在"跑道编辑"里配置的内外圈）—— 必须在这里（setup 期）取，不能在 start() 里取 */
  const lib = useTrackLibrary()

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
    // ⚠️ 自由跑（runType=1）**不需要任务**：厂商的自由跑不带任务号、也不校验任务约束
    const isFreeRun = run.value.runType !== 0
    if (!isFreeRun && !task.value) {
      run.value.error = '尚未载入任务（请先在工作台「读取真实账号与任务」，或「载入演示数据」试界面）'
      return
    }
    const isRealLine = !demoMode.value
    const isSunRun = run.value.runType === 0

    /**
     * 本次用哪条线路的几何。
     *
     * ⚠️ **只允许"本机描过跑道的线路"**（用户 2026-09-18 口径：两种跑法都要保证线路稳健性）。
     * 2026-09-18 审计 #3 修掉的错法：原来是
     * `lines.value.find(p => p.pointId === run.lineId) ?? lines.value[0]` ——
     * 当 `run.lineId` 属于**上一个任务**（切换任务/恢复缓存后常见）时，`find` 落空、静默回落到
     * `lines[0]`，而它**可能根本没描过** ⇒ 用官方模板生成轨迹，正是本轮要防的场景。
     * 现在的判据与页面按钮（`canStart`）**同源**：只从 `lib.entries` 里挑，挑不到就明确报错。
     */
    const drawnIds = new Set(lib.entries.value.map((e) => String(e.lineId)))
    const drawnLines = lines.value.filter((l) => drawnIds.has(String(l.pointId)))
    /**
     * 🆕 2026-09-22（issue #12）：**服务端未下发线路的任务**兜底 —— 从**本机第一条已描跑道**取几何。
     * 判据：`routeRequirementOf(task).kind === 'free'`（纯函数）。
     * ⚠️ 只在这个分支兜底：`kind === 'line'`（服务端下发了线路）时**逐字保持原行为** ——
     *    没描过就是报错去描，绝不回落到别的线路（那是 2026-09-18 审计 #3 明确修掉的错法）。
     */
    const routeIsFree = routeRequirementOf(task.value).kind === 'free'
    const localFallback = routeIsFree ? localTrackLines(lib.entries.value, task.value?.taskId ?? '')[0] : undefined
    const line =
      drawnLines.find((l) => String(l.pointId) === String(run.value.lineId)) ?? drawnLines[0] ?? localFallback
    if (!line) {
      /**
       * 两种"没有几何"的原因必须分开归因（user 在 issue #12 里正是被混为一谈坑到的）：
       *   · `kind === 'line'`：任务有线路，但你**没给这条线路描过**跑道 ⇒ 去描这一条；
       *   · `kind === 'free'`：任务**未下发线路**，而本机**一条跑道都没描过** ⇒ 我们总得有个几何，去描一条。
       */
      run.value.error = routeIsFree
        ? '本机还没有可用的跑道几何：本任务「服务端未下发线路（不指定路线）」，轨迹只能用你自己描的跑道生成。' +
          '请先去「跑道编辑」描一条外圈并保存（本机），回到本页即可开跑。'
        : '这条线路还没描过跑道：本版只允许用你自己描的跑道生成轨迹（官方模板偏十几到几十米）。' +
          '请去「跑道编辑」选这条线路 → 「快速定位」→ 沿卫星图描外圈 → 保存（本机）。'
      return
    }

    // 真实感规划：里程**略超**任务要求（2%~9%）、配速**非整分钟**且夹紧在任务窗口内。
    // 这样提交的数值是 3.41km / 20:34 / 6'02" 这种，而不是 3.20 / 16:00 / 5'00"（一眼假）。
    // ⚠️ 阳光跑分支一定已经有 task（上面刚校验过），这里显式收窄类型，避免 TS 认为可能为 null。
    const sunrunTask = task.value
    const plan: RunPlan =
      isSunRun && sunrunTask
        ? planRealisticRun({
            requiredKm: Number(sunrunTask.mileage) || 3,
            minSpeedKmh: sunrunTask.minSpeed,
            maxSpeedKmh: sunrunTask.maxSpeed,
            minMinutes: sunrunTask.minTime,
            maxMinutes: sunrunTask.maxTime,
            basePaceSecPerKm: run.value.paceSecPerKm,
            seed: newRunSeed(),
          })
        : {
            /**
             * 🆕 2026-09-20（1.1.12 需求①）：自由跑的里程**不再是写死的上限**，而是用户在
             * 「开跑设置」里设的目标距离（`freeRunKm`，0.5~42.2 km，已归一化）。
             * ⚠️ 它只决定"本地生成多长的轨迹"，不影响提交口径（自由跑仍 `runType=1`、
             *    不带任务号、不发路径点明细 —— 见 submitPayload 的 freeRun 分支）。
             */
            targetKm: freeRunKm.value,
            paceSecPerKm: run.value.paceSecPerKm,
            overshootRatio: 0,
            durationSeconds: 0,
          }

    try {
      // 演示用 20m 采样（点少、页面轻）；真实模式用 3m（≈1Hz GPS，与真实提交口径一致）
      // drift:true → 叠加"GPS 精度下降期"，拟合度自然落到 0.9x（不是满分 1.00）
      //
      // ⭐ 2026-09-17：**若这条线路在"跑道编辑"里配置过内外圈**，就用**车道线**当生成几何
      //    （随机一道 + 缓慢换道，按弧长），这样跑出来是**真跑道的形状**；
      //    没配置则回退官方路线。⚠️ `officialRoute` 始终是**厂商模板** —— 拟合度必须按它算
      //    （服务端就是按它算），两者不能混。
      //    ℹ️（2026-09-20 更正）**自由跑现在也要选线路**（用户要求）——本函数对两种跑法一视同仁：
      //       都用 `run.lineId` 从"本机描过的线路"里挑几何。原先这里写着"自由跑没有线路 ⇒ 直接用官方模板"，
      //       那句在 2026-09-18 收紧"只允许描过的跑道"之后就已经不成立了，容易误导，故删除。
      const trackEntry = line ? lib.get(line.pointId) : undefined
      let geometry: LatLng[] = line?.pointList ?? []
      /**
       * ⭐ 2026-09-22「非官方路径绘制」：几何统一走 `resolveTrackGeometry` ——
       *   有 `freeShape` 的条目用它展开（**并关掉圆角**）；老条目（双圈）逐字保持原行为。
       */
      const resolved = trackEntry ? resolveTrackGeometry(trackEntry) : null
      if (resolved && resolved.geometry.length >= 2) geometry = resolved.geometry
      /**
       * 非官方路径不做圆角（圆角会把直线折返的几何毁掉，见 `resolveTrackGeometry` 的注释）；
       * `2` = 生成器默认的圆角轮数（老条目的既有行为，逐字不变）。
       */
      const smoothRouteForThisRun = resolved ? (resolved.smooth ? 2 : 0) : 2
      const generated = generateCorridorRoute(geometry, {
        targetKm: plan.targetKm,
        stepM: isRealLine ? REAL_STEP_M : DEMO_STEP_M,
        drift: true,
        seed: newRunSeed(),
        smoothRoute: smoothRouteForThisRun,
      })
      const actualKm = Number(generated.km)
      run.value = {
        ...createRunState(),
        status: 'running',
        runType: run.value.runType,
        lineId: line?.pointId ?? '',
        paceSecPerKm: plan.paceSecPerKm,
        plan: { ...plan, targetKm: actualKm, durationSeconds: Math.round(actualKm * plan.paceSecPerKm) },
        speed: run.value.speed,
        // 以"轨迹真实累计长度"为准（两位小数、非整数值），而不是任务要求里的整数
        targetKm: actualKm,
        points: generated.points,
        visibleCount: 1,
        officialRoute: line?.pointList ?? [],
        // 供「轨迹预览」按圈着色（多圈同色会糊成一条粗带）
        lapLengthM: generated.lapLengthM,
        lapDriftM: generated.lapDriftM,
        passPoints: { all: DEMO_PASS_POINTS.length, done: 0, notPassed: DEMO_PASS_POINTS.length },
        /**
         * ⚠️ 2026-09-21（用户要求"冗余提示"，并修一个自伤 bug）：任务速度窗与时长窗互斥时的说明，
         * **必须写进这个"整对象"里** —— 上面是 `run.value = { ...createRunState(), ... }` **整体替换**，
         * 任何在替换**之前**挂到 `run.value` 上的字段都会被丢掉（本字段第一版就是这么 100% 失效的，被审计抓到）。
         */
        windowConflictDetail: plan.windowConflictDetail,
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
    // ⚠️ 自由跑没有任务（厂商口径：自由跑不带任务号）⇒ 这里只在**阳光跑**时要求任务
    const isFreeRun = run.value.runType !== 0
    if (!isFreeRun && !task.value) return

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
        // 自由跑没有线路 ⇒ 传 null（构造器会把 taskId 置空、路径点列为 []，与厂商口径一致）
        line: isFreeRun
          ? null
          : {
              pointId: run.value.lineId || 'demo-line',
              // ⚠️ `DEMO_LINES` 里没有 taskId；真包里 `taskId` 取线路的 taskId（实测两者同值），
              //    这里显式补上，保持预览与真实提交一致。
              taskId: task.value?.taskId ?? '',
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
      line: isFreeRun
        ? null
        : { pointId: run.value.lineId || 'demo-line', taskId: task.value?.taskId ?? '', pointName: '', pointList: [] },
      km: distanceKm,
      durationSeconds,
      fitDegree,
      points: points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
      token,
      scantronId,
      startMs: endedAtMs - durationSeconds * 1000,
      endMs: endedAtMs,
    })

    /**
     * ⚠️ 自检只对**阳光跑**有意义（`evaluateRunAgainstTask` 检查的是"任务的里程/时长/拟合度约束"）。
     *    自由跑**没有任务** ⇒ 不做任务自检，给一个"无约束、恒通过"的结果
     *    （`items: []` 是显式空清单；页面在自由跑时会隐藏"任务与约束"面板，不会显示空表）。
     */
    const sunrunTaskForCheck = task.value
    const check: TaskCheckResult =
      !isFreeRun && sunrunTaskForCheck
        ? evaluateRunAgainstTask({
            task: sunrunTaskForCheck,
            km: distanceKm,
            durationSeconds,
            fitDegree,
          })
        : { pass: true, problems: [], items: [] }

    run.value.status = 'finished'
    // 🆕 2026-09-21（冗余加固）：记下结算时刻 —— 换任务后若"结算早于本次任务读取时刻"，提交按钮禁止点击
    run.value.settledAtMs = Date.now()
    run.value.fitDegree = fitDegree
    run.value.distanceM = distanceKm * 1000
    run.value.result = {
      km: distanceKm,
      durationSeconds,
      fitDegree,
      // 提交口径的 runType（0 阳光跑 / 1 自由跑）随结果留给页面 —— 真实提交必须与预览同源
      submitRunType,
      // 🆕 实际跑出来的那一段：自由跑提前结束时提交必须用它，而不是整条 points
      points: points.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
      scoreRequest,
      detailRequest,
      check,
      // ⚠️ 2026-09-21（用户要求"冗余提示"）：任务的速度窗与时长窗互斥时，计划只能按速度窗生成、
      // 必然违反时长窗 —— 把这条如实放进"自洽校验告警"（自检卡已渲染这一栏），并请用户把参数发给开发者。
      // 说明文字在 `start()` 里算计划时存进状态（`plan` 不在本作用域）。
      statsProblems: run.value.windowConflictDetail
        ? [run.value.windowConflictDetail, ...stats.problems]
        : stats.problems,
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
