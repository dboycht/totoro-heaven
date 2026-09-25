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
import { classifyWriteOutcome, outcomeIsSuccess, writeOutcomeMessage } from '~/utils/mp/writeOutcome'
// 提交过程清单的文案（2026-09-21 用户要求"要能看到现在在传什么"）
import {
  SUBMIT_PROGRESS,
  submitProgressLine,
  type SubmitProgressKind,
} from '~/utils/mp/submitProgress'
// 🆕 2026-09-21（E 自由跑入口标灰）："是不是未开通自由跑"的判据在纯逻辑层（单一来源）
import { isFreeRunUnsupportedMessage } from '~/utils/mp/freeRun'
import { useRealState, type RealSubmitResult } from './state'

export function useMpRealSubmit() {
  const { session } = useMpSession()
  const { profile, task, switches, cameraFlag, cameraFlagLineId, phase, phaseMessage, remainingSeconds, result, submitProgress, markFreeRunUnsupported } =
    useRealState()
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
      // 若失败原因是 token 过期 → 给"退出登录并重新登录小程序"的可操作提示
      phaseMessage.value = looksLikeTokenExpired(begin.raw)
        ? TOKEN_EXPIRED_HINT
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
      logError('submit', '开跑失败（getRunBegin）', {
        message: begin.message,
        // 日志里如实区分三种情形（自由跑 / 本任务未下发线路 / 有线路）
        lineId: input.line?.pointId ?? (freeRun ? '(自由跑)' : '(本任务未下发线路)'),
        paperId,
        ...(noFreeRunTask ? { note: '服务端未开通自由跑任务（2026-09-21 实测）' } : {}),
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

    // ② 真实等待（安全设计：让 endTime-startTime 与服务器观测一致）
    const planned = Math.max(1, Math.round(input.plannedSeconds))
    phase.value = 'waiting'
    remainingSeconds.value = planned
    phaseMessage.value = `会话已创建，正在「跑」：为了让时间线一致，需真实等待 ${Math.ceil(planned / 60)} 分钟`
    pushProgress('step', SUBMIT_PROGRESS.wait(planned, input.km))
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
      pushProgress('error', '等待期间会话/档案被清除 → 本次提交中止（未发送成绩）')
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
    pushProgress('ok', SUBMIT_PROGRESS.waitDone())

    // ③ 提交成绩（写；只发一次，失败不重试）
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
      startMs: startedAt,
      endMs: submittedAt,
    }
    phase.value = 'submitting'
    phaseMessage.value = '正在提交成绩（sunRunExercises）…'
    // ⚠️ 自由跑必须把 runType 传进报文构造器：它决定 taskId=''、sunrunPathPointList=[]
    //    （厂商源码：自由跑不带任务号、路径点列为空数组）
    const usedTimeText = `${String(Math.floor(planned / 60)).padStart(2, '0')}:${String(planned % 60).padStart(2, '0')}`
    pushProgress('step', SUBMIT_PROGRESS.score(input.km, input.line?.pointList?.length ?? 0, usedTimeText))
    const scoreStartedAt = Date.now()
    const score = await MpApiWrapper.saveScores(buildScoreRequest(context, { runType }), options)
    const scoreMs = Date.now() - scoreStartedAt

    /**
     * ⚠️ **2026-09-21 修 GitHub issue #11（有实测日志）**：**超时 ≠ 失败**。
     *
     * 用户的服务端日志原文：厂商回 `{"message":"提交成功"}`、本地代理耗时 **`ms:15404`**，
     * 而客户端超时上限是 **15000 ms** ⇒ 浏览器只比真实响应早放弃 **404 毫秒**。
     * 结果：界面报"提交失败"、**轨迹明细被跳过**，可成绩其实已经入库（用户称"假报错"）。
     *
     * 判据：写操作超时后**必须去服务端核实**（`fetchVerdict` 按 `scantronId` 查归档）：
     *   · 核实到已入库 ⇒ 按成功继续，并**补交轨迹明细**（把缺掉的那一步补上）；
     *   · 核实不到     ⇒ 只能说"**结果未知**"并明确"**请勿立即重复提交**"
     *     （重复提交会多录一条成绩，比缺轨迹严重得多）。
     */
    let landedAfterTimeout: boolean | null = null
    if (!score.ok && score.timedOut) {
      phaseMessage.value = '提交请求超时，正在向服务端核实是否已入库…'
      pushProgress('warn', SUBMIT_PROGRESS.scoreTimeout(scoreMs))
      logWarn('submit', '提交超时（结果未知），开始核实是否已入库', { scantronId, message: score.message })
      /**
       * ⚠️ **2026-09-21 审计修复（B1，本轮最关键）**：核实**必须延时重试**。
       *
       * 项目自己的实测（`DEVELOPMENT.md` §27）明确写着：**提交后"立刻"读回 `getSunrunArch` 是读不到的**
       * （回 `total=0`，要过几分钟才可见）。所以第一版"超时后立刻查一次"几乎必然查不到
       * ⇒ 承诺的"自动补交轨迹明细"形同虚设，issue #11 的第二半（轨迹仍被跳过）实际没修好。
       *
       * 判据：**核实的时机要匹配"服务端可见延迟"** —— 3 s / 8 s / 20 s 三次递进重试，命中即停；
       * 一旦外部复位了状态（清空本机数据等）就立刻放弃，不做无谓等待。
       */
      const delays = [3_000, 8_000, 20_000]
      for (const waitMs of delays) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
        if (phase.value !== 'submitting') {
          logWarn('submit', '核实期间状态被外部复位，停止核实', { scantronId, phase: phase.value })
          break
        }
        try {
          landedAfterTimeout = Boolean(await fetchVerdict(scantronId, { quiet: true }))
        } catch (err) {
          landedAfterTimeout = null
          logWarn('submit', '超时后的核实失败（保持"未知"）', {
            scantronId,
            message: err instanceof Error ? err.message : String(err),
          })
        }
        if (landedAfterTimeout) break
      }
      if (!landedAfterTimeout) {
        logWarn('submit', `超时后核实三次仍未在归档中找到（可能仍在处理）`, { scantronId, delays })
      }
    }
    const outcome = classifyWriteOutcome(score, landedAfterTimeout)
    const scoreOk = outcomeIsSuccess(outcome)
    const scoreMessage = outcome === 'ok' ? score.message || '提交成功' : writeOutcomeMessage(outcome, score.message)
    // 过程清单：把这一步的结论如实打出来（**超时 ≠ 失败**，未知态要说清"别急着重试"）
    if (outcome === 'ok') pushProgress('ok', SUBMIT_PROGRESS.scoreOk(scoreMs))
    else if (outcome === 'timeout-landed') pushProgress('ok', SUBMIT_PROGRESS.scoreVerified())
    else if (outcome === 'timeout-unknown') pushProgress('warn', SUBMIT_PROGRESS.scoreUnknown())
    else pushProgress('error', SUBMIT_PROGRESS.scoreFail(scoreMessage))

    const out: RealSubmitResult = {
      scantronId,
      startedAt,
      submittedAt,
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

    // ④ 轨迹明细（**成绩成功，或"超时但已核实入库"**时都要发；照源码顺序）
    if (scoreOk) {
      phaseMessage.value = '成绩已提交，正在提交轨迹明细（sunRunExercisesDetail）…'
      pushProgress('step', SUBMIT_PROGRESS.detail(context.points.length))
      const detailStartedAt = Date.now()
      const detail = await MpApiWrapper.saveScoreDetail(buildScoreDetailRequest(context), options)
      const detailMs = Date.now() - detailStartedAt
      out.detailOk = detail.ok
      out.detailMessage = detail.message || (detail.ok ? '轨迹提交成功' : '轨迹提交失败')
      if (detail.ok) {
        pushProgress('ok', SUBMIT_PROGRESS.detailOk(detailMs))
        logInfo('submit', '轨迹明细已提交', { detail: out.detailMessage })
      } else {
        pushProgress('error', SUBMIT_PROGRESS.detailFail(out.detailMessage))
        logWarn('submit', '轨迹明细提交失败', { message: out.detailMessage })
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
    if (phase.value !== 'submitting') {
      // ① phase 已被外部复位（清空本机数据）⇒ 静默返回，不写回
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
        : looksLikeTokenExpired(score.raw)
          ? TOKEN_EXPIRED_HINT
          : `提交失败：${out.scoreMessage}`
    if (scoreOk) {
      logInfo('submit', outcome === 'timeout-landed' ? '提交超时，但已核实成绩入库（按成功处理）' : '成绩提交成功', {
        scantronId,
        km: Number(input.km.toFixed(2)),
        durationSeconds: planned,
        fitDegree: input.fitDegree,
        waitedSeconds: Math.round((submittedAt - startedAt) / 1000),
        ...(outcome === 'timeout-landed' ? { note: '首次请求超时，已按 scantronId 在服务端归档中核实' } : {}),
      })
      // 超时核实的那条：把判定读回来填进结果（先前那次核实发生在 `result` 赋值之前，判定文本要重取一次才有）
      if (outcome === 'timeout-landed') {
        try {
          await fetchVerdict(scantronId)
        } catch {
          /* 只读补充信息：失败不影响"提交已成功"这个结论 */
        }
      }
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
        waitedSeconds: Math.round((submittedAt - startedAt) / 1000),
      },
    )
    return out
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
