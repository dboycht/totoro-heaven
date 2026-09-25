/**
 * 学校登记表 + 开跑前三合一否决门禁（纯函数，零依赖，有单测）
 *
 * 设计目的（2026-09-15，1.1.3）：
 *   1. **支持范围 = 条件式**（2026-09-15 用户明确）：
 *        ① 与南航**共享同一个 API 域**（`wxxcx.xtotoro.com`）；且
 *        ② 该校**没有开启**开跑前的人脸/抽查/摄像头校验
 *      ⇒ 即可支持。**不再是"只支持南航"的白名单**。
 *      （登记表 `VERIFIED_SCHOOLS` 仅用于**标注"判分口径是否已被我们实测验证"**，不再作为放行条件。）
 *   2. **开跑前三合一否决门禁** —— 南航实测（2026-09-14）确认开跑前有三个**服务端强校验**项：
 *      `sunrunStartFace`（开场人脸）、`sunrunPointRandom`（随机抽查）、`camera.getCameraConfig.flag`（摄像头杆）。
 *      任一开启 ⇒ 纯网页/本地伪造轨迹**不成立**，必须在**创建场次之前**拒绝。
 *      ⚠️ 1.1.2 之前这三项**只在界面展示、没有真正拦截**，本模块补上真正的拦截。
 *
 * 门禁原则（宁可挡住，不可放行）：
 *   - 三个开关**未读取**（未知）⇒ 拒绝（不能拿"不知道"当"没开启"）；
 *   - 线路的摄像头 flag 属于**当前选中线路**，未读取该线路 ⇒ 拒绝；
 *   - 专属小程序（非共享域）⇒ 拒绝（那等于另一个后端，不在支持范围）。
 */
import type { MpRunLine } from '../../src/mp/types'

/**
 * **线路不要求时的门禁说明**（`lineRequired: false` 且没选线路时，`reason` 就是它）。
 *
 * ⚠️ 口径纪律：只说**客观事实**（"服务端未下发线路列表"），**不许**写成
 * "服务端不判路线"（我们无法证明服务端在判定时怎么做）—— 与 `utils/mp/taskShape.ts` 的措辞一致。
 */
export const LINE_NOT_REQUIRED_REASON = '本任务未下发线路（不指定路线），无需选择线路'

/** 共享域 host（支持范围判据①：与南航同一个 API 域） */
export const SHARED_DOMAIN_HOST = 'wxxcx.xtotoro.com'

/** 判断某个基址是否属于共享域（支持范围判据①） */
export function isSharedDomain(baseUrl: string | null | undefined): boolean {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return false
  try {
    return new URL(raw).host.toLowerCase() === SHARED_DOMAIN_HOST
  } catch {
    return raw.toLowerCase().includes(SHARED_DOMAIN_HOST)
  }
}

/** 登记表里的一所学校 */
export interface VerifiedSchool {
  /** 学校代码（= GetStudentInfoByToken 的 schoolCode） */
  schoolCode: string
  /** 学校名（展示用） */
  schoolName: string
  /** 判分口径是否已被我们**实测验证**（false = 可用但未验证；仅影响提示，不影响放行） */
  verified: boolean
  /** 验证日期（YYYY-MM-DD）；未验证为 '' */
  verifiedAt: string
  /** 该校实测到的开跑前三个开关状态（供界面展示与回归对照） */
  knownSwitches: {
    sunrunStartFace: string
    sunrunPointRandom: string
    cameraFlag: boolean
  }
  /** 备注（判分口径、任务约束等实测要点） */
  note?: string
}

/**
 * **已验证学校登记表**（唯一支持来源）。
 * ⚠️ 新增学校 = 先做「逐校取证」再在此登记，**不要只加一行就放开**：
 *    取证清单见 HANDOVER.md §7（任务约束 + 三个开关 + 是否专属小程序 + 判分口径验证）。
 */
export const VERIFIED_SCHOOLS: VerifiedSchool[] = [
  {
    schoolCode: '98765',
    schoolName: '南京航空航天大学',
    verified: true,
    verifiedAt: '2026-09-14',
    knownSwitches: { sunrunStartFace: '0', sunrunPointRandom: '0', cameraFlag: false },
    note:
      '唯一实测通过的学校：3.20km / 拟合度阈值 0.60 / 3~15 km/h / 10~25 分钟 / 06:00~23:00 / 围栏 300m；' +
      '三个开关均关闭；2026-09-14 真实提交判 scorePassType=1（有效）。',
  },
]

