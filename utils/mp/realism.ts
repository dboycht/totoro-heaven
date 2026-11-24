/**
 * 真实感跑步规划（纯函数，有单测）
 *
 * 2026-09-14 用户要求：现在生成的数据"一眼假" —— 3.20km / 16:00 整 / 拟合度 1.00。
 * 真实学生跑的：里程会**略超任务要求**（超跑一段才停）、配速不是整分钟、
 * 时长自然落到 20:36 这种**非整分钟**、拟合度 0.9x 而不是满分。
 *
 * 设计：
 *   1. 里程 = 要求 × (1 + 0.3%~4.0% 超跑)，保留两位小数（如 3.20 → 3.27）；
 *   2. 配速 = **按档位在段内随机**（`runPaceWindow` 算区间 → `paceGearPoints` 四等分出三档 →
 *      `sampleGearPace` 在所选档的段内均匀随机，避开整分钟）；区间口径见 `runPaceWindow`；
 *   3. 每次跑用不同种子 → 每次数据都不同（`newRunSeed()`）。
 *
 * 🆕 2026-09-29（GitHub issue #13）：**把"配速允许区间"抽成独立纯函数**，并改掉
 *   "先算基线再 clamp 到边界"的旧做法 —— 那是"每次提交都是同一个值、且贴着一侧边界"的根因
 *   （用户原话："实际配速永远是按照官方下发配速的最低要求去上传数据"，详见 `runPaceWindow` 注释）。
 * 🆕 2026-11-24（用户口径）：区间改成**以时长窗为准**（速度窗只兜底）、里程用**实测/规划出来的那个**，
 *   配速改成"四等分三档 + 段内随机"（`PACE_GEARS`）。`sampleRunPace` 退居为**没有可用区间时的兜底**。
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
  /**
   * 🆕 2026-11-24（用户口径）：**配速档位**（区间四等分后的三个分界点之一，
   * 见 `PACE_GEARS`）。模拟路径也按它**在段内随机**；不传按「中速」。
   */
  gear?: PaceGearKey
  /**
   * 用户想要的配速基线（秒/公里，如 360 = 6'00"）。
   * ⚠️ 现在只在**没有可用区间**（任务两个窗都没下发）时兜底；正常任务按 `gear` 采样。
   */
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
   * ⚠️ 任务参数**自相矛盾**（速度窗与时长窗无交集）时为 `true` —— 按时长窗生成（2026-11-24 口径），
   * 结果必然违反速度窗。2026-09-21 用户决定：这种情况**基本不可能**，所以做个"冗余提示"——
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
 * **任务的"配速允许区间"** —— 2026-11-24 起**以时长窗为准**（速度窗只作兜底）。
 *
 * ## 为什么改（用户口径）
 * > "对于真实路径而言，我们就需要考虑其路径长度了，有的真实路径长度达到 4km，
 * >  而整个窗口限制一般是时间，所以我们需要修改一下相关算法"
 *
 * 时长窗是"这段里程要在 10~25 分钟内跑完" ⇒ 换成配速就是 `时长 ÷ 里程`，**里程越大配速越快**：
 * 同一个任务、3.2 km 的真实路径算出 4'41"~7'49"，换成 4 km 的真实路径就收紧成 3'45"~6'15"。
 * 旧实现取"速度窗 ∩ 时长窗"，速度窗（3~15 km/h ⇒ 4'00"~20'00"）会把 4 km 真正该快的时段切掉，
 * 于是 4 km 的真实路径根本选不到"该有的快配速"。
 *
 * ## 判据（唯一来源：跑步引擎、界面档位、单测都读它）
 *   · **有**时长窗（`minTime`/`maxTime` 都是正数，且里程可换算）⇒ `lo/hi = timeLo/timeHi`；
 *   · 没有时长窗 ⇒ 退回速度窗；两个窗都没有 ⇒ `0 ~ Infinity`（采样器再走历史兜底 5'50"~6'20"）；
 *   · 两窗都存在但**无交集** ⇒ 仍然按时长窗（用户口径"窗口一般是时间"），只把 `conflict` 标出来
 *     供界面如实提示（旧版此时以速度窗为准，2026-11-24 改）。
 *
 * ⚠️ `speedLo/speedHi/timeLo/timeHi` 四个字段**一律照算**（界面要显示"任务还没下发哪种窗口"）。
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
  /**
   * 两窗都有、但**无交集**（任务参数自相矛盾）。
   * ⚠️ 2026-11-24 起这只作**提示**：`lo`/`hi` 仍按时长窗（见函数头注释），不再回落到速度窗。
   */
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

  /** ① 有可换算的时长窗 ⇒ **以时长窗为准**（用户 2026-11-24 口径：窗口限制一般是时间） */
  let lo: number
  let hi: number
  if (hasTimeWindow) {
    lo = Math.max(0, timeLo)
    hi = timeHi
  } else if (hasSpeedWindow) {
    /** ② 没有时长窗才退回速度窗 */
    lo = Math.max(0, speedLo)
    hi = speedHi
  } else {
    /** ③ 两个窗都没有：不设界（采样器走历史兜底） */
    lo = 0
    hi = Number.POSITIVE_INFINITY
  }

  /**
   * 两窗都下发、但换算出来的配速区间**无交集** ⇒ 任务参数本身有错。
   * 只标 `conflict` 如实提示（结果仍按时长窗生成），不复核、不猜哪一侧是对的。
   */
  let conflict = false
  let conflictDetail: string | undefined
  if (hasTimeWindow && hasSpeedWindow && !(Math.min(speedHi, timeHi) >= Math.max(speedLo, timeLo))) {
    conflict = true
    conflictDetail =
      `任务参数自相矛盾：速度窗换算配速 ${Math.round(speedLo)}~${Math.round(speedHi)} 秒/公里，` +
      `时长窗换算配速 ${Math.round(timeLo)}~${Math.round(timeHi)} 秒/公里，` +
      `两者无交集（里程约 ${Number.isFinite(km) ? km : 0} km）—— 本次**按时长窗**生成，请把这条任务参数发给开发者核对`
  }
  return { lo, hi, speedLo, speedHi, timeLo, timeHi, hasSpeedWindow, hasTimeWindow, conflict, ...(conflict ? { conflictDetail } : {}) }
}

