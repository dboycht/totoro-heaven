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
// 🆕 2026-09-22（issue #12）：门禁要按"任务到底要不要求线路"来判（纯函数，与只读侧 `gateStatus` 同源）
// 🔴 2026-09-23（pre3）：任务号也走兜底链（厂商响应可能只有 paperId/id，没有 taskId）
import { routeRequirementOf, taskPaperIdOf } from '~/utils/mp/taskShape'
// 🆕 2026-09-23（pre3）：门禁还要判"本机有没有可用几何"（同一判据 `freeRouteGeometryChoice`）
import { freeRouteGeometryChoice } from '~/utils/mp/trackLibrary'
// 🔴 2026-09-23（pre3 实测事故）：提交前的**上下文校验**收口到纯函数（任务号兜底链 / 自由路线任务必须放行）
import { evaluateSubmitContext } from '~/utils/mp/submitContext'
import { TOKEN_EXPIRED_HINT } from '~/utils/mp/tokenScan'
import { looksLikeTokenExpired } from '~/src/mp/envelope'
import { logError, logEvent, logInfo, logWarn } from '../useEventLog'
// 🆕 2026-09-23（用户要求 2️⃣）：被本地门禁/上下文检查拦下的提交要**显式上报**（诊断包里"明写的事实"）
// 🆕 2026-09-23（pre3 要求 3️⃣）：**放宽放行**（本该拦住但只警告）也要逐条上报，便于从包里看出"这笔是在放宽状态下提交的"
import { newEventId, reportBlocked, reportDiagEvent } from '../useDiagEventReporter'
// 写操作"结果未知"的判定与措辞（2026-09-21 修 issue #11：超时 ≠ 失败，必须核实）
import type { WriteOutcome } from '~/utils/mp/writeOutcome'
// 提交过程清单的文案（2026-09-21 用户要求"要能看到现在在传什么"）
import {
  SUBMIT_PROGRESS,
  submitProgressLine,
  type SubmitProgressKind,
} from '~/utils/mp/submitProgress'
// 🆕 2026-09-21（E 自由跑入口标灰）："是不是未开通自由跑"的判据在纯逻辑层（单一来源）
import { isFreeRunUnsupportedMessage } from '~/utils/mp/freeRun'
// 🆕 2026-10-07（用户要求）：服务端"今日该任务次数已达上限"的判据与人话文案（纯逻辑层，单一来源）
import { dailyQuotaNotice, dailyQuotaProgressNote, isDailyQuotaReachedMessage } from '~/utils/mp/dailyQuota'
// 🆕 2026-10-07（实测事故）：待补交轨迹的文案；成绩成功即落盘、明细成功才清除
import { pendingDetailProgressNote, type PendingDetail } from '~/utils/mp/pendingDetail'
// 🆕 2026-10-07（用户要求）：本机记录三态 —— 真实提交后**认领**那一条并写回真实场次号/服务端判定
import { applyServerVerdict, claimRecordForRealSubmit, setRecordDetailOk } from '~/utils/mp/recordState'
// 🆕 2026-10-08（用户要求，防 kill 的第二个边界）：跨进程续跑 —— 挂起作业摘要的**共享形状**
//   （定义在算法层：装配层不许直接 import `server/`，见守卫 R6 与 `utils/mp/runResume.ts` 的说明）
import type { SuspendedJobSummary } from '~/utils/mp/runResume'
import { useRealState, type RealSubmitResult } from './state'

