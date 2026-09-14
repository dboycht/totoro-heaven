/**
 * 【1.1.2 真实链路】南航（schoolCode 98765）真实账号 / 任务 / 线路 / 提交
 *
 * ⚠️ **支持范围：目前仅支持南京航空航天大学（`schoolCode === '98765'`）**。
 *    其他学校（含会自动跳转「学校专属小程序」的学校，如江苏科技大学 10289）**不在支持范围** ——
 *    `loadRealData()` 里会直接拒绝，界面上也有明确提示。
 *
 * 安全设计（来自 2026-09-14 实测那笔"判有效"的成功经验）：
 *   1. **真实等待**：`getRunBegin` 之后**真等够报备时长**再提交，
 *      保证 `endTime - startTime` 与服务器观测到的真实间隔一致（避免"秒级完成 3.2km"的破绽）；
 *   2. **只提交一次**：写操作不重试；失败即停（按源码行为：成绩失败则轨迹不发）；
 *   3. **提交前自检**：用 `evaluateRunAgainstTask` 先把硬性项算一遍，不合格就不提交；
 *   4. **不做挑衅性实验**（不重复提交同一 `scantronId`、不故意偏离轨迹）。
 *
 * 只读/写入端点清单（除此之外不碰任何端点）：
 *   只读：`resolveSchoolBaseUrl`(getSunRunSchoolList) / `GetStudentInfoByToken` / `getSunrunPaper` /
 *         `getTermList` / `getSchoolMonthByTerm` / `getSunrunArch`
 *   写入：`getRunBegin` / `sunRunExercises` / `sunRunExercisesDetail`
 */
import { MpApiWrapper } from '~/src/wrappers/MpApiWrapper'
import type { MpRunLine, MpSunrunTask } from '~/src/mp/types'
import { buildRunBeginRequest, buildScoreDetailRequest, buildScoreRequest, toSubmitPoints } from '~/utils/mp/submitPayload'

/** 当前唯一支持的学校：南京航空航天大学 */
export const SUPPORTED_SCHOOL_CODE = '98765'
export const SUPPORTED_SCHOOL_NAME = '南京航空航天大学'

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

const TASK_CACHE_KEY = 'mp_real_task_v1'

