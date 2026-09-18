/**
 * 小程序版模拟轨迹生成（走廊式 · 弧长连续推进）
 *
 * 与旧版 `utils/generateRoute.ts` 的关键差别：
 *   旧版是「在路线上随机取点 + 抖动 + 累加到目标公里数」，点序可能跳变；
 *   小程序服务端会算**拟合度**（采样点到官方折线 ≤25 米才命中），所以这里改为
 *   **沿官方折线按弧长顺序前进、在走廊内做高斯抖动、走满目标公里数**，
 *   保证 `fitDegree` 天然接近 1，同时保留真实 GPS 的抖动观感。
 *
 * 实现要点（踩坑）：
 *   必须用**全局弧长**做插值推进，不能用「每段内部从段首按步长走」——
 *   后者在闭合路线跑第二圈时会从段首重启，产生 m 级跳变，拟合度直接掉到 0.45。
 *
 * 逆向依据：`_mp-analyze/小程序逆向分析.md` 第 5.3 节（算法参数 5m/25m）
 */

import { distanceMeters, calculateRouteSimilarity, pointToSegmentDistance, type LatLng } from './routeSimilarity'

export interface CorridorOptions {
  /** 目标里程（公里） */
  targetKm: number
  /** 抖动标准差（米），默认 2.2（与旧版一致） */
  jitterSigmaM?: number
  /** 抖动时间相关系数 ρ ∈ [0,1)，默认 0.92（模拟真实 GPS 漂移，避免锯齿） */
  jitterRho?: number
  /** 采样步长（米），默认 2（≈ 真实 GPS 上报间隔） */
  stepM?: number
  /** 路线走完后是否循环（默认 true，支持跑多圈） */
  loop?: boolean
  /** 随机种子（便于测试复现） */
  seed?: number
  /**
   * 真实感：叠加**GPS 精度下降期**（树下 / 楼旁 / 拐角贴墙），让拟合度自然落到 0.9x
   * 而不是满分 1.00（默认 false，保持既有测试口径）。
   * ⚠️ 偏移用"缓慢随机游走"实现（每点位移 ≤ ~6m），**不会制造飞点**（逐点速度远低于 12 m/s）。
   */
  drift?: boolean
  /** 漂移期参数（给测试用；默认 2~4 次、每次 24~44 点、峰值偏移 14~30 米） */
  driftOptions?: { minCount?: number; maxCount?: number; minLen?: number; maxLen?: number; minM?: number; maxM?: number }
  /**
   * 单点相对路线的**最大允许偏离（米）**，默认 `MAX_OFF_ROUTE_M`（6）。
   * 2026-09-17 新增：无论漂移档位怎么加码，都会把偏移向量**按上限截断** ⇒ 轨迹不会甩出跑道。
   */
  maxOffRouteM?: number
  /**
   * 生成前对官方路线做几轮 **Chaikin 圆角**（默认 2，0 = 不平滑）。
   * 官方模板是 **7~24 个点的粗多边形**（实测），照它走会出现"带尖角的折线"——
   * 真跑是一条圆滑的线。圆角后观感接近真跑；拟合度仍按**原始路线**计算（截角本身会产生自然的小偏差）。
   */
  smoothRoute?: number
  /**
   * 抖动是否**按弧长锁定**（默认 true）：同一弧长位置每圈偏移一致 ⇒ 多圈几乎重合（真跑就是这样）。
   * 旧实现用"按点序号"的 AR(1)，每圈噪声独立 ⇒ 几圈错开成"绳带状"（实测逐圈离散 30~86 m）。
   * ⚠️ 2026-09-18：**"完全一致"是过头的** —— 用户看到 8 圈叠成同一个圈，要求"每圈在模板线附近小幅波动"。
   *    现在弧长锁定只负责**圈内**形状，**圈间差异由 `lapDrift` 单独负责**（见下）。
   */
  arcLockedJitter?: boolean
  /**
   * 🆕 **每圈漂移**（2026-09-18 用户要求）：让轨迹**以官方模板线为中心、逐圈小幅波动** ——
   * 第 1 圈比模板稍大一点、第 2 圈稍小一点……整体是几个"同心但略有间隔"的圈，
   * 而不是 8 圈完全重合（更不是旧版那种"左右剧烈晃动"）。
   *
   * 语义（默认 true）：
   *   · **圈内恒定** ⇒ 直道仍然笔直（不会重新引入"波浪/左右抖"）；
   *   · **圈间均值回复**（OU 过程）⇒ 大小交替波动，不会越跑越偏；
   *   · 幅度受 `lapDriftRatio` × `maxOffRouteM` 与 `lapDriftMaxM` 双重限制 ⇒ 始终在跑道宽度内。
   */
  lapDrift?: boolean
  /** 每圈漂移的标准差 = `lapDriftRatio`（米，默认 1.5——按"1 m ≈ 预览图 1.67 px"标定，见上） */
  lapDriftRatio?: number
  /** 每圈漂移的**硬上限**（米，默认 2.2）—— 防极端取样把某圈顶到跑道边 */
  lapDriftMaxM?: number
}

