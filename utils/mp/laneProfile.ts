/**
 * **每轮换圈**的纯算法层（2026-11-03，1.3.6 需求②）
 *
 * ## 用户口径（原话要点，逐条对应到本文件的函数）
 * > "先计算出大约奔跑圈数，向上取整 n，作横向 XY 图，以时间 t 为 X 轴，**道次 index 为 y 轴**，
 * >  初始 y0 为用户预设中设置的圈 index（= 预设里的道次），随后上下随机波动（不超过其内外圈范围），
 * >  设每一圈平均用时为 T，则最终 XY 图片中**斜率均小于 1/T**；相关控件用户可以自行拖动"
 * > "（流程）原胚跑道 → 模拟跑道 → 最终路径 → 提交"
 *
 * 于是：
 *   · **n** = 目标里程 ÷ 一圈长度，向上取整（`lapCountForKm`）；
 *   · **T** = 一圈用时（`lapSecondsForPace`：配速(秒/公里) × 一圈公里数）；
 *   · **Y 轴 = 道次**（1 = 最内道，`laneCount` = 最外道），初值 = 预设里的 `laneNo`；
 *   · **斜率上限** `|Δ道次| / (圈数) ≤ 1`（等价于 `|dLane/dt| ≤ 1/T`，因为一圈正好 T 秒）；
 *   · 用户拖动的就是"每个整圈处停在哪条道"这些**控制点**。
 *
 * ## 为什么控制点放在"每个整圈边界"上
 * 斜率上限是 **1 道/圈** ⇒ 相邻两个整圈之间的道次差最多 1 ⇒ **只要约束住相邻控制点，
 * 整条折线的斜率天然达标**（不需要另做"斜率检测"再报错；但校验函数仍然提供，用来兜住导入/坏数据）。
 * 这也正是用户要的粒度：他拖的是"第 3 圈开始换到第 2 道"这种决策。
 *
 * ## 三条纪律
 *   ① **纯函数、零依赖**（只 relative-import 类型）：可离线单测，能被生成器与界面同时消费；
 *   ② **它只决定"横向在哪条道"**：不碰里程、配速、拟合度算法，更不碰任何提交报文；
 *   ③ **不落盘、不进预设**（用户 2026-11-03 明确："只放跑步页，每次开跑前设"）。
 */

/** 一个控制点：`u` = 第几圈（0 = 起跑瞬间；整数，0..laps），`lane` = 该处停在**第几道**（1 起，可小数=正在换道） */
export interface LanePoint {
  u: number
  lane: number
}

/** 道次缺省值（与跑道编辑页的默认一致：6 道、第 3 道） */
export const DEFAULT_LANE_COUNT = 6
export const DEFAULT_LANE_NO = 3

/** 每圈最多能换几条道（= 用户给的斜率上限 `1/T` 换算成"每圈"单位） */
export const MAX_LANE_CHANGE_PER_LAP = 1

/**
 * **圈数 n**：目标里程 ÷ 一圈长度，**向上取整**（用户原话"向上取整n"）。
 * 判据：`lapCountForKm(3.2, 400)` → `8`；`lapCountForKm(0.5, 400)` → `2`（0.5 km 也要跑满 1.25 圈 ⇒ 2 圈）；
 * 一圈长度非法（≤0）⇒ `1`（绝不返回 0/NaN，否则下游会除以 0）。
 */
export function lapCountForKm(targetKm: number, lapLengthM: number): number {
  const km = Number(targetKm)
  const lap = Number(lapLengthM)
  if (!(km > 0) || !(lap > 0)) return 1
  return Math.max(1, Math.ceil((km * 1000) / lap - 1e-9))
}

/**
 * **每圈用时 T（秒）**：配速（秒/公里）× 一圈的公里数。
 * 判据：配速 360 s/km、一圈 400 m ⇒ 144 s。配速或圈长非法 ⇒ `0`（界面据此不显示 T）。
 */
