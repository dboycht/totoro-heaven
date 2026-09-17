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
   *
   * ⚠️ **第一件事是过三合一否决门禁**（`utils/mp/schoolGate.ts`）：学校登记表 + 开场人脸 + 随机抽查 + 摄像头杆。
   *    任一不通过都**不会调用 `getRunBegin`**（即不创建场次、不留脏数据）。
   */
  async function submitRealRun(input: {
    line: MpRunLine
    points: { latitude: string | number; longitude: string | number }[]
    km: number
    fitDegree: number
    plannedSeconds: number
  }): Promise<RealSubmitResult | null> {
    const token = session.value?.token
    if (!token || !profile.value || !task.value) {
      phase.value = 'error'
      phaseMessage.value = '缺少真实会话/档案/任务，请先在工作台读取真实数据'
      return null
    }

    // ⓪ 三合一否决门禁（必须在任何写操作之前）—— 含"夜间停用 22:30~06:00"（同一纯函数，实时取时钟）
    const gate = evaluateRunGate({
      schoolCode: profile.value.schoolCode,
      switches: switches.value,
      line: input.line,
      cameraFlag: cameraFlag.value,
      cameraFlagLineId: cameraFlagLineId.value,
      now: new Date(),
    })
    if (!gate.allow) {
      phase.value = 'error'
      phaseMessage.value = `已停止（未创建场次）：${gate.reason}`
      return null
    }

    const options = { token, baseUrl: session.value?.baseUrl }

    // ① 开跑：getRunBegin（写）
    phase.value = 'begin'
    phaseMessage.value = '正在创建跑步会话（getRunBegin）…'
    const begin = await MpApiWrapper.getRunBegin(
      buildRunBeginRequest({ line: input.line, runType: 0 }),
      options,
    )
    const scantronId = (begin.data as { scantronId?: string } | undefined)?.scantronId
    if (!begin.ok || !scantronId) {
      phase.value = 'error'
      // 若失败原因是 token 过期 → 给"退出登录并重新登录小程序"的可操作提示
      phaseMessage.value = looksLikeTokenExpired(begin.raw)
        ? TOKEN_EXPIRED_HINT
        : `开跑失败：${begin.message}`
      logError('submit', '开跑失败（getRunBegin）', { message: begin.message, lineId: input.line.pointId })
      return null
    }
    const startedAt = Date.now()
    logInfo('submit', '开跑会话已创建', {
      scantronId,
      lineId: input.line.pointId,
      lineName: input.line.pointName,
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

    // ③ 提交成绩（写；只发一次，失败不重试）
    const submittedAt = Date.now()
    const context = {
      snCode: profile.value.snCode,
      schoolCode: profile.value.schoolCode,
      task: task.value,
      line: input.line,
      km: input.km,
      durationSeconds: planned,
      fitDegree: input.fitDegree,
      points: toSubmitPoints(input.points),
      token,
      scantronId,
      startMs: startedAt,
      endMs: submittedAt,
    }
    phase.value = 'submitting'
    phaseMessage.value = '正在提交成绩（sunRunExercises）…'
    const score = await MpApiWrapper.saveScores(buildScoreRequest(context), options)
    const out: RealSubmitResult = {
      scantronId,
      startedAt,
      submittedAt,
      scoreOk: score.ok,
      scoreMessage: score.message || (score.ok ? '提交成功' : '提交失败'),
      scoreRequestMasked: { ...buildScoreRequest(context), token: '***', sunrunPathPointList: `（${input.line.pointList.length} 点）` },
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
        ? `scorePassType=${mine.scorePassType}（${{ 0: '无效', 1: '有效', 2: '申诉有效', 3: '补录有效' }[Number(mine.scorePassType)] ?? '未知'}）` +
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
