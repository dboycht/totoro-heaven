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
// 🔴 2026-09-23（pre3）：任务号走兜底链（厂商响应可能只有 paperId/id，没有 taskId）
import { routeRequirementOf, taskPaperIdOf } from '~/utils/mp/taskShape'
// 🆕 2026-09-23（pre3）：门禁要判"本机有没有可用几何" ⇒ 与跑步页/引擎**同一处判据**
import { freeRouteGeometryChoice } from '~/utils/mp/trackLibrary'
import { looksLikeEnvelope, maskToken, normalizeCachePayload, restorePatchOf, serializeCachePayload, shouldAutoRestoreFromCache, type RealCachePayload } from '~/utils/mp/realCache'
// 🆕 2026-09-22（issue #12 的正解）：`getSunrunPaper` 的**解包兜底**（规格没命中时任务本体可能在别的层）
import { resolvePaperTask, type PaperTaskResolution } from '~/utils/mp/taskUnpack'
import { TOKEN_EXPIRED_HINT } from '~/utils/mp/tokenScan'
import { looksLikeTokenExpired } from '~/src/mp/envelope'
// 🆕 2026-09-22：成功读取后写一份「最近已知状态」（**纯诊断证据，不参与放行**，见该模块文件头）
import { buildLastKnown, clearLastKnown, saveLastKnown } from '~/utils/mp/diagLastKnown'
// 🆕 2026-09-23（用户要求 2️⃣）：门禁/本地判定拦下提交时**显式上报**（诊断包里"明写的事实"）
import { reportBlocked } from '~/composables/useDiagEventReporter'
import {
  evaluateRunGate,
  findVerifiedSchool,
  isSharedDomain,
  nonSharedDomainMessage,
  unverifiedSchoolNotice,
} from '~/utils/mp/schoolGate'
import { logError, logInfo, logWarn } from '../useEventLog'
import { TASK_CACHE_KEY, useRealState } from './state'

/**
 * 🔴🔴 2026-09-24（用户实测：`getCameraConfig` 在 **0.21 秒内被打了 21 次**，同一 lineId、全部 200）
 * —— 摄像头杆开关查询的**跨实例**收口状态。
 *
 * ## 为什么必须放在**模块级**（而不是 `useMpRealData()` 里）
 * `useMpRealData()` 会被多个组件/组合式各调用一次（跑步页 / 工作台卡 / 诊断卡 / 非官方路径页…），
 * 每次调用都会**新建一份闭包状态**并**各注册一个 watch**。第一版修复把去抖/在途表放在函数里
 * ⇒ 每个实例一套 ⇒ 一次成批触发仍然发 N 次（实测挂载一次就 3 次，正好等于实例数）✗。
 * 这些 ref（`cameraFlag` / `cameraFlagLineId` / …）本身都是 `useState` **单例** ⇒ 调度状态也必须是单例。
 *
 * ## 三重收口（只收口"怎么读"，**判据一个字不改**）
 *   ① **在途复用**：同一 `lineId` 正在请求中 ⇒ 后来者复用同一个 Promise；
 *   ② **突发合并（短去抖）**：`CAMERA_FLAG_DEBOUNCE_MS` 窗口内的多次触发只发"最后一次要查的线路"；
 *   ③ **短 TTL 缓存**（仅 `force=false` 命中）：同一线路的 flag 一次会话里极少变；点「重试」（`force=true`）永远绕过它。
 * ⚠️ 失败**不记账、不进缓存**（保持"未知 ⇒ 门禁继续拦"，E29 的恢复路径不变）；`force` 只绕过 ③，不绕过 ①。
 */
const CAMERA_FLAG_TTL_MS = 30_000
const CAMERA_FLAG_DEBOUNCE_MS = 80
/** 成功结果的短缓存（只缓存"拿到布尔 flag"的成功；key = lineId） */
const cameraFlagCache = new Map<string, { flag: boolean | null; error: string; atMs: number }>()
/** 在途请求（key = lineId）⇒ 并发调用复用同一个 Promise */
const cameraFlagInFlight = new Map<string, Promise<void>>()
/** 去抖定时器（跨实例共享） */
let cameraFlagTimer: ReturnType<typeof setTimeout> | null = null
/** 去抖窗口内"最后一次要查的线路"（+ 这批里是否有人要求 force） */
let cameraFlagQueued: { id: string; force: boolean } | null = null
/**
 * 最近注册的"真正去查一次"的实现（由 `useMpRealData()` 在 setup 时赋值）。
 * 各实例读写的都是同一批 `useState` 单例 ⇒ 谁执行都一样。
 */
let cameraFlagRunner: ((id: string, force: boolean) => Promise<void>) | null = null

/** ② 突发合并：把这一批触发压成"最后一次要查的线路"，窗口结束只执行一次（跨实例共享同一个定时器） */
function queueCameraFlag(id: string, force: boolean): void {
  cameraFlagQueued = { id, force: Boolean(cameraFlagQueued?.force) || force }
  if (cameraFlagTimer !== null) return
  cameraFlagTimer = setTimeout(() => {
    cameraFlagTimer = null
    const q = cameraFlagQueued
    cameraFlagQueued = null
    if (q && cameraFlagRunner) void cameraFlagRunner(q.id, q.force)
  }, CAMERA_FLAG_DEBOUNCE_MS)
}