/** 取一所已登记学校（未登记返回 undefined） */
export function findVerifiedSchool(schoolCode: string | undefined | null): VerifiedSchool | undefined {
  const code = String(schoolCode ?? '').trim()
  if (!code) return undefined
  return VERIFIED_SCHOOLS.find((s) => s.schoolCode === code)
}

/** 该校的**判分口径**是否已被我们实测验证（仅用于提示，不再作为放行条件） */
export function isSchoolVerified(schoolCode: string | undefined | null): boolean {
  return findVerifiedSchool(schoolCode)?.verified === true
}

/**
 * 未验证学校的软披露（不阻断，只提示"判分口径未实测"；已验证或已登记返回空串）。
 * ℹ️ 支持范围本身是**条件式**的（共享域 + 无三类风控校验，见 `isSharedDomain` 与 `evaluateRunGate`），
 *    本函数只负责"这所学校的判分口径我们实测过没有"这一条**非阻断**提示。
 */
export function unverifiedSchoolNotice(schoolCode: string | undefined | null, schoolName?: string): string {
  const code = String(schoolCode ?? '').trim()
  const registered = findVerifiedSchool(code)
  if (registered?.verified) return ''
  const who = code ? `${schoolName || registered?.schoolName || '本校'}（${code}）` : '当前学校'
  const list = VERIFIED_SCHOOLS.filter((s) => s.verified)
    .map((s) => `${s.schoolName}（${s.schoolCode}）`)
    .join('、')
  return `${who} 不在我们实测验证过的名单内（已验证：${list || '（无）'}）：可以开跑，但「判分口径未经实测」，首次提交后请到「记录」页核对是否判为「有效」。`
}

/** 非共享域（专属小程序等）的统一提示语 */
export function nonSharedDomainMessage(baseUrl: string | null | undefined): string {
  const host = (() => {
    try {
      return new URL(String(baseUrl ?? '')).host
    } catch {
      return String(baseUrl ?? '未知域名')
    }
  })()
  return `该校使用独立域（${host}），不在支持范围内（只支持共享域 ${SHARED_DOMAIN_HOST}）。专属小程序等于另一套后端，本项目不支持。`
}

/** 门禁输入：三个开关的读取状态 + 当前线路 */
export interface RunGateInput {
  /** 选择的学校代码（来自学生档案） */
  schoolCode: string | null | undefined
  /** `selectSunRunStartConfiguration` 的 body（null/undefined = 未读取） */
  switches: Record<string, string> | null | undefined
  /** 当前选中线路（**自由跑可为空**） */
  line: MpRunLine | null | undefined
  /** 当前线路的摄像头 flag（null = 未读取；undefined 同） */
  cameraFlag: boolean | null | undefined
  /** 上面那个 flag 对应的线路 id（防止"线路已切换但 flag 还是上一条的"） */
  cameraFlagLineId?: string | null | undefined
  /**
   * 🆕 2026-09-22（issue #12）：**本次任务是否要求指定线路** ——
   * 调用方传 `routeRequirementOf(task).kind === 'line'`（纯函数 `utils/mp/taskShape.ts`）。
   *
   * · 省略 / `true` = **保持历史行为**：没选线路 ⇒ 拒绝（`camera_unknown`）；
   * · `false` = 服务端**未下发线路列表**（自由路线任务）⇒ **不再因"未选线路"拒绝**，
   *   摄像头杆那一段也无从校验（它是**按线路**下发的，没有线路就没有线路级开关可查）。
   *
   * ⚠️ 它**只放宽"线路"这一条**：开关未读 / 开场人脸 / 随机抽查 / 夜间停用一律照旧拦。
   */
  lineRequired?: boolean
  /**
   * 🆕 2026-09-23（pre3）：**本机有没有可用的本机路径几何**（服务端未下发线路时才有意义）。
   * 调用方传 `freeRouteGeometryChoice(entries, task).entry !== undefined`（判据唯一来源）。
   *
   * 🔴 **三态**（2026-09-25 实测事故后明确，别再退回两态）：
   * · `undefined`（**省略**）= **未知 ⇒ 不记也不拦** —— 用于"本机路线库**还没装载**"（`useTrackLibrary().load()` 尚未调用）。
   *   **"没装载"不等于"没有"**：实测在工作台读数据那一刻库里明明有 1 条（`local:free`），两态写法却记了 `no_local_geometry`
   *   （严格模式下会被误拦）。判据来源 = `useTrackLibrary()` 暴露的 `loaded`。
   * · `true` = 已装载且有可用几何 ⇒ 不记；
   * · `false` = **已装载且确认一条都没有** ⇒ 记一条 `no_local_geometry`（严格模式拦；`RELAX_GATE_FOR_CAPTURE=true` 时只提示）。
   */
  localGeometryReady?: boolean
  /**
   * 🆕 2026-09-23（pre3）：**本次判定用不用"放宽"** —— 缺省取模块常量 `RELAX_GATE_FOR_CAPTURE`
   * （pre3 采数据期 = `true`）。显式传 `false` 就是**跑严格那一遍**（单测这么用，保证"改回严格"不会坏）。
   */
  relaxGate?: boolean
  /**
   * 本次跑步类型（提交口径：`0` 阳光跑 / `1` 自由跑）。
   * 自由跑只受夜间停用约束 —— 厂商的自由跑**不打卡、不取线路**（见 `evaluateRunGate` 说明）。
   */
  runType?: 0 | 1
  /** 当前时刻（**可注入**，便于测试；缺省取系统时间） */
  now?: Date
}