export interface GeneratedRoute {
  /** 轨迹点（字符串化后 6 位小数，符合接口习惯） */
  points: { latitude: string; longitude: string }[]
  /** 实际累计里程（公里，两位小数） */
  km: string
  /** 自算拟合度（0~1，两位小数），可直接作为 fitDegree 提交 */
  fitDegree: string
  /** 漂移期次数（0 = 未开启/未命中） */
  driftEpisodes: number
  /**
   * 🆕 **逐圈漂移量（米）**：第 1 圈、第 2 圈……相对模板线的横向偏移（正 = 偏法向一侧）。
   * 用途：① 单测/诊断可断言"各圈真的不同了"；② 排查时一眼看出"是不是某圈偏太多"。
   */
  lapDriftM: number[]
  /**
   * 🆕 **一圈的弧长（米，= 生成几何的周长）**：给"按圈着色"的可视化用 ——
   * 调用方把累积弧长除以它，就能知道每个点属于第几圈（与内部切圈规则完全一致）。
   */
  lapLengthM: number
}

/**
 * 拟合度控幅目标区间（**2026-09-17 用户要求改为 0.97~1.00**）。
 *
 * 为什么又改了（这条是"看图说话"改的，详见 `_mp-analyze/scratch/viz_map.mjs` 与 `memory/10` §6/§7）：
 *   - 手机上看 9-17 那笔（区间 0.70~0.85，实测 0.83）：**轨迹甩出跑道、几圈互相错开** ⇒ 一眼假；
 *     而 9-16 真跑那条（0.75）**紧紧贴在跑道上**，是一条干净的椭圆。
 *   - 根因：**拟合度的容差是 25 m**（5 m 采样 / 25 m 命中）。想把拟合度压到 0.8x，就必须让轨迹
 *     偏离路线 25~44 m —— 那就必然离开跑道。**"在跑道上"与"低拟合度"在数学上互斥。**
 *   - 用户拍板：**接受更高的拟合度**，优先"看起来在跑道上"。
 *   - 旁证：该账号 2025 学年的真跑记录大多就是 **1.00 / 0.99** ⇒ 高分本身并不异常。
 */
export const FIT_TARGET_MIN = 0.97
export const FIT_TARGET_MAX = 1.0

/** 单点相对路线的**最大允许偏离（米）**：5 m ≈ 跑到宽度量级 ⇒ 保证"还在跑道上" */
export const MAX_OFF_ROUTE_M = 5

/**
 * 圆角（Chaikin）允许造成的**最大偏离（米）**。
 * 为什么要有这个上限：圆角会削掉尖角，段越长削得越多 —— 实测 100 m 的直角会被削掉约 14 m
 * （真模板段长只有 ~27 m，只削 ~4 m）。所以**自适应**：从最大轮数往下试，取第一个不超上限的；
 * 都超就**完全不圆角**（宁可保留尖角，也不能跑到路线外）。
 */