export function lapSecondsForPace(paceSecPerKm: number, lapLengthM: number): number {
  const pace = Number(paceSecPerKm)
  const lap = Number(lapLengthM)
  if (!(pace > 0) || !(lap > 0)) return 0
  return (pace * lap) / 1000
}

/** 道次夹紧到 `[1, laneCount]`（非数 ⇒ `baseLane`/1） */
export function clampLane(lane: unknown, laneCount: number): number {
  const n = Math.max(1, Math.round(Number(laneCount) || DEFAULT_LANE_COUNT))
  const v = Number(lane)
  if (!Number.isFinite(v)) return 1
  return Math.min(n, Math.max(1, v))
}

/**
 * **道次 → ratio**（0 = 贴内圈，1 = 贴外圈），**允许小数**。
 *
 * ⚠️ 与 `trackEditor.laneRatioFor()` 的关系：那个函数会**把道次四舍五入成整数**（它是给"整圈恒定一道"
 * 用的），而换圈过渡期间道次是小数（例如 2.5 = 正在从第 2 道切到第 3 道）⇒ 必须用本函数。
 * 判据：整数入参时两者**逐位一致**（`laneRatioExact(3, 6) === laneRatioFor(3, 6) === 0.4166…`）。
 */
export function laneRatioExact(lane: number, laneCount: number): number {
  const n = Math.max(1, Math.round(Number(laneCount) || DEFAULT_LANE_COUNT))
  const v = clampLane(lane, n)
  return (v - 0.5) / n
}

/**
 * **归一化剖面**（唯一入口；坏数据一律安全降级，绝不抛）：
 *   · `u` 夹到 `[0, laps]` 并按升序排序（`u` 相同的后者覆盖前者）；
 *   · 保证**首尾都有点**（首点补 `baseLane`、尾点补最后一条）；
 *   · 道次一律 `clampLane`；
 *   · 相邻点若**跨越了相同的 u**（去重后）不做斜率修正 —— 斜率是**校验**的事，不在这里偷偷改用户的图
 *     （否则"用户画的线"与"真跑的线"会不一致，那正是本项目最忌讳的一类静默欺骗）。
 */
export function normalizeLanePoints(points: unknown, profile: { laps: number; baseLane: number; laneCount: number }): LanePoint[] {
  const laps = Math.max(1, Number(profile.laps) || 1)
  const laneCount = Math.max(1, Math.round(Number(profile.laneCount) || DEFAULT_LANE_COUNT))
  const baseLane = clampLane(profile.baseLane ?? DEFAULT_LANE_NO, laneCount)
  const raw = Array.isArray(points) ? points : []
  const clean: LanePoint[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const u = Number((it as LanePoint).u)
    const lane = Number((it as LanePoint).lane)
    if (!Number.isFinite(u) || !Number.isFinite(lane)) continue
    clean.push({ u: Math.min(laps, Math.max(0, u)), lane: clampLane(lane, laneCount) })
  }
  clean.sort((a, b) => a.u - b.u)
  /** 同一个 u 上只留最后一条（拖动时会短暂出现重合点） */
  const dedup: LanePoint[] = []
  for (const p of clean) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1]!.u - p.u) < 1e-9) dedup[dedup.length - 1] = p
    else dedup.push(p)
  }
  if (!dedup.length) return [{ u: 0, lane: baseLane }, { u: laps, lane: baseLane }]
  if (dedup[0]!.u > 1e-9) dedup.unshift({ u: 0, lane: baseLane })
  if (laps - dedup[dedup.length - 1]!.u > 1e-9) dedup.push({ u: laps, lane: dedup[dedup.length - 1]!.lane })
  /** 只有一个点（首尾被压成同一个 u）⇒ 补成一条水平线 */
  if (dedup.length < 2) dedup.push({ u: laps, lane: dedup[0]!.lane })
  return dedup
}

