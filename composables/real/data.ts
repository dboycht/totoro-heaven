/**
 * 【真实链路·只读侧】`useMpRealData()` —— 读档案 / 任务 / 线路 / 风控开关 / 摄像头杆、
 * 「上次任务」缓存、选线、开跑门禁状态与所有派生展示值。
 *
 * 拆分说明（`useMpReal` 结构整理，1.1.7）：本文件**只有读**（唯一例外是清空本机数据时把
 * 共享状态复位 —— 那是界面按钮，不是链路写操作）；真正的写链路（`getRunBegin` /
 * `sunRunExercises` / `sunRunExercisesDetail`）在 `real/submit.ts`。
 * 共享状态一律来自 `./state`（`useState('mpRealXxx')` 是跨文件同一个引用），
 * 依赖方向：`useMpReal.ts` → 本文件 → `./state`（**不反向依赖** `real/submit.ts`）。
 */
import { MpApiWrapper, MP_DEFAULT_BASE_URL } from '~/src/wrappers/MpApiWrapper'
import type { MpRunLine, MpSunrunTask } from '~/src/mp/types'
import { groupRoutesByCampus } from '~/utils/mp/routeGroups'
import { normalizeCachePayload, serializeCachePayload, type RealCachePayload } from '~/utils/mp/realCache'
import { TOKEN_EXPIRED_HINT } from '~/utils/mp/tokenScan'
import { looksLikeTokenExpired } from '~/src/mp/envelope'
import {
  evaluateRunGate,
  findVerifiedSchool,
  isSharedDomain,
  nonSharedDomainMessage,
  unverifiedSchoolNotice,
} from '~/utils/mp/schoolGate'
import { logError, logInfo, logWarn } from '../useEventLog'
import { TASK_CACHE_KEY, useRealState, type MpRealProfile } from './state'