export function useMpRealData() {
  // `setToken` 用于「恢复上次会话」时把缓存里的 token 写回会话（重建会话并落盘）
  const { session, clearSession, setToken } = useMpSession()
  const { setTask, setLines, task: currentTask, run, demoMode, disableDemo, clearLocalData } = useMpDemo()
  // 🆕 2026-09-23（pre3）：门禁的 `localGeometryReady` 要读本机路线库（与跑步页同一份状态）
  const lib = useTrackLibrary()

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
    // 🆕 2026-09-21（E）：自由跑入口标灰（"本机已知该校未开通自由跑任务"）
    freeRunUnsupported,
    clearFreeRunUnsupported,
    cacheAt,
    cachePaperName,
    cacheHasToken,
    cacheTokenMask,
    /** 🆕 2026-09-22：这次的任务是不是"从本机缓存自动恢复"来的（0 = 不是） */
    restoredAt,
    // 下面这几个是**提交期**状态；只读侧只在「一键清空本机数据」时负责复位
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    // 🆕 2026-09-21：提交过程清单（已从 submit.ts 的局部 ref 提为 ./state 的单例；清空本机数据时必须一起复位）
    submitProgress,
    clockTick,
  } = useRealState()

  // 只在客户端读一次缓存的元信息（用于显示"恢复上次任务"入口 / 自动恢复的判据）
  // ⚠️ 注意：本行**只同步界面状态**，不动任务；真正的自动恢复入口是下面的 `autoRestoreFromCache()`
  //    （由跑步页 / 跑道编辑页 / 非官方路径页在挂载时调用 —— 2026-09-22 真实用户实测后新增）。
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
    if (!list.length) {
      /**
       * 🆕 2026-09-22（issue #12）：**服务端未下发线路的任务**（自由路线任务，如"研途健行"）。
       *
       * 旧写法是直接 `return` —— 那会把**上一个任务/演示数据**的线路留在 `lines` 里（`setLines` 没被调用），
       * 而跑步引擎正是从 `lines` 里挑几何的 ⇒ 要么挑到不相干的旧线路，要么报"这条线路还没描过跑道"。
       * 现在的判据：**没有线路 ⇒ 明确清空**（线路集与选线都归零）；几何由跑步引擎回落到
       * 「本机第一条已描跑道」（`composables/demo/runner.ts` 的本地几何兜底，与"本任务不指定路线"一致）。
       */
      setLines([])
      run.value.lineId = ''
      return
    }
    setLines(list)
    // 选线优先级：① 显式指定（恢复缓存时）且仍有效 → 用它；
    //               ② **当前已选且仍在这条任务的线路里** → 保持不动（刷新后从缓存恢复的场景；
    //                  与跑步页那个 watch 的既有口径一致："已选线路仍在新列表里 → 保持不动"）；
    //               ③ 与本人校区同名的线路；④ 按坐标分组的本校区第一条
    //                  （不再盲选数据里的第一条 —— 实测数据第一条常在别的校区）。
    const campus = profile.value?.campusName || profile.value?.campusId || ''
    const valid = (id?: string) => (id && list.some((l) => String(l.pointId) === String(id)) ? String(id) : '')
    const preferred = campus ? list.find((l) => String(l.pointName ?? '').includes(campus)) : undefined
    const fallback = groupRoutesByCampus(list, campus).defaultLineId
    const chosen = valid(overrideLineId) || valid(String(run.value.lineId || '')) || preferred?.pointId || fallback
    if (chosen) run.value.lineId = chosen
  }

  /**
   * 🆕 2026-09-22（issue #12）：把"**解包退化**"这件事**同时**留痕到**应用内日志**与**服务端日志**。
   *
   * 为什么两边都要：
   *   · 应用内日志（`useEventLog`）会进诊断包的 `timeline` —— 用户导包时能带上；
   *   · 服务端日志（`%TEMP%\totoro-heaven-runtime\logs\app-*.log`）是诊断包的**主力证据**
   *     （用户不发 timeline 也能看到），而浏览器写不了它 ⇒ 走一个只在本机可用的极小接口
   *     `POST /api/local/task-unpack`（见 `server/api/local/task-unpack.post.ts`）。
   * ⚠️ 这是"尽力而为"的留痕：**失败只记一条 warn，绝不影响读取任务**（读取路径不该被日志拖垮）。
   */
  function noteUnpackDegraded(where: string, r: PaperTaskResolution, extra: Record<string, unknown> = {}): void {
    const info = {
      where,
      source: r.source,
      lineCount: r.lineCount,
      adoptedFrom: r.adoptedFrom || '(none)',
      candidates: r.candidates.join('>'),
      ...extra,
    }
    // ① 应用内日志（诊断包 timeline 会带上它）
    logWarn('real', `unpack degraded: sunrunPaper via ${r.source}`, info)
    // ② 服务端日志（只在本机、只发这几个非敏感字段）
    if (!import.meta.client) return
    void fetch('/api/local/task-unpack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'sunrunPaper', ...info }),
    }).catch((err: unknown) => {
      // 尽力而为：留痕失败不影响任务读取，但**不静默**（R8：可吞的异常要留痕）
      logWarn('real', '解包退化留痕到服务端失败（不影响读取）', {
        message: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * 读取真实账号 + 任务 + 线路（**只读**）。
   * 依次：学校基址 → 学生档案（snCode/campusId）→ getSunrunPaper（约束 + 线路）。
   * @param preferredLineId 优先沿用的选线（「恢复上次会话」时传入缓存里记住的那条）；
   *        不传则按"本人校区同名 → 坐标分组默认"自动选。
   */
  async function loadRealData(preferredLineId?: string): Promise<boolean> {
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
    /**
     * 🆕 2026-09-22（issue #12 的**正解**）：**解包兜底** —— 见 `utils/mp/taskUnpack.ts`。
     *
     * 规格（`getSunrunPaperResponseList#0`）没命中时（真实用户的响应就是这样），任务本体可能在
     * `data` / `sunrunTaskList[0]` / 顶层自己；不兜底就会把"有 1 条线路"读成"没线路"
     * （线路下拉为空 / 门禁说"尚未选择跑步线路" / 用户在「非官方路径」页白画）。
     *
     * ⚠️ 三条口径（**不许放松**）：
     *   ① 兜底只影响"**任务读没读到**"；开关 / 摄像头杆的"未知 ≠ 关闭"一个字不改；
     *   ② **明确失败（登录过期 / 业务失败）一律照旧报错** —— 绝不拿兜底把失败掩盖成成功；
     *   ③ 走了兜底**必须留痕**（应用内日志 + 服务端日志各一行），否则以后没人知道我们退化过。
     */
    const unpacked = resolvePaperTask(paper.raw)
    if (unpacked.degraded && unpacked.task) {
      noteUnpackDegraded('read', unpacked, {
        envelope: looksLikeEnvelope(paper.raw),
        verdict: paper.kind,
        specData: paper.data ? '(有)' : '(无)',
      })
    }
    const taskBody = unpacked.task
    /** 明确失败（登录态失效 / 业务失败）绝不用兜底掩盖；其余情况只要**解包拿到任务本体**就算成功 */
    const definiteFailure = paper.kind === 'expired' || paper.kind === 'business'
    if (!taskBody || definiteFailure) {
      status.value = 'error'
      error.value = `读取任务失败：${paper.message}（任务可能尚未下发）`
      logError('real', '读取任务失败', {
        message: paper.message,
        kind: paper.kind,
        unpackSource: unpacked.source,
        unpackCandidates: unpacked.candidates.join('>'),
      })
      return false
    }
    task.value = taskBody
    loadedAt.value = Date.now()
    status.value = 'ready'
    /**
     * 🆕 2026-09-22：**真的联网读成功了** ⇒ 清掉"本次是缓存恢复来的"标记（否则界面会一直挂着那句话）。
     */
    restoredAt.value = 0
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
    //    若调用方指定了优先选线（"恢复上次会话"沿用缓存里的选线），则按它来。
    applyToRunner(preferredLineId)

    if (import.meta.client) {
      // 存"任务 + 选线 + **token**"：token 进缓存是「恢复」能真正重建会话的前提（用户 2026-09-18 确认）
      writeCachePayload({
        at: loadedAt.value,
        task: task.value,
        lineId: String(run.value.lineId || ''),
        token,
      })
    }

    const selectedId = String(run.value.lineId || (task.value.runPointList ?? [])[0]?.pointId || '')
    if (selectedId) await refreshCameraFlag(selectedId, true)

    /**
     * 🆕 2026-09-22（用户原话："你刚刚说刷新后就丢了，我们直接丢之前记录下来不行吗"）：
     * **成功读取后立刻把"最近已知状态"写进 localStorage**（诊断证据）。
     *
     * 为什么在这里：这一刻刚好是"任务 + 开关 + 摄像头杆"三样都拿到手的时刻；
     * 用户随后刷新/关页会丢掉 `useState` 内存态，而这份证据能让诊断包说清
     * "最近一次读到开关是 <时刻>：<当时的判定>"（正是"读取后又跑不了"那个现场的证据）。
     *
     * 🔴 **它不参与任何放行判断**：门禁读的是 `switches.value` / `cameraFlag.value`（实时态），
     *    不是这份 `localStorage`。`evaluateRunGate()` / `submitRealRun()` 一个字都没改。
     *    旧值可以随时被学校改掉 ⇒ 用旧值放行等于用昨天的事实做今天的决定。
     */
    if (import.meta.client) {
      const snapshot = buildLastKnown({
        task: task.value as unknown as Record<string, unknown> | null,
        schoolCode: profile.value.schoolCode,
        schoolName: profile.value.schoolName,
        campusId: profile.value.campusId,
        campusName: profile.value.campusName,
        snCode: profile.value.snCode,
        studentName: profile.value.studentName,
        hasToken: Boolean(token),
        tokenFingerprint: '',
        switches: switches.value,
        cameraFlag: cameraFlag.value,
        cameraFlagLineId: cameraFlagLineId.value,
        cameraFlagError: cameraFlagError.value,
        lineId: String(run.value.lineId || selectedId || ''),
        /** 任务下发了线路 ⇒ 门禁那条"未选线路"适用；没下发 ⇒ 不适用（与 `routeRequirementOf()` 同口径） */
        lineRequired: (task.value.runPointList ?? []).length > 0,
        demoMode: demoMode.value,
      })
      if (snapshot && !saveLastKnown(snapshot)) {
        // 写不进去（配额/隐私模式）只留一行日志：诊断证据丢了不影响任何业务
        logWarn('ui', '「最近已知状态」写盘失败（诊断证据，不影响业务）', { at: snapshot.at })
      }
    }

    // 门禁终值（日志）：方便事后核对"为什么拦住 / 为什么放行"
    const gate = gateStatus.value
    if (gate.allow) logInfo('gate', '门禁通过（三类开关均无阻碍）', { blockedBy: gate.blockedBy ?? '' })
    else {
      logWarn('gate', `门禁拦住：${gate.reason}`, { blockedBy: gate.blockedBy ?? '' })
      /**
       * 🆕 2026-09-23（用户要求 2️⃣）：**"读到数据了但门禁不让提交"本身就是用户可感知的失败** ⇒ 显式记一条。
       *
       * ⚠️ 判据是 **`!gate.allow`（不看 `blockedBy` 是否为空）** —— 实测踩到：
       * 从本机缓存恢复任务、而缓存里没有开跑开关时，门禁停在"**尚未读取开关**"这个**软状态**
       * （`allow=false` 但 `blockedBy=''`），只判 `blockedBy` 会漏掉这一类 —— 而那恰是用户最常遇到的"点了不能跑"。
       *
       * 为什么也放在这里（`submit.ts` 的提交入口已记一条）：两条路径都要覆盖 ——
       * 用户可能**根本没点到提交按钮**（按钮 disabled / 页面在别处），此时 `submit.ts` 那条永远不会触发，
       * 而"提交从未发出"仍需要在包里是**明写的事实**（不靠"日志里没有写请求"反推）。
       * `data` 里只有**判定输入**，没有 token/身份原文（脱敏链路还会再兜一层）。
       */
      reportBlocked(gate.blockedBy ? 'gate-blocked-after-read' : 'gate-not-ready-after-read', gate.reason || '门禁未通过', {
        blockedBy: String(gate.blockedBy ?? ''),
        allow: Boolean(gate.allow),
        switchesFound: Boolean(switches.value),
        switchStartFace: String(switches.value?.sunrunStartFace ?? '-'),
        switchPointRandom: String(switches.value?.sunrunPointRandom ?? '-'),
        cameraFlag: cameraFlag.value === null ? 'unknown' : String(cameraFlag.value),
        cameraFlagLineId: String(cameraFlagLineId.value ?? ''),
        nowIso: new Date().toISOString(),
        tzOffsetMin: new Date().getTimezoneOffset(),
        source: 'after-read',
      })
    }
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
    // 「恢复」能否真正重建会话，取决于缓存里有没有 token（界面据此改文案；只放布尔与掩码，不放完整 token）
    cacheHasToken.value = Boolean(p?.token)
    cacheTokenMask.value = p?.token ? maskToken(p.token) : ''
  }

  /**
   * 🆕 2026-09-22（真实用户实测：**刷新后跑步页"变哑"**）：**自动**从本机缓存把任务恢复进内存。
   *
   * ## 为什么要它
   * 用户的现场（诊断包）：17:10 两次「读取真实数据」都成功、门禁也通过；之后他刷新/重开过页面
   * ⇒ `useState` 内存里的 task/profile/switches 全丢 ⇒ 跑步页只剩一句"请先读取真实账号和任务"，
   * 而他刚刚才读过 —— 于是以为程序坏了（反复撞上）。**本机明明存着上次读到的任务**，没理由不认。
   *
   * ## 口径（**只做"本机已知事实"的搬运，绝不联网、绝不编造**）
   *   · 判据：`shouldAutoRestoreFromCache()`（纯函数，有单测）—— 内存里已有任务 / 演示模式 / 没有缓存
   *     三者任一 ⇒ **什么都不做**；
   *   · 恢复的是**缓存里的任务本体**（信封会被 `restorePatchOf` 拆开，见 `utils/mp/realCache.ts`）、
   *     当时的选线、以及缓存里的 token（没有 token 就只恢复任务，界面会说明"要真提交得先重新读取"）；
   *   · **开跑开关（人脸/抽查）与摄像头杆不在缓存里**（缓存只存 task/lineId/token，见 realCache 的说明）
   *     ⇒ `gateStatus` 会如实停在 `switches_unknown`。界面必须**明说这一点**并给一键「重新读取」，
   *     而不是假装门禁已经通过。
   *   · 幂等：多次调用只在"内存里没有任务"时生效。
   *
   * @returns `true` = 这次调用真的恢复了（界面可据此提示）
   */
  function autoRestoreFromCache(): boolean {
    if (!import.meta.client) return false
    const raw = (() => {
      try {
        const s = localStorage.getItem(TASK_CACHE_KEY)
        return s ? JSON.parse(s) : null
      } catch {
        /* 缓存损坏（JSON 解析失败）：当作没有缓存，静默降级 */
        return null
      }
    })()
    const patch = restorePatchOf(raw)
    const should = shouldAutoRestoreFromCache({
      hasTaskInMemory: Boolean(task.value),
      demoMode: Boolean(demoMode.value),
      hasCache: Boolean(patch),
    })
    if (!should || !patch) return false

    // ① token 兜底：会话里没有、而缓存里有 ⇒ 写回会话（与显式「恢复」同一口径，只是不联网）
    if (patch.token && !String(session.value?.token ?? '')) {
      setToken(patch.token)
      logInfo('real', '已从本机缓存恢复 token（重建会话，未联网）', { tokenLen: patch.token.length })
    }
    // ② 任务本体 + 读取时刻 + 选线
    /**
     * 🆕 2026-09-22（issue #12）：缓存里的 `task` **本身也可能被包着**（信封 / 平铺任务元素）
     * ⇒ 再用**同一个**解包器取一次本体（`utils/mp/taskUnpack.ts`，与联网读取那条路同源）。
     * 判据：只有真的取到本体才用它；取不到就沿用 `restorePatchOf` 已经解析出来的那份。
     */
    const cachedUnpack = resolvePaperTask(patch.task)
    const taskBody = cachedUnpack.task ?? patch.task
    /**
     * 留痕判据（与**读取路径**有意不同）：缓存里存的本来就是"已经解包过的任务本体"
     * ⇒ `source === 'self'` 是**正常形态**，不许刷"解包退化"的日志（否则每次刷新都会留一行假证据）。
     * 只有真的换了层（`adoptedFrom`）或缓存里躺着的其实是信封（`source` 指向 `data` 等）才留痕。
     */
    if (cachedUnpack.task && (cachedUnpack.adoptedFrom || cachedUnpack.source !== 'self')) {
      noteUnpackDegraded('cache', cachedUnpack, { envelope: looksLikeEnvelope(patch.task) })
    }
    task.value = taskBody
    loadedAt.value = patch.loadedAt || Date.now()
    status.value = 'ready'
    error.value = ''
    restoredAt.value = patch.loadedAt || Date.now()
    applyToRunner(patch.lineId || undefined)
    logInfo('real', '已从本机缓存自动恢复任务（未联网）', {
      paperName: taskBody.paperName,
      lines: taskBody.runPointList?.length ?? 0,
      unpackSource: cachedUnpack.source,
      lineId: patch.lineId || '(按默认选线)',
      hasToken: Boolean(patch.token || session.value?.token),
      readAt: patch.loadedAt ? new Date(patch.loadedAt).toLocaleString('zh-CN') : '(未记录)',
    })
    logWarn('gate', '开跑开关不在缓存里：门禁会停在"尚未读取开关"，真实提交前请点「重新读取」')
    return true
  }

  /** 把当前选中的线路写回缓存（用户换线路时调用；"恢复上次任务"时保持选线） */
  function persistSelectedLine(): void {
    if (!import.meta.client) return
    const p = readCachePayload()
    if (!p) return
    writeCachePayload({ ...p, lineId: String(run.value.lineId || '') })
  }

  /** 统一写缓存（**任务 + 选线 + token**，见 `utils/mp/realCache.ts` 的说明） */
  function writeCachePayload(p: { at: number; task: MpSunrunTask | null; lineId: string; token: string }): void {
    if (!import.meta.client || !p.task) return
    try {
      localStorage.setItem(TASK_CACHE_KEY, serializeCachePayload({ ...p, task: p.task }))
      syncCacheState() // 同步"可恢复上次任务"的界面状态（否则要等下次刷新才显示）
    } catch {
      /* 忽略配额错误 */
    }
  }
  /**
   * 「恢复上次会话」= **用缓存里的 token 重建会话 → 自动重新读取**（2026-09-18 用户确认的最终语义）
   *
   * 用户原话："把那个恢复任务搞成恢复成 token 然后自动吧"。三轮迭代后的结论：
   * 只要 token **不在缓存里**，这个按钮就永远只是个"检查有没有 token"的触发器 ——
   * `localStorage['mp_session']` 一旦被清（退出登录 / 清浏览器数据 / 换浏览器）就**救不回来**，
   * 用户实测正是被这一点卡住（"为什么无法恢复？"）。
   *
   * 现在的三段：
   *   ① 取"可用 token"：**会话里的优先，没有就用缓存里存的兜底**，
   *      并把兜底来的 token **写回会话**（这一步才是真正的"恢复会话"）；
   *   ② 有 token ⇒ `loadRealData()` 全链路重新读取（账号 / 任务 / 线路 / 开关 / 摄像头杆），
   *      并**沿用缓存里记住的那条选线**；
   *   ③ 连缓存里也没有 token（老缓存 / 首次使用）⇒ 写一条**可操作**的提示，返回 false。
   *
   * 返回 `true` = 已发起重新读取（异步）；`false` = 缺 token（`error` 里已写好提示）。
   */
  function restoreCachedTask(): boolean {
    const payload = readCachePayload()
    const cachedLineId = payload?.lineId ?? ''
    const inSession = String(session.value?.token ?? '')
    const fromCache = String(payload?.token ?? '')
    const usable = (t: string) => Boolean(t) && !t.startsWith('demo-')

    let token = ''
    let source = ''
    if (usable(inSession)) {
      token = inSession
      source = 'session'
    } else if (usable(fromCache)) {
      token = fromCache
      source = 'cache'
      // ① 真正的"恢复"：把缓存里的 token 写回会话（`setToken` 内部会 persist 落盘）
      setToken(token)
      logInfo('real', '已从本机缓存恢复 token（重建会话）', { tokenLen: token.length })
    }

    if (!token) {
      status.value = 'error'
      error.value =
        '本机没有可用的 token（缓存里也没有），无法重新读取 —— 请先点「一键获取 token」（或在上方粘贴 token），之后再点「恢复」即可。'
      logWarn('real', '恢复失败：会话与缓存里都没有可用 token')
      return false
    }

    logInfo('real', '恢复上次会话：重新读取真实数据', { tokenLen: token.length, source, cachedLineId })
    void loadRealData(cachedLineId || undefined)
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
   * 🆕 2026-09-23（用户要求 3️⃣）：清**服务端**的"响应原文留档"（captures）。
   *
   * 为什么走端点：captures 在**服务端进程**的目录里（`<运行时目录>/captures`），composable 碰不到文件系统；
   * 于是按既有 `/api/local/**` 方式调 `POST /api/local/diagnostics/captures/clear`。
   *
   * ⚠️ **尽力而为**：任何失败（服务端没起来、网络、权限）都只记一条日志 ——
   * **绝不能让"清不掉一份诊断留档"把"退出登录/清空本机数据"本身搞失败**。
   */
  async function clearServerCaptures(reason: 'logout' | 'clearAll'): Promise<void> {
    try {
      const res = await fetch('/api/local/diagnostics/captures/clear', { method: 'POST' })
      if (!res.ok) {
        logWarn('ui', '清空服务端响应原文留档失败（不影响退出/清空本身）', { reason, http: res.status })
        return
      }
      const data = (await res.json().catch(() => ({}))) as { files?: unknown }
      logInfo('ui', '已清空服务端响应原文留档', { reason, files: Number(data?.files ?? 0) })
    } catch (err) {
      logWarn('ui', '清空服务端响应原文留档失败（不影响退出/清空本身）', { reason, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * **退出登录（清除会话）** —— 必须是"彻底的"，所以**连缓存里的 token 一起清**。
   *
   * ⚠️ 2026-09-18 修（发布前审计 S1）：此前顶栏与工作台的"清除会话"只 `clearSession()`
   * （删掉 `localStorage['mp_session']`），而**缓存里那份完整 token 还在** ⇒ 点「恢复」就能一键登回去。
   * 用户点"退出登录"却仍留着凭据，是**安全语义上的真 bug**，也与 `utils/mp/realCache.ts` 自己写的
   * 不变量（"退出登录 / 清空本机数据时两份一起清"）矛盾。
   *
   * 与"浏览器自己清了 `mp_session`"的区别（两点都成立，互不冲突）：
   *   · **用户显式退出** ⇒ 走本函数 ⇒ 凭据从本机**彻底消失**；
   *   · 浏览器/系统清理导致 `mp_session` 消失（用户没点退出）⇒ 缓存里的 token 仍可救回来，
   *     这正是「恢复（重建会话并读取）」存在的意义。
   */
  function logoutAndClearSession(): void {
    clearSession()
    clearCachedTask()
    // 让界面回到"干净"状态：退出后不该继续显示"真实任务已就绪"（审计 S1 顺带指出的不一致）
    task.value = null
    profile.value = null
    switches.value = null
    cameraFlag.value = null
    cameraFlagLineId.value = ''
    cameraFlagError.value = ''
    loadedAt.value = 0
    status.value = 'idle'
    error.value = ''
    // 🆕 2026-09-22：退出登录也要清掉"本次是缓存恢复来的"标记（否则换账号后还挂着上一条恢复提示）
    restoredAt.value = 0
    // ⚠️ 任务/线路也要从跑步机侧清掉，否则阳光跑页还留着上一次的线路
    clearLocalData()
    // 🆕 2026-09-21 审计修复（B2）："该校未开通自由跑"的标记也属于本机缓存 ——
    // 退出登录/换账号后必须一起清掉，否则换了学校还会被标灰（`useState` 单例在 SPA 内也不会自己复位）
    clearFreeRunUnsupported()
    /**
     * ⚠️ 2026-09-21 审计修复（B2）：**过程清单也一起清**（与「清空本机数据」对称）。
     * 原先只在「清空本机数据」里清，退出登录不清 —— 但退出已经把 `result`、线路、本机数据都清了，
     * "回看"其实只剩一份**无主**清单：换账号后跑步页会显示**上一个账号**的六步过程、结果卡却是空的（自相矛盾）。
     */
    submitProgress.value = []
    /**
     * 🆕 2026-09-22 审计 B8：**「最近已知状态」也要清**（与 `TASK_CACHE_KEY` 同等对待）。
     * 不清的后果：换账号后上一个账号的掩码身份/开关/任务名仍留在 `mp_diag_last_known_v1`，
     * 新账号读取失败时会被当"最近已知状态"打进诊断包 ⇒ **跨账号证据污染**（维护者会拿 A 的开关分析 B 的问题）。
     */
    clearLastKnown()
    /**
     * 🆕 2026-09-23（用户要求 3️⃣）：**服务端的"响应原文留档"（captures）也要清**。
     * 它里面是**每个请求的完整响应原文**（已脱敏，但仍属上一个账号的证据）⇒ 与 `clearLastKnown()` 同等对待。
     * 走 `/api/local/**`（captures 在服务端进程的目录里，composable 碰不到文件系统）；
     * **尽力而为**：请求失败只记一条日志，**绝不影响退出登录本身**（`void` + `catch`）。
     */
    void clearServerCaptures('logout')
    logInfo('real', '已退出登录并清除本机缓存（含缓存中的 token）')
  }

  /**
   * **一键清空本机数据**（界面按钮）：会话 token + 任务/线路/开关/记录 + 跑步机状态 + "上次任务"缓存。
   * 清完后界面回到全新状态（需要重新粘贴 token 并读取）。
   */
  function clearAllLocalData(): void {
    clearSession()
    clearLocalData() // useMpDemo：任务/线路/开关/记录/跑步机 + 退出演示
    clearCachedTask()
    // 🆕 2026-09-21 审计修复（B2）：一并清掉"该校未开通自由跑"的标记（见 logoutAndClearSession 的说明）
    clearFreeRunUnsupported()
    profile.value = null
    task.value = null
    status.value = 'idle'
    error.value = ''
    loadedAt.value = 0
    // 🆕 2026-09-22：清空本机数据后，界面上不该再挂着"已从本机缓存恢复…"那句话
    restoredAt.value = 0
    switches.value = null
    cameraFlag.value = null
    cameraFlagLineId.value = ''
    cameraFlagError.value = ''
    phase.value = 'idle'
    phaseMessage.value = ''
    remainingSeconds.value = 0
    result.value = null
    // 🆕 2026-09-21：提交过程清单也是本机数据 —— 不一起清，界面上会残留"上一次提交的过程"
    // （它现在是 `./state` 的单例，退出登录时**不清**：退出不必抹掉过程清单，用户可能还想回看）
    submitProgress.value = []
    /**
     * 🆕 2026-09-22 审计 B8：「最近已知状态」同样是本机数据 ⇒ **一键清空必须连它一起清**，
     * 否则"清空后"的诊断包里还带着清空前的开关/身份证据（与"清空"两字自相矛盾）。
     */
    clearLastKnown()
    /**
     * 🆕 2026-09-23（用户要求 3️⃣）：**服务端的 captures 也一起清**（"清空"两字必须名副其实：
     * 清空后导出的包里不该还带着清空前的**响应原文**）。同样尽力而为，失败不影响清空流程。
     */
    void clearServerCaptures('clearAll')
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
   * 🔴 2026-09-24（用户实测：`getCameraConfig` 在 **0.21 秒内被打了 21 次**，全是同一条线路、全部 200）：
   * 摄像头杆开关的查询做**三重收口**（只收口"怎么读"，**判据一个字不改**）：
   *
   *   ① **在途复用**：同一 `lineId` 正在请求中 ⇒ 后来者复用**同一个 Promise**（不再重复发请求）；
   *   ② **突发合并（短去抖）**：`CAMERA_FLAG_DEBOUNCE_MS` 窗口内的多次触发只发**最后一次要的那条线路**
   *      —— 触发源本来就会成批（`watch([status, run.lineId, session.token])` 的 immediate + `loadRealData`
   *      里 `force=true` 的重查 ⇒ 原先"在途期间再来的全部通过检查、全部发请求"）；
   *   ③ **短 TTL 缓存**（`CAMERA_FLAG_TTL_MS`，仅 `force=false` 命中）：一次会话里同一线路的 flag 极少变，
   *      切换页面/缓存回填不再重复问；用户点「重试」（`force=true`）**永远绕过缓存**重查 ✓。
   *
   * ⚠️ **失败仍然不记账**（保持"未知 ⇒ 门禁继续拦"的老语义，E29 的恢复路径不变），也**不进缓存**
   *    （失败必须可重试）；`force` 只绕过 ③ 的缓存，**不绕过** ①：同一 tick 内的多个 force 也合并成 1 次。
   *
   * ⚠️⚠️ 调度状态（缓存/在途表/定时器/队列）**定义在模块级**（见文件上方 `cameraFlagCache` 那段注释）：
   *     放在函数里会"每个 `useMpRealData()` 实例一套" ⇒ 成批触发仍然重复发请求（实测挂载一次 3 次 = 实例数）。
   */

  /** 真正发请求那一段（在途复用/去抖都在 `refreshCameraFlag()` 里做完，这里只管"发一次"） */
  async function fetchCameraFlagOnce(id: string, force: boolean): Promise<void> {
    // 让模块级的去抖回调能调到"本实例的实现"（各实例的 refs 都是同一批 useState 单例 ⇒ 等价）
    cameraFlagRunner = fetchCameraFlagOnce
    const token = session.value?.token
    if (!id || !token) return
    // ③ 短 TTL 缓存（force 绕过）
    const hit = cameraFlagCache.get(id)
    if (!force && hit && Date.now() - hit.atMs < CAMERA_FLAG_TTL_MS) {
      cameraFlag.value = hit.flag
      cameraFlagLineId.value = id
      cameraFlagError.value = hit.error
      return
    }
    // ① 在途复用
    const inFlight = cameraFlagInFlight.get(id)
    if (inFlight) return inFlight
    const task = (async () => {
      const cam = await MpApiWrapper.call<Record<string, unknown>>(
        'cameraConfig',
        { lineId: id, token },
        { token, baseUrl: session.value?.baseUrl },
      )
      if (!cam.ok) {
        // 失败：保持"未知"（门禁继续拦），但**不记 lineId、不进缓存**，以便下次重试
        cameraFlag.value = null
        cameraFlagLineId.value = ''
        cameraFlagError.value = `读取该线路的摄像头杆开关失败：${cam.message}`
        logWarn('gate', '摄像头杆开关读取失败', { lineId: id, message: cam.message })
        return
      }
      /**
       * ⚠️ 2026-09-20 审计修复（**响应回验**）：快速切线路时 A 的响应可能晚于 B 到达，
       * 原先会无条件把 `cameraFlag`/`cameraFlagLineId` 写成 A 的 ⇒ 而当前选中的是 B
       * ⇒ 门禁判 `flagLineId !== lineId`、一直显示"当前线路的摄像头杆开关尚未读取"，
       * 而且 watcher 的依赖不含 `cameraFlagLineId`，不会自动纠正（用户只能手动「重新读取」）。
       * 判据：**异步响应回来时必须确认"它还是当前这条线路的"**，不是就丢弃。
       */
      const currentId = String(run.value.lineId || selectedLine.value?.pointId || '')
      if (currentId && currentId !== id) {
        logWarn('gate', '摄像头杆开关的响应已过期（线路已切换），丢弃该结果', { requested: id, current: currentId })
        return
      }
      const flag = (cam.data as Record<string, unknown> | undefined)?.flag
      cameraFlag.value = typeof flag === 'boolean' ? flag : null
      cameraFlagLineId.value = id
      cameraFlagError.value =
        typeof flag === 'boolean' ? '' : `该线路的 getCameraConfig 未返回布尔 flag（实际 ${JSON.stringify(flag)}），按"未知"处理`
      // 只缓存成功结果（失败不进缓存 ⇒ 下次仍会重试）
      cameraFlagCache.set(id, { flag: cameraFlag.value, error: cameraFlagError.value, atMs: Date.now() })
      logInfo('gate', `摄像头杆开关：${cameraFlag.value === true ? '启用（会拦）' : cameraFlag.value === false ? '未启用（放行）' : '未知'}`, {
        lineId: id,
        flag: cameraFlag.value,
      })
    })().finally(() => cameraFlagInFlight.delete(id))
    cameraFlagInFlight.set(id, task)
    return task
  }

  /**
   * 查询某条线路的摄像头杆开关（只读；换线路时由 watch 自动跟随）。
   *
   * ⚠️ 2026-09-15 修 bug：**只有请求成功才记 `cameraFlagLineId`**。
   *    原实现在请求失败时也把该线路标记为"已查询"，而本函数开头又用
   *    `id === cameraFlagLineId.value` 做去重 → **一次失败就永久不再重试**，
   *    门禁会一直显示"摄像头杆尚未读取"，必须刷新页面才能恢复。
   * 🔴 2026-09-24：本函数现在只做"**要不要发、合并成几次**"的调度（①在途复用 ②突发合并 ③短缓存），
   *    真正发请求在 `fetchCameraFlagOnce()`。
   * @param force 忽略幂等去重与短缓存、强制重查（界面"重新读取"按钮用）
   */
  function refreshCameraFlag(lineId?: string, force = false): Promise<void> {
    const id = lineId || (task.value?.runPointList?.[0]?.pointId ?? '')
    if (!id || !session.value?.token) return Promise.resolve()
    // 幂等（老行为）：已经读过这条线路 ⇒ 不再发
    if (!force && id === cameraFlagLineId.value) return Promise.resolve()
    // ① 已经有这条线路的请求在途 ⇒ 直接复用（force 也复用：一批触发只发一次）
    const inFlight = cameraFlagInFlight.get(id)
    if (inFlight) return inFlight
    /**
     * ② 突发合并（**模块级**去抖：跨所有 `useMpRealData()` 实例共用同一个窗口与同一条"最后要查的线路"）。
     * 注册本实例的实现，供窗口结束时执行（各实例的 refs 是同一批 `useState` 单例 ⇒ 等价）。
     */
    cameraFlagRunner = fetchCameraFlagOnce
    queueCameraFlag(id, force)
    // 触发方一律 fire-and-forget（现有调用点全是 `void`）；要等待结果的调用方走的是上面的在途复用分支
    return Promise.resolve()
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
      /**
       * 🆕 2026-09-22（issue #12）：**本任务是否要求指定线路** —— 判据收口到纯函数
       * `routeRequirementOf()`（`utils/mp/taskShape.ts`，有单测）。
       *
       * 为什么不传就会误拦：任务本身**服务端未下发线路**（`runPointList` 缺失/为空，如"研途健行"）时，
       * `selectedLine` 必然是空的 ⇒ 门禁判 `camera_unknown`（"尚未选择跑步线路"）⇒ 真实提交永远灰着。
       * 而"没选线路"在这里是**必然结果**，不是用户的疏忽 —— 那是我们自己造出来的一个要求。
       * ⚠️ 传 `false` 只放宽"线路"这一条：开关/人脸/抽查/夜间一律照旧拦（见 `evaluateRunGate`）。
       */
      lineRequired: routeRequirementOf(task.value).kind === 'line',
      /**
       * 🆕 2026-09-23（pre3）：**本机有没有可用的本机路径几何**（只有"服务端未下发线路"的任务才有意义）。
       * 判据与跑步页/引擎**同一处**：`freeRouteGeometryChoice()`（算法层）⇒ 界面那条"一键去画一条"的提示
       * 与门禁的 `no_local_geometry` 警告不会分叉。严格模式下这一条会拦（放宽模式下只提示）。
       */
      localGeometryReady: Boolean(
        // ⚠️ 任务"身份"走兜底链（他这份响应没有 `taskId`，只有 `id`/`paperId`）
        freeRouteGeometryChoice(lib.entries.value, task.value, lib.freeRouteChoiceFor(taskPaperIdOf(task.value))).entry,
      ),

      /**
       * ⚠️ 必须带上**本次跑步类型**（2026-09-18 自由跑落地）：
       * 自由跑不选线路、也不校验"开场人脸/随机抽查/摄像头杆"（厂商的自由跑**不打卡**）。
       * 不带这个参数时 `line` 恒为空 ⇒ 门禁判 `camera_unknown` ⇒ "真实提交"按钮永远灰着。
       */
      runType: run.value.runType === 0 ? 0 : 1,
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
    /** 🆕 2026-09-21（E）：本机已知"该校未开通自由跑任务"（自由跑真实提交入口标灰） */
    freeRunUnsupported,
    /** 清除该标记（"仍要试一次"） */
    clearFreeRunUnsupported,
    selectedLine,
    /** 开跑前三合一否决门禁状态（allow / reason / blockedBy） */
    gateStatus,
    /** 未验证学校的软提示（非阻断） */
    schoolNotice,
    isRealApplied,
    // 动作
    loadRealData,
    /**
     * **显式恢复**"上次读取的任务"：用缓存里的 token 重建会话 → **联网**全链路重新读取。
     * ℹ️ 2026-09-22 起，跑步页/跑道编辑页挂载时还会先做一次 `autoRestoreFromCache()`（**不联网**）——
     *    所以刷新后页面不再"变哑"；本函数仍是"要把开跑开关/摄像头杆也读回来"时必须点的那一步。
     */
    restoreCachedTask,
    /** 是否存在可恢复的上次任务 */
    hasCachedTask,
    cachedTaskLabel,
    /** 缓存里是否存了 token（决定「恢复」能否重建会话）+ 其掩码（仅供显示，不含完整 token） */
    cacheHasToken,
    cacheTokenMask,
    /** 🆕 2026-09-22：这次的任务是不是"从本机缓存自动恢复"来的（值是那次读取的时刻，0 = 不是） */
    restoredAt,
    clearCachedTask,
    /** 退出登录（彻底）：清会话 + **连缓存里的 token 一起清** + 复位界面状态（审计 S1） */
    logoutAndClearSession,
    /** 一键清空本机数据（会话 + 任务 + 记录 + 缓存） */
    clearAllLocalData,
    applyToRunner,
    /**
     * 🆕 2026-09-22（真实用户实测）：**从本机缓存自动恢复任务**（不联网、幂等）——
     * 由跑步页/跑道编辑页/非官方路径页在挂载时调用；判据见 `shouldAutoRestoreFromCache`。
     */
    autoRestoreFromCache,
    persistSelectedLine,
    refreshCameraFlag,
    retryCameraFlag,
  }
}
