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
import { TOKEN_EXPIRED_HINT } from '~/utils/mp/tokenScan'
import { looksLikeTokenExpired } from '~/src/mp/envelope'
import { logError, logInfo, logWarn } from './useEventLog'

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
  const { session, clearSession } = useMpSession()
  const { setTask, setLines, task: currentTask, run, disableDemo, clearLocalData } = useMpDemo()

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

  // 只在客户端读一次缓存的元信息（用于是否显示"恢复上次任务"入口）——**不自动恢复数据**
  if (import.meta.client) syncCacheState()

  /**
   * 把**真实**任务/线路注入到跑步页（跑步引擎照旧跑，但按真实约束与真实线路）。
   *
   * ⚠️ 语义边界（2026-09-15 修 bug）：**没有真实任务时本函数必须什么都不做**。
   *    它在跑步页 `onMounted` 也会被调用；若在这里无条件 `disableDemo()`，
   *    用户"在工作台载入演示数据 → 进跑步页"时演示模式会被误关（数据还在、但标识/步长口径全变），
   *    所以 `disableDemo()` 只在**确实要应用真实数据**时执行。
   * @param overrideLineId 指定选线（"恢复上次任务"时传入缓存里记住的那条）；不传则按下面优先级自动选
   */
  const applyToRunner = (overrideLineId?: string) => {
    if (!task.value) return
    disableDemo()
    setTask(task.value)
    const list = (task.value?.runPointList ?? []) as MpRunLine[]
    if (!list.length) return
    setLines(list)
    // 选线优先级：① 显式指定（恢复缓存时）且仍有效 → 用它；② 与本人校区同名的线路；
    // ③ 按坐标分组的本校区第一条（不再盲选数据里的第一条 —— 实测数据第一条常在别的校区）。
    const campus = profile.value?.campusName || profile.value?.campusId || ''
    const valid = (id?: string) => (id && list.some((l) => String(l.pointId) === String(id)) ? String(id) : '')
    const preferred = campus ? list.find((l) => String(l.pointName ?? '').includes(campus)) : undefined
    const fallback = groupRoutesByCampus(list, campus).defaultLineId
    const chosen = valid(overrideLineId) || preferred?.pointId || fallback
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
    logInfo('real', '开始读取真实数据', { tokenLen: token.length })

    // ① 先拉学生档案（此刻还不知道 schoolCode，走共享域；token 自身标识身份）
    const info = await MpApiWrapper.getStudentInfoByToken({ token })
    if (!info.ok || !info.data?.snCode) {
      status.value = 'error'
      // token 过期/失效 → 给**可操作**提示（用户 2026-09-15 指定：提示退出登录并重新登录小程序）
      error.value = looksLikeTokenExpired(info.raw) ? TOKEN_EXPIRED_HINT : `读取学生档案失败：${info.message}`
      if (looksLikeTokenExpired(info.raw)) logWarn('real', 'token 已过期/失效', { raw: info.message })
      else logError('real', '读取学生档案失败', { message: info.message })
      return false
    }
    const raw = info.data as Record<string, unknown>
    const schoolCode = String(raw.schoolCode ?? '')

    // ② 按**真实 schoolCode** 解析该校基址（多租户），校验是否共享域（支持范围判据①）
    const resolved = (await MpApiWrapper.resolveSchoolBaseUrl(schoolCode, { token })) || undefined
    if (resolved && !isSharedDomain(resolved)) {
      status.value = 'error'
      error.value = nonSharedDomainMessage(resolved)
      logWarn('real', '学校不在共享域，已拒绝', { schoolCode })
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
    logInfo('real', '读到学生档案', {
      schoolCode,
      school: profile.value.schoolName,
      campus: profile.value.campusName,
      baseUrl,
    })

    // ③ 任务与线路（campusId 是必填，否则必报「该校区阳光跑任务未设置」）
    const paper = await MpApiWrapper.getSunrunPaper(
      { stuNumber: profile.value.snCode, campusId: profile.value.campusId, token },
      options,
    )
    if (!paper.ok || !paper.data) {
      status.value = 'error'
      error.value = `读取任务失败：${paper.message}（任务可能尚未下发）`
      logError('real', '读取任务失败', { message: paper.message })
      return false
    }
    task.value = paper.data as MpSunrunTask
    loadedAt.value = Date.now()
    status.value = 'ready'
    logInfo('real', '读到任务与线路', {
      paperName: task.value.paperName,
      lines: task.value.runPointList?.length ?? 0,
      mileage: task.value.mileage,
      minSpeed: task.value.minSpeed,
      maxSpeed: task.value.maxSpeed,
      minTime: task.value.minTime,
      maxTime: task.value.maxTime,
      fitDegree: task.value.fitDegree,
    })

    // ④ 顺带把「一票否决项」也读出来（只读，30 秒内出结果）：人脸 / 抽查开关 + 摄像头杆
    const cfg = await MpApiWrapper.getSunRunStartConfiguration(profile.value.snCode, options)
    switches.value = cfg.ok ? ((cfg.data as Record<string, string>) ?? null) : null
    if (cfg.ok) {
      logInfo('gate', '开跑开关已读取', {
        sunrunStartFace: switches.value?.sunrunStartFace,
        sunrunPointRandom: switches.value?.sunrunPointRandom,
        sunrunPointShowOff: switches.value?.sunrunPointShowOff,
      })
    } else {
      logWarn('gate', '开跑开关读取失败', { message: cfg.message })
    }

    // 先定好"本次选中哪条线路"（校区名 → 坐标分组默认），再查**该线路**的摄像头杆开关。
    // ⚠️ 顺序很重要：摄像头杆是按线路下发的；早先这里查的是 runPointList[0]，
    //    而 applyToRunner 之后选中的可能是**另一条**（如与本人校区同名的），导致门禁拿不到当前线路的值。
    applyToRunner()

    if (import.meta.client) {
      try {
        localStorage.setItem(
          TASK_CACHE_KEY,
          JSON.stringify({ at: loadedAt.value, task: task.value, lineId: String(run.value.lineId || '') }),
        )
        syncCacheState() // 同步"可恢复上次任务"的界面状态（否则要等下次刷新才显示）
      } catch {
        /* 忽略配额错误 */
      }
    }

    const selectedId = String(run.value.lineId || (task.value.runPointList ?? [])[0]?.pointId || '')
    if (selectedId) await refreshCameraFlag(selectedId, true)

    // 门禁终值（日志）：方便事后核对"为什么拦住 / 为什么放行"
    const gate = gateStatus.value
    if (gate.allow) logInfo('gate', '门禁通过（三类开关均无阻碍）', { blockedBy: gate.blockedBy ?? '' })
    else logWarn('gate', `门禁拦住：${gate.reason}`, { blockedBy: gate.blockedBy ?? '' })
    return true
  }

  /** 读整个缓存负载（不存在/损坏返回 null） */
  function readCachePayload(): { at?: number; task?: MpSunrunTask; lineId?: string } | null {
    if (!import.meta.client) return null
    try {
      const raw = localStorage.getItem(TASK_CACHE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as { at?: number; task?: MpSunrunTask; lineId?: string }
      return parsed?.task ? parsed : null
    } catch {
      return null
    }
  }

  /** 刷新"是否存在可恢复的上次任务"这个界面状态（非响应式存储，需手动同步） */
  function syncCacheState(): void {
    const p = readCachePayload()
    cacheAt.value = p ? (p.at ?? 1) : 0
    cachePaperName.value = p?.task?.paperName ?? ''
    cacheLineId.value = p?.lineId ?? ''
  }

  /** 把当前选中的线路写回缓存（用户换线路时调用；"恢复上次任务"时保持选线） */
  function persistSelectedLine(): void {
    if (!import.meta.client) return
    try {
      const raw = localStorage.getItem(TASK_CACHE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { at?: number; task?: MpSunrunTask; lineId?: string }
      if (!parsed?.task) return
      localStorage.setItem(TASK_CACHE_KEY, JSON.stringify({ ...parsed, lineId: String(run.value.lineId || '') }))
      syncCacheState()
    } catch {
      /* 忽略配额/解析错误 */
    }
  }
  /**
   * **显式**恢复上次读取的任务（刷新页面后**不再自动回填** —— 用户要求"刷新默认是干净状态"）。
   * 任务/线路/开关会恢复到缓存时的样子，并沿用当时选中的线路。
   */
  function restoreCachedTask(): boolean {
    if (task.value) return false
    const p = readCachePayload()
    const cachedTask = p?.task
    if (!cachedTask?.runPointList?.length) return false
    task.value = cachedTask
    loadedAt.value = p?.at ?? Date.now()
    status.value = 'ready'
    applyToRunner(p?.lineId)
    return true
  }

  /** 清掉"上次任务"缓存（界面"忽略并清除"用） */
  function clearCachedTask(): void {
    if (import.meta.client) {
      try {
        localStorage.removeItem(TASK_CACHE_KEY)
      } catch {
        /* 忽略 */
      }
    }
    syncCacheState()
  }

  /**
   * **一键清空本机数据**（界面按钮）：会话 token + 任务/线路/开关/记录 + 跑步机状态 + "上次任务"缓存。
   * 清完后界面回到全新状态（需要重新粘贴 token 并读取）。
   */
  function clearAllLocalData(): void {
    clearSession()
    clearLocalData() // useMpDemo：任务/线路/开关/记录/跑步机 + 退出演示
    clearCachedTask()
    profile.value = null
    task.value = null
    status.value = 'idle'
    error.value = ''
    loadedAt.value = 0
    switches.value = null
    cameraFlag.value = null
    cameraFlagLineId.value = ''
    cameraFlagError.value = ''
    phase.value = 'idle'
    phaseMessage.value = ''
    remainingSeconds.value = 0
    result.value = null
  }

  /** 是否存在"可恢复的上次任务"（界面据此显示恢复入口） */
  const hasCachedTask = computed(() => cacheAt.value > 0)
  /** 上次任务的展示信息（时间 + 任务名），用于恢复入口的文案 */
  const cachedTaskLabel = computed(() => {
    if (!hasCachedTask.value) return ''
    const t = cacheAt.value === 1 ? '' : new Date(cacheAt.value).toLocaleString('zh-CN')
    return `${cachePaperName.value || '（未命名任务）'}${t ? ` · ${t}` : ''}`
  })

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

  /**
   * 查询某条线路的摄像头杆开关（只读；换线路时由 watch 自动跟随）。
   *
   * ⚠️ 2026-09-15 修 bug：**只有请求成功才记 `cameraFlagLineId`**。
   *    原实现在请求失败时也把该线路标记为"已查询"，而本函数开头又用
   *    `id === cameraFlagLineId.value` 做去重 → **一次失败就永久不再重试**，
   *    门禁会一直显示"摄像头杆尚未读取"，必须刷新页面才能恢复。
   * @param force 忽略去重、强制重查（界面"重新读取"按钮用）
   */
  async function refreshCameraFlag(lineId?: string, force = false): Promise<void> {
    const id = lineId || (task.value?.runPointList?.[0]?.pointId ?? '')
    if (!id || !session.value?.token) return
    if (!force && id === cameraFlagLineId.value) return
    const cam = await MpApiWrapper.call<Record<string, unknown>>(
      'cameraConfig',
      { lineId: id, token: session.value.token },
      { token: session.value.token, baseUrl: session.value.baseUrl },
    )
    if (!cam.ok) {
      // 失败：保持"未知"（门禁继续拦），但**不记 lineId**，以便下次重试
      cameraFlag.value = null
      cameraFlagLineId.value = ''
      cameraFlagError.value = `读取该线路的摄像头杆开关失败：${cam.message}`
      logWarn('gate', '摄像头杆开关读取失败', { lineId: id, message: cam.message })
      return
    }
    const flag = (cam.data as Record<string, unknown> | undefined)?.flag
    cameraFlag.value = typeof flag === 'boolean' ? flag : null
    cameraFlagLineId.value = id
    cameraFlagError.value =
      typeof flag === 'boolean' ? '' : `该线路的 getCameraConfig 未返回布尔 flag（实际 ${JSON.stringify(flag)}），按"未知"处理`
    logInfo('gate', `摄像头杆开关：${cameraFlag.value === true ? '启用（会拦）' : cameraFlag.value === false ? '未启用（放行）' : '未知'}`, {
      lineId: id,
      flag: cameraFlag.value,
    })
  }

  /** 界面按钮用：强制重查「当前选中线路」的摄像头杆开关（失败不再永久卡住） */
  const retryCameraFlag = (): Promise<void> => refreshCameraFlag(String(run.value.lineId || ''), true)

  /** 当前选中线路对象（门禁需要它的 pointId） */
  const selectedLine = computed<MpRunLine | undefined>(() =>
    (task.value?.runPointList ?? []).find((l) => String(l.pointId) === String(run.value.lineId)) ??
    (task.value?.runPointList ?? [])[0],
  )

  /**
   * **自动确保**「当前选中线路」的摄像头杆开关已读取（幂等 + 覆盖所有进入路径）。
   *
   * 为什么需要它（2026-09-15，E29 的第二半修复）：上一版只做到"失败不再永久卡住"，
   * 但**没有任何东西会主动去读** —— 工作台打开（缓存回填任务）时不会触发，
   * 于是门禁一直显示"摄像头杆尚未读取"，用户只能刷新页面或手动点重试。
   *
   * 覆盖：① 页面加载/缓存回填（status 变 ready）；② 选线变化；③ token 就绪。
   * 不会死循环：依赖里**不含** `cameraFlagLineId`（成功记账不会自触发）；失败时依赖不变，也不会连发。
   */
  watch(
    [() => status.value, () => run.value.lineId, () => session.value?.token],
    () => {
      if (status.value !== 'ready' || !session.value?.token) return
      const id = String(run.value.lineId || selectedLine.value?.pointId || '')
      if (!id || id === cameraFlagLineId.value) return
      void refreshCameraFlag(id)
    },
    { immediate: true },
  )

  /**
   * 时钟 tick（每 30 秒）：**只**用于让"夜间停用（22:30~06:00）"这类与时间有关的门禁自动刷新，
   * 不参与任何成绩/拟合度判定（判定仍只看任务的里程/配速/拟合度/时段那几个字段）。
   */
  const clockTick = useState('mpRealClockTick', () => Date.now())
  let clockTimer: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    if (!import.meta.client) return
    clockTick.value = Date.now()
    clockTimer = setInterval(() => {
      clockTick.value = Date.now()
    }, 30_000)
  })
  onUnmounted(() => {
    if (clockTimer !== null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  })

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
      // ⚠️ 依赖 clockTick：门禁里的"夜间停用（22:30~06:00）"要能**随时间自动刷新**（每 30 秒）
      now: new Date(clockTick.value),
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
    /** 摄像头杆开关读取失败的原因（空串=正常） */
    cameraFlagError,
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
    /** 显式恢复"上次读取的任务"（刷新后**不会**自动恢复） */
    restoreCachedTask,
    /** 是否存在可恢复的上次任务 */
    hasCachedTask,
    cachedTaskLabel,
    clearCachedTask,
    /** 一键清空本机数据（会话 + 任务 + 记录 + 缓存） */
    clearAllLocalData,
    applyToRunner,
    persistSelectedLine,
    submitRealRun,
    fetchVerdict,
    refreshCameraFlag,
    retryCameraFlag,
    stopWait,
  }
}
