/**
 * 真实感跑步规划（纯函数，有单测）
 *
 * 2026-09-14 用户要求：现在生成的数据"一眼假" —— 3.20km / 16:00 整 / 拟合度 1.00。
 * 真实学生跑的：里程会**略超任务要求**（超跑一段才停）、配速不是整分钟、
 * 时长自然落到 20:36 这种**非整分钟**、拟合度 0.9x 而不是满分。
 *
 * 设计：
 *   1. 里程 = 要求 × (1 + 2%~9% 超跑)，保留两位小数（如 3.20 → 3.41）；
 *   2. 配速 = 用户策略基线 × ±3% 微调，并**夹紧到任务窗口**（速度 km/h ∈ [min,max]、
 *      时长分钟 ∈ [min,max]），保证数值非整、又在约束内；
 *   3. 每次跑用不同种子 → 每次数据都不同（`newRunSeed()`）。
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

/** mulberry32（与 generateRoute 同款，保证同种子可复现） */
function createRng(seed: number): () => number {
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

export function planRealisticRun(input: RunPlanInput): RunPlan {
  const rng = createRng(input.seed ?? newRunSeed())
  const required = Math.max(0.1, Number(input.requiredKm) || 3)

  // 1) 超跑 **+0.3%~+4.0%**（2026-09-16 用户要求：3.2 km 任务 → 实跑 **3.21~3.33 km**，更贴近真跑）
  //    ⚠️ 真实提交的 km 是"轨迹累计长度"，会在 target 基础上再溢出几米（收尾最后一步），
  //       所以上限留了点余量；实际产物落在 3.21~3.34 km（用户要的区间是 3.21~3.35）。
  const overshootRatio = 0.003 + rng() * 0.037
  const targetKm = Number((required * (1 + overshootRatio)).toFixed(2))

  // 2) 配速基线：用户策略 or 5'50"~6'20"
  const base = input.basePaceSecPerKm ?? 350 + rng() * 30

  // 3) ±3% 微调 → 非整分钟
  let pace = base * (0.97 + rng() * 0.06)

  // 4) 夹紧到任务窗口 —— ⚠️ 必须**求交集**（快/慢、时长的上下限各给一个区间，取交）
  let lo = 0 // 最快允许配速（秒/公里）
  let hi = Number.POSITIVE_INFINITY // 最慢允许配速
  const minSpeed = Number(input.minSpeedKmh)
  const maxSpeed = Number(input.maxSpeedKmh)
  const speedLo = Number.isFinite(maxSpeed) && maxSpeed > 0 ? 3600 / maxSpeed : 0
  const speedHi = Number.isFinite(minSpeed) && minSpeed > 0 ? 3600 / minSpeed : Number.POSITIVE_INFINITY
  lo = Math.max(lo, speedLo)
  hi = Math.min(hi, speedHi)
  const minMin = Number(input.minMinutes)
  const maxMin = Number(input.maxMinutes)
  const hasTimeWindow = Number.isFinite(minMin) && minMin > 0 && Number.isFinite(maxMin) && maxMin > 0
  if (hasTimeWindow) {
    lo = Math.max(lo, (minMin * 60) / targetKm)
    hi = Math.min(hi, (maxMin * 60) / targetKm)
  }
  let windowConflict = false
  let windowConflictDetail: string | undefined
  if (!(hi >= lo)) {
    /**
     * ⚠️ 两个窗口冲突（任务参数本身矛盾）→ 以速度窗口为准。
     * 🆕 2026-09-21（用户要求"做个冗余提示"）：**如实报出来**，不要静默——
     * 这种任务本身不可能同时满足两个窗口，用户应当把参数发给开发者核对。
     */
    windowConflict = true
    windowConflictDetail =
      `任务参数自相矛盾：速度窗换算配速 ${Math.round(speedLo)}~${Math.round(speedHi)} 秒/公里，` +
      `时长窗换算配速 ${Math.round((minMin * 60) / targetKm)}~${Math.round((maxMin * 60) / targetKm)} 秒/公里，` +
      `两者无交集（里程约 ${targetKm} km）—— 本次按速度窗生成，请把这条任务参数发给开发者核对`
    lo = speedLo
    hi = speedHi
  }
  pace = Math.min(Math.max(pace, lo), hi)
  pace = Math.round(pace)

  return {
    targetKm,
    paceSecPerKm: pace,
    overshootRatio,
    durationSeconds: Math.round(targetKm * pace),
    // 只在真的冲突时才带这两个字段（正常任务里它们不存在，避免污染常规产物）
    ...(windowConflict ? { windowConflict: true, windowConflictDetail } : {}),
  }
}