export function useMpRealSubmit() {
  const { session } = useMpSession()
  const { profile, task, switches, cameraFlag, cameraFlagLineId, phase, phaseMessage, remainingSeconds, result, submitProgress, markFreeRunUnsupported, markDailyQuotaReached, pendingDetail, savePendingDetail, clearPendingDetail, patchPendingDetail, pendingResume, savePendingResume, clearPendingResume, suspendedJob } =
    useRealState()
  /**
   * 🆕 2026-10-07：改写**本机记录**（认领"已真实提交"、写回场次号与判定）。
   * ⚠️ 本机记录的 owner 是 `composables/demo/records.ts`（`useState('mpDemoRecords')`）——
   *    这里只借用它暴露的 `mutateRecords`（套纯函数 + 落盘），**不自己另起一份 state**。
   */
  const { mutateRecords } = useMpDemo()
  // 🆕 2026-09-23（pre3）：门禁的 `localGeometryReady` 与跑步页/引擎读同一份本机路线库状态
  const lib = useTrackLibrary()

  // ---------- 真实提交 ----------

  /**
   * **提交过程清单**（2026-09-21 用户要求："要能看到现在在传什么"）。
   * 每步都记一行（时间 + 图标 + 文案），六步：① 门禁 → ② 建场次 → ③ 真实等待 → ④ 成绩 → ⑤ 轨迹 → ⑥ 判定。
   * ⚠️ 超时分支（issue #11 的修复）也要**看得见**：超时 → 结果未知 → 核实 → 已入库/无法确认。
   * 文案与格式全部来自纯函数 `utils/mp/submitProgress.ts`（有单测）。
   *
   * ⚠️ 2026-09-21：清单本体**不再是本文件的局部 ref**，而是 `./state` 里的 `useState` 单例
   * （原先每个 `useMpRealSubmit()` 调用点各一份 ⇒ 换页就丢、清空本机数据也清不掉）。
   * 这里只负责往里打点：读写在下面统一用 `submitProgress.value`。
   */
  const pushProgress = (kind: SubmitProgressKind, text: string) => {
    submitProgress.value = [...submitProgress.value, submitProgressLine(kind, text)].slice(-40)
  }

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
    /** 阳光跑必填；**自由跑传 null**；**服务端未下发线路的任务也传 null**（任务号由 `paperId` 兜底） */
    line: MpRunLine | null
    /**
     * 🆕 2026-09-22（issue #12）：**任务号兜底**（任务自身的 `taskId`）。
     *
     * 只在"没有线路"时生效（有线路时 `buildRunBeginRequest` / `buildScoreRequest` **以线路为准**，
     * 传了也会被忽略 ⇒ `kind === 'line'` 的老路径行为一字不变）。
     *
     * 依据：`MpRunLine.taskId` 与任务 `taskId` **实测同值**（`src/mp/models.ts` 字段注释、9-14 实测），
     * 所以服务端未下发线路时用任务号不是发明新值，而是取同一事实的另一个来源；
     * 反之若传空串，成绩会挂在"没有任务号"上，服务端无从归属。
     */
    paperId?: string
    runType?: 0 | 1
    points: { latitude: string | number; longitude: string | number }[]
    km: number
    fitDegree: number
    plannedSeconds: number
    /**
     * 🆕 2026-10-07（用户要求）：本次结算的时刻（= 本机记录的 `settledAtMs`）。
     * 用途：真实提交成功后**认领**那条本机记录，把真实场次号写回去（记录页据此区分
     * "已真实提交 / 仅本地结算 / 演示"）。缺省 ⇒ 认领不到，只影响记录页的标注，不影响提交。
     */
    settledAtMs?: number
  }): Promise<RealSubmitResult | null> {
    /**
     * ⚠️ **并发互斥（2026-09-19 审计 S2，2026-09-20 审计补 `begin`）**：本函数**会创建服务端场次**
     * （非幂等写），而它内部的 `waitTimer` 是**闭包级单变量** —— 第二次调用会把第一次的计时器清掉，
     * 于是第一次的等待 Promise **永不 resolve**（既不发提交、也不报错，`phase` 卡死）。
     *
     * 🔴 2026-09-20 修：原判据只有 `waiting|submitting`，**漏了 `'begin'`** ——
     * `phase='begin'` 时正在 await `getRunBegin`（最长 15 s），这段时间里第二次调用能穿过互斥
     * ⇒ **服务端被建出两个场次**，且第二次的 `stopWait()` 会清掉第一次的计时器 ⇒ 第一次永久卡住。
     * 判据：**互斥的相集合必须等于"函数在途"的真实相集合**（begin/waiting/submitting 三态都算在途）。
     */
    if (phase.value === 'begin' || phase.value === 'waiting' || phase.value === 'submitting') {
      return null
    }
    /**
     * ⚠️ 2026-09-21（冗余加固）：**入口先把过程清单清空**。
     * 原先清空发生在"门禁检查"那一段、而这之前还有若干提前 `return`（缺会话/缺任务等）⇒
     * 那些分支会把**上一次的步骤**留在面板上、配一条新错误，看起来像"上次的错"。
     */
    submitProgress.value = []
    const token = session.value?.token
    const runType: 0 | 1 = input.runType === 1 ? 1 : 0
    const freeRun = runType === 1
    /**
     * 🆕 2026-09-22（issue #12）：**本次任务要不要求线路**（纯函数判据，与只读侧 `gateStatus` 同一处口径）。
     * · `kind: 'line'` ⇒ 服务端下发了线路列表：没选线路依旧拦（**老行为不变**）；
     * · `kind: 'free'` ⇒ 服务端未下发线路（自由路线任务）：没有线路是必然的，不该因此拦。
     */
    const lineRequired = routeRequirementOf(task.value).kind === 'line'
    /**
     * 🔴 2026-09-23（pre3 实测事故）：**前置上下文校验**收口到纯函数 `evaluateSubmitContext()`。
     *
     * 老代码在这里内联了五条判据，其中 `!freeRun && !lineRequired && !input.line && !paperId` 里
     * `paperId` 只取 `task.taskId` —— 而用户那份任务响应**顶层没有 `taskId`**（只有 `id`/`paperId`）
     * ⇒ 取到空串 ⇒ 明明"会话/任务/门禁"都齐了，却在**最后一步**被拦，`getRunBegin` 一个都没发出去。
     * 现在：任务号走**兜底链** `taskId → paperId → id`（`taskPaperIdOf()`），且"自由路线任务 + 有任务"
     * **必须放行**；真正必须拦的只剩「会话/档案缺」「任务缺」「任务号三者皆空」「指定了线路却没选」。
     * 提示一律**指路**（"回工作台读取真实账号与任务"），不再笼统说"缺少…"。
     */
    const ctx = evaluateSubmitContext({
      token,
      hasProfile: Boolean(profile.value),
      runType,
      task: task.value,
      lineRequired,
      line: input.line,
      paperId: input.paperId,
    })
    if (!ctx.ok) {
      phase.value = 'error'
      phaseMessage.value = ctx.message
      /** 🆕 2026-09-23（用户要求 2️⃣）：这也是"提交从未发出"的一种，显式记一条（原因 + 判定输入摘要） */
      reportBlocked('missing-context', ctx.message, {
        reasonCode: ctx.reasonCode,
        hasToken: Boolean(token),
        hasProfile: Boolean(profile.value),
        hasTask: Boolean(task.value),
        lineRequired,
        hasLine: Boolean(input.line),
        freeRun,
        hasPaperId: Boolean(ctx.paperId),
      })
      return null
    }
    /** 最终采用的任务号（兜底链结果；自由路线任务提交时靠它归属成绩） */
    const paperId = ctx.paperId

    // ⓪ 三合一否决门禁（必须在任何写操作之前）—— 含"夜间停用 22:30~06:00"（同一纯函数，实时取时钟）
    // （过程清单已在入口清空，见上面的 `submitProgress.value = []`）
    pushProgress('step', SUBMIT_PROGRESS.gate())
    const gate = evaluateRunGate({
      /**
       * ⚠️ 用可选链：上下文校验已收口到纯函数 `evaluateSubmitContext()` ⇒ TS 在这里**不再**能收窄
       * `profile.value`（历史注释说过"别把判据抽成布尔变量"正是为此）。`RunGateInput.schoolCode`
       * 本来就允许 null/undefined，所以 `?.` 与原来语义一致（门禁不看 schoolCode 的取值）。
       */
      schoolCode: profile.value?.schoolCode,
      switches: switches.value,
      line: input.line,
      cameraFlag: cameraFlag.value,
      cameraFlagLineId: cameraFlagLineId.value,
      // 🆕 2026-09-22（issue #12）：与只读侧 `gateStatus` **同一判据** —— 服务端未下发线路的任务不因"未选线路"拦
      lineRequired,
      // 🆕 2026-09-23（pre3）：本机有没有可用几何（只对"未下发线路"的任务有意义；同一判据 `freeRouteGeometryChoice`）
      // ⚠️ 任务的"身份"也要走兜底链（他这份响应没有 `taskId` ⇒ 只用 taskId 会让"记住的本机路径"对不上）
      // 🔴 2026-09-25 修复：**三态** —— 本机库还没装载时传 `undefined`（未知 ⇒ 不记也不拦），
      //    与只读侧 `composables/real/data.ts` 的 `gateStatus` 完全同源（见 `DEVELOPMENT.md` §39.3 第 2 条）
      localGeometryReady: lib.loaded.value
        ? Boolean(freeRouteGeometryChoice(lib.entries.value, task.value, lib.freeRouteChoiceFor(taskPaperIdOf(task.value))).entry)
        : undefined,
      runType,
      now: new Date(),
    })
    if (!gate.allow) {
      pushProgress('error', SUBMIT_PROGRESS.gateBlocked(gate.reason))
      /**
       * 🆕 2026-09-23（用户要求 2️⃣）：**被门禁挡住的提交必须显式记一条**。
       * 以前只能靠"日志里没有写请求"**反推**"提交从未发出"—— 这是上一轮排查最费劲的一步。
       * 现在把判定所需的关键输入摘要一起记下来（开关值 / 是否夜间 / 线路要求 / 时钟与时区偏移），
       * 于是"提交被本地拦下"在诊断包里是**明写的事实**。
       * 🔒 `data` 里**没有** token/学号/姓名（只有判定输入），脱敏仍由上报链路兜一层。
       */
      reportBlocked('gate-blocked', gate.reason || '门禁未通过', {
        blockedBy: String(gate.blockedBy ?? ''),
        lineRequired,
        runType,
        switchesFound: Boolean(switches.value),
        switchStartFace: String(switches.value?.sunrunStartFace ?? '-'),
        switchPointRandom: String(switches.value?.sunrunPointRandom ?? '-'),
        cameraFlag: cameraFlag.value === null ? 'unknown' : String(cameraFlag.value),
        hasLine: Boolean(input.line),
        nightWindow: /夜间/.test(String(gate.reason ?? '')) || String(gate.blockedBy ?? '') === 'night',
        nowIso: new Date().toISOString(),
        tzOffsetMin: new Date().getTimezoneOffset(),
      })
      phase.value = 'error'
      phaseMessage.value = `已停止（未创建场次）：${gate.reason}`
      return null
    }
    /**
     * 🆕 2026-09-23（pre3，用户要求 3️⃣）：**"放宽放行"必须上报一条诊断事件** ——
     * 这样我们从包里就能看到「这笔提交是在放宽状态下发生的」（而不是事后猜）。
     * 每条命中项各报一条（`cat:'warn-relaxed'`），文案前缀 `pre3：`，便于在时间线里一眼筛出来。
     * 🔒 只带判定输入摘要（与上面 `reportBlocked` 同一套字段），**没有** token/学号/姓名。
     */
    if (gate.relaxed) {
      for (const [i, code] of gate.warningCodes.entries()) {
        reportDiagEvent({
          id: newEventId(),
          at: new Date().toISOString(),
          level: 'gate',
          cat: 'warn-relaxed',
          text: `pre3：${gate.warnings[i] ?? ''} —— 只警告未阻断，仍允许提交`,
          data: {
            reasonCode: code,
            blockedBy: String(gate.blockedBy ?? ''),
            lineRequired,
            runType,
            hasLine: Boolean(input.line),
            switchesFound: Boolean(switches.value),
            relaxGate: true,
            tzOffsetMin: new Date().getTimezoneOffset(),
          },
        })
      }
      pushProgress('warn', `pre3 放宽：${gate.warnings.length} 条本该拦住的理由只警告未阻断（仍继续提交）`)
    }
    pushProgress('ok', SUBMIT_PROGRESS.gatePassed())

    const options = { token, baseUrl: session.value?.baseUrl }

    // ① 开跑：getRunBegin（写）。自由跑照厂商口径传 runType=1 且 paperId/lineId 为空串；
    //    **服务端未下发线路的任务**：paperId 用任务号兜底、lineId 为空串（本机跑道 id 不是服务端线路，绝不进报文）。
    phase.value = 'begin'
    phaseMessage.value = '正在创建跑步会话（getRunBegin）…'
    pushProgress('step', SUBMIT_PROGRESS.begin(input.line?.pointName ?? '', freeRun ? '自由跑' : '阳光跑'))
    const begin = await MpApiWrapper.getRunBegin(buildRunBeginRequest({ line: input.line, paperId, runType }), options)
    const scantronId = (begin.data as { scantronId?: string } | undefined)?.scantronId
    if (!begin.ok || !scantronId) {
      phase.value = 'error'
      pushProgress('error', SUBMIT_PROGRESS.beginFail(begin.message))
      /**
       * ⚠️ 2026-09-21 实测（自由跑真提交一笔）：厂商对自由跑回
       * `status:"01" code:"1" msg:"暂无自由跑任务,请选择阳光跑!"` —— 这是**服务端按学校/账号的资格判定**
       * （已核对厂商小程序源码：自由跑就是 `runType:1` + `paperId/lineId` 空串，**并不去取什么"自由跑任务"**，
       *  与我们的报文逐字一致）⇒ **不是本机问题，也没有 paperId 可以补**。
       * 判据：**"服务器明确说没开通"这类回复要单独翻译成人话**，别让用户以为是自己的操作或本程序的 bug。
       */
      const noFreeRunTask = freeRun && isFreeRunUnsupportedMessage(begin.message)
      // 🆕 2026-09-21（E）：记住"该校未开通自由跑"，下次开跑前就把真实提交入口标灰（可手动清除再试）
      if (noFreeRunTask) markFreeRunUnsupported()
      /**
       * 🆕 2026-10-07（用户要求）：**"今日该任务次数已达上限"要单独翻译 + 记住今天**。
       * 实测（用户当天第二次提交）：厂商在 `getRunBegin` 就回 `status:"01" code:"1" msg:"该任务次数今日已达上限!"`。
       * 这是**服务端按"任务 + 当天"的配额**（不是本机操作错、不是报文格式问题、也没有参数可补），
       * 而旧界面只会把它显示成一句 `开跑失败：…` ⇒ 用户以为是自己或程序出了问题。
       */
      const quotaReached = !freeRun && isDailyQuotaReachedMessage(begin.message)
      // 只有"有任务号"时才记标记：没有任务号就记的话，会把"别的任务"也一起标灰（宁可少挡，不可乱挡）
      if (quotaReached && paperId) markDailyQuotaReached(begin.message, paperId)
      // 若失败原因是 token 过期 → 给"退出登录并重新登录小程序"的可操作提示
      phaseMessage.value = looksLikeTokenExpired(begin.raw)
        ? TOKEN_EXPIRED_HINT
        : quotaReached
          ? dailyQuotaNotice(begin.message)
          : noFreeRunTask
            ? `你所在学校/账号暂无「自由跑任务」——厂商服务端拒绝开跑（原话：${begin.message}）。` +
              `自由跑目前只能用于本地模拟与预览，真实提交需要学校开通；阳光跑不受影响。`
            : `开跑失败：${begin.message}`
      if (noFreeRunTask) {
        pushProgress(
          'warn',
          '② 说明：服务端未给该校/该账号开通「自由跑任务」⇒ 自由跑无法真实提交（与报文格式、本机操作无关）；阳光跑可正常提交',
        )
      }
      if (quotaReached) pushProgress('warn', dailyQuotaProgressNote(begin.message))
      logError('submit', '开跑失败（getRunBegin）', {
        message: begin.message,
        // 日志里如实区分三种情形（自由跑 / 本任务未下发线路 / 有线路）
        lineId: input.line?.pointId ?? (freeRun ? '(自由跑)' : '(本任务未下发线路)'),
        paperId,
        ...(noFreeRunTask ? { note: '服务端未开通自由跑任务（2026-09-21 实测）' } : {}),
        ...(quotaReached ? { note: '服务端说今日该任务次数已达上限（每日配额，非本机问题；2026-10-07 实测）' } : {}),
      })
      return null
    }
    const startedAt = Date.now()
    pushProgress('ok', SUBMIT_PROGRESS.beginOk(scantronId))
    logInfo('submit', '开跑会话已创建', {
      scantronId,
      runType,
      lineId: input.line?.pointId ?? (freeRun ? '(自由跑)' : '(本任务未下发线路)'),
      lineName: input.line?.pointName ?? '',
      paperId,
      km: Number(input.km.toFixed(2)),
      fitDegree: input.fitDegree,
      points: input.points.length,
    })

    /**
     * ②③④⑤ **交给服务端提交作业**（防 kill）—— 2026-10-07 用户明确要求：
     * "就最终的提交那个地方（就是得等待几十分钟的）这个需要重构"、
     * "下次你运行的时候在那个终端也显示进度，前端只是展示，不作为一种步进的过程"。
     *
     * ⇒ 那段"真实等待 + 成绩 + 轨迹明细 + 读判定"全部搬到 Node 进程（`server/utils/runSubmitJob.ts`）：
     *   · 浏览器被冻结/关闭**不影响**它跑完（旧实现断在中间 ⇒ 云端成绩有效却没轨迹，见 `ERROR.md` E71）；
     *   · 服务端计时器**不被浏览器节流**（旧实现实测晚了约 12 分钟）；
     *   · 进度**同时打在服务端终端与当天日志**，并供本函数轮询展示。
     * 本函数只剩：**启动作业 + 轮询 + 按结果写回界面状态**（不再推进任何一步）。
     */
    const planned = Math.max(1, Math.round(input.plannedSeconds))
    const tokenNow = session.value?.token
    const profileNow = profile.value
    if (!tokenNow || !profileNow) {
      pushProgress('error', '会话/档案缺失 → 本次提交中止（未发送成绩）')
      phase.value = 'error'
      phaseMessage.value =
        '缺少会话或档案（可能点了「退出登录」或「清空本机数据」）——本次提交已中止，未发送成绩。请重新读取真实数据后再试。'
      logWarn('submit', '启动服务端作业前上下文丢失，提交中止', { scantronId })
      return null
    }
    const submittedAt = Date.now()
    const context = {
      snCode: profileNow.snCode,
      schoolCode: profileNow.schoolCode,
      task: task.value,
      line: input.line,
      // 🆕 2026-09-22（issue #12）：任务号兜底 —— 没有线路时 `sunRunExercises.taskId` 取它（有线路时被忽略）
      paperId,
      km: input.km,
      durationSeconds: planned,
      fitDegree: input.fitDegree,
      points: toSubmitPoints(input.points),
      token: tokenNow,
      scantronId,
      /**
       * ⚠️ 这两个时间戳**只是本地占位**（用于 `out.scoreRequestMasked` 那份报文预览）：
       * 真正进报文的时间戳由**服务端作业在发出的那一刻**算（`startMs` = 作业开始、`endMs` = 发出前），
       * 否则 `endTime` 会停在"等待开始"的时刻、白白少掉整个等待时长。
       */
      startMs: startedAt,
      endMs: submittedAt,
    }
    phase.value = 'waiting'
    remainingSeconds.value = planned
    phaseMessage.value = `已交给服务端执行：需真实等待 ${Math.ceil(planned / 60)} 分钟（进度同时打在服务端终端）`
    stopWait()
    const started = await startServerSubmitJob({
      token: tokenNow,
      baseUrl: session.value?.baseUrl,
      plannedSeconds: planned,
      scantronId,
      context: {
        snCode: context.snCode,
        schoolCode: context.schoolCode,
        task: context.task,
        line: context.line,
        paperId: context.paperId,
        km: context.km,
        durationSeconds: context.durationSeconds,
        fitDegree: context.fitDegree,
        points: context.points,
        runType,
      },
      verdictRequest: await buildVerdictRequest(tokenNow),
      meta: {
        km: input.km,
        lineName: input.line?.pointName ?? '',
        runTypeLabel: freeRun ? '自由跑' : '阳光跑',
      },
    })
    if (!started.ok) {
      pushProgress('error', `无法启动服务端提交作业：${started.message}`)
      phase.value = 'error'
      phaseMessage.value = `无法启动服务端提交作业：${started.message}（未发送成绩）`
      logError('submit', '启动服务端提交作业失败', { scantronId, message: started.message })
      return null
    }
    logInfo('submit', '已启动服务端提交作业（等待与两次写都在服务端）', { jobId: started.id, scantronId, planned })
    /**
     * 🆕 2026-10-08（进程级续跑，用户要求）：作业已受理 ⇒ 记下**浏览器侧**要补交的那三样，
     * "关掉 EXE 重启也能接着跑"从这一刻起才成立。
     * 🔒 只记 `jobId / scantronId / startedAt / snCode / 轨迹点`：**token 不进这里**（现从会话取）——
     * 落盘边界见 `utils/mp/runResume.ts`（用户 2026-10-08 拍板：token 与轨迹点都不进**服务端**磁盘）。
     */
    savePendingResume({
      jobId: started.id,
      scantronId,
      startedAt,
      snCode: context.snCode,
      points: toSubmitPoints(input.points),
      at: Date.now(),
    })
    const job = await pollServerSubmitJob(started.id)
    const outcome = (job.result?.scoreOutcome ?? 'failed') as WriteOutcome
    const scoreOk = Boolean(job.result?.scoreOk)
    const scoreMessage = job.result?.scoreMessage ?? '服务端作业没有返回结果（请查看服务端终端与当天日志）'
    const submittedAtFinal = job.finishedAt || Date.now()

    // 过程清单：按服务端作业的结论打点（**超时 ≠ 失败**，未知态要说清"别急着重试"）
    if (outcome === 'ok' || outcome === 'timeout-landed') {
      pushProgress('ok', outcome === 'ok' ? '④ 成绩已提交（服务端发出）' : SUBMIT_PROGRESS.scoreVerified())
    } else if (outcome === 'timeout-unknown') {
      pushProgress('warn', SUBMIT_PROGRESS.scoreUnknown())
    } else {
      pushProgress('error', SUBMIT_PROGRESS.scoreFail(scoreMessage))
    }

    /**
     * ③④⑤ 的**实际执行**见 `server/utils/runSubmitJob.ts`（本函数在上面启动作业并轮询）——
     * 这里保留这段说明是为了让后来者知道"那两步为什么不在这个文件里了"：
     *   · 旧实现在这里做"前端等待 + 两次写 + 读判定"，页面被冻结/关闭就会断在中间（`ERROR.md` E71）；
     *   · 现在**由服务端作业按同一顺序执行**，报文仍由同一套唯一构造器产出（口径一字未变）。
     */


    const out: RealSubmitResult = {
      scantronId,
      startedAt,
      submittedAt: submittedAtFinal,
      scoreOk,
      // 🆕 2026-09-21（冗余加固）：把四态结局透给界面 —— 别让它按 scoreOk 二分成"红/绿"
      scoreOutcome: outcome,
      scoreMessage,
      // 自由跑没有线路 ⇒ 路径点列本来就是空的（厂商口径），这里如实显示 0 点
      scoreRequestMasked: {
        ...buildScoreRequest(context, { runType }),
        token: '***',
        sunrunPathPointList: `（${input.line?.pointList?.length ?? 0} 点）`,
      },
    }

    /**
     * 🆕 2026-10-08（进程级续跑）：作业已经**有结论**（跑到 done/error 了）⇒
     * 浏览器侧那份"待续跑载荷"使命结束，清掉（不清的话下次启动会提示一笔早就跑完的作业）。
     * ⚠️ `phase === 'suspended'` 的情形在上面的轮询里就 return 了，走不到这里；
     *    那种情况**必须保留**载荷（那是"还能不能续跑"的唯一依据）。
     */
    if (job.phase !== 'suspended') clearPendingResume()
    suspendedJob.value = null

    /**
     * ④ 轨迹明细的**结果**（由服务端作业发出并记账）。
     *
     * ⚠️ 与旧实现的关键差别：旧实现"发明细"这件事**只存在于前端执行流里**，页面一死就静默消失
     * （`ERROR.md` E71）；现在成败由**服务端**判定并写进日志/状态，本函数只按结论记账：
     *   · 交上了 ⇒ 销掉本地欠账；
     *   · 没交上 ⇒ 落一笔欠账（界面给「补交轨迹」，用户点一次发一次）。
     */
    if (scoreOk) {
      // 认领本机记录：把**真实场次号**写回去（记录页据此把"仅本地结算"改成"已真实提交"）
      if (typeof input.settledAtMs === 'number') {
        mutateRecords((rs) =>
          claimRecordForRealSubmit(rs, { settledAtMs: input.settledAtMs, scantronId }).records,
        )
      }
      out.detailOk = job.result?.detailOk
      out.detailMessage = job.result?.detailMessage ?? '（服务端未返回轨迹明细结果，请看服务端终端与当天日志）'
      if (out.detailOk === true) {
        clearPendingDetail()
        mutateRecords((rs) => setRecordDetailOk(rs, scantronId, true))
        pushProgress('ok', `⑤ 轨迹已交（服务端发出）：${out.detailMessage}`)
        logInfo('submit', '轨迹明细已提交（服务端作业）', { detail: out.detailMessage })
      } else {
        const pending: PendingDetail = {
          scantronId,
          taskId: paperId,
          lineId: input.line?.pointId ?? '',
          runType,
          km: input.km,
          durationSeconds: planned,
          startMs: startedAt,
          endMs: submittedAtFinal,
          points: context.points,
          at: Date.now(),
          attempts: 0,
          lastError: '',
        }
        savePendingDetail(pending)
        pushProgress('step', pendingDetailProgressNote(pending))
        mutateRecords((rs) => setRecordDetailOk(rs, scantronId, false))
        pushProgress('error', SUBMIT_PROGRESS.detailFail(out.detailMessage))
        logWarn('submit', '轨迹明细未交上（服务端作业的结论）', { message: out.detailMessage })
      }
    } else {
      out.detailOk = undefined
      out.detailMessage =
        outcome === 'timeout-unknown'
          ? '结果未知 → 先不发轨迹（不在未确认的成绩上乱写）；核实到已入库时会自动补交'
          : '成绩未成功 → 按源码行为不发轨迹，也不重试'
      pushProgress('warn', SUBMIT_PROGRESS.detailSkipped(out.detailMessage))
    }

    /**
     * ⚠️ **写回前复查（2026-09-20 审计 B2；2026-09-21 审计 B2 拆开两种情形）**：
     * 成绩/明细两次 await 期间用户可能点了「退出登录」或「清空本机数据」。
     * ⚠️ 这两种情形**必须分开处理**（第一版混在一起 ⇒ 退出登录会把 `phase` 永久钉在 `submitting`，
     *    「真实提交」与「重置」双双灰死到刷新页面为止，而已成功的成绩被静默丢弃）。
     */
    if ((phase.value as string) !== 'submitting') {
      /**
       * ① phase 已被外部复位（清空本机数据）⇒ 静默返回，不写回。
       * ⚠️ 这里显式按 `string` 比较：TS 会按上面那句 `phase.value = 'waiting'` 把类型窄化成字面量，
       *    而**轮询是在闭包里改它的**（TS 看不见），窄化后的比较会被判成"永远不成立"。
       */
      logWarn('submit', '提交期间状态被外部复位，本地状态不写回', { scantronId, phase: phase.value })
      return null
    }
    if (!session.value?.token || !profile.value) {
      // ② 只是凭据/档案被清（退出登录）⇒ **必须复位 phase 并给提示**，否则按钮永久灰死
      phase.value = 'error'
      phaseMessage.value =
        '提交期间会话/档案被清除（可能点了「退出登录」）——本次提交的结果不再写回界面；请重新读取真实数据后再查看记录'
      logWarn('submit', '提交期间凭据被清除，phase 置为 error（避免按钮永久灰死）', {
        scantronId,
        hadToken: Boolean(session.value?.token),
        hadProfile: Boolean(profile.value),
      })
      return null
    }

    result.value = out
    phase.value = scoreOk ? 'done' : 'error'
    phaseMessage.value = scoreOk
      ? `提交完成：${out.scoreMessage}${out.detailOk ? '；轨迹已提交' : '；轨迹未提交'}`
      : // ⚠️ "结果未知"那条文案自带完整说明，**不能**再前缀"提交失败"（会自相矛盾：既说失败又说未知）
        outcome === 'timeout-unknown'
        ? out.scoreMessage
        : job.result?.tokenExpired
          ? TOKEN_EXPIRED_HINT
          : `提交失败：${out.scoreMessage}`
    if (scoreOk) {
      logInfo('submit', outcome === 'timeout-landed' ? '提交超时，但已核实成绩入库（按成功处理）' : '成绩提交成功（服务端作业）', {
        scantronId,
        km: Number(input.km.toFixed(2)),
        durationSeconds: planned,
        fitDegree: input.fitDegree,
        waitedSeconds: Math.round((submittedAtFinal - startedAt) / 1000),
        ...(outcome === 'timeout-landed' ? { note: '首次请求超时，已在服务端归档中核实' } : {}),
      })
      /**
       * 🆕 2026-10-07：判定**由服务端作业读回**（它是编排的最后一步）⇒ 这里只把服务端判定写回本机记录。
       * 于是记录页的「已真实提交」那一行显示的就是**服务端判定**，不再有"本地预判冒充"的歧义。
       */
      const verdict = job.result?.verdict ?? null
      if (verdict) {
        mutateRecords((rs) =>
          applyServerVerdict(rs, scantronId, {
            scorePassType: verdict.scorePassType as number | string | undefined,
            scorePassRemark: typeof verdict.scorePassRemark === 'string' ? verdict.scorePassRemark : undefined,
          }),
        )
      }
      /**
       * ⚠️ 旧实现在这里会再调一次 `fetchVerdict`（超时核实那条）——现在**不需要了**：
       * 作业在超时后已经自己核实过并读回了判定（`job.result.verdict`），重复只读请求没有意义。
       */
    } else {
      logError('submit', outcome === 'timeout-unknown' ? '成绩提交结果未知（超时且归档暂无）' : '成绩提交失败', {
        scantronId,
        message: out.scoreMessage,
      })
    }
    /**
     * 🆕 2026-09-23（用户要求：**"用户提交一下一定记录一下响应"**）：
     * 无论**成功 / 上游业务失败 / 超时未确认**，都补一条**结论事件**进 UI 时间线（⇒ 双写进诊断包）。
     *
     * 为什么单独一条：日志里有细节（`submit` 那几条），但维护者打开包第一眼要看的是**结论**：
     * 「这次提交到底成没成、失败是什么 code、超时算不算成功」。把结论写成一条**结构化**事件
     * （`cat:'submit'`，`data.scoreOutcome` 是四态之一），一眼能筛。
     *
     * 🔴 同时**明确不自动重试**：`MP_RETRY_CONFIG` 只对 **GET** 重试（`methods:['get']`，有单测钉住），
     * 提交/轨迹这些**非幂等写操作绝不重试**；超时后也只是**只读核实**（`fetchVerdict`/归档查询），
     * 绝不重发写请求 —— 这里把这件事**写进事件摘要**，让包里也能看到"没有自动重试"。
     */
    logEvent(
      outcome === 'ok' || outcome === 'timeout-landed' ? 'info' : outcome === 'timeout-unknown' ? 'warn' : 'error',
      'submit',
      `提交结果：${outcomeLabel(outcome)}${out.scoreMessage ? `（${out.scoreMessage}）` : ''}`,
      {
        scoreOutcome: outcome,
        scoreOk,
        scantronId,
        detailOk: out.detailOk ?? null,
        autoRetried: false,
        retryPolicy: '写操作绝不重试（只有 GET 会重试一次）',
        waitedSeconds: Math.round((submittedAtFinal - startedAt) / 1000),
      },
    )
    return out
  }

  /**
   * 🆕 2026-10-07（防 kill；用户要求："就是得等待几十分钟的那个需要重构"、"前端只是展示"）：
   * **启动作业 + 轮询状态**。类型在这里**就地声明**（不从 `server/utils/runSubmitJob.ts` 导 —— 那会把
   * 服务端模块拉进前端包）；形状以服务端返回为准，前端只读不改。
   */
  interface ServerSubmitJobView {
    id: string
    active: boolean
    phase: 'idle' | 'waiting' | 'scoring' | 'detail' | 'verdict' | 'done' | 'error' | 'suspended' | 'aborted' | 'discarded'
    phaseMessage: string
    progress: { at: number; kind: 'step' | 'ok' | 'warn' | 'error'; text: string }[]
    remainingSeconds: number
    startedAt: number
    finishedAt: number
    /** 🆕 2026-10-08：`phase === 'suspended'` 时的非敏感摘要（渲染「继续提交」卡片用） */
    suspended?: SuspendedJobSummary | null
    result: {
      scoreOk: boolean
      scoreOutcome: string
      scoreMessage: string
      detailOk?: boolean
      detailMessage?: string
      tokenExpired?: boolean
      verdict?: Record<string, unknown> | null
      verdictMessage?: string
      scantronId: string
    } | null
  }

  /** 把报文上下文交给服务端作业（本机端点，带"只允许本机"校验） */
  const startServerSubmitJob = async (body: unknown): Promise<{ ok: boolean; message: string; id: string }> => {
    try {
      return await $fetch<{ ok: boolean; message: string; id: string }>('/api/local/run/submit/start', {
        method: 'POST',
        body: body as Record<string, unknown>,
      })
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), id: '' }
    }
  }

  /**
   * 轮询服务端作业，把**阶段 / 倒计时 / 进度清单**镜像到界面（纯展示，不推进任何一步）。
   * ⚠️ 轮询中断（页面被冻结）不会影响作业：下次唤醒继续读同一个状态；页面被关掉后重开也能重新接上。
   */
  const pollServerSubmitJob = async (jobId: string): Promise<ServerSubmitJobView> => {
    let lastMessage = ''
    for (;;) {
      let job: ServerSubmitJobView
      try {
        const res = await $fetch<{ ok: boolean; job: ServerSubmitJobView }>('/api/local/run/submit/status')
        job = res.job
      } catch (err) {
        logWarn('submit', '轮询服务端作业状态失败（2 秒后重试；作业本身不受影响）', {
          jobId,
          message: err instanceof Error ? err.message : String(err),
        })
        await new Promise<void>((r) => setTimeout(r, 2000))
        continue
      }
      // 镜像（进度清单以**服务端**为唯一来源：它记着 ① 建场次 ② 真实等待 ③ 成绩 ④ 轨迹 ⑤ 判定）
      submitProgress.value = job.progress.map((l) => ({ ...l }))
      remainingSeconds.value = job.remainingSeconds
      /**
       * 阶段映射：**作业在途时** waiting / submitting；**作业结束时仍停在 `submitting`** ——
       * 最终的 `done`/`error` 由下面的写回段落统一决定（与此前同一条纪律：
       * `submitting` 是"本函数在途"的标记，清空数据会把它复位 ⇒ 写回前复查据此发现"状态被外部复位"）。
       */
      phase.value = job.active && job.phase === 'waiting' ? 'waiting' : 'submitting'
      phaseMessage.value = job.phaseMessage
      if (job.phaseMessage && job.phaseMessage !== lastMessage) {
        lastMessage = job.phaseMessage
        logInfo('submit', `服务端作业：${job.phaseMessage}`, { jobId, phase: job.phase })
      }
      /**
       * ⚠️ 用户在作业期间点了「退出登录 / 清空本机数据」：**作业仍在服务端继续跑**（这正是"防 kill"的另一面），
       * 所以这里**不能**假装什么都没发生 —— 停掉展示并如实告知"成绩可能仍会入库"。
       * ✅ 2026-10-08：现在有**中途叫停**了（`abortServerSubmitJob` → `POST /api/local/run/submit/abort`），
       * 界面会在这种情形下引导用户去叫停（只在"还没发出写请求"的阶段有效，见该函数说明）。
       *
       * 🔴 **判据只看 token，不看档案**（2026-10-08 浏览器探针抓到的真 bug）：
       * 原先这里写的是 `!session.value?.token || !profile.value` —— 而**档案不会被缓存**
       * （`mp_real_task_v1` 只存 `{at, task, lineId, token}`，见 `composables/real/data.ts`）⇒
       * **关掉 EXE 重启后档案必然是空的** ⇒ 点「继续这笔提交」会被这里误判成"凭据/档案已被清除"，
       * 界面报一句**假的**"提交失败（续跑）" —— 而那笔作业其实好好地在服务端跑着。
       * 轮询只是**镜像服务端状态**（不写任何东西、也不需要档案），所以判据收窄成"**会话 token 没了**"即可：
       * 那才是"用户真的清了凭据"（退出登录 / 清空本机数据都会清掉它）。
       */
      if (!session.value?.token) {
        phase.value = 'error'
        phaseMessage.value =
          '凭据已被清除 —— 服务端作业仍在继续（成绩可能仍会入库）；可用「停止本次提交」叫停它，' +
          '或看服务端终端与「成绩记录」页确认'
        logWarn('submit', '轮询期间凭据被清除：停止展示，但服务端作业仍在跑', { jobId, phase: job.phase })
        return job
      }
      /**
       * 🆕 2026-10-08（进程级续跑）：`suspended` = 服务端发现**上次没跑完的作业**（等用户点「继续提交」）。
       * 这时**不要继续轮询**（它不会自己动），也别把它当成"正在提交" ⇒ 把摘要交给界面渲染卡片后立刻返回。
       */
      suspendedJob.value = job.suspended ?? null
      if (job.phase === 'suspended') {
        phase.value = 'idle'
        return job
      }
      if (!job.active) return job
      await new Promise<void>((r) => setTimeout(r, 1000))
    }
  }

  /**
   * 🆕 2026-10-08（用户要求）：**只查一次**服务端作业状态，用来在页面刚打开时发现
   * "上次没跑完的提交"（服务端会在启动后从磁盘把它读回来、进入 `suspended`）。
   *
   * 为什么不复用 `pollServerSubmitJob`：那个是"盯着一次提交跑完"的循环，会一直轮询；
   * 这里只需要**一次快照**，而且**绝不能**因为一次网络抖动就把界面卡住。
   */
  /**
   * ⭐ **把服务端作业的最终结论写回界面**（2026-10-08 抽出来共用）。
   * 为什么必须抽出来：这个写回原先只存在于 `submitRealRun` ⇒ 凡**不是由本页发起**的作业
   * （续跑、以及"刷新后接回"）跑完都会**没有任何结论**，用户看不出来成没成。三条路现在同一份口径。
   * @param info.label 文案前缀（"续跑" / "接回"）
   */
  const applyJobOutcomeToUi = (
    job: ServerSubmitJobView,
    info: {
      scantronId: string
      startedAt: number
      points: { latitude: number; longitude: number }[]
      km: number
      durationSeconds: number
      runType: 0 | 1
      /** 那次结算的时刻 —— **认领本机记录**要用它精确匹配（刷新后由 `pendingResume` 提供） */
      settledAtMs?: number
      label: string
    },
  ): void => {
    const scoreOk = Boolean(job.result?.scoreOk)
    const outcome = (job.result?.scoreOutcome ?? 'failed') as WriteOutcome
    const scoreMessage = job.result?.scoreMessage ?? '服务端作业没有返回结果（请看服务端终端与当天日志）'
    const submittedAt = job.finishedAt || Date.now()
    const out: RealSubmitResult = {
      scantronId: info.scantronId,
      startedAt: info.startedAt,
      submittedAt,
      scoreOk,
      scoreOutcome: outcome,
      scoreMessage,
      detailOk: job.result?.detailOk,
      detailMessage: job.result?.detailMessage,
    }
    result.value = out
    phase.value = scoreOk ? 'done' : 'error'
    phaseMessage.value = scoreOk
      ? `提交完成（${info.label}）：${scoreMessage}${out.detailOk ? '；轨迹已提交' : '；轨迹未提交'}`
      : outcome === 'timeout-unknown'
        ? scoreMessage
        : `提交失败（${info.label}）：${scoreMessage}`
    logInfo('submit', `${info.label}作业结束：${scoreOk ? '成功' : '未成功'}`, { scantronId: info.scantronId, outcome })
    if (!scoreOk) return
    /**
     * ① **认领本机记录**（把「仅本地结算」改成「已真实提交」并写回真实场次号）。
     * ⚠️ 只在拿得到 `settledAtMs`（毫秒级唯一键）时认领；拿不到就**不认领**，绝不瞎认领到别的记录上。
     */
    if (typeof info.settledAtMs === 'number' && Number.isFinite(info.settledAtMs)) {
      mutateRecords((rs) =>
        claimRecordForRealSubmit(rs, { settledAtMs: info.settledAtMs, scantronId: info.scantronId, detailOk: out.detailOk }).records,
      )
    } else {
      logWarn('submit', '缺少 settledAtMs ⇒ 跳过"认领本机记录"（不瞎认领）', { scantronId: info.scantronId })
    }
    /** ② 判定的**权威值是服务端** ⇒ 按场次号写回 */
    const verdict = job.result?.verdict ?? null
    if (verdict) {
      mutateRecords((rs) =>
        applyServerVerdict(rs, info.scantronId, {
          scorePassType: verdict.scorePassType as number | string | undefined,
          scorePassRemark: verdict.scorePassRemark as string | undefined,
        }),
      )
    }
    /** ③ 轨迹没交上 ⇒ 记一笔欠账（与首次提交同一口径：界面给「补交轨迹」，用户点一次发一次） */
    if (out.detailOk === false && info.points.length > 0) {
      savePendingDetail({
        scantronId: info.scantronId,
        taskId: '',
        lineId: '',
        runType: info.runType,
        km: info.km,
        durationSeconds: info.durationSeconds,
        startMs: info.startedAt,
        endMs: submittedAt,
        points: info.points,
        at: Date.now(),
        attempts: 0,
        lastError: out.detailMessage ?? '',
      })
      mutateRecords((rs) => setRecordDetailOk(rs, info.scantronId, false))
      logWarn('submit', `${info.label}的成绩成功但轨迹没交上 ⇒ 已记一笔待补交`, { scantronId: info.scantronId })
    }
  }

  const refreshSubmitJobStatus = async (): Promise<SuspendedJobSummary | null> => {
    try {
      const res = await $fetch<{ ok: boolean; job: ServerSubmitJobView }>('/api/local/run/submit/status')
      suspendedJob.value = res.job?.suspended ?? null
      return suspendedJob.value
    } catch (err) {
      /**
       * 读不到就**保持原样**（不清空）：这只是一次展示用快照，
       * 服务端磁盘上的作业不会因为它失败而变化；下次进页面还会再查。
       */
      logWarn('submit', '查询服务端提交作业状态失败（不影响磁盘上那笔作业）', {
        message: err instanceof Error ? err.message : String(err),
      })
      return suspendedJob.value
    }
  }

  /**
   * 🆕 2026-10-08（用户要求）：**刷新/重开页面后自动"接回"正在跑的作业**。
   *
   * ## 为什么必须有它（这条是用户点出来的）
   * 重构后作业跑在服务端 ⇒ **刷新页面不影响提交**；但界面原先**接不回来**：挂载时只查了一次 `suspended`
   * （那是"进程重启后挂起"那种），**在途**作业（waiting/scoring/…）不出现任何卡片、不显示进度、
   * 跑完了也**没有任何结论**（写回只存在于本页发起的那次调用里）。
   * ⚠️ 而 `server/api/local/run/submit/status.get.ts` 的文件头**一直写着**"页面刷新或被关掉再打开，
   *    也可以靠它重新接上正在跑的作业（进度与倒计时照旧显示）"——那是**意图**，此前**没实现**；本函数兑现它。
   *
   * ## 边界（保守）
   * - **只读 + 只展示**：不发起任何写请求、不改提交口径；
   * - 服务端没有在途作业 ⇒ **什么都不做**（不打扰）；
   * - `suspended` ⇒ 设 `suspendedJob`（既有行为，出「继续这笔提交」卡片）；
   * - 跑完后的写回走**同一个** `applyJobOutcomeToUi`；`settledAtMs` 由 `pendingResume` 提供，
   *   拿不到就**不认领**本机记录（宁可显示"仅本地结算"，也不瞎认领）。
   */
  const reattachServerSubmitJob = async (): Promise<{ attached: boolean }> => {
    let job: ServerSubmitJobView | null = null
    try {
      const res = await $fetch<{ ok: boolean; job: ServerSubmitJobView }>('/api/local/run/submit/status')
      job = res.job ?? null
    } catch (err) {
      logWarn('submit', '接回检查失败（不影响服务端那笔作业）', { message: err instanceof Error ? err.message : String(err) })
      return { attached: false }
    }
    if (!job) return { attached: false }
    suspendedJob.value = job.suspended ?? null
    /** 挂起（进程重启过）⇒ 交给卡片，等用户点「继续这笔提交」 */
    if (job.phase === 'suspended') return { attached: false }
    /** 不在途 ⇒ 什么都不做（那笔的写回由本页当时那次调用负责，这里补写会重复认领） */
    if (!job.active) return { attached: false }

    const payload = pendingResume.value
    const scantronId = String(job.suspended?.scantronId || payload?.scantronId || '')
    if (!scantronId) logWarn('submit', '服务端有在途作业但本机拿不到场次号 ⇒ 只展示进度、不做写回', { phase: job.phase })
    logInfo('submit', '页面重开后接回在途作业（进度与倒计时照旧显示）', { scantronId, phase: job.phase })
    pushProgress('step', `已接回服务端的在途作业（${job.phaseMessage || job.phase}）——页面刷新不影响它继续跑`)
    phase.value = job.phase === 'waiting' ? 'waiting' : 'submitting'
    const done = await pollServerSubmitJob(scantronId || 'reattach')
    if (done.phase === 'suspended') return { attached: true }
    clearPendingResume()
    if (scantronId) {
      applyJobOutcomeToUi(done, {
        scantronId,
        startedAt: payload?.startedAt ?? job.startedAt,
        points: payload?.points ?? [],
        km: job.suspended?.km ?? 0,
        durationSeconds: job.suspended?.plannedSeconds ?? 0,
        runType: job.suspended?.runType ?? 0,
        /**
         * ⚠️ **本路径不给 `settledAtMs`**（它只存在于结算那一刻的内存里，刷新后拿不到）
         * ⇒ `applyJobOutcomeToUi` 会**跳过"认领本机记录"**并记一条日志：
         * 记录页会如实显示「仅本地结算」，**不会**被瞎认领。要认领请刷新前不要离开本页，
         * 或刷新后自己点「查询判定」（判定写入是按场次号匹配的，不受影响）。
         */
        label: '接回',
      })
    }
    return { attached: true }
  }

  /**
   * 🆕 2026-10-08（用户要求，防 kill 的第二个边界）：**中途叫停**当前提交。
   *
   * ⚠️ 只在"**还没发出任何写请求**"的阶段有效（服务端 `abortRunSubmitJob` 的口径）；
   * 已进入提交阶段时服务端会**明确拒绝**并说明原因（那时打断只会留下半成品，见 E71）。
   * 叫停成功后清掉浏览器侧那份续跑载荷（不然下次启动还会提示一笔已经作废的作业）。
   */
  const abortServerSubmitJob = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const res = await $fetch<{ ok: boolean; message: string; phase: string }>(
        '/api/local/run/submit/abort',
        { method: 'POST', body: {} },
      )
      if (res.ok) {
        clearPendingResume()
        suspendedJob.value = null
        phase.value = 'idle'
        pushProgress('warn', res.message)
        logInfo('submit', '已按用户要求叫停提交作业', { phase: res.phase })
      } else {
        pushProgress('warn', res.message)
        logWarn('submit', '叫停提交作业被拒', { message: res.message, phase: res.phase })
      }
      return { ok: res.ok, message: res.message }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pushProgress('error', `叫停失败：${message}`)
      logWarn('submit', '叫停提交作业的请求失败', { message })
      return { ok: false, message }
    }
  }

  /**
   * 🆕 2026-10-08（用户要求）：**继续上次没跑完的提交**（进程级续跑）。
   *
   * 由用户点一次发起一次；服务端按 `decideResume()` 判"接着等 / 立即提交 / 作废"。
   * 这里负责把那三样**只有浏览器才有**的东西补交上去（**token 现从会话取**，不在载荷里）：
   *   · `token`：会话里的当前 token（用户可能已经重新取过 token，所以**用现在的**）；
   *   · `snCode`：档案里的学号（落盘时按隐私口径剥掉了）；
   *   · `points`：那次跑步的轨迹点（在 `pendingResume` 里，浏览器 localStorage）。
   */
  const resumeServerSubmitJob = async (): Promise<{ ok: boolean; message: string; action?: string }> => {
    const token = session.value?.token
    if (!token) return { ok: false, message: '没有可用会话：请先在「工作台」取 token，再点「继续提交」' }
    const payload = pendingResume.value
    if (!payload) {
      return {
        ok: false,
        message: '找不到那次跑步的轨迹点（浏览器本机数据可能被清过）⇒ 无法继续这笔提交；可以点「作废」放弃它',
      }
    }
    try {
      const snCode = profile.value?.snCode || payload.snCode || ''
      const res = await $fetch<{ ok: boolean; message: string; action: 'wait' | 'submit' | 'discard' | '' }>(
        '/api/local/run/submit/resume',
        { method: 'POST', body: { token, snCode, points: payload.points } },
      )
      pushProgress(res.ok ? 'ok' : 'warn', res.message)
      logInfo('submit', `续跑请求结果：${res.message}`, { action: res.action, points: payload.points.length })
      if (res.ok && res.action === 'discard') {
        // 作废：载荷没用了，清掉（服务端也已删掉落盘作业）
        clearPendingResume()
        suspendedJob.value = null
        phase.value = 'idle'
        return { ok: true, message: res.message, action: res.action }
      }
      if (!res.ok) return { ok: false, message: res.message }
      /** 受理了 ⇒ 接着轮询（与首次提交同一条展示路径） */
      const summary = suspendedJob.value // 先留一份（下面要把它清掉，但结果写回还要用它的里程/时长）
      suspendedJob.value = null
      phase.value = 'waiting'
      const job = await pollServerSubmitJob(payload.jobId)
      if (job.phase !== 'suspended') clearPendingResume()

      /**
       * 🆕 2026-10-08（**本轮浏览器探针抓到的缺口**）：续跑跑完必须**把结论写回界面**。
       * 原先这里只轮询展示进度 ⇒ 作业跑完后`result` 仍是空的、结果卡什么都不显示，
       * 用户根本看不出来这笔到底成没成（首次提交那条路是靠 `submitRealRun` 写回的）。
       * 这里按与 `submitRealRun` **同一口径**落定 `phase / phaseMessage / result`。
       */
      const scoreOkResumed = Boolean(job.result?.scoreOk)
      const outcomeResumed = (job.result?.scoreOutcome ?? 'failed') as WriteOutcome
      const scoreMessageResumed = job.result?.scoreMessage ?? '服务端作业没有返回结果（请看服务端终端与当天日志）'
      const submittedAtResumed = job.finishedAt || Date.now()
      const outResumed: RealSubmitResult = {
        scantronId: payload.scantronId,
        startedAt: payload.startedAt,
        submittedAt: submittedAtResumed,
        scoreOk: scoreOkResumed,
        scoreOutcome: outcomeResumed,
        scoreMessage: scoreMessageResumed,
        detailOk: job.result?.detailOk,
        detailMessage: job.result?.detailMessage,
      }
      result.value = outResumed
      phase.value = scoreOkResumed ? 'done' : 'error'
      phaseMessage.value = scoreOkResumed
        ? `提交完成（续跑）：${scoreMessageResumed}${outResumed.detailOk ? '；轨迹已提交' : '；轨迹未提交'}`
        : outcomeResumed === 'timeout-unknown'
          ? scoreMessageResumed
          : `提交失败（续跑）：${scoreMessageResumed}`
      logInfo('submit', `续跑作业结束：${scoreOkResumed ? '成功' : '未成功'}`, {
        scantronId: payload.scantronId,
        outcome: outcomeResumed,
      })
      if (scoreOkResumed) {
        /** 判定由服务端读回 ⇒ 写回本机记录（记录页的「已真实提交」显示的才是服务端判定） */
        const verdict = job.result?.verdict ?? null
        if (verdict) {
          mutateRecords((rs) =>
            applyServerVerdict(rs, payload.scantronId, {
              scorePassType: verdict.scorePassType as number | string | undefined,
              scorePassRemark: verdict.scorePassRemark as string | undefined,
            }),
          )
        }
        /** 轨迹没交上 ⇒ 记一笔欠账（与首次提交同一口径：界面给「补交轨迹」，用户点一次发一次） */
        if (outResumed.detailOk === false && payload.points.length > 0) {
          savePendingDetail({
            scantronId: payload.scantronId,
            taskId: '',
            lineId: '',
            runType: summary?.runType ?? 0,
            km: summary?.km ?? 0,
            durationSeconds: summary?.plannedSeconds ?? 0,
            startMs: payload.startedAt,
            endMs: submittedAtResumed,
            points: payload.points,
            at: Date.now(),
            attempts: 0,
            lastError: outResumed.detailMessage ?? '',
          })
          mutateRecords((rs) => setRecordDetailOk(rs, payload.scantronId, false))
          logWarn('submit', '续跑的成绩成功但轨迹没交上 ⇒ 已记一笔待补交', { scantronId: payload.scantronId })
        }
      }
      return { ok: true, message: res.message, action: res.action }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pushProgress('error', `继续提交失败：${message}`)
      logWarn('submit', '续跑请求失败', { message })
      return { ok: false, message }
    }
  }

  /**
   * 🆕 2026-10-08：**放弃**上次没跑完的那笔（= 走叫停那条路，但不需要它在途）。
   * 服务端 `abortRunSubmitJob` 对 `suspended` 阶段是允许的（那时确实一个写请求都没发）。
   */
  const discardSuspendedSubmitJob = async (): Promise<{ ok: boolean; message: string }> => {
    const out = await abortServerSubmitJob()
    if (out.ok) clearPendingResume()
    return out
  }

  /**
   * 读判定用的入参（`getSunrunArch`）：学期/月份必须先读出来才能查归档 ——
   * 与 `fetchVerdict` 同口径（同两个只读端点、同样的 `rowNumber: 1000`）。
   * 因为要先发两个只读请求，所以这里是 `async`：在**启动作业前**算好交给服务端（作业只读一次）。
   */
  const buildVerdictRequest = async (token: string): Promise<Record<string, unknown>> => {
    const options = { token, baseUrl: session.value?.baseUrl }
    const terms = await MpApiWrapper.getTermList(options)
    const termList = (terms.data as { id?: string; isActive?: string | number }[] | undefined) ?? []
    const activeTerm = termList.find((t) => String(t.isActive) === '1') ?? termList[0]
    const months = await MpApiWrapper.getSchoolMonthByTerm(options)
    const monthList = (months.data as { monthId?: string; ifCurrent?: string | number }[] | undefined) ?? []
    const currentMonth = monthList.find((m) => String(m.ifCurrent) === '1') ?? monthList[0]
    return {
      projectName: '阳光跑',
      monthId: currentMonth?.monthId ?? '',
      termId: activeTerm?.id ?? '',
      paperId: '',
      stuNumber: profile.value?.snCode ?? '',
      snCode: profile.value?.snCode ?? '',
      pageNumber: 1,
      rowNumber: 1000,
    }
  }

  /** 四态结局的人话标签（与 `writeOutcome` 的文案口径一致：**超时 ≠ 失败**） */
  function outcomeLabel(outcome: string): string {
    if (outcome === 'ok') return '成功'
    if (outcome === 'timeout-landed') return '超时但已核实入库（按成功处理）'
    if (outcome === 'timeout-unknown') return '超时未确认（请勿自动重试，稍后自己看归档）'
    return '上游业务失败'
  }

  /**
   * 读回判定（只读）：getSunrunArch → 按 scantronId 找这条。
   * @param opts.quiet `true` = 不往"提交过程清单"里打点（超时后的自动核实用它，避免把 ⑥ 插到 ④ 前面去）
   */
  async function fetchVerdict(
    scantronId?: string,
    opts: { quiet?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    const token = session.value?.token
    const id = scantronId || result.value?.scantronId
    if (!token || !id || !profile.value) return null
    const options = { token, baseUrl: session.value?.baseUrl }
    if (!opts.quiet) pushProgress('step', SUBMIT_PROGRESS.verdict())

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
        // ⚠️ 2026-09-21（冗余加固）：原先 100 —— 归档里超过 100 条（或按别的顺序返回）时会**漏查**本笔，
        // 进而误判成"没入库"。放宽到 1000（只读、无副作用；厂商一页给这么多）。
        rowNumber: 1000,
      },
      options,
    )
    const data = (arch.data as { data?: Record<string, unknown>[] } | undefined)?.data ?? []
    const mine = data.find((r) => String(r.scoreId) === String(id)) ?? null
    if (mine) {
      /**
       * 🆕 2026-10-07（用户要求）：**把服务端判定写回那条本机记录**。
       * 于是记录页里的「有效」在"已真实提交"的行上才是**服务端说的**；
       * 而"仅本地结算 / 演示"的行仍显示本地预判（并明确加前缀）—— 这是用户被绕住的那个点。
       */
      mutateRecords((rs) =>
        applyServerVerdict(rs, id, {
          scorePassType: mine.scorePassType as number | string | undefined,
          scorePassRemark: typeof mine.scorePassRemark === 'string' ? mine.scorePassRemark : undefined,
        }),
      )
      if (!opts.quiet) pushProgress('ok', SUBMIT_PROGRESS.verdictOk(verdictText(mine)))
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
      if (!opts.quiet) pushProgress('warn', SUBMIT_PROGRESS.verdictNone())
      logWarn('submit', '判定暂未在归档中找到', { scantronId: id })
    }
    /**
     * ⚠️ 2026-09-21（冗余加固，审计 B6）：**只把判定写回"属于这条 scantronId"的结果**。
     * 超时核实走的是 `quiet` 分支，而那时 `result.value` 可能还挂着**上一次提交**的结果 ⇒
     * 原先会把它改写成"旧 scantronId + 新判定"这种张冠李戴的内容。
     */
    if (result.value && String(result.value.scantronId) === String(id)) {
      result.value.record = mine
      result.value.verdictText = mine ? verdictText(mine) : '归档里还没找到这条（可稍后再查）'
    }
    return mine
  }

  /**
   * 🆕 2026-10-07（用户要求）：**重发轨迹明细** —— 把"待补交"的那笔轨迹再发一次。
   *
   * 为什么需要：成绩成功后到明细发出前，页面可能被浏览器冻结/丢弃（实测事故），
   * 那笔成绩就会**只有成绩、没有轨迹**（E33 同族）。欠账在成绩成功时就落盘了
   * （含轨迹点本体 ⇒ **逐点重现**同一笔），所以这里能原样重发。
   *
   * ⚠️ **纪律**：**用户点一次发一次** —— 不自动重试、不设定时器、不批量；
   *    每次失败都把服务端原话记进 `lastError`（界面如实显示"已补交 N 次"）。
   */
  const sendDetail = async (cur: PendingDetail): Promise<{ ok: boolean; message: string }> => {
    const tokenNow = session.value?.token
    if (!tokenNow) {
      const msg = '没有可用会话（请先在工作台「一键获取 token」或重新读取真实数据）'
      if (pendingDetail.value?.scantronId === cur.scantronId) patchPendingDetail({ lastError: msg })
      logWarn('submit', '补交轨迹失败：无可用会话', { scantronId: cur.scantronId })
      return { ok: false, message: msg }
    }
    pushProgress('step', `补交轨迹明细（场次 ${cur.scantronId}，${cur.km.toFixed(2)} km）…`)
    const options = { token: tokenNow, baseUrl: session.value?.baseUrl }
    const detail = await MpApiWrapper.saveScoreDetail(
      buildScoreDetailRequest({
        // ⚠️ 明细构造器只用 points / startMs / durationSeconds / scantronId / token，
        //    其余字段是占位（见 `submitPayload.ts` 的注释）—— 这里如实填"能填的"，别编造。
        snCode: profile.value?.snCode ?? '',
        schoolCode: profile.value?.schoolCode ?? '',
        task: task.value,
        line: null,
        paperId: cur.taskId,
        km: cur.km,
        durationSeconds: cur.durationSeconds,
        fitDegree: 0,
        points: cur.points,
        token: tokenNow,
        scantronId: cur.scantronId,
        startMs: cur.startMs,
        endMs: cur.endMs,
      }),
      options,
    )
    // 只有"同一场次"才动那份欠账：用当前这一笔重发时，别去改另一笔的记账
    const samePending = pendingDetail.value?.scantronId === cur.scantronId
    if (detail.ok) {
      if (samePending) clearPendingDetail()
      mutateRecords((rs) => setRecordDetailOk(rs, cur.scantronId, true))
      pushProgress('ok', `补交成功：轨迹明细已提交（场次 ${cur.scantronId}）`)
      logInfo('submit', '补交轨迹明细成功', { scantronId: cur.scantronId, detail: detail.message })
      return { ok: true, message: detail.message || '轨迹提交成功' }
    }
    const msg = detail.message || '轨迹提交失败'
    if (samePending) patchPendingDetail({ attempts: (pendingDetail.value?.attempts ?? 0) + 1, lastError: msg })
    pushProgress('error', `补交失败：${msg}`)
    logWarn('submit', '补交轨迹明细失败', { scantronId: cur.scantronId, message: msg })
    return { ok: false, message: msg }
  }

  /** 补交"落盘的那笔欠账"（跑步页顶部提示卡上的按钮） */
  const resendPendingDetail = async (): Promise<{ ok: boolean; message: string }> => {
    const cur = pendingDetail.value
    if (!cur) return { ok: false, message: '没有待补交的轨迹' }
    return sendDetail(cur)
  }

  /**
   * 🆕 2026-10-07：用**当前结算的这一笔**（内存里那份轨迹）重发明细。
   *
   * 与 `resendPendingDetail` 的区别：那条靠**落盘的**欠账（页面被杀也能用，但轨迹是落盘副本）；
   * 这条直接用界面上的 `run.result.points` + 本次提交的 `startedAt/durationSeconds`
   * ⇒ **逐点与当时完全一致**，且连"欠账都没记上"的历史笔（功能上线前那种）也能救。
   */
  const resendDetail = async (detail: PendingDetail): Promise<{ ok: boolean; message: string }> => sendDetail(detail)

  return {
    phase,
    phaseMessage,
    remainingSeconds,
    result,
    // ⚠️ 对外**键名保持 `progress`**：`components/RunWorkspace.vue` 按 `progress: submitProgress` 解构
    // （值换成 ./state 的单例，调用方无需改动）
    progress: submitProgress,
    submitRealRun,
    fetchVerdict,
    stopWait,
    // 🆕 2026-10-07：补交轨迹明细（成绩成功但明细没发出去时的欠账；用户点一次发一次）
    resendPendingDetail,
    /** 🆕 2026-10-07：用**当前结算这一笔**（内存里那份轨迹）重发明细 —— 逐点与当时一致 */
    resendDetail,
    // 🆕 2026-10-08（用户要求，防 kill 的第二个边界）：跨进程续跑 + 中途叫停
    /** 上次没跑完的作业摘要（`null` = 没有）；界面据此渲染「继续提交 / 作废」卡片 */
    suspendedJob,
    /** 只查一次服务端作业状态（页面打开时用来发现"上次没跑完的提交"） */
    refreshSubmitJobStatus,
    /** 🆕 2026-10-08：**刷新/重开页面后接回正在跑的作业**（只读+只展示；跑完照旧写回结论） */
    reattachServerSubmitJob,
    /** **中途叫停**（只在"还没发出任何写请求"的阶段有效；进入提交阶段会被服务端拒绝） */
    abortServerSubmitJob,
    /** **继续**上次没跑完的提交（用户点一次发一次；由服务端判"接着等 / 立即提交 / 作废"） */
    resumeServerSubmitJob,
    /** **放弃**上次没跑完的那笔（等价于对挂起作业叫停） */
    discardSuspendedSubmitJob,
  }
}

/** 判定文案（`fetchVerdict` 里两处共用；原先内联在赋值处，2026-09-21 提到过程清单后抽出来） */
function verdictText(record: Record<string, unknown>): string {
  return (
    `scorePassType=${record.scorePassType}（${(MP_SCORE_STATUS as Record<number, string>)[Number(record.scorePassType)] ?? '未知'}）` +
    (record.scorePassRemark ? ` | 备注：${record.scorePassRemark}` : '') +
    ` | 里程 ${record.mileage} | 用时 ${record.usedTime} | 拟合度 ${record.trajectorySimilary}`
  )
}