export const SMOOTH_MAX_DEV_M = 5

/** 可复现随机数（mulberry32） */
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
 * Chaikin 圆角（闭合折线）：每轮把每条线段按 1/4、3/4 处切成两点，折角被"削平"。
 * 用途：官方路线模板实测只有 **7~24 个点**（粗多边形），直接沿它走会出现明显尖角；
 * 圆角后观感接近真跑的平滑路径（2026-09-17 用户"一眼假"反馈后新增）。
 */
function chaikinClosed<T extends { latitude: number; longitude: number }>(points: T[], iterations: number): T[] {
  let out: T[] = points
  for (let it = 0; it < iterations; it++) {
    const next: T[] = []
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!
      const b = out[(i + 1) % out.length]!
      next.push({ ...a, latitude: a.latitude * 0.75 + b.latitude * 0.25, longitude: a.longitude * 0.75 + b.longitude * 0.25 })
      next.push({ ...a, latitude: a.latitude * 0.25 + b.latitude * 0.75, longitude: a.longitude * 0.25 + b.longitude * 0.75 })
    }
    out = next
  }
  return out
}

/** 一条折线到另一条折线的**最大偏离（米）**（逐段用中点加密，够精确且便宜） */
function maxDeviationM(
  candidate: { latitude: number; longitude: number }[],
  route: { latitude: number; longitude: number }[],
): number {
  let worst = 0
  for (let i = 0; i < candidate.length; i++) {
    const p = candidate[i]!
    const q = candidate[(i + 1) % candidate.length]!
    for (const t of [0, 0.5]) {
      const lat = p.latitude + (q.latitude - p.latitude) * t
      const lng = p.longitude + (q.longitude - p.longitude) * t
      let best = Number.POSITIVE_INFINITY
      for (let k = 1; k < route.length; k++) {
        const a = route[k - 1]!
        const b = route[k]!
        best = Math.min(best, pointToSegmentDistance(lat, lng, a.latitude, a.longitude, b.latitude, b.longitude))
      }
      if (best > worst) worst = best
    }
  }
  return worst
}

/**
 * 自适应圆角：从 `iterations` 轮往下试，取**第一个**偏离原路线不超过 `SMOOTH_MAX_DEV_M` 的候选；
 * 都不满足就返回原路线（不圆角）。⇒ 既拿到"圆滑"的观感，又保证不因为圆角而离开路线。
 */
function smoothRouteWithinBound<T extends { latitude: number; longitude: number }>(route: T[], iterations: number): T[] {
  if (iterations <= 0) return route
  for (let it = iterations; it >= 1; it--) {
    const cand = chaikinClosed(route, it)
    if (maxDeviationM(cand, route) <= SMOOTH_MAX_DEV_M) return cand
  }
  return route
}

/** 高斯随机（Box-Muller），sigma 为标准差 */
function gauss(rng: () => number, mean: number, sigma: number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 米 → 纬度增量（度） */
const M_PER_DEG_LAT = 111320
/** 米 → 经度增量（度），随纬度收缩 */
const degLngPerMeter = (lat: number) => 1 / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))

/**
 * 沿官方路线生成走廊内轨迹
 * @param officialRoute 官方路线点列（pointList）
 */
