/**
 * 真实感跑步规划（纯函数，有单测）
 *
 * 2026-09-14 用户要求：现在生成的数据"一眼假" —— 3.20km / 16:00 整 / 拟合度 1.00。
 * 真实学生跑的：里程会**略超任务要求**（超跑一段才停）、配速不是整分钟、
 * 时长自然落到 20:36 这种**非整分钟**、拟合度 0.9x 而不是满分。
 *
 * 设计：
 *   1. 里程 = 要求 × (1 + 2%~9% 超跑)，保留两位小数（如 3.20 → 3.41）；
 *   2. 配速 = **在"任务允许区间"内采样**：区间 = 速度窗 ∩ 时长窗（`runPaceWindow`），
 *      采样策略见 `sampleRunPace`（基线在区间内就尊重它 ±3%；不在就取"中段偏快"锚点 ±3%）；
 *   3. 每次跑用不同种子 → 每次数据都不同（`newRunSeed()`）。
 *
 * 🆕 2026-09-29（GitHub issue #13）：**把"配速允许区间"抽成独立纯函数**，并改掉
 *   "先算基线再 clamp 到边界"的旧做法 —— 那是"每次提交都是同一个值、且贴着一侧边界"的根因
 *   （用户原话："实际配速永远是按照官方下发配速的最低要求去上传数据"，详见 `runPaceWindow` 注释）。
 */
export interface RunPlanInput {
  /** 任务要求里程（km） */
  requiredKm: number
  /** 速度上下限（km/h）——实测任务字段 minSpeed / maxSpeed */
  minSpeedKmh?: number | string
  maxSpeedKmh?: number | string
  /** 时长上下限（分钟）——实测任务字段 minTime / maxTime */
  minMinutes?: number | string
  maxMinutes?: number | string
  /** 用户想要的配速基线（秒/公里，如 360 = 6'00"）；不传则按 5'50"~6'20" 随机 */
  basePaceSecPerKm?: number
  /** 随机种子（不传则用时间派生） */
  seed?: number
}

export interface RunPlan {
  /** 实际里程（km，两位小数，≥ 要求） */
  targetKm: number
  /** 实际配速（秒/公里，整数） */
  paceSecPerKm: number
  /** 超跑比例（0.003~0.04；3.2km 任务 → 3.21~3.33km） */
  overshootRatio: number
  /** 预计时长（秒）= targetKm × paceSecPerKm（只作展示/规划，实际以模拟推进为准） */
  durationSeconds: number
  /**
   * ⚠️ 任务参数**自相矛盾**（速度窗与时长窗无交集）时为 `true` —— 此时计划只能以速度窗为准，
   * 结果必然违反时长窗。2026-09-21 用户决定：这种情况**基本不可能**，所以做个"冗余提示"——
   * 如实告警并请用户把参数发给开发者，不要静默糊过去。
   */
  windowConflict?: boolean
  /** 冲突时的可读说明（含两侧窗口与里程，方便用户直接发给开发者） */
  windowConflictDetail?: string
}

/**
 * mulberry32（与 generateRoute 同款，保证同种子可复现）。
 * 🆕 2026-09-29：导出（改名前叫内部函数 `createRng`）—— 单测要**按种子复现**采样结果
 * （`sampleRunPace` 收的是一个 `rng` 函数），不导出就只能靠"多跑几次看像不像随机"，
 * 那种断言证明不了"同种子可复现"。
 */