/** 门禁命中项代号（`blockedBy` / `warningCodes` 共用） */
export type RunGateBlockCode =
  | 'night'
  | 'switches_unknown'
  | 'start_face'
  | 'point_random'
  | 'camera_on'
  | 'camera_unknown'
  /** 🆕 pre3：服务端未下发线路，而**本机一条可用几何都没有**（严格模式下会拦住） */
  | 'no_local_geometry'

/**
 * 🔴 **门禁"放宽"总开关**（历史：pre3「采集数据专用」；**2026-09-25 已关闸 ⇒ `false`**）
 *
 * 由来：2026-09-23 采数据期，用户要求「用户相关提交的判定松一点，之前那种都是**你自己终止了**导致用户提交不了，
 * 导致我们根本无法采集数据！……**你相关东西要做的不是没读取到就直接终止**」⇒ 那时置 `true`。
 *
 * `true` ⇒ `evaluateRunGate()` **只收集 `warnings`、不阻断**（`allow` 恒为 true，界面**必须**把每条理由如实展示，
 *   并在提交时上报一条诊断事件）；`false` ⇒ **原本的"第一条命中就拦"语义**（= 当前值）。
 *
 * 📌 **2026-09-25 关闸的依据**（不是拍脑袋，是可复算的证据）：拿测试用户在"开着开关"时采到的诊断包做**关门预演** ——
 * 整包 **0 条 `cat:'warn-relaxed'`**（`composables/real/submit.ts` 是"**每个命中项各报一条**"）
 * ⇒ **他按下提交那一刻命中项 = 0** ⇒ 严格模式走同一条路、照样放行。逐条判据见 `DEVELOPMENT.md` §39.5 与
 * `HANDOVER.md` 附录 I.6（含"夜间/人脸/抽查/摄像头杆/未选线路/无本机几何"七条逐项对照）。
 *
 * ⚠️ 它**只放宽"拦不拦"**：报文口径、门禁的判据集合、上报内容一个字都不变；**判据代码一行没删**。
 * 要临时再开回去采数据：把这一行改 `true` 即可（单测两边都覆盖 —— `tests/mp/schoolGate.test.ts` 用 `relaxGate: false` 跑严格那一遍）。
 */
export const RELAX_GATE_FOR_CAPTURE = false

/** 门禁结论 */
export interface RunGateResult {
  /** true = 允许创建场次并开跑（⚠️ 放宽模式下**有命中项也会是 true**，见 `warnings` / `relaxed`） */
  allow: boolean
  /**
   * 拒绝原因（严格模式 `allow=false` 时必填；放宽模式下这里是**第一条命中项**的文案，供夜间提示等复用）。
   * ⚠️ 例外：`lineRequired: false` 且没选线路时**放行**，`reason` 为 `LINE_NOT_REQUIRED_REASON`
   * （说明"这一条为什么不拦"，供日志/诊断核对；界面只在 `!allow` 时把它当错误显示）。
   */
  reason: string
  /** 命中的否决项代号（便于界面/测试断言；放宽模式下 = 第一条命中项） */
  blockedBy?: RunGateBlockCode
  /**
   * 🆕 全部"本该拦住"的理由（严格模式 = 命中项；放宽模式 = **只提示不拦**，界面必须如实展示）。
   * 顺序与判定顺序一致（夜间 → 开关未读 → 开场人脸 → 随机抽查 → 线路/摄像头杆）。
   */
  warnings: string[]
  /** 🆕 与 `warnings` 一一对应的机器码（诊断上报 / 断言用） */
  warningCodes: RunGateBlockCode[]
  /** 🆕 这次判定是否"**放宽放行**"（有命中项但 allow=true）⇒ 提交时要上报一条诊断事件 */
  relaxed: boolean
}

