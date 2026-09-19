/**
 * 【真实链路·写侧】`useMpRealSubmit()` —— 真实提交（`getRunBegin` → 真实等待 → `sunRunExercises`
 * → `sunRunExercisesDetail`）+ 读回判定（`getSunrunArch`，只读）+ 停止等待。
 *
 * 安全设计（来自 2026-09-14 实测那笔"判有效"的成功经验）：
 *   1. **真实等待**：`getRunBegin` 之后**真等够报备时长**再提交，
 *      保证 `endTime - startTime` 与服务器观测到的真实间隔一致（避免"秒级完成 3.2km"的破绽）；
 *   2. **只提交一次**：写操作不重试；失败即停（按源码行为：成绩失败则轨迹不发）；
 *   3. **提交前自检**：用 `evaluateRunAgainstTask` 先把硬性项算一遍，不合格就不提交；
 *   4. **不做挑衅性实验**（不重复提交同一 `scantronId`、不故意偏离轨迹）。
 *
 * 拆分说明（`useMpReal` 结构整理，1.1.7）：共享状态一律来自 `./state`
 * （`useState('mpRealXxx')` 是跨文件同一个引用）。依赖方向：`useMpReal.ts` → 本文件 → `./state`，
 * **不**依赖只读侧 `real/data.ts`（提交前的门禁用同一个纯函数**就地算**，
 * 与 `gateStatus` 保持同一判据，且不引入反向依赖）。
 */
import { MpApiWrapper } from '~/src/wrappers/MpApiWrapper'
import { MP_SCORE_STATUS } from '~/src/mp/models'
import type { MpRunLine } from '~/src/mp/types'
import { buildRunBeginRequest, buildScoreDetailRequest, buildScoreRequest, toSubmitPoints } from '~/utils/mp/submitPayload'
import { evaluateRunGate } from '~/utils/mp/schoolGate'
import { TOKEN_EXPIRED_HINT } from '~/utils/mp/tokenScan'
import { looksLikeTokenExpired } from '~/src/mp/envelope'
import { logError, logInfo, logWarn } from '../useEventLog'
import { useRealState, type RealSubmitResult } from './state'