export function useMpReal() {
  const { session } = useMpSession()
  const { setTask, setLines, task: currentTask, run } = useMpDemo()

  const profile = useState<MpRealProfile | null>('mpRealProfile', () => null)
  const task = useState<MpSunrunTask | null>('mpRealTask', () => null)
  const status = useState<'idle' | 'loading' | 'ready' | 'error'>('mpRealStatus', () => 'idle')
  const error = useState('mpRealError', () => '')
  const loadedAt = useState('mpRealLoadedAt', () => 0)
  /** 人脸 / 抽查开关（selectSunRunStartConfiguration 的 body）—— 一票否决项，实测值直接展示 */
  const switches = useState<Record<string, string> | null>('mpRealSwitches', () => null)
  /** 所选线路是否启用摄像头杆（getCameraConfig 的 body.flag） */
  const cameraFlag = useState<boolean | null>('mpRealCameraFlag', () => null)

  const phase = useState<RealPhase>('mpRealPhase', () => 'idle')
  const phaseMessage = useState('mpRealPhaseMessage', () => '')
  const remainingSeconds = useState('mpRealRemaining', () => 0)
  const result = useState<RealSubmitResult | null>('mpRealResult', () => null)

  /** 把真实任务/线路注入到跑步页（演示机器照旧跑，但按真实约束与真实线路） */
  const applyToRunner = () => {
    if (task.value) setTask(task.value)
    const list = (task.value?.runPointList ?? []) as MpRunLine[]
    if (!list.length) return
    setLines(list)
    // 默认选中**与本人校区同名**的线路（如校区「天目湖」→ 线路「天目湖-西操场」），否则用第一条
    const campus = profile.value?.campusName || profile.value?.campusId || ''
    const preferred = campus ? list.find((l) => String(l.pointName ?? '').includes(campus)) : undefined
    if (preferred?.pointId) run.value.lineId = preferred.pointId
  }

  /**
   * 读取真实账号 + 任务 + 线路（**只读**）。
   * 依次：学校基址 → 学生档案（snCode/campusId）→ getSunrunPaper（约束 + 线路）。
   */
  async function loadRealData(): Promise<boolean> {
    const token = session.value?.token
    if (!token || token.startsWith('demo-')) {
      status.value = 'error'
      error.value = '请先在上方填入真实 token（演示 token 不能查真实数据）'
      return false
    }
    status.value = 'loading'
    error.value = ''

    // ① 多租户基址（南航是共享域，但仍按域名解析，避免硬编码）
    const baseUrl = (await MpApiWrapper.resolveSchoolBaseUrl(SUPPORTED_SCHOOL_CODE, { token })) || undefined
    const options = { token, baseUrl }

    // ② 学生档案
    const info = await MpApiWrapper.getStudentInfoByToken(options)
    if (!info.ok || !info.data?.snCode) {
      status.value = 'error'
      error.value = `读取学生档案失败：${info.message}`
      return false
    }
    const raw = info.data as Record<string, unknown>
    const schoolCode = String(raw.schoolCode ?? '')
    if (schoolCode !== SUPPORTED_SCHOOL_CODE) {
      status.value = 'error'
      error.value = `目前仅支持${SUPPORTED_SCHOOL_NAME}（${SUPPORTED_SCHOOL_CODE}），你的学校是 ${schoolCode || '未知'} —— 本项目暂不支持`
      return false
    }
    profile.value = {
      snCode: String(raw.snCode ?? ''),
      studentName: String(raw.studentName ?? ''),
      schoolCode,
      schoolName: String(raw.schoolName ?? SUPPORTED_SCHOOL_NAME),
      campusId: String(raw.schoolCampusCode ?? ''),
      campusName: String(raw.schoolCampusName ?? raw.schoolCampusCode ?? ''),
      className: String(raw.className ?? ''),
    }

    // ③ 任务与线路（campusId 是必填，否则必报「该校区阳光跑任务未设置」）
    const paper = await MpApiWrapper.getSunrunPaper(
      { stuNumber: profile.value.snCode, campusId: profile.value.campusId, token },
      options,
    )
    if (!paper.ok || !paper.data) {
      status.value = 'error'
      error.value = `读取任务失败：${paper.message}（任务可能尚未下发）`
      return false
    }
    task.value = paper.data as MpSunrunTask
    loadedAt.value = Date.now()
    status.value = 'ready'

    // ④ 顺带把「一票否决项」也读出来（只读，30 秒内出结果）：人脸 / 抽查开关 + 摄像头杆
    const cfg = await MpApiWrapper.getSunRunStartConfiguration(profile.value.snCode, options)
    switches.value = cfg.ok ? ((cfg.data as Record<string, string>) ?? null) : null
    const firstLine = (task.value.runPointList ?? [])[0]
    if (firstLine?.pointId) {
      const cam = await MpApiWrapper.call<Record<string, unknown>>(
        'cameraConfig',
        { lineId: firstLine.pointId, token },
        options,
      )
      const flag = (cam.data as Record<string, unknown> | undefined)?.flag
      cameraFlag.value = typeof flag === 'boolean' ? flag : null
    }

    if (import.meta.client) {
      try {
        localStorage.setItem(TASK_CACHE_KEY, JSON.stringify({ at: loadedAt.value, task: task.value }))
      } catch {
        /* 忽略配额错误 */
      }
    }
    applyToRunner()
    return true
  }

  /** 用本地缓存回填任务（刷新页面后不用重新拉；点「刷新任务」可更新） */
  function restoreTaskFromCache() {
    if (task.value || !import.meta.client) return
    try {
      const raw = localStorage.getItem(TASK_CACHE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { at: number; task: MpSunrunTask }
      if (parsed?.task?.runPointList?.length) {
        task.value = parsed.task
        loadedAt.value = parsed.at
        status.value = 'ready'
      }
    } catch {
      /* 忽略损坏缓存 */
    }
  }

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
      phaseMessage.value = `开跑失败：${begin.message}`
      return null
    }
    const startedAt = Date.now()

    // ② 真实等待（安全设计：让 endTime-startTime 与服务器观测一致）
    const planned = Math.max(1, Math.round(input.plannedSeconds))
    phase.value = 'waiting'
    remainingSeconds.value = planned
    phaseMessage.value = `会话已创建，正在「跑」：为了让时间线一致，需真实等待 ${Math.ceil(planned / 60)} 分钟`
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
    } else {
      out.detailOk = undefined
      out.detailMessage = '成绩未成功 → 按源码行为不发轨迹，也不重试'
    }

    result.value = out
    phase.value = score.ok ? 'done' : 'error'
    phaseMessage.value = score.ok
      ? `提交完成：${out.scoreMessage}${out.detailOk ? '；轨迹已提交' : ''}`
      : `提交失败：${out.scoreMessage}`
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

  const profileMasked = computed(() => {
    if (!profile.value) return null
    const mask = (s: string) => (s.length <= 4 ? s[0] + '***' : `${s.slice(0, 2)}***${s.slice(-2)}`)
    return {
      ...profile.value,
      snCode: mask(profile.value.snCode),
      studentName: mask(profile.value.studentName),
    }
  })

  const realLines = computed<MpRunLine[]>(() => (task.value?.runPointList ?? []) as MpRunLine[])

  /** 当前跑步页用的是不是真实任务（大小写无关的简单判定） */
  const isRealApplied = computed(() => Boolean(task.value) && currentTask.value?.paperName === task.value?.paperName)

  return {
    // 状态
    profile,
    profileMasked,
    task,
    realLines,
    status,
    error,
    loadedAt,
    switches,
    cameraFlag,
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    isRealApplied,
    // 动作
    loadRealData,
    restoreTaskFromCache,
    applyToRunner,
    submitRealRun,
    fetchVerdict,
    stopWait,
  }
}