/**
 * **采样本次配速**（2026-09-29 issue #13 的修法，纯函数、可复现）。
 *
 * 🔄 2026-11-24：**已退居兜底** —— 正常任务（能算出区间）走 `sampleGearPace` 的"档位段内随机"；
 *    只有**两个窗都没下发**（`paceGearPoints()` 返回 `null`）时才会走到这里。
 *
 * 规则（按顺序）：
 *   ① 用户在**区间之内**给的基线 ⇒ **尊重它**，只做 ±3% 浮动（这是"配速策略"这个设置的本意）；
 *   ② 用户在**区间之外**给的基线（典型：某校任务要求 8'34"~14'35" 的慢跑，而默认策略是 6'00"）⇒
 *      **改用"偏快侧的中段"锚点** `fast + 0.62 × span`，再 **±3% 抖动**。
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
 * **配速档位**（2026-11-24 用户口径）—— 区间 `[lo, hi]`（`lo` = 最快）**四等分**，
 * 取三个内部分界点，分别叫「最高速 / 中速 / 低速」：
 *
 * ```
 * lo ──── 0.25 ──── 0.5 ──── 0.75 ──── hi      （秒/公里：左快右慢）
 *          最高速     中速      低速
 * ```
 *
 * 为什么是四等分而不是直接用端点：端点就是窗口边界，贴着边走等于"每笔都卡在极限值"，
 * 正是 2026-09-29 issue #13 要修掉的那个病。三个分界点各自离最近边界都有 1/4 区间余量。
 */
export const PACE_GEARS = [
  { key: 'fast', position: 0.25, label: '最高速' },
  { key: 'mid', position: 0.5, label: '中速' },
  { key: 'slow', position: 0.75, label: '低速' },
] as const

/** 档位键（`fast` 最高速 / `mid` 中速 / `slow` 低速） */
export type PaceGearKey = (typeof PACE_GEARS)[number]['key']

/** 一个档位的配速点与它的随机范围（界面显示与实际采样共用这一份数） */
export interface PaceGearPoint {
  key: PaceGearKey
  /** 在区间里的相对位置（0.25 / 0.5 / 0.75） */
  position: number
  /** 中文名（最高速 / 中速 / 低速） */
  label: string
  /** 这个档位的配速（秒/公里，= 区间上的该分界点） */
  paceSecPerKm: number
  /** **随机半径**（秒/公里）= 一个等分段宽 = `(hi - lo) / 4` */
  radiusSecPerKm: number
  /** 随机下界（已夹到窗口内）= `max(lo, 中心 - 半径)` */
  lo: number
  /** 随机上界（已夹到窗口内）= `min(hi, 中心 + 半径)` */
  hi: number
}