export function useMpRealSubmit() {
  const { session } = useMpSession()
  const { profile, task, switches, cameraFlag, cameraFlagLineId, phase, phaseMessage, remainingSeconds, result } =
    useRealState()

  // ---------- 真实提交 ----------

  let waitTimer: ReturnType<typeof setInterval> | null = null
  const stopWait = () => {
    if (waitTimer !== null) {
      clearInterval(waitTimer)
      waitTimer = null
    }
  }

  /**
   * 真实提交一次成绩。
   * @param input points/km/fitDegree 来自跑步页生成的真实轨迹；plannedSeconds = 报备时长（= 模拟跑完的时长）
   * @param input.runType `0` 阳光跑 / `1` 自由跑（**提交口径**）。自由跑：**不需要线路**、不取任务号、不发路径点明细。
   *
   * ⚠️ **第一件事是过三合一否决门禁**（`utils/mp/schoolGate.ts`）：学校登记表 + 开场人脸 + 随机抽查 + 摄像头杆。
   *    任一不通过都**不会调用 `getRunBegin`**（即不创建场次、不留脏数据）。
   *    自由跑按厂商口径只受夜间停用约束（厂商的自由跑不打卡、不取线路）。
   */
  async function submitRealRun(input: {
    /** 阳光跑必填；**自由跑传 null** */
    line: MpRunLine | null
    runType?: 0 | 1
    points: { latitude: string | number; longitude: string | number }[]
    km: number
    fitDegree: number
    plannedSeconds: number
  }): Promise<RealSubmitResult | null> {
    /**
     * ⚠️ **并发互斥（2026-09-19 审计 S2）**：本函数**会创建服务端场次**（非幂等写），
     * 而它内部的 `waitTimer` 是**闭包级单变量** —— 第二次调用会把第一次的计时器清掉，
     * 于是第一次的等待 Promise **永不 resolve**（既不发提交、也不报错，`phase` 卡死）。
     * 所以入口必须先挡住"已经在等/已经在提交"的第二次调用（界面按钮也加了 disabled，这里是兜底）。
     */
    if (phase.value === 'waiting' || phase.value === 'submitting') {
      return null
    }
    const token = session.value?.token
    const runType: 0 | 1 = input.runType === 1 ? 1 : 0
    const freeRun = runType === 1
    // 阳光跑需要"档案 + 任务 + 线路"；自由跑只需要档案（不取任务、不取线路）
    if (!token || !profile.value || (!freeRun && !task.value) || (!freeRun && !input.line)) {
      phase.value = 'error'
      phaseMessage.value = freeRun
        ? '缺少真实会话/档案，请先在工作台读取真实数据'
        : '缺少真实会话/档案/任务，请先在工作台读取真实数据'
      return null
    }

    // ⓪ 三合一否决门禁（必须在任何写操作之前）—— 含"夜间停用 22:30~06:00"（同一纯函数，实时取时钟）
    const gate = evaluateRunGate({
      schoolCode: profile.value.schoolCode,
      switches: switches.value,
      line: input.line,
      cameraFlag: cameraFlag.value,
      cameraFlagLineId: cameraFlagLineId.value,
      runType,
      now: new Date(),
    })
    if (!gate.allow) {
      phase.value = 'error'
      phaseMessage.value = `已停止（未创建场次）：${gate.reason}`
      return null
    }

    const options = { token, baseUrl: session.value?.baseUrl }

    // ① 开跑：getRunBegin（写）。自由跑照厂商口径传 runType=1 且 paperId/lineId 为空串。
    phase.value = 'begin'
    phaseMessage.value = '正在创建跑步会话（getRunBegin）…'
    const begin = await MpApiWrapper.getRunBegin(buildRunBeginRequest({ line: input.line, runType }), options)
    const scantronId = (begin.data as { scantronId?: string } | undefined)?.scantronId
    if (!begin.ok || !scantronId) {
      phase.value = 'error'
      // 若失败原因是 token 过期 → 给"退出登录并重新登录小程序"的可操作提示
      phaseMessage.value = looksLikeTokenExpired(begin.raw)
        ? TOKEN_EXPIRED_HINT
        : `开跑失败：${begin.message}`
      logError('submit', '开跑失败（getRunBegin）', { message: begin.message, lineId: input.line?.pointId ?? '(自由跑)' })
      return null
    }
    const startedAt = Date.now()
    logInfo('submit', '开跑会话已创建', {
      scantronId,
      runType,
      lineId: input.line?.pointId ?? '(自由跑)',
      lineName: input.line?.pointName ?? '',
      km: Number(input.km.toFixed(2)),
      fitDegree: input.fitDegree,
      points: input.points.length,
    })

    // ② 真实等待（安全设计：让 endTime-startTime 与服务器观测一致）
    const planned = Math.max(1, Math.round(input.plannedSeconds))
    phase.value = 'waiting'
    remainingSeconds.value = planned
    phaseMessage.value = `会话已创建，正在「跑」：为了让时间线一致，需真实等待 ${Math.ceil(planned / 60)} 分钟`
    logInfo('submit', '进入真实等待', { plannedSeconds: planned, minutes: Math.round(planned / 60) })
    await new Promise<void>((resolve) => {
      stopWait()
      waitTimer = setInterval(() => {
        const left = planned - Math.round((Date.now() - startedAt) / 1000)
        remainingSeconds.value = Math.max(0, left)
        if (left <= 0) {
          stopWait()
          resolve()
        }
      }, 1000)
    })

    /**
     * ⚠️ **等待结束后必须重新校验上下文**（2026-09-19 审计 S3）。
     *
     * 等待可以长达 20 分钟，期间用户完全可能在顶栏点「退出登录」或在工作台点「清空本机数据」——
     * 那会把 `profile` / `session` 置空。而下面 `const context = { snCode: profile.value.snCode, … }`
     * 依赖**进入本函数时**的 TS 窄化（`!profile.value` 已在前面判过），**跨 `await` 后窄化并不能保证非空**
     * ⇒ 会抛 `TypeError: Cannot read properties of null`，而且：
     *   · 异常冒到调用方（界面无 catch）⇒ 无任何提示；
     *   · 已创建的场次被丢弃；
     *   · `phase` 永久停在 `'waiting'` ⇒ 「真实提交」与「重置」双双灰死，只能刷新页面。
     * 所以这里重取一次，缺了就明确置错并退出（场次丢弃是已知代价，但至少状态正确、有提示）。
     */
    const tokenNow = session.value?.token
    const profileNow = profile.value
    if (!tokenNow || !profileNow) {
      phase.value = 'error'
      phaseMessage.value =
        '等待期间会话/档案被清除（可能点了「退出登录」或「清空本机数据」）——本次提交已中止，未发送成绩。请重新读取真实数据后再试。'
      logWarn('submit', '等待期间上下文丢失，提交中止', {
        scantronId,
        hadToken: Boolean(tokenNow),
        hadProfile: Boolean(profileNow),
      })
      return null
    }

    // ③ 提交成绩（写；只发一次，失败不重试）
    const submittedAt = Date.now()
    const context = {
      snCode: profileNow.snCode,
      schoolCode: profileNow.schoolCode,
      task: task.value,
      line: input.line,
      km: input.km,
      durationSeconds: planned,
      fitDegree: input.fitDegree,
      points: toSubmitPoints(input.points),
      token: tokenNow,
      scantronId,
      startMs: startedAt,
      endMs: submittedAt,
    }
    phase.value = 'submitting'
    phaseMessage.value = '正在提交成绩（sunRunExercises）…'
    // ⚠️ 自由跑必须把 runType 传进报文构造器：它决定 taskId=''、sunrunPathPointList=[]
    //    （厂商源码：自由跑不带任务号、路径点列为空数组）
    const score = await MpApiWrapper.saveScores(buildScoreRequest(context, { runType }), options)
    const out: RealSubmitResult = {
      scantronId,
      startedAt,
      submittedAt,
      scoreOk: score.ok,
      scoreMessage: score.message || (score.ok ? '提交成功' : '提交失败'),
      // 自由跑没有线路 ⇒ 路径点列本来就是空的（厂商口径），这里如实显示 0 点
      scoreRequestMasked: {
        ...buildScoreRequest(context, { runType }),
        token: '***',
        sunrunPathPointList: `（${input.line?.pointList?.length ?? 0} 点）`,
      },
    }

    // ④ 轨迹明细（仅当成绩成功；照源码顺序）
    if (score.ok) {
      phaseMessage.value = '成绩已提交，正在提交轨迹明细（sunRunExercisesDetail）…'
      const detail = await MpApiWrapper.saveScoreDetail(buildScoreDetailRequest(context), options)
      out.detailOk = detail.ok
      out.detailMessage = detail.message || (detail.ok ? '轨迹提交成功' : '轨迹提交失败')
      if (detail.ok) logInfo('submit', '轨迹明细已提交', { detail: out.detailMessage })
      else logWarn('submit', '轨迹明细提交失败', { message: out.detailMessage })
    } else {
      out.detailOk = undefined
      out.detailMessage = '成绩未成功 → 按源码行为不发轨迹，也不重试'
    }

    result.value = out
    phase.value = score.ok ? 'done' : 'error'
    phaseMessage.value = score.ok
      ? `提交完成：${out.scoreMessage}${out.detailOk ? '；轨迹已提交' : ''}`
      : looksLikeTokenExpired(score.raw)
        ? TOKEN_EXPIRED_HINT
        : `提交失败：${out.scoreMessage}`
    if (score.ok) {
      logInfo('submit', '成绩提交成功', {
        scantronId,
        km: Number(input.km.toFixed(2)),
        durationSeconds: planned,
        fitDegree: input.fitDegree,
        waitedSeconds: Math.round((submittedAt - startedAt) / 1000),
      })
    } else {
      logError('submit', '成绩提交失败', { scantronId, message: out.scoreMessage })
    }
    return out
  }

  /** 读回判定（只读）：getSunrunArch → 按 scantronId 找这条 */
  async function fetchVerdict(scantronId?: string): Promise<Record<string, unknown> | null> {
    const token = session.value?.token
    const id = scantronId || result.value?.scantronId
    if (!token || !id || !profile.value) return null
    const options = { token, baseUrl: session.value?.baseUrl }

    const terms = await MpApiWrapper.getTermList(options)
    const termList = (terms.data as { id?: string; isActive?: string | number }[] | undefined) ?? []
    const activeTerm = termList.find((t) => String(t.isActive) === '1') ?? termList[0]
    const months = await MpApiWrapper.getSchoolMonthByTerm(options)
    const monthList = (months.data as { monthId?: string; ifCurrent?: string | number }[] | undefined) ?? []
    const currentMonth = monthList.find((m) => String(m.ifCurrent) === '1') ?? monthList[0]

    const arch = await MpApiWrapper.getSunrunArch(
      {
        projectName: '阳光跑',
        monthId: currentMonth?.monthId ?? '',
        termId: activeTerm?.id ?? '',
        paperId: '',
        stuNumber: profile.value.snCode,
        snCode: profile.value.snCode,
        pageNumber: 1,
        rowNumber: 100,
      },
      options,
    )
    const data = (arch.data as { data?: Record<string, unknown>[] } | undefined)?.data ?? []
    const mine = data.find((r) => String(r.scoreId) === String(id)) ?? null
    if (mine) {
      logInfo('submit', '判定已读回', {
        scantronId: id,
        scorePassType: mine.scorePassType,
        warnType: mine.warnType,
        trajectorySimilary: mine.trajectorySimilary,
        scorePassRemark: mine.scorePassRemark,
        mileage: mine.mileage,
        usedTime: mine.usedTime,
      })
    } else {
      logWarn('submit', '判定暂未在归档中找到', { scantronId: id })
    }
    if (result.value) {
      result.value.record = mine
      result.value.verdictText = mine
        ? `scorePassType=${mine.scorePassType}（${(MP_SCORE_STATUS as Record<number, string>)[Number(mine.scorePassType)] ?? '未知'}）` +
          (mine.scorePassRemark ? ` | 备注：${mine.scorePassRemark}` : '') +
          ` | 里程 ${mine.mileage} | 用时 ${mine.usedTime} | 拟合度 ${mine.trajectorySimilary}`
        : '归档里还没找到这条（可稍后再查）'
    }
    return mine
  }

  return {
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    submitRealRun,
    fetchVerdict,
    stopWait,
  }
}