/** 在圈坐标 `u` 处的**道次**（分段线性插值；`u` 超界按端点） */
export function laneAtU(points: LanePoint[], u: number): number {
  const list = Array.isArray(points) ? points : []
  if (!list.length) return 1
  const x = Number(u)
  if (!Number.isFinite(x) || x <= list[0]!.u) return list[0]!.lane
  const last = list[list.length - 1]!
  if (x >= last.u) return last.lane
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!
    const b = list[i]!
    if (x <= b.u) {
      const span = b.u - a.u
      if (!(span > 1e-12)) return b.lane
      const t = (x - a.u) / span
      return a.lane + (b.lane - a.lane) * t
    }
  }
  return last.lane
}

/** 剖面上相邻控制点的**最大斜率**（单位：道次/圈）；单点/空 ⇒ 0 */
export function maxSlopePerLap(points: LanePoint[]): number {
  const list = Array.isArray(points) ? points : []
  let worst = 0
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!
    const b = list[i]!
    const du = b.u - a.u
    if (!(du > 1e-12)) continue
    worst = Math.max(worst, Math.abs(b.lane - a.lane) / du)
  }
  return worst
}

/** 剖面校验结果（界面据此禁用「再次评测」并逐条说明） */
export interface LaneProfileCheck {
  ok: boolean
  /** 给人看的问题清单（空 = 没问题） */
  problems: string[]
  /** 实测最大斜率（道次/圈） */
  maxSlope: number
  /** 上限（= `MAX_LANE_CHANGE_PER_LAP`） */
  slopeLimit: number
  /** 一圈用时 T（秒；0 = 算不出来） */
  lapSeconds: number
}

/**
 * **校验剖面是否符合"斜率 < 1/T"**（唯一判据，界面与引擎共用）。
 * 换算：`|Δlane| / Δu ≤ 1` ⇔ `|Δlane| / Δt ≤ 1/T`（因为 `Δu = Δt / T`）。
 *
 * 判据（可执行）：`[{u:0,lane:3},{u:1,lane:2}]` ⇒ ok；`[{u:0,lane:3},{u:1,lane:1}]` ⇒
 * `problems` 里有"每圈最多换 1 条道"。**逐段**校验（不是只看全局平均）——否则"中间猛换两次、首尾抵消"
 * 这种图会被放过。
 */
export function checkLaneProfile(
  input: { points: LanePoint[]; laps: number; laneCount: number; baseLane: number },
  lapSeconds: number,
): LaneProfileCheck {
  const laps = Math.max(1, Number(input.laps) || 1)
  const laneCount = Math.max(1, Math.round(Number(input.laneCount) || DEFAULT_LANE_COUNT))
  const points = normalizeLanePoints(input.points, { laps, baseLane: input.baseLane, laneCount })
  const problems: string[] = []
  const maxSlope = maxSlopePerLap(points)
  if (!(maxSlope <= MAX_LANE_CHANGE_PER_LAP + 1e-9)) {
    /** 找出最陡的那一段，把位置说清楚（只说"超了"用户没法改） */
    let worstAt = 0
    let worst = 0
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      const du = b.u - a.u
      if (!(du > 1e-12)) continue
      const s = Math.abs(b.lane - a.lane) / du
      if (s > worst) {
        worst = s
        worstAt = a.u
      }
    }
    problems.push(
      `换道太快：第 ${worstAt.toFixed(0)}~${Math.ceil(worstAt + 1)} 圈之间换了 ${worst.toFixed(1)} 条道，` +
        `上限是每圈 ${MAX_LANE_CHANGE_PER_LAP} 条（这就是你说的"斜率小于 1/T"）`,
    )
  }
  /** 道次范围：normalize 已经夹紧，这里只在**原始值越界**时提示（让用户知道被夹过） */
  if (Array.isArray(input.points)) {
    for (const p of input.points) {
      const lane = Number(p?.lane)
      if (Number.isFinite(lane) && (lane < 1 - 1e-9 || lane > laneCount + 1e-9)) {
        problems.push(`有控制点落在跑道外（第 ${lane.toFixed(1)} 道）—— 已夹到第 1~${laneCount} 道之间`)
        break
      }
    }
  }
  return { ok: problems.length === 0, problems, maxSlope, slopeLimit: MAX_LANE_CHANGE_PER_LAP, lapSeconds }
}