/**
 * 把配速区间切成三个档位点（纯函数）。
 * 区间不可用（非有限 / `hi <= lo`，例如任务两个窗都没下发）⇒ 返回 `null`，
 * 调用方退回旧口径（基线 ±3% / 5'50"~6'20"）。
 */
export function paceGearPoints(window: RunPaceWindow): PaceGearPoint[] | null {
  const lo = Number(window.lo)
  const hi = Number(window.hi)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null
  const span = hi - lo
  const radius = span / 4
  return PACE_GEARS.map((g) => {
    /**
     * ⚠️ 中心**先取整**，档内范围再由这个整数中心推出 —— 否则"界面显示的档位值"与
     * "实际随机范围"会差零点几秒，用户对不上账。
     */
    const center = Math.round(lo + g.position * span)
    return {
      key: g.key,
      position: g.position,
      label: g.label,
      paceSecPerKm: center,
      radiusSecPerKm: radius,
      lo: Math.max(lo, center - radius),
      hi: Math.min(hi, center + radius),
    }
  })
}

/** 取某一个档位点（区间不可用时 `null`） */
export function paceGearOf(window: RunPaceWindow, key: PaceGearKey): PaceGearPoint | null {
  const points = paceGearPoints(window)
  if (!points) return null
  return points.find((p) => p.key === key) ?? points[1] ?? null
}

/**
 * "避开整分钟"（2026-11-18 用户口径"不是 6:00 这种太假的，而是那种 6:11"）：
 * 恰好落在 `x'00"` 时沿随机方向挪 1~9 秒，再夹回窗口。**只由随机/采样路径执行** ——
 * 用户手动在档位里选中的整分钟值不在此列（那是他明确选的）。
 */
const avoidWholeMinute = (pace: number, window: RunPaceWindow, rng: () => number): number => {
  let out = pace
  if (out > 0 && Math.round(out) % 60 === 0) {
    const delta = 1 + Math.floor(rng() * 9)
    out += rng() < 0.5 ? -delta : delta
  }
  if (Number.isFinite(window.lo) && Number.isFinite(window.hi) && window.hi >= window.lo) {
    out = Math.min(Math.max(out, window.lo), window.hi)
  }
  return Math.max(1, Math.round(out))
}

/**
 * **按档位在段内随机抽一个配速**（2026-11-24 用户口径）。
 *
 * 用户原话：「选择相对应的速度后，用户点击随机配速……则以其选择的分割点为中心，
 * 四均分为半径，随机进行抽取」。⇒ 均匀分布在 `[中心 − 半径, 中心 + 半径]`（半径 = 区间 ÷ 4），
 * 夹回窗口，再避开整分钟。
 *
 * 用在两处：**真实路径**的「随机配速」按钮；**模拟路径**结算时自动抽（同一套口径）。
 * 没有可用区间时退回旧口径（`sampleRunPace` 的"基线 ±3% / 5'50"~6'20"）。
 */
export function sampleGearPace(input: {
  gear: PaceGearKey
  window: RunPaceWindow
  /** 只在"没有可用区间"时兜底用的基线配速 */
  basePaceSecPerKm?: number
  /** 只在"没有可用区间"时兜底用的里程 */
  targetKm?: number
  rng: () => number
}): number {
  const point = paceGearOf(input.window, input.gear)
  if (!point) {
    const fallback = sampleRunPace(
      { basePaceSecPerKm: input.basePaceSecPerKm, window: input.window, rng: input.rng },
      Number(input.targetKm) || 0,
    )
    return avoidWholeMinute(fallback, input.window, input.rng)
  }
  const raw = point.lo + input.rng() * (point.hi - point.lo)
  return avoidWholeMinute(Math.min(Math.max(raw, input.window.lo), input.window.hi), input.window, input.rng)
}

/**
 * 界面预览用：**模拟路径的计划里程**（超跑系数取区间中值 2.15%）。
 * ⚠️ 只给界面算"三档配速"用；结算时 `planRealisticRun` 仍用真随机超跑值（0.3%~4.0%）。
 */