export function useMpRealData() {
  const { session, clearSession } = useMpSession()
  const { setTask, setLines, task: currentTask, run, disableDemo, clearLocalData } = useMpDemo()

  const {
    profile,
    task,
    status,
    error,
    loadedAt,
    switches,
    cameraFlag,
    cameraFlagLineId,
    cameraFlagError,
    cacheAt,
    cachePaperName,
    cacheLineId,
    // 下面这几个是**提交期**状态；只读侧只在「一键清空本机数据」时负责复位
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    clockTick,
  } = useRealState()

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
      // ⚠️ 除任务外**连账号与开关一起存**（2026-09-18）：只存任务的话，
      //    "恢复上次任务"后账号面板/一票否决项永远是"未读取"（用户实测反馈）。
      writeCachePayload({
        at: loadedAt.value,
        task: task.value,
        lineId: String(run.value.lineId || ''),
        profile: profile.value,
        switches: switches.value,
        cameraFlag: cameraFlag.value,
      })
    }

    const selectedId = String(run.value.lineId || (task.value.runPointList ?? [])[0]?.pointId || '')
    if (selectedId) await refreshCameraFlag(selectedId, true)

    // 门禁终值（日志）：方便事后核对"为什么拦住 / 为什么放行"
    const gate = gateStatus.value
    if (gate.allow) logInfo('gate', '门禁通过（三类开关均无阻碍）', { blockedBy: gate.blockedBy ?? '' })
    else logWarn('gate', `门禁拦住：${gate.reason}`, { blockedBy: gate.blockedBy ?? '' })
    return true
  }

  /** 读整个缓存负载（不存在/损坏/没有任务 → null）；解析与归一化走纯函数 `normalizeCachePayload` */
  function readCachePayload(): RealCachePayload | null {
    if (!import.meta.client) return null
    try {
      const raw = localStorage.getItem(TASK_CACHE_KEY)
      if (!raw) return null
      return normalizeCachePayload(JSON.parse(raw))
    } catch {
      return null
    }
  }

  /** 刷新"是否存在可恢复的上次任务"这个界面状态（非响应式存储，需手动同步） */
  function syncCacheState(): void {
    const p = readCachePayload()
    cacheAt.value = p ? (p.at || 1) : 0
    cachePaperName.value = p?.task?.paperName ?? ''
    cacheLineId.value = p?.lineId ?? ''
  }

  /** 把当前选中的线路写回缓存（用户换线路时调用；"恢复上次任务"时保持选线） */
  function persistSelectedLine(): void {
    if (!import.meta.client) return
    const p = readCachePayload()
    if (!p) return
    writeCachePayload({ ...p, lineId: String(run.value.lineId || '') })
  }

  /** 统一写缓存（**补上账号/开关**，见 `utils/mp/realCache.ts` 的沿革说明） */
  function writeCachePayload(p: {
    at: number
    task: MpSunrunTask | null
    lineId: string
    profile?: MpRealProfile | null
    switches?: Record<string, string> | null
    cameraFlag?: boolean | null
  }): void {
    if (!import.meta.client || !p.task) return
    try {
      localStorage.setItem(TASK_CACHE_KEY, serializeCachePayload({ ...p, task: p.task }))
      syncCacheState() // 同步"可恢复上次任务"的界面状态（否则要等下次刷新才显示）
    } catch {
      /* 忽略配额错误 */
    }
  }
  /**
   * 「恢复上次读取」——**先恢复，再用 token 重新读取一遍**（2026-09-18 按用户要求改）
   *
   * 用户实测反馈：只点「恢复上次任务」时，右侧账号面板与一票否决项（人脸/抽查/摄像头杆）
   * **永远是"未读取"** —— 因为老实现只恢复了 `task`，从来不动 `profile` / `switches`。
   *
   * 现在的两段式：
   *   ① **先即时恢复**缓存里的账号 / 任务 / 开关 / 摄像头杆（界面立刻可用，即便没网也能看）；
   *   ② 若本机**存有真实 token** ⇒ 立刻用 token **重新读取一遍**（拿到最新的任务与开关；
   *      token 过期时会走已有的"可操作提示"分支）；没有 token 就只能用缓存。
   *
   * 返回"是否恢复了缓存"（`false` = 没有可用缓存；此时若仍有 token，页面应改走「读取真实账号与任务」）。
   */
  function restoreCachedTask(): boolean {
    if (task.value) return false
    const p = readCachePayload()
    const cachedTask = p?.task
    let restored = false
    if (cachedTask?.runPointList?.length) {
      task.value = cachedTask
      loadedAt.value = p?.at || Date.now()
      status.value = 'ready'
      // 账号与开关一起恢复（老缓存没有这些字段 ⇒ 保持 undefined/原值，由第 ② 步重新读取补齐）
      if (p?.profile) profile.value = p.profile
      if (p?.switches) switches.value = p.switches
      if (typeof p?.cameraFlag === 'boolean') {
        cameraFlag.value = p.cameraFlag
        cameraFlagLineId.value = String(p.lineId || '')
      }
      applyToRunner(p?.lineId)
      restored = true
      logInfo('real', '已从本机缓存恢复上次读取（账号/任务/开关）', {
        paperName: cachedTask.paperName,
        hasProfile: Boolean(p?.profile),
        hasSwitches: Boolean(p?.switches),
      })
    }
    // ② 有真实 token 就再读一遍（异步；失败会走 status/error 的既有分支，不会吞掉缓存里已恢复的内容）
    const token = session.value?.token
    if (token && !token.startsWith('demo-')) {
      logInfo('real', '恢复后自动重新读取真实数据', { tokenLen: token.length })
      void loadRealData()
    }
    return restored
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

  // 时钟 tick 的状态声明在 ./state（`mpRealClockTick`）；这里只负责每 30 秒驱动它。
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
    refreshCameraFlag,
    retryCameraFlag,
  }
}