/** 可复现随机数（mulberry32，与 `generateRoute` 同款实现；不从那边 import 是为了让本文件零依赖） */
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

/**
 * **生成初始换圈图**（用户点「生成初始版本」时用）。
 *
 * 口径：y0 = 预设道次；之后**每圈 ±1 条道以内随机游走**，并且**倾向于留在中间**（越靠边越容易往回走）
 * —— 因为真实跑者不会一直贴着最内/最外道跑，而完全均匀随机会让图长期贴边。
 * 结果保证：① 每个控制点都在 `[1, laneCount]`；② 相邻差 ≤ 1（斜率达标）；③ 首点 = `baseLane`。
 */
export function defaultLanePoints(profile: { laps: number; baseLane: number; laneCount: number }, seed = 20261103): LanePoint[] {
  const laps = Math.max(1, Math.round(Number(profile.laps) || 1))
  const laneCount = Math.max(1, Math.round(Number(profile.laneCount) || DEFAULT_LANE_COUNT))
  const baseLane = clampLane(profile.baseLane ?? DEFAULT_LANE_NO, laneCount)
  const rng = createRng(seed)
  const out: LanePoint[] = [{ u: 0, lane: baseLane }]
  let lane = baseLane
  for (let u = 1; u <= laps; u++) {
    const r = rng()
    /** 贴边时把"再往外"的那半概率折回来（折返式随机游走） */
    let step = r < 0.34 ? -1 : r < 0.68 ? 0 : 1
    if (lane + step < 1) step = 1
    if (lane + step > laneCount) step = -1
    lane = clampLane(lane + step, laneCount)
    out.push({ u, lane })
  }
  return out
}

/**
 * 把剖面压成一句人话（界面/提示用）：**连续同道的整圈合并成区间**，
 * 形如 `第 1~2 圈 第 3 道 · 第 3~4 圈 第 2 道 · 第 5 圈 第 4 道`。
 *
 * 口径：第 k 圈用**该圈中点**（`u = k-0.5`）的道次代表（与 `lanesByLap` 同一基准，
 * 否则"界面说第 3 圈第 2 道、实际跑在第 3 道"这种错会悄悄发生）。
 */
export function laneProfileText(points: LanePoint[], laps: number, laneCount: number): string {
  const n = Math.max(1, Math.round(Number(laps) || 1))
  const parts: string[] = []
  let startLap = 1
  let cur = Math.round(laneAtU(points, 0.5))
  for (let lap = 2; lap <= n + 1; lap++) {
    const lane = lap <= n ? Math.round(laneAtU(points, lap - 0.5)) : Number.NaN
    if (lane !== cur) {
      const from = startLap
      const to = lap - 1
      parts.push(`${from === to ? `第 ${from} 圈` : `第 ${from}~${to} 圈`} 第 ${clampLane(cur, laneCount)} 道`)
      startLap = lap
      cur = lane
    }
  }
  return parts.join(' · ')
}

/**
 * **每圈实际用的道次**（1 基，`index 0` = 第 1 圈）——用"该圈中点"的道次代表整圈。
 * 用途：单测断言"第 k 圈真的在第 N 道"、以及轨迹预览/诊断显示。
 */
export function lanesByLap(points: LanePoint[], laps: number, laneCount: number): number[] {
  const n = Math.max(1, Math.round(Number(laps) || 1))
  return Array.from({ length: n }, (_, i) => clampLane(laneAtU(points, i + 0.5), laneCount))
}