/**
 * **夜间停用时段**（用户 2026-09-16 要求："22:30 后禁止使用，防止出现不必要的麻烦"）。
 *
 * 口径：**22:30 ~ 次日 06:00 停用**（即每天可用窗口 = 06:00~22:30）。
 *   - 为什么延伸到次日 06:00：任务本身的生效时段就是 06:00 起（`runTimeRuleList`），
 *     凌晨其实也跑不了；把整夜都算停用时段，语义更清楚，也不会出现"0 点后又偷偷能用"。
 *   - ⚠️ 只影响**开跑/提交**（门禁前置拦截），**不影响任何判定逻辑**：里程/拟合度/配速/时段自检
 *     与 `scorePassType` 的读回一律照旧（见 `taskRules.ts`，本文件不碰）。
 */
export const NIGHT_BLOCK_START_MIN = 22 * 60 + 30 // 22:30
export const NIGHT_BLOCK_END_MIN = 6 * 60 // 次日 06:00

/** 当前是否处于夜间停用时段 */
export function isNightBlocked(now: Date = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes()
  // 跨零点：>= 22:30 或 < 06:00 都算停用
  return minutes >= NIGHT_BLOCK_START_MIN || minutes < NIGHT_BLOCK_END_MIN
}

/**
 * 夜间停用时的提示文案（含当前时间，便于用户判断）。
 * ⚠️ 2026-09-17 用户澄清口径：夜间只停「**真实提交**」，**本地模拟/预览照旧可用**
 *    （生成轨迹、看自检表与报文预览都不受影响）—— 所以文案里不再写"停止开跑"。
 */
export function nightBlockReason(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return (
    `现在是 ${hhmm}，处于夜间停用时段（22:30~06:00）：为避免不必要的麻烦，已停止真实提交。` +
    `本地模拟与预览仍可正常使用（跑一条看形状、自检、报文预览都可以）；要真提交请在每天 06:00 之后。`
  )
}

/**
 * 开跑前三合一否决门禁（**必须在 `getRunBegin` 之前调用**）。
 * 判定顺序：夜间停用 → 开关是否读到 → 开场人脸 → 随机抽查 → 摄像头杆（含"线路切了但没重查"）。
 * ℹ️ 学校**不再做白名单校验**（支持范围改条件式）；是否"已验证判分口径"只由界面软提示。
 *
 * ⚠️ **自由跑（`runType === 1`）走另一条口径**（2026-09-18 从厂商反编译源码读出）：
 *   厂商在自由跑时**跳过打卡/人脸**直接开跑（`2==runType ? realStartRun() : 显示打卡相机`），
 *   且 `getRunBegin` **不取线路**（`paperId`/`lineId` 都为空串）——
 *   也就是说"开场人脸 / 随机抽查 / 摄像头杆"这三项**都是按学校的阳光跑线路下发的**，与自由跑无关。
 *   所以自由跑：**只受夜间停用约束**，不查开关、不要求线路。
 *   夜间仍然拦：那是"避免留下深夜记录"的自定纪律，与厂商判分无关（用户 2026-09-17 确认的口径）。
 * ⚠️ **服务端未下发线路的任务**（调用方传 `lineRequired: false`，issue #12）：④「未选线路」**不拦**
 *   —— 详见 `RunGateInput.lineRequired` 与下面的分支注释。
 */