export function createRngFromSeed(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 每次跑都不同（时间派生种子） */
export function newRunSeed(): number {
  return (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0
}

/**
 * **任务的"配速允许区间"** = 速度窗 ∩ 时长窗（两个窗口都换算成"秒/公里"再取交集）。
 *
 * ## 为什么要把它单独拿出来（2026-09-29，GitHub issue #13）
 * 用户反馈："实际配速**永远是按照官方下发配速的最低要求**去上传数据……配速在能修改的情况下需要引入随机性"。
 * 回源码取证后的根因就在**"夹紧"这一个动作**上：原实现是
 * 「基线配速 ±3% → `clamp(交集的 lo, hi)`」，而基线**落在交集之外**时，
 * `clamp` 必然把它推到**边界**上 ⇒ 每一笔提交都是同一个值、且贴着窗口的一侧
 * （研途健行实测：速度 4~7 km/h ⇒ 514~900 秒/公里，时长 20~35 分钟 / 2.4 km ⇒ 500~875 秒/公里，
 *  交集 = 514~875；界面基线 6'00" = 360 秒/公里 远在快侧之外 ⇒ 每次都夹成 **514**）。
 *
 * ⇒ 判据（可执行）：**"随机性"必须发生在"允许区间之内"，不能靠"夹紧一个越界的基线"来产生**。
 *    本函数只负责把区间算出来（唯一来源），采样策略在 `sampleRunPace()` 里，界面也直接读它显示。
 *
 * ⚠️ 两个窗口**矛盾**（无交集，任务参数本身有错）时：如实标 `conflict` 并**以速度窗为准**
 *    （与 2026-09-21 的既有口径一致，见 `planRealisticRun` 的 `windowConflict` 冗余提示）。
 */
export interface RunPaceWindow {
  /** 最快允许配速（秒/公里；越小越快）。没有任何约束时为 0 */
  lo: number
  /** 最慢允许配速（秒/公里；越大越慢）。没有任何约束时为 `Infinity` */
  hi: number
  /** 速度窗换算出来的配速区间（任务没下发速度 ⇒ 0 ~ Infinity） */
  speedLo: number
  speedHi: number
  /** 时长窗换算出来的配速区间（任务没下发时长 ⇒ 0 ~ Infinity） */
  timeLo: number
  timeHi: number
  /** 是否**真的**下发了速度窗（下发了才好在界面上标"任务要求"） */
  hasSpeedWindow: boolean
  /** 是否**真的**下发了时长窗 */
  hasTimeWindow: boolean
  /** 两窗无交集（任务参数矛盾）—— 此时 `lo`/`hi` 回落到速度窗 */
  conflict: boolean
  /** 冲突时给人看的一句说明（含两侧窗口与里程） */
  conflictDetail?: string
}

/** `RunPaceWindow` 的入参（与 `RunPlanInput` 的前四个字段同形） */
export type RunPaceWindowInput = Pick<RunPlanInput, 'requiredKm' | 'minSpeedKmh' | 'maxSpeedKmh' | 'minMinutes' | 'maxMinutes'>

/**
 * 算出**配速允许区间**（唯一判据来源：跑步引擎、界面显示、单测都读它）。
 * `targetKm` 非法（≤ 0 / 非数字）时按时长窗**无法换算**处理（只有速度窗生效），绝不抛。
 */
export function runPaceWindow(input: RunPaceWindowInput, targetKm: number): RunPaceWindow {
  const km = Number(targetKm)
  const minSpeed = Number(input.minSpeedKmh)
  const maxSpeed = Number(input.maxSpeedKmh)
  const hasSpeedWindow = (Number.isFinite(minSpeed) && minSpeed > 0) || (Number.isFinite(maxSpeed) && maxSpeed > 0)
  /** 速度 km/h → 配速 秒/公里：**上限速度给最快配速**，下限速度给最慢配速 */
  const speedLo = Number.isFinite(maxSpeed) && maxSpeed > 0 ? 3600 / maxSpeed : 0
  const speedHi = Number.isFinite(minSpeed) && minSpeed > 0 ? 3600 / minSpeed : Number.POSITIVE_INFINITY

  const minMin = Number(input.minMinutes)
  const maxMin = Number(input.maxMinutes)
  const hasTimeWindow = Number.isFinite(minMin) && minMin > 0 && Number.isFinite(maxMin) && maxMin > 0 && km > 0
  const timeLo = hasTimeWindow ? (minMin * 60) / km : 0
  const timeHi = hasTimeWindow ? (maxMin * 60) / km : Number.POSITIVE_INFINITY

  let lo = Math.max(0, speedLo, hasTimeWindow ? timeLo : 0)
  let hi = Math.min(speedHi, hasTimeWindow ? timeHi : Number.POSITIVE_INFINITY)

  let conflict = false
  let conflictDetail: string | undefined
  if (!(hi >= lo)) {
    conflict = true
    conflictDetail =
      `任务参数自相矛盾：速度窗换算配速 ${Math.round(speedLo)}~${Math.round(speedHi)} 秒/公里，` +
      `时长窗换算配速 ${Math.round(timeLo)}~${Math.round(timeHi)} 秒/公里，` +
      `两者无交集（里程约 ${Number.isFinite(km) ? km : 0} km）—— 本次按速度窗生成，请把这条任务参数发给开发者核对`
    lo = speedLo
    hi = speedHi
  }
  return { lo, hi, speedLo, speedHi, timeLo, timeHi, hasSpeedWindow, hasTimeWindow, conflict, ...(conflict ? { conflictDetail } : {}) }
}

/**
 * **采样本次配速**（2026-09-29 issue #13 的修法，纯函数、可复现）。
 *
 * 规则（按顺序）：
 *   ① 用户在**交集之内**给的基线 ⇒ **尊重它**，只做 ±3% 浮动（这是"配速策略"这个设置的本意）；
 *   ② 用户在**交集之外**给的基线（典型：某校任务要求 8'34"~14'35" 的慢跑，而默认策略是 6'00"）⇒
 *      **改用"交集偏快侧的中段"锚点** `fast + 0.62 × span`，再 **±3% 抖动**。
 *      为什么不取正中：跑步任务里挑"偏快一点"更符合真实学生行为，同时**离两侧边界都还有余量**
 *      （正中只留一半余量，反而容易在结算时被夹回边界 —— 那正是本次要修掉的病）；
 *   ③ `windowConflict`（两窗无交集）⇒ 锚点取**中段偏快**（不能取正中，怕边界）。
 *
 * ⚠️ 允许区间退化成一个点（`hi === lo`，极端任务）⇒ 只能返回那个点（如实、不假装随机）。
 * ⚠️ 返回值**不做夹紧**：调用方若要严格落在区间内，请自行夹到 `[window.lo, window.hi]`
 *    （`planRealisticRun` 就是这么做的）。
 */
export function sampleRunPace(
  input: { basePaceSecPerKm?: number; window: RunPaceWindow; rng: () => number },
  targetKm: number,
): number {
  const { lo, hi } = input.window
  const km = Number(targetKm)
  const base = Number(input.basePaceSecPerKm)
  const hasBase = Number.isFinite(base) && base > 0
  /** 真有"可选择"的区间（`hi > lo`）；退化成一点时它是 false，但**那一点仍然是硬约束** */
  const hasSpan = Number.isFinite(hi) && hi > lo
  const hasTimeWindow = input.window.hasTimeWindow && km > 0
  /**
   * ⚠️ 区间退化成一点（极端任务：速度窗与时长窗恰好只交出一个配速）⇒ **必须尊重那个点**。
   *    这里显式判它，否则会掉进"中段偏快"的分支上算出 `NaN`（`0.62 × 0` 的分母没问题、
   *    但 `lo`/`hi` 相等时 `anchor` 仍能算 —— 真正的坑是**既没有区间也没有基线**那条分支）。
   */
  const degenerate = !hasSpan && Number.isFinite(hi) && Number.isFinite(lo) && hi === lo
  /** ① 基线**满足**硬约束（在区间内，或恰好等于退化点）⇒ 尊重用户设置 */
  const baseRespects = hasBase && ((hasSpan && base >= lo && base <= hi) || (degenerate && base === lo))
  let anchor: number
  if (baseRespects || (hasBase && !hasSpan && !degenerate && !hasTimeWindow)) {
    anchor = base
  } else if (hasSpan) {
    /** ② 中段偏快（0.62 = "偏快但离两侧边界都还有余量"的位置，见函数头注释） */
    anchor = lo + 0.62 * (hi - lo)
  } else if (degenerate) {
    anchor = lo
  } else if (hasBase) {
    anchor = base
  } else {
    /** 连窗口都没有（任务两个窗口都没下发）⇒ 保持历史口径 5'50"~6'20" */
    anchor = 350 + input.rng() * 30
  }
  /** ③ ±3% 抖动 ⇒ 数值非整分钟；再夹回区间（有区间时；退化成一点时夹紧等于原样返回该点） */
  let pace = anchor * (0.97 + input.rng() * 0.06)
  if (Number.isFinite(hi) && Number.isFinite(lo) && hi >= lo && (hasSpan || degenerate)) {
    pace = Math.min(Math.max(pace, lo), hi)
  }
  return pace
}

/**
 * 🆕 2026-11-18（用户）：**真实路径的「随机配速」按钮**的唯一来源。
 *
 * 用户原话：「不是 6:00 这种太假的，而是那种 6:11 这种」。
 *   · 有归档用时 ⇒ 结算**优先用归档**（`resolveRealPathPace`），不用这里；
 *   · 没有归档用时 ⇒ 由用户在上方选基线，再按这个函数随机抖动（仍落在任务允许区间内）。
 *
 * 口径：`sampleRunPace()`（与模拟跑**同一个采样器**）→ 取整 → 夹回允许区间 →
 * **避开整分钟**（恰好转出 `x'00"` 时沿随机的方向挪 1~9 秒，再夹一次）。
 * ⚠️ 「避开整分钟」只由这个按钮强制执行；用户从下拉里主动选 5'30"/6'00" 仍然照用。
 */
export function randomRealPathPace(input: {
  /** 当前配速（秒/公里）；非法则退回模块默认档 */
  basePaceSecPerKm?: number
  window: RunPaceWindow
  targetKm: number
  rng?: () => number
}): number {
  const rng = input.rng ?? Math.random
  let pace = Math.round(
    sampleRunPace({ basePaceSecPerKm: input.basePaceSecPerKm, window: input.window, rng }, input.targetKm),
  )
  const { lo, hi } = input.window
  if (Number.isFinite(lo) && Number.isFinite(hi)) pace = Math.min(Math.max(pace, lo), hi)
  if (pace > 0 && pace % 60 === 0) {
    const delta = 1 + Math.floor(rng() * 9)
    pace += rng() < 0.5 ? -delta : delta
    if (Number.isFinite(lo) && Number.isFinite(hi)) pace = Math.min(Math.max(pace, lo), hi)
  }
  return Math.max(1, Math.round(pace))
}

export function planRealisticRun(input: RunPlanInput): RunPlan {
  const rng = createRngFromSeed(input.seed ?? newRunSeed())
  const required = Math.max(0.1, Number(input.requiredKm) || 3)

  // 1) 超跑 **+0.3%~+4.0%**（2026-09-16 用户要求：3.2 km 任务 → 实跑 **3.21~3.33 km**，更贴近真跑）
  //    ⚠️ 真实提交的 km 是"轨迹累计长度"，会在 target 基础上再溢出几米（收尾最后一步），
  //       所以上限留了点余量；实际产物落在 3.21~3.34 km（用户要的区间是 3.21~3.35）。
  const overshootRatio = 0.003 + rng() * 0.037
  const targetKm = Number((required * (1 + overshootRatio)).toFixed(2))

  // 2) 任务的**配速允许区间**（唯一来源；界面显示与这里算的是同一个函数）
  const window = runPaceWindow(input, targetKm)

  // 3) 在允许区间内**采样**配速（2026-09-29 issue #13：不再靠"夹紧越界基线"产生随机性）
  let pace = Math.round(sampleRunPace({ basePaceSecPerKm: input.basePaceSecPerKm, window, rng }, targetKm))
  /**
   * 4) 兜底夹紧（等价于原来的 `clamp(lo, hi)`，但正常路径下**根本不会触发** —— 采样本来就在区间内）。
   *    ⚠️ 保留它只为"退化区间 / 冲突窗口"这类极端输入仍然绝不越界。
   */
  pace = Math.min(Math.max(pace, window.lo), window.hi)

  return {
    targetKm,
    paceSecPerKm: pace,
    overshootRatio,
    durationSeconds: Math.round(targetKm * pace),
    // 只在真的冲突时才带这两个字段（正常任务里它们不存在，避免污染常规产物）
    ...(window.conflict ? { windowConflict: true, windowConflictDetail: window.conflictDetail } : {}),
  }
}