export const PLANNED_KM_OVERSHOOT_MID = 0.003 + 0.037 / 2

/** 按"超跑系数中值"预估计划里程（km，两位小数；界面算档位用） */
export function previewPlannedKm(requiredKm: number): number {
  const required = Math.max(0.1, Number(requiredKm) || 0)
  return Number((required * (1 + PLANNED_KM_OVERSHOOT_MID)).toFixed(2))
}

/**
 * 🆕 2026-11-18（用户）：**真实路径的「随机配速」按钮**的唯一来源。
 * 🔄 2026-11-24（用户口径改版）：不再是"基线 ±3%"，而是**在所选档位的段内均匀随机**
 *    （`sampleGearPace`：以该分界点为中心、区间 ÷ 4 为半径，夹回窗口，避开整分钟）。
 *
 * 用户原话：「选择相对应的速度后，用户点击随机配速（仅真实路径），则以其选择的分割点为中心，
 * 五均分为半径，随机进行抽取」—— 2026-11-24 当天更正为**四等分**（三个分界点：最高速/中速/低速）。
 *
 * ⚠️ 真实路径还有"归档用时优先"这一层：有归档用时 ⇒ 结算默认用归档（`resolveRealPathPace`），
 *    只有点了这个按钮才会用随机值覆盖它（`run.realPathPaceSeconds`）。
 */
export function randomRealPathPace(input: {
  /** 当前选中的档位 */
  gear: PaceGearKey
  window: RunPaceWindow
  /** 只在"没有可用区间"时兜底 */
  basePaceSecPerKm?: number
  targetKm?: number
  rng?: () => number
}): number {
  return sampleGearPace({
    gear: input.gear,
    window: input.window,
    basePaceSecPerKm: input.basePaceSecPerKm,
    targetKm: input.targetKm,
    rng: input.rng ?? Math.random,
  })
}

/**
 * 🆕 2026-11-24：**"这次按时长窗生成"要不要提醒一句"**（纯函数，界面直接用）。
 *
 * 时长窗与速度窗**有交集但不等价**时（例：3.2 km 任务要求 10~25 分钟 ⇒ 配速 3'07"~7'49"，
 * 而速度窗 3~15 km/h ⇒ 配速 4'00"~20'00"），按时长窗生成就可能**跑得比任务允许的速度更快**。
 * 用户 2026-11-24 口径是"窗口限制一般是时间"（速度窗仅兜底），所以这里**不拦**，只如实说明。
 *
 * 返回空串 = 不需要提醒（没有速度窗 / 两窗一致 / 时长窗完全落在速度窗内）。
 */
export function paceWindowCrossNote(window: RunPaceWindow): string {
  if (!window.hasTimeWindow || !window.hasSpeedWindow) return ''
  const fastestTime = Number(window.timeLo)
  const fastestSpeed = Number(window.speedLo)
  const slowestTime = Number(window.timeHi)
  const slowestSpeed = Number(window.speedHi)
  const tooFast = Number.isFinite(fastestTime) && Number.isFinite(fastestSpeed) && fastestTime < fastestSpeed - 1
  const tooSlow = Number.isFinite(slowestTime) && Number.isFinite(slowestSpeed) && slowestTime > slowestSpeed + 1
  if (!tooFast && !tooSlow) return ''
  const fmt = (v: number) => `${Math.floor(v / 60)}'${String(Math.round(v % 60)).padStart(2, '0')}"`
  const parts: string[] = []
  if (tooFast) parts.push(`最快档 ${fmt(fastestTime)}/km 快于任务速度窗的 ${fmt(fastestSpeed)}/km`)
  if (tooSlow) parts.push(`最慢档 ${fmt(slowestTime)}/km 慢于任务速度窗的 ${fmt(slowestSpeed)}/km`)
  return `本次按时长窗生成（${parts.join('；')}）—— 任务自己的速度窗与时长窗本来就不一致`
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

  // 3) 在**所选档位段内**采样配速（2026-11-24 用户口径：四等分档位 + 段内随机）
  //    ⚠️ 没有可用区间时才退回旧口径（`sampleGearPace` 内部处理）
  let pace = Math.round(
    sampleGearPace({
      gear: input.gear ?? 'mid',
      window,
      basePaceSecPerKm: input.basePaceSecPerKm,
      targetKm,
      rng,
    }),
  )
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