export function evaluateRunGate(input: RunGateInput): RunGateResult {
  /** ⓪ 放宽开关（**2026-09-25 起缺省 `false` = 严格**）：`true` 时命中项**只收集不拦**；`false` 时逐字恢复"第一条命中就拦" */
  const relax = input.relaxGate ?? RELAX_GATE_FOR_CAPTURE
  const hits: { code: RunGateBlockCode; reason: string }[] = []
  const hit = (code: RunGateBlockCode, reason: string) => hits.push({ code, reason })
  /** "不拦、但要说一句"的信息（如自由路线任务"无需选择线路"）——与 warnings 分开：它不是"本该拦住"的理由 */
  let info = ''

  // ⓪ 夜间停用（最先判：到点就谁也别跑，避免留下深夜记录）
  const now = input.now ?? new Date()
  if (isNightBlocked(now)) hit('night', nightBlockReason(now))

  /**
   * ⓪′ 自由跑：厂商不打卡、不取线路 ⇒ **跳过下面全部"阳光跑专属"校验**（只有夜间那一条对它有约束）。
   * ⚠️ 与原来逐字一致：自由跑**不查开关**，所以"开关未读"对它不算问题（放宽模式下也不会多出一条 warning）。
   */
  if (input.runType !== 1) {
    // ① 三个开关必须已读取（未知 ≠ 关闭）
    if (!input.switches || typeof input.switches !== 'object') {
      hit('switches_unknown', '尚未读取学校的开跑开关（人脸 / 随机抽查），请先在工作台「读取真实账号与任务」。')
    } else {
      // ② 开场人脸
      if (String(input.switches.sunrunStartFace ?? '') === '1') {
        hit(
          'start_face',
          '本任务「开场人脸校验」已开启（sunrunStartFace=1）：需要实时拍摄，网页无法完成 —— 已停止，未创建场次。',
        )
      }
      // ③ 随机人脸抽查
      if (String(input.switches.sunrunPointRandom ?? '') === '1') {
        hit(
          'point_random',
          '本任务「随机人脸抽查」已开启（sunrunPointRandom=1）：跑动中会弹脸，网页无法完成 —— 已停止，未创建场次。',
        )
      }
    }

    // ④ 线路 / 摄像头杆（**按线路**下发，且必须确认是"当前这条线路"的 flag）
    const lineId = String(input.line?.pointId ?? '')
    if (!lineId) {
      /**
       * - 默认（`lineRequired` 省略/true）⇒ 没选线路就记一条（严格模式拦，`relax=true` 时只提示）；
       * - `lineRequired === false`（服务端未下发线路 = 自由路线任务）⇒ **不因"未选线路"记**，
       *   只说明依据（`LINE_NOT_REQUIRED_REASON`）；但**确认本机一条可用几何都没有**时记 `no_local_geometry`
       *   （严格模式会拦：没有几何就没法生成轨迹）。
       * 🔴 **只有显式 `false` 才记**：`undefined` = "本机库还没装载" = **未知** ⇒ 不记（2026-09-25 修复，见 `RunGateInput.localGeometryReady`）。
       */
      if (input.lineRequired === false) {
        info = LINE_NOT_REQUIRED_REASON
        if (input.localGeometryReady === false) {
          hit(
            'no_local_geometry',
            '这台电脑还没有可用的本机路径几何（本任务未下发线路）：轨迹没法生成 —— 请先在「非官方路径【测试】」画一条。',
          )
        }
      } else {
        hit('camera_unknown', '尚未选择跑步线路。')
      }
    } else {
      const flagLineId = String(input.cameraFlagLineId ?? '')
      if (input.cameraFlag === null || input.cameraFlag === undefined || flagLineId !== lineId) {
        hit(
          'camera_unknown',
          '当前线路的「摄像头杆」开关尚未读取（切换线路后需重新读取）——为避免误提交，已停止。',
        )
      } else if (input.cameraFlag === true) {
        hit(
          'camera_on',
          '当前线路启用了「摄像头杆过点校验（getCameraConfig.flag=true）」：需真人到杆附近拍摄，网页无法完成 —— 已停止，未创建场次。',
        )
      }
    }
  }

  const warningCodes = hits.map((h) => h.code)
  const warnings = hits.map((h) => h.reason)
  if (!hits.length) return { allow: true, reason: info, warnings: [], warningCodes: [], relaxed: false }

  /**
   * 🔴 pre3 采数据期：命中项**只警告、不阻断** —— `allow` 仍为 true，界面必须把 `warnings` 如实展示，
   * 提交时另上报一条诊断事件（"这笔提交是在放宽状态下发生的"）。
   * 严格模式（`relax === false`）⇒ **逐字恢复"第一条命中就拦"**（`reason`/`blockedBy` 取第一条）。
   */
  if (relax) {
    return { allow: true, reason: warnings[0]!, blockedBy: warningCodes[0], warnings, warningCodes, relaxed: true }
  }
  return { allow: false, reason: warnings[0]!, blockedBy: warningCodes[0], warnings, warningCodes, relaxed: false }
}