export function generateCorridorRoute(officialRoute: LatLng[], options: CorridorOptions): GeneratedRoute {
  const {
    targetKm,
    jitterSigmaM = 0.6,
    jitterRho = 0.92,
    stepM = 2,
    loop = true,
    seed = 20260914,
    maxOffRouteM = MAX_OFF_ROUTE_M,
    smoothRoute = 2,
    arcLockedJitter = true,
  } = options

  if (!officialRoute || officialRoute.length < 2) {
    throw new Error('官方路线点列不足（至少需要 2 个点）')
  }
  if (!(targetKm > 0)) {
    throw new Error('目标里程必须大于 0')
  }

  const rng = createRng(seed)
  const targetM = targetKm * 1000

  const route = officialRoute.map((p) => ({
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
  }))

  /**
   * ⚠️ 生成用的路径（可圆角）与**计算拟合度用的路线**（始终是原始模板）**是两条**：
   *    圆角会削掉尖角 ⇒ 轨迹相对原始多边形自然产生几米的偏差（这正是真跑"抄近道"的样子），
   *    所以拟合度仍按**原始** `route` 计算，不会因为圆角而被"算虚高"。
   */
  const genRoute = smoothRoute > 0 ? smoothRouteWithinBound(route, smoothRoute) : route

  // 闭合路线：把首点接到末尾，保证最后一圈也能走满
  const closed = distanceMeters(
    genRoute[0]!.latitude,
    genRoute[0]!.longitude,
    genRoute[genRoute.length - 1]!.latitude,
    genRoute[genRoute.length - 1]!.longitude,
  ) < 30
  const path = closed ? [...genRoute, genRoute[0]!] : genRoute

  // 预计算每段长度与累计弧长
  const segLen: number[] = []
  const cum: number[] = [0]
  for (let i = 0; i < path.length - 1; i++) {
    const d = distanceMeters(path[i]!.latitude, path[i]!.longitude, path[i + 1]!.latitude, path[i + 1]!.longitude)
    segLen.push(d)
    cum.push(cum[i]! + d)
  }
  const pathTotal = cum[cum.length - 1]!
  if (!(pathTotal > 0)) throw new Error('官方路线长度为 0（点列退化）')

  /**
   * 按弧长取路径上的基准点，并**同时返回"该处对应的路线弧长位置"**。
   *
   * ⚠️ 接圈规则（2026-09-14 修）：**闭合路线**直接取模绕圈；
   *    **未闭合路线**必须用**折返（ping-pong）**而不是取模 ——
   *    取模会让轨迹从路线终点"瞬移"回起点（实测出现 35m 的逐点跳变，等于飞点）。
   *    折返既符合真实跑法（折返跑），也彻底消除瞬移。
   */
  const locate = (position: number): { lat: number; lng: number; arc: number } => {
    let p = position
    if (p <= 0) p = 0
    if (p >= pathTotal) {
      if (!loop) p = pathTotal
      else if (closed) p = p % pathTotal
      else {
        // 折返：0 → pathTotal → 0 → pathTotal …
        const period = pathTotal * 2
        const q = p % period
        p = q <= pathTotal ? q : period - q
      }
    }
    // 二分找所在段
    let lo = 0
    let hi = segLen.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid + 1]! < p) lo = mid + 1
      else hi = mid
    }
    const segIndex = lo
    const segStart = cum[segIndex]!
    const len = segLen[segIndex]!
    const t = len > 0 ? (p - segStart) / len : 0
    const a = path[segIndex]!
    const b = path[segIndex + 1]!
    return {
      lat: a.latitude + (b.latitude - a.latitude) * t,
      lng: a.longitude + (b.longitude - a.longitude) * t,
      arc: p,
    }
  }
  const maxPosition = loop ? targetM * 3 : Math.min(targetM, pathTotal)

  // 时间相关抖动（OU/AR(1) 过程）：
  //   白噪声（ρ=0）会让 2m 步长配 σ=2.2m 的轨迹变成锯齿，实际长度翻倍（踩坑）；
  //   ρ=0.92 时相邻点误差高度相关，轨迹平滑漂移，仍保持真实 GPS 观感。
  const rho = Math.min(0.999, Math.max(0, jitterRho))
  const innovScale = Math.sqrt(Math.max(0, 1 - rho * rho))

  // ---- 真实感：**车道模型**（2026-09-17 彻底重写；依据"真跑 vs 官方"实测：ERROR E43 / memory/10 §9）----
  // 真跑 9-16 实测（1121 点，`_mp-analyze/scratch/analyze_real_run.mjs`）：
  //   · 横向抖动（相对自身平滑中心线）：中位 **1.46 m**、P90 4.24、P99 7.34；
  //   · **逐点横向变化只有 0.175 m/点** ⇒ 真跑的线是**光滑的**，不是波浪（旧算法 2~3 m 波浪 = "一眼假"）；
  //   · 每 ~90 m 的横向均值在 0.9~4.0 m 之间缓慢摆动 ⇒ 人是在**一条跑道里跑、缓慢小漂移**。
  // 结论：偏移 = **车道偏移**（按弧长、缓慢、圈间一致） + **极小高频颗粒**（≈0.2 m） + 偶发"精度下降"小凸起（几米）。
  // ⚠️ 关键："直道肯定要跑直" ⇒ **偏移只在弯道变化、直道段内恒定**，直道与官方直道**严格平行**。
  const driftOn = options.drift === true
  /** 取某弧长所在**线段**的单位切向（用折线本身，绕开 locate 的折返/夹紧） */
  const segmentTangentAt = (arc: number): { lat: number; lng: number } => {
    const p = Math.min(Math.max(arc, 0), pathTotal - 1e-6)
    let lo = 0
    let hi = segLen.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid + 1]! < p) lo = mid + 1
      else hi = mid
    }
    const a = path[lo]!
    const b = path[lo + 1]!
    const dNorth = (b.latitude - a.latitude) * M_PER_DEG_LAT
    const dEast = (b.longitude - a.longitude) / degLngPerMeter(a.latitude)
    const len = Math.hypot(dNorth, dEast)
    if (!(len > 1e-6)) return { lat: 0, lng: 1 } // 退化线段：给个稳定方向
    return { lat: dNorth / len, lng: dEast / len }
  }

  /**
   * 车道偏移表：把路线按**转角**切成"段"（直道 / 弯道），**每段一个恒定偏移**（相邻段之间缓慢随机游走），
   * 再按弧长取用并做 ±2 m 轻微平滑（过渡落在段边界＝弯道附近，直道内部仍近似恒定 ⇒ **直道笔直**）。
   */
  const LANE_HALF_WIDTH_M = Math.min(maxOffRouteM, 3.5) // 车道偏移上限（≈ 两条跑道宽）
  const laneTable: number[] = (() => {
    const turnDegAt = (i: number) => {
      const a = path[(i - 1 + path.length) % path.length]!
      const b = path[i % path.length]!
      const c = path[(i + 1) % path.length]!
      const v1 = Math.atan2(
        (b.latitude - a.latitude) * M_PER_DEG_LAT,
        (b.longitude - a.longitude) / degLngPerMeter(b.latitude),
      )
      const v2 = Math.atan2(
        (c.latitude - b.latitude) * M_PER_DEG_LAT,
        (c.longitude - b.longitude) / degLngPerMeter(c.latitude),
      )
      const d = ((v2 - v1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      return Math.abs((d * 180) / Math.PI)
    }
    const bounds: number[] = [0]
    for (let i = 1; i < path.length - 1; i++) if (turnDegAt(i) >= 8) bounds.push(cum[i]!)
    bounds.push(pathTotal)

    const perLeg: { startM: number; endM: number; v: number }[] = []
    let v = 1.2 // 起始约"第 2 道"
    for (let i = 1; i < bounds.length; i++) {
      perLeg.push({ startM: bounds[i - 1]!, endM: bounds[i]!, v })
      v = Math.max(-LANE_HALF_WIDTH_M, Math.min(LANE_HALF_WIDTH_M, v + gauss(rng, 0, 0.6)))
    }
    const bins = Math.max(8, Math.round(pathTotal)) // 1 m 一格
    const raw: number[] = []
    for (let i = 0; i < bins; i++) {
      const s = (i * pathTotal) / bins
      const leg = perLeg.find((l) => s >= l.startM && s < l.endM) ?? perLeg[perLeg.length - 1]
      raw.push(leg ? leg.v : 0)
    }
    const w = 2 // ±2 m 平滑
    return raw.map((_, i) => {
      let sum = 0
      for (let k = i - w; k <= i + w; k++) sum += raw[(k + bins) % bins]!
      return sum / (2 * w + 1)
    })
  })()
  const laneAt = (arcPos: number): number => {
    const bins = laneTable.length
    const s = ((((arcPos % pathTotal) + pathTotal) % pathTotal) / pathTotal) * bins
    const i = Math.floor(s) % bins
    const f = s - Math.floor(s)
    return laneTable[i]! * (1 - f) + laneTable[(i + 1) % bins]! * f
  }

  /**
   * 🆕 **逐圈漂移**（2026-09-18 用户要求）：让各圈"以模板线为中心、大小交替小幅波动"。
   *
   * 为什么必须有它：上面的 `laneAt` / `burstAt` / 颗粒**全都只按 `arcPos % pathTotal` 取值** ——
   * 弧长每绕一圈就回到同一位置，**没有任何"第几圈"的信息** ⇒ 8 圈在数学上**完全重合**（用户看到的
   * "八圈都落在同一个圈上"）。若改成"每圈独立随机"又会退回旧版的"左右剧烈晃动"。
   *
   * 做法（三条约束一次满足）：
   *   ① **圈内恒定**：同一圈内所有点的漂移相同 ⇒ 直道依旧笔直，不会引入波浪；
   *   ② **圈间均值回复**（OU/AR(1)：`v ← 0.7v + 0.55·gauss(0,1)·σ`）⇒ 大小交替波动，不越跑越偏；
   *   ③ **幅度双重封顶**（σ = ratio×maxOffRouteM，再夹到 ±lapDriftMaxM）⇒ 始终留在跑道宽度内。
   */
  const lapDriftOn = options.lapDrift !== false
  /**
   * ⚠️ **必须用独立的 RNG**：`laneTable` / `bursts` 都取自 `rng`（同一个种子序列），
   * 若每圈漂移也去消耗它，就会**挪动后续所有取样** ⇒ 同一个 seed 的既有轨迹全变
   * （实测：加进来后老测试"直道必须是直的"从 1.4 m 变 1.98 m，直接判失败）。
   * 用 `seed ^ 0x9e3779b9` 派生一个独立序列 ⇒ 漂移是**叠加**在既有轨迹上的正交维度。
   */
  const lapRng = createRng((seed ^ 0x9e3779b9) >>> 0)
  /**
   * 幅度按**"看得见"**标定（2026-09-18 实测，`_mp-analyze/scratch/diag_lap_spread.mjs`）：
   * 轨迹预览把整条轨迹（含 300 m 级跑道圈）缩到约 500 px ⇒ **1 m ≈ 1.67 px**。
   *   · σ=0.5 m ⇒ 圈间散布仅 1.1 m ⇒ 图上 1.8 px ⇒ **看起来仍是一圈**（用户反馈的就是这个）；
   *   · σ=1.5 m / 上限 2.2 m ⇒ 圈间散布 2.6 m ⇒ 图上约 4.3 px ⇒ 能看出"几条并排的线"。
   * 物理上也说得通：一个人跑 3 km 本来就会在 2~3 条道之间缓慢挪动（跑道整宽约 8~10 m）。
   */
  const lapDriftSigma = Math.max(0, options.lapDriftRatio ?? 1.5) // 稳态标准差（米）
  const lapDriftCap = Math.max(0, options.lapDriftMaxM ?? 2.2)
  const lapDriftValues: number[] = (() => {
    if (!lapDriftOn || lapDriftSigma <= 0) return []
    // 先按时长估计圈数（够用即可；真实圈数由下面按累计里程推算，超出时续算）
    const estLaps = Math.max(2, Math.ceil(targetM / pathTotal) + 2)
    const out: number[] = []
    let v = 0
    // OU/AR(1)：稳态标准差 = σ（下面的 0.55 与 0.7 满足 0.55/√(1−0.7²) ≈ 0.77，再按需缩放）
    const step = lapDriftSigma * 0.77
    for (let i = 0; i < estLaps; i++) {
      v = 0.7 * v + step * gauss(lapRng, 0, 1)
      out.push(Math.max(-lapDriftCap, Math.min(lapDriftCap, v)))
    }
    return out
  })()
  /** 取第 n 圈（0 基）的漂移；超出预估圈数时现场续算，保证长跑也连续 */
  const lapDriftAt = (lap: number): number => {
    if (!lapDriftValues.length) return 0
    let i = Math.max(0, Math.floor(lap))
    while (lapDriftValues.length <= i) {
      const prev = lapDriftValues[lapDriftValues.length - 1]!
      const step = lapDriftSigma * 0.77
      const next = Math.max(-lapDriftCap, Math.min(lapDriftCap, 0.7 * prev + step * gauss(lapRng, 0, 1)))
      lapDriftValues.push(next)
    }
    i = Math.min(i, lapDriftValues.length - 1)
    return lapDriftValues[i]!
  }

  /**
   * 偶发"GPS 精度下降"小凸起：真跑实测 P99 = 7.3 m ⇒ 是**几米级、几个点**的凸起（旧算法 26~44 m 是错的）。
   * 弧长锁定（每圈位置一致，与真跑"同一个人同一条道"一致）。
   */
  const bursts = driftOn
    ? Array.from({ length: 2 }, () => ({
        startM: rng() * pathTotal,
        lenM: 20 + rng() * 20, // 7~13 个点（3 m 步长）
        // ⚠️ 幅度必须小（0.3~0.6 m）：**直道必须是直的**（用户要求）——旧算法 26~44 m 那种凸起
        //    压在直道上就是"左右抖动太假"。真正的车道变化放在**弯道**（见上面按段恒定的车道偏移）。
        ampM: (rng() < 0.5 ? -1 : 1) * (0.3 + rng() * 0.3),
      }))
    : []
  const burstAt = (arcPos: number): number => {
    let sum = 0
    for (const b of bursts) {
      const d = (((arcPos - b.startM) % pathTotal) + pathTotal) % pathTotal
      if (d <= b.lenM) sum += b.ampM * Math.sin(Math.PI * (d / b.lenM))
    }
    return sum
  }

  /**
   * 偏移（米，north/east 分量）= 车道偏移 + 小凸起 + **逐圈漂移**，方向取路线**法向**（垂直）。
   * ⚠️ `arcPos` 是**累积**弧长（跨圈累计），所以 `floor(arcPos / pathTotal)` 就是"第几圈"；
   *    圈内它恒定 ⇒ 直道仍然笔直。后三个参数保留只为兼容闭环扫描的调用签名。
   */
  const offsetAt = (
    arcPos: number,
    _zoneCount = 1,
    _ampScale = 1,
    _lenScale = 1,
    lapDrift = 0,
  ): { lat: number; lng: number } => {
    const lane = laneAt(arcPos) + burstAt(arcPos) + lapDrift
    const t = segmentTangentAt(arcPos)
    return { lat: lane * t.lng, lng: -lane * t.lat }
  }
  /** 旧"按弧长的噪声波"已废弃（就是"左右抖动太假"的来源）；逐点颗粒改由 `jitterFor` 独立叠加 */
  const noiseAt = (_arcPos: number): { lat: number; lng: number } => ({ lat: 0, lng: 0 })
  /** 偏移向量按**上限截断**：无论怎么叠加，单点偏离不超过 maxOffRouteM ⇒ 不会甩出跑道 */
  const clampOffset = (off: { lat: number; lng: number }): { lat: number; lng: number } => {
    const mag = Math.hypot(off.lat, off.lng)
    if (!(mag > maxOffRouteM) || mag === 0) return off
    const k = maxOffRouteM / mag
    return { lat: off.lat * k, lng: off.lng * k }
  }
  /** 构建一条轨迹（**同一 seed** → 每次尝试的抖动完全一致，只有偏移档位不同） */
  const buildTrajectory = (zoneCount: number, ampScale: number, lenScale = 1) => {
    const r = createRng(seed)
    const pts: { latitude: number; longitude: number }[] = []
    let eLat = 0
    let eLng = 0
    let acc = 0
    let p = 0
    /** 取当前点的抖动（米）：弧长锁定 + 细颗粒；关掉锁定时退回旧的"按序号 AR(1)" */
    const jitterFor = (arc: number): { lat: number; lng: number } => {
      if (arcLockedJitter) {
        const n = noiseAt(arc)
        return { lat: n.lat + gauss(r, 0, jitterSigmaM * 0.25), lng: n.lng + gauss(r, 0, jitterSigmaM * 0.25) }
      }
      eLat = rho * eLat + innovScale * gauss(r, 0, jitterSigmaM)
      eLng = rho * eLng + innovScale * gauss(r, 0, jitterSigmaM)
      return { lat: eLat, lng: eLng }
    }
    // ⚠️ 首点也必须走同一套"抖动 + 偏移"（否则首点与第二点之间会凭空出现一次 15~22m 跳变 —— 实测抓到的）
    const first = locate(0)
    const j0 = jitterFor(first.arc)
    const off0 = clampOffset(
      driftOn ? offsetAt(first.arc, zoneCount, ampScale, lenScale, lapDriftAt(Math.floor(first.arc / pathTotal))) : { lat: 0, lng: 0 },
    )
    pts.push({
      latitude: first.lat + (j0.lat + off0.lat) / M_PER_DEG_LAT,
      longitude: first.lng + (j0.lng + off0.lng) * degLngPerMeter(first.lat),
    })
    while (p < maxPosition && acc < targetM) {
      p += stepM
      const here = locate(p)
      const j = jitterFor(here.arc)
      // 第几圈由**累积弧长**决定（locate 对闭合路线取模、对未闭合路线折返，故用 p 而非 here.arc）
      const off = clampOffset(
        driftOn ? offsetAt(here.arc, zoneCount, ampScale, lenScale, lapDriftAt(Math.floor(p / pathTotal))) : { lat: 0, lng: 0 },
      )
      const lat = here.lat + (j.lat + off.lat) / M_PER_DEG_LAT
      const lng = here.lng + (j.lng + off.lng) * degLngPerMeter(here.lat)
      const prev = pts[pts.length - 1]!
      acc += distanceMeters(prev.latitude, prev.longitude, lat, lng)
      pts.push({ latitude: lat, longitude: lng })
    }
    return { pts, accumulated: acc }
  }

  // 车道模型是**确定性**的（偏移由弧长与随机种子决定，不再有"加码档位"）⇒ 直接构建一次即可。
  const built = buildTrajectory(1, 1)
  const fit = calculateRouteSimilarity(route, built.pts)

  // 实际用到的圈数（诊断/测试用）：按总弧长推
  const lapsUsed = Math.max(1, Math.ceil(built.accumulated / pathTotal))

  return {
    points: built.pts.map((p) => ({
      latitude: p.latitude.toFixed(6),
      longitude: p.longitude.toFixed(6),
    })),
    km: (built.accumulated / 1000).toFixed(2),
    fitDegree: Number(fit).toFixed(2),
    driftEpisodes: driftOn ? bursts.length : 0,
    lapDriftM: Array.from({ length: lapsUsed }, (_, i) => Number(lapDriftAt(i).toFixed(2))),
    lapLengthM: Number(pathTotal.toFixed(1)),
  }
}

/**
 * 由轨迹生成等间隔时间戳（毫秒），用于构造 startTime/endTime 与配速一致性检查
 * @param count 轨迹点数
 * @param totalSeconds 总时长（秒）
 */
export function buildTimeline(count: number, totalSeconds: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0]
  const stepMs = (totalSeconds * 1000) / (count - 1)
  return Array.from({ length: count }, (_, i) => Math.round(i * stepMs))
}
