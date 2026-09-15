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
import { MpApiWrapper, MP_DEFAULT_BASE_URL } from '~/src/wrappers/MpApiWrapper'
import type { MpRunLine, MpSunrunTask } from '~/src/mp/types'
import { buildRunBeginRequest, buildScoreDetailRequest, buildScoreRequest, toSubmitPoints } from '~/utils/mp/submitPayload'
import {
  evaluateRunGate,
  findVerifiedSchool,
  isSharedDomain,
  nonSharedDomainMessage,
  unverifiedSchoolNotice,
} from '~/utils/mp/schoolGate'
import { groupRoutesByCampus } from '~/utils/mp/routeGroups'

/**
 * 支持范围 = **条件式**（1.1.3，2026-09-15 用户确认）：
 *   ① 与南航共享同一个 API 域（`wxxcx.xtotoro.com`）；且
 *   ② 该校未开启开场人脸 / 随机抽查 / 摄像头杆校验（运行时由门禁判定）。
 * 学校是否"判分口径已被实测验证"只作**软提示**（`schoolNotice`），不影响放行。
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
}

const TASK_CACHE_KEY = 'mp_real_task_v1'

export function useMpReal() {
  const { session } = useMpSession()
  const { setTask, setLines, task: currentTask, run, disableDemo } = useMpDemo()

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

  const phase = useState<RealPhase>('mpRealPhase', () => 'idle')
  const phaseMessage = useState('mpRealPhaseMessage', () => '')
  const remainingSeconds = useState('mpRealRemaining', () => 0)
  const result = useState<RealSubmitResult | null>('mpRealResult', () => null)

  /**
   * 把**真实**任务/线路注入到跑步页（跑步引擎照旧跑，但按真实约束与真实线路）。
   *
   * ⚠️ 语义边界（2026-09-15 修 bug）：**没有真实任务时本函数必须什么都不做**。
   *    它在跑步页 `onMounted` 也会被调用；若在这里无条件 `disableDemo()`，
   *    用户"在工作台载入演示数据 → 进跑步页"时演示模式会被误关（数据还在、但标识/步长口径全变），
   *    所以 `disableDemo()` 只在**确实要应用真实数据**时执行。
   */
  const applyToRunner = () => {
    if (!task.value) return
    disableDemo()
    setTask(task.value)
    const list = (task.value?.runPointList ?? []) as MpRunLine[]
    if (!list.length) return
    setLines(list)
    // 选线优先级（1.1.3 起）：① 本次会话已选且仍有效 → 保留；② 与本人校区同名的线路；
    // ③ 按坐标分组的本校区第一条（不再盲选数据里的第一条 —— 实测数据第一条常在别的校区）。
    const campus = profile.value?.campusName || profile.value?.campusId || ''
    const cached = readCachedLineId()
    const keepCached = cached && list.some((l) => String(l.pointId) === String(cached))
    const preferred = campus ? list.find((l) => String(l.pointName ?? '').includes(campus)) : undefined
    const fallback = groupRoutesByCampus(list, campus).defaultLineId
    const chosen = (keepCached ? cached : '') || preferred?.pointId || fallback
    if (chosen) run.value.lineId = chosen
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

    // ① 先拉学生档案（此刻还不知道 schoolCode，走共享域；token 自身标识身份）
    const info = await MpApiWrapper.getStudentInfoByToken({ token })
    if (!info.ok || !info.data?.snCode) {
      status.value = 'error'
      error.value = `读取学生档案失败：${info.message}`
      return false
    }
    const raw = info.data as Record<string, unknown>
    const schoolCode = String(raw.schoolCode ?? '')

    // ② 按**真实 schoolCode** 解析该校基址（多租户），校验是否共享域（支持范围判据①）
    const resolved = (await MpApiWrapper.resolveSchoolBaseUrl(schoolCode, { token })) || undefined
    if (resolved && !isSharedDomain(resolved)) {
      status.value = 'error'
      error.value = nonSharedDomainMessage(resolved)
      return false
    }
    const baseUrl = resolved || MP_DEFAULT_BASE_URL
    // ⚠️ 必须写回会话：后续 getRunBegin / 提交 / 读判定都走 session.value.baseUrl
    if (session.value) session.value = { ...session.value, baseUrl }
    const options = { token, baseUrl }

    profile.value = {
      snCode: String(raw.snCode ?? ''),
      studentName: String(raw.studentName ?? ''),
      schoolCode,
      schoolName: String(raw.schoolName ?? findVerifiedSchool(schoolCode)?.schoolName ?? ''),
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
    if (firstLine?.pointId) await refreshCameraFlag(firstLine.pointId)

    if (import.meta.client) {
      try {
        localStorage.setItem(
          TASK_CACHE_KEY,
          JSON.stringify({ at: loadedAt.value, task: task.value, lineId: String(run.value.lineId || '') }),
        )
      } catch {
        /* 忽略配额错误 */
      }
    }
    applyToRunner()
    return true
  }

  /** 读缓存里「上次选中的线路 id」（刷新后保持选线；无则空串） */
  function readCachedLineId(): string {
    if (!import.meta.client) return ''
    try {
      const raw = localStorage.getItem(TASK_CACHE_KEY)
      if (!raw) return ''
      const parsed = JSON.parse(raw) as { lineId?: string }
      return String(parsed?.lineId || '')
    } catch {
      return ''
    }
  }

  /** 把当前选中的线路写回缓存（用户换线路时调用；刷新页面后仍保持） */
  function persistSelectedLine(): void {
    if (!import.meta.client) return
    try {
      const raw = localStorage.getItem(TASK_CACHE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { at?: number; task?: MpSunrunTask; lineId?: string }
      if (!parsed?.task) return
      localStorage.setItem(TASK_CACHE_KEY, JSON.stringify({ ...parsed, lineId: String(run.value.lineId || '') }))
    } catch {
      /* 忽略配额/解析错误 */
    }
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

    // ⓪ 三合一否决门禁（必须在任何写操作之前）
    const gate = evaluateRunGate({
      schoolCode: profile.value.schoolCode,
      switches: switches.value,
      line: input.line,
      cameraFlag: cameraFlag.value,
      cameraFlagLineId: cameraFlagLineId.value,
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

  /** 查询某条线路的摄像头杆开关（只读；换线路时由 watch 自动跟随） */
  async function refreshCameraFlag(lineId?: string): Promise<void> {
    const id = lineId || (task.value?.runPointList?.[0]?.pointId ?? '')
    if (!id || !session.value?.token || id === cameraFlagLineId.value) return
    const cam = await MpApiWrapper.call<Record<string, unknown>>(
      'cameraConfig',
      { lineId: id, token: session.value.token },
      { token: session.value.token, baseUrl: session.value.baseUrl },
    )
    const flag = (cam.data as Record<string, unknown> | undefined)?.flag
    cameraFlag.value = typeof flag === 'boolean' ? flag : null
    cameraFlagLineId.value = id
  }

  // ⚠️ 摄像头杆是**按线路**下发的：选中线路变化时自动重新查询（不再显示"第一条线路"的值）
  watch(
    () => run.value.lineId,
    (id) => {
      if (id && status.value === 'ready') void refreshCameraFlag(id)
    },
  )

  /** 当前选中线路对象（门禁需要它的 pointId） */
  const selectedLine = computed<MpRunLine | undefined>(() =>
    (task.value?.runPointList ?? []).find((l) => String(l.pointId) === String(run.value.lineId)) ??
    (task.value?.runPointList ?? [])[0],
  )

  /**
   * 开跑前门禁的实时状态（**界面用它禁用「真实提交」按钮并说明原因**）。
   * 与 `submitRealRun` 内那道门禁调用同一个纯函数，保证"按钮说能点"与"点了真能提交"一致。
   */
  const gateStatus = computed(() =>
    evaluateRunGate({
      schoolCode: profile.value?.schoolCode,
      switches: switches.value,
      line: selectedLine.value,
      cameraFlag: cameraFlag.value,
      cameraFlagLineId: cameraFlagLineId.value,
    }),
  )

  /**
   * 未验证学校的软提示（不阻断开跑，只提醒"判分口径未实测"；已验证学校为空串）。
   * 支持范围已改为条件式（共享域 + 无风控校验），登记表只承担这个提示职责。
   */
  const schoolNotice = computed(() =>
    unverifiedSchoolNotice(profile.value?.schoolCode, profile.value?.schoolName),
  )

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
    selectedLine,
    /** 开跑前三合一否决门禁状态（allow / reason / blockedBy） */
    gateStatus,
    /** 未验证学校的软提示（非阻断） */
    schoolNotice,
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    isRealApplied,
    // 动作
    loadRealData,
    restoreTaskFromCache,
    applyToRunner,
    persistSelectedLine,
    submitRealRun,
    fetchVerdict,
    refreshCameraFlag,
    stopWait,
  }
}
