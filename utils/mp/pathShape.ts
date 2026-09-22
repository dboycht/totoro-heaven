/**
 * **非官方路径（自由路径）的形状与展开** —— 2026-09-22 新功能「非官方路径绘制」的纯算法层
 *
 * ## 这是什么（用户原话）
 * > "主要的功能是绘制**非官方性路径**……用户可以选择**圈型**，或者**直线型**【直线型又有**折返性**】，
 * >  然后绘制那些路径。圈型的话就是**绘制一个闭合曲线**，然后就是这个曲线进行跑图"
 *
 * 服务端**未下发线路**的任务（`routeRequirementOf(task).kind === 'free'`，如「研途健行」）
 * 只有一条本机跑道（`local:free`）。本模块让这条本机跑道**也能是"非官方形状"**：
 *   · `curve` = 用户在地图上点出来的**闭合曲线**（首尾自动闭合）⇒ 绕圈跑；
 *   · `line`  = 一条直路 A→B ⇒ **折返跑**（A→B→A→B…）。
 *
 * ## 三条口径（避免后人误改）
 *   ① **零依赖、纯函数**（只 relative-import 一个类型）：可离线单测，能直接被跑图链路消费；
 *   ② **它永远不是官方线路几何**：`FreePathShape` 只进本机路线库（`mp_track_library_v1`），
 *      **绝不许**被当成服务端线路（`pointId` / `pointList`）写进任何提交报文；
 *   ③ **不许改官方线路那套几何**（`generateCorridorRoute` / `laneLoop` / 起跑点旋转）——
 *      本模块只产出"喂给现有生成器的一条几何点列"，采样、抖动、结算口径一个字都不动。
 *
 * ## 与生成器的接缝（重要）
 * `expandFreePathTrajectory()` 返回的是**路径本身的有序点列**（不是逐点 GPS 轨迹）：
 * 它交给 `generateCorridorRoute(geometry, …)` 当几何用，由后者按弧长推进、加抖动、算拟合度。
 * 生成器内部的**闭合判定**是"首尾点距离 < 30 m" ⇒ 本模块据此保证：
 *   · curve 展开后**首尾严格同点** ⇒ 判为闭合 ⇒ 按取模绕圈（多圈重合，符合"沿曲线跑圈"）；
 *   · line  展开后 A、B 相距 > 30 m 时首尾不同点 ⇒ 判为未闭合 ⇒ 生成器走**折返（ping-pong）**。
 * 详见 `expandFreePathTrajectory` 的注释。
 */

import { distanceMeters, type LatLng } from './routeSimilarity.ts'

/** 非官方路径的形状（**只有这两种**；存进本机路线库时藏在可选的 `freeShape` 字段里） */
export type FreePathShape =
  | {
      /** 闭合曲线：用户点出的点，**首尾自动闭合**（数组里不重复存收盘点） */
      kind: 'curve'
      points: LatLng[]
    }
  | {
      /** 一条直路：A → B（折返跑按"一整趟"计，见 `lineLengthM`） */
      kind: 'line'
      from: LatLng
      to: LatLng
    }

/** 数值型坐标（本模块内部统一用它做算术） */
type N = { latitude: number; longitude: number }

// ---------------------------------------------------------------- 约束（**唯一口径**：界面/持久化/展开都从这里取）

/** 闭合曲线的点数上限（localStorage 有 5 MB 量级上限；手点也不可能点到这么多，纯属防坏数据） */
export const FREE_PATH_MAX_POINTS = 2000
/** **一次完整折返（A→B→A）**的趟数上限（16000 → 最细 ≈ 每趟 0.2 m 才够 3.2 km，已远超手画精度） */
export const FREE_PATH_MAX_TRIPS = 16000
/** 目标里程上限（km）—— 与自由跑上限同量级，纯粹用来兜住异常输入 */
export const FREE_PATH_MAX_TARGET_KM = 100

/**
 * 不可用的形状判定（**"这个形状还能不能拿来跑图"的唯一判据**）。
 *
 * ⚠️ 读数必须是**安全的**：库里可能存着旧版本/坏数据/我们不认识的 `kind`
 *    ⇒ 一律当"没有形状"处理（退回双圈模式），**绝不抛异常**。
 */
export function usableFreePathShape(shape: FreePathShape | null | undefined): boolean {
  if (!shape || typeof shape !== 'object') return false
  if (shape.kind === 'curve') return Array.isArray(shape.points) && shape.points.length >= 2 && curveLengthM(shape) > 0
  if (shape.kind === 'line') {
    const s = shape.from
    const e = shape.to
    return isNumPoint(s) && isNumPoint(e) && distanceMeters(Number(s.latitude), Number(s.longitude), Number(e.latitude), Number(e.longitude)) > 0
  }
  return false
}

/** 有限数字坐标（字符串形式的数字也认——契约层坐标可能是字符串） */
function isNumPoint(p: unknown): p is LatLng {
  return (
    !!p &&
    typeof p === 'object' &&
    Number.isFinite(Number((p as LatLng).latitude)) &&
    Number.isFinite(Number((p as LatLng).longitude))
  )
}

const toN = (p: LatLng): N => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })

/**
 * 按欧氏距离**去掉相邻重复点**（用户双击/手抖会在同一点加两次；重复点会让长度为 0 的段混进来）。
 * 保留首尾（哪怕首尾相同也不算"相邻重复"的两端之外）。
 */
function dedupeAdjacent(points: N[]): N[] {
  const out: N[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && last.latitude === p.latitude && last.longitude === p.longitude) continue
    out.push(p)
  }
  return out
}

// ---------------------------------------------------------------- 长度（**等距近似**，与项目既有风格一致）

/**
 * 折线长度（米）。`closed = true` 时把"最后一点 → 第一点"那一段也算进去。
 *
 * 近似方式与 `utils/mp/trackEditor.ts` 的 `ringLengthM` 完全同源 —— 逐段用
 * `distanceMeters`（haversine）累加，**不引新依赖、不自造投影**。
 */
export function polylineLengthM(points: LatLng[], closed = false): number {
  const pts = dedupeAdjacent((Array.isArray(points) ? points : []).filter(isNumPoint).map(toN))
  if (pts.length < 2) return 0
  let sum = 0
  for (let i = 0; i < pts.length - 1; i++) {
    sum += distanceMeters(pts[i]!.latitude, pts[i]!.longitude, pts[i + 1]!.latitude, pts[i + 1]!.longitude)
  }
  if (closed) {
    const a = pts[pts.length - 1]!
    const b = pts[0]!
    sum += distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude)
  }
  return sum
}

/**
 * **曲线长度（米）**。默认 `closed = true`（用户画的就是闭合曲线）。
 * `points` 里**不要求**已经重复收盘点 —— 本函数自己补"最后一点 → 第一点"那一段。
 * 点数不足（< 2）⇒ `0`。
 */
export function curveLengthM(shape: FreePathShape | null | undefined, closed = true): number {
  if (!shape || typeof shape !== 'object' || shape.kind !== 'curve') return 0
  return polylineLengthM(shape.points, closed)
}

/**
 * **一条直路的长度（米）** —— 也就是**一趟折返的单程**。
 *
 * ⚠️ 语义说明：折返跑"跑一个来回"= 2 × 本值。本函数只回答"A 到 B 有多远"，
 *    "绕几趟"由 `planFreePathTrips` 算（它内部按 `2 × 单程` 计一趟）。
 */
export function lineLengthM(shape: FreePathShape | null | undefined): number {
  if (!shape || typeof shape !== 'object' || shape.kind !== 'line') return 0
  if (!isNumPoint(shape.from) || !isNumPoint(shape.to)) return 0
  const a = toN(shape.from)
  const b = toN(shape.to)
  return distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude)
}

/** 一趟（curve = 一圈；line = 一去一回）的长度（米）—— `planFreePathTrips` 的分母 */
function perTripLengthM(shape: FreePathShape): number {
  return shape.kind === 'curve' ? curveLengthM(shape, true) : lineLengthM(shape) * 2
}

// ---------------------------------------------------------------- 趟数（**宁可多跑，不许少跑**）

/** 目标里程归一化（km）：非法/越界一律夹到合法区间；返回 `null` = 没法算（调用方给"不可用") */
function normalizeTargetKm(raw: unknown): number | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(FREE_PATH_MAX_TARGET_KM, n)
}

/** 手填趟数归一化：`null` = 非法/没填（提示用户），合法值 = 夹到 [1, FREE_PATH_MAX_TRIPS] 的整数 */
export function normalizeFreePathTrips(raw: unknown): number | null {
  if (isBlankOverride(raw)) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(FREE_PATH_MAX_TRIPS, Math.max(1, Math.round(n)))
}

/**
 * **"用户没填"** 还是 **"用户填错了"**（2026-09-22 审计 B7 修）。
 *
 * `''` / 纯空白 / `undefined` / `null` = **没填**（输入框标签写着"留空＝按目标里程自动算"）；
 * 其余（`0`、`-1`、`'abc'`）才是**填错**。两者必须分开，否则用户把趟数清空时会看到
 * "手填的趟数不是有效正数"这种自相矛盾的提示。
 */
function isBlankOverride(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')
}

/**
 * **"恰好整除"时不许多算一趟**的向上取整（浮点安全）。
 *
 * 为什么要它：目标里程来自界面/自由跑设置（**km，一位小数量级**），而一趟长度是把
 * haversine 逐段加起来算的（米）⇒ 两者做除法时，本来"正好整圈"的情形会得到
 * `1.0000024` 这种值，裸 `Math.ceil` 就多算一趟（实测：一圈 399.5506 m、目标就是这一圈，
 * 却算出 2 圈）。多算一趟不违反"宁可多跑"的口径，但会让"按目标里程自动算"看着像 bug。
 *
 * 判据：相对误差 ≤ **1e-5**（即百万分之一万）视为整除。
 * 为什么取 1e-5 这么"宽"：要吞掉的正是"界面上的 km ↔ 米制 haversine"之间的换算/精度噪声
 * （实测约 2.4e-6）；而"真的少跑一点"的量级远大于它 —— 在 400 m 的圈上**少 1 m** 就是 2.5e-3，
 * 比阈值大两个数量级 ⇒ 照样会多算一趟（有单测钉住这两侧）。
 */
function ceilNear(ratio: number): number {
  const r = Number.isFinite(ratio) ? ratio : 0
  const nearest = Math.round(r)
  if (nearest >= 1 && Math.abs(r - nearest) <= nearest * 1e-5) return nearest
  return Math.ceil(r)
}

/** 计划结果（界面直接显示 `共 X 趟 · 合计约 Y km`） */
export interface FreePathTripPlan {
  /**
   * 绕几圈（curve）/ 折返几趟（line）；**恒为 ≥ 1 的整数**。
   * ⚠️ `totalM` 与目标的关系**不是**严格的 `>=`：`ceilNear` 允许 ≤ **1e-5 相对量**的
   *    "恰好整除"容差（用来吞掉 km↔米 的换算噪声）⇒ 极端情况下可能比目标少几毫米。
   *    这个量级与"少跑一趟"（几十米起）差好几个数量级，不影响"宁可多跑"的口径。
   */
  trips: number
  /**
   * 一趟的长度（米）：
   *   · curve ⇒ 闭合曲线一圈的长度（= `curveLengthM(shape, true)`）；
   *   · line  ⇒ **一去一回**的长度（= `2 × lineLengthM(shape)`）。
   * `perTripM × trips = totalM`（展开后几何的弧长，正是生成器要跑的距离量级）。
   */
  perTripM: number
  /** 合计长度（米）= `perTripM × trips`；正常情况 ≥ 目标里程（误差 ≤ 1e-5 相对量，见 `trips`） */
  totalM: number
  /** 目标里程（米，已归一化；目标非法时用**默认 3 km** 兜底并如实说明，见 `note`） */
  targetM: number
  /** 该给用户看的一句话（界面**直接渲染这一句**即可，不要在外面再拼一遍 head） */
  note: string
}

/**
 * **算出"绕几圈 / 折返几趟"**。
 *
 * 规则（**取整方向是硬要求**）：
 *   · `trips = ceil(目标 / 一趟)` ⇒ **宁可多跑一两米，绝不少跑**（少跑 ⇒ 结算里程不达标）；
 *   · `trips` 至少 1（哪怕目标比一圈还短，也至少跑一趟）；
 *   · `override` 是用户手填的趟数：合法就**用它**（并如实标注"你手填的"）；
 *     **填错**（0 / 负数 / 非数字）⇒ 忽略它、回落到自动算，且 `note` 里说明回落原因；
 *     **没填**（空串/空白/undefined）⇒ 静默按自动算（**不报"填错了"** —— 标签写的就是"留空＝自动算"）。
 *
 * 退化情形（**不抛异常**）：形状不可用 / 长度为 0 ⇒ `trips = 0`、`totalM = 0`，
 * `note` 说明"这个形状还跑不了"。调用方按 `trips > 0` 判断能不能保存/开跑。
 */
export function planFreePathTrips(
  shape: FreePathShape | null | undefined,
  targetKm: number,
  override?: unknown,
): FreePathTripPlan {
  const perTripM = shape && typeof shape === 'object' && (shape.kind === 'curve' || shape.kind === 'line') ? perTripLengthM(shape) : 0
  const targetM0 = normalizeTargetKm(targetKm)
  /** 目标非法（缺省/0/负数/非数字）⇒ 用 3 km 兜底（与界面"默认 3.2 km"同一量级），并如实标注 */
  const fellBackTarget = targetM0 === null
  const targetM = (targetM0 ?? 3) * 1000

  if (!(perTripM > 0)) {
    return { trips: 0, perTripM: 0, totalM: 0, targetM, note: '这个形状还不能跑：点数不够或长度为 0（至少 2 个不重合的点）' }
  }

  const auto = Math.max(1, Math.min(FREE_PATH_MAX_TRIPS, ceilNear(targetM / perTripM)))
  const manual = normalizeFreePathTrips(override)
  const trips = manual ?? auto
  const totalM = perTripM * trips

  const unit = shape!.kind === 'curve' ? '圈' : '趟'
  const head = `共 ${trips} ${unit} · 合计约 ${(totalM / 1000).toFixed(2)} km`
  const which = manual === null ? '按目标里程自动算' : '你手填的趟数'
  /** ⚠️ 只有"**填错了**"才加回落说明；"没填"（空串）走静默自动（审计 B7） */
  const back = !isBlankOverride(override) && manual === null ? '（手填的趟数不是有效正数，已按目标里程自动算）' : ''
  const tgt = fellBackTarget ? '（没给有效目标里程，按默认 3 km 算）' : ''
  const unitLen = shape!.kind === 'curve' ? `一圈 ${perTripM.toFixed(1)} m` : `一来一回 ${perTripM.toFixed(1)} m（单程 ${(perTripM / 2).toFixed(1)} m）`
  return { trips, perTripM, totalM, targetM, note: `${head}（${which}${back}${tgt}；${unitLen}）` }
}

// ---------------------------------------------------------------- 展开成有序轨迹（喂给生成器）

/**
 * 把形状 + 趟数展开成**有序的路径点列**（给 `generateCorridorRoute` 当几何用）。
 *
 * 展开规则：
 *   · `curve`：`p0 p1 … pn-1` 重复 `trips` 遍，且**收尾处补回 `p0`**
 *     （这样首末两点完全相同 ⇒ 生成器判为闭合 ⇒ 取模绕圈，多圈重合、不会"从末点瞬移回首点"）；
 *     ⚠️ 补点时**不让两个相同坐标相邻**（否则会多出一段 0 m 的段，生成器会把速度算成 0）；
 *   · `line` ：`A B A …` 共 `trips` 趟（每趟 = A→B→A）⇒ 相邻两段方向天然相反（这就是"折返"，
 *     可直接用"相邻段方向是否相反"来断言）。
 *
 * ⚠️ 已知边界（**如实记下，不藏**）：若直线短到 `单程 × 2 × trips ≤ 30 m`，生成器的
 *    "首尾 < 30 m 即闭合"判定会把展开结果当成闭合圈 —— 那时它在 A 点会重复一次（原地不动一步），
 *    整体仍是往复而非单向。这么短的直线（< 15 m）在真实场景里没有意义（GPS 抖动就有几米），
 *    故不做特殊处理（否则反而要引入一条只有坏数据才走到的分支）。
 *
 * 趟数非法（`<= 0`）或形状不可用 ⇒ 返回 `[]`（调用方按"空几何"处理，绝不抛异常）。
 */
export function expandFreePathTrajectory(shape: FreePathShape | null | undefined, trips: number): { latitude: number; longitude: number }[] {
  if (!shape || typeof shape !== 'object' || !usableFreePathShape(shape)) return []
  const n = Math.floor(Number(trips))
  if (!Number.isFinite(n) || n <= 0 || n > FREE_PATH_MAX_TRIPS) return []

  if (shape.kind === 'curve') {
    const ring = dedupeAdjacent(shape.points.map(toN))
    if (ring.length < 2) return []
    const out: N[] = []
    for (let t = 0; t < n; t++) {
      // ⚠️ 每圈的收尾点只在"下一圈不会紧接着补上同一个点"时才加（避免 0 m 段）
      for (let i = 0; i < ring.length; i++) {
        if (i === 0 && out.length && samePoint(out[out.length - 1]!, ring[0]!)) continue
        out.push({ ...ring[i]! })
      }
    }
    if (!samePoint(out[out.length - 1]!, ring[0]!)) out.push({ ...ring[0]! })
    return out
  }

  const a = toN(shape.from)
  const b = toN(shape.to)
  const out: N[] = [{ ...a }]
  for (let t = 0; t < n; t++) {
    out.push({ ...b })
    out.push({ ...a })
  }
  return out
}

function samePoint(a: N, b: N): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude
}

// ---------------------------------------------------------------- 形状的读数工具（界面/列表摘要用）

/** 形状可用时返回"这一趟多少米"的一句话；不可用返回 `null`（界面据此标灰） */
export function freePathShapeText(shape: FreePathShape | null | undefined): string | null {
  if (!usableFreePathShape(shape)) return null
  if (shape!.kind === 'curve') {
    return `圈型（闭合曲线）：${shape!.points.length} 个点 · 一圈 ${curveLengthM(shape, true).toFixed(1)} m`
  }
  return `直线型（折返）：单程 ${lineLengthM(shape).toFixed(1)} m · 一来一回 ${(lineLengthM(shape) * 2).toFixed(1)} m`
}

/** 形状的点数（列表摘要用；不可用返回 0） */
export function freePathPointCount(shape: FreePathShape | null | undefined): number {
  if (!shape || typeof shape !== 'object') return 0
  if (shape.kind === 'curve') return Array.isArray(shape.points) ? shape.points.length : 0
  if (shape.kind === 'line') return 2
  return 0
}

/**
 * **持久化归一化（唯一入口）**：把任意读到的值收敛成合法的 `FreePathShape`，或 `undefined`。
 *
 * 为什么要这么严：
 *   · 库里可能存着我们**不认识**的形状（老版本/手改/坏数据）⇒ 一律 `undefined`
 *     （含义＝"这条记录没有非官方形状"，退回双圈模式）；**绝不抛异常、绝不猜**；
 *   · 坐标统一转成 `number`（字符串坐标写回 JSON 会变成字符串，比较/算术都要先 Number）；
 *   · 点数/趟数一律按上限截断 ⇒ 坏数据不会把 localStorage 撑爆。
 */
export function parseFreePathShape(raw: unknown): FreePathShape | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  if (v.kind === 'curve') {
    const list = Array.isArray(v.points) ? v.points : []
    const pts = dedupeAdjacent(list.filter(isNumPoint).map(toN)).slice(0, FREE_PATH_MAX_POINTS)
    const shape: FreePathShape = { kind: 'curve', points: pts }
    return usableFreePathShape(shape) ? shape : undefined
  }
  if (v.kind === 'line') {
    if (!isNumPoint(v.from) || !isNumPoint(v.to)) return undefined
    const shape: FreePathShape = { kind: 'line', from: toN(v.from), to: toN(v.to) }
    return usableFreePathShape(shape) ? shape : undefined
  }
  return undefined
}

/**
 * 形状上的**顶点**（供界面画线、定位取范围、给库里的形状取点用）：
 * curve ⇒ 用户点出的那些点（不补收盘点）；line ⇒ `[from, to]`；不可用 ⇒ `[]`。
 */
export function freePathPoints(shape: FreePathShape | null | undefined): { latitude: number; longitude: number }[] {
  if (!usableFreePathShape(shape)) return []
  if (shape!.kind === 'curve') return dedupeAdjacent(shape!.points.map(toN))
  return [toN(shape!.from), toN(shape!.to)]
}

/**
 * 🆕 **给旧版本应用看的"占位几何"**（2026-09-22 审计 B3 修）：**至少 3 个点**的坐标数组。
 *
 * ## 为什么需要它（数据安全）
 * 非官方路径**不需要内外圈**，所以带上形状保存的条目，内外圈只放"占位几何"。
 * 但 1.2.4 及更早的版本用 `hasValidRings`（**内外圈各 ≥3 点**）判一条记录合不合法：
 *   · 占位几何只有 2 点时，**旧版会认为这条记录不合法** ⇒ 列表里看不到它；
 *   · 更糟的是旧版**任何一次写操作**（`upsert`/`rename`/`remove`）都会把"不含它"的
 *     `entries` 整体写回 localStorage ⇒ **连同 `freeShape` 一起被永久删掉**。
 * 补到 ≥3 点就能让旧版**收下**这条记录（哪怕它画出来的是一条粗糙的线，也好过丢掉用户画的路径）。
 *
 * 判据（可执行）：返回数组长度 **≥ 3**，且**每个点都落在原形状上**（line 就是 A、中点、B；
 * curve 少于 3 点时补中间点），坐标一律 `number`。形状不可用 ⇒ `[]`（调用方如实报错）。
 */
export function freeShapePlaceholderRing(shape: FreePathShape | null | undefined): { latitude: number; longitude: number }[] {
  if (!usableFreePathShape(shape)) return []
  if (shape!.kind === 'line') {
    const a = toN(shape!.from)
    const b = toN(shape!.to)
    return [a, { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 }, b]
  }
  const ring = dedupeAdjacent(shape!.points.map(toN))
  if (ring.length >= 3) return ring
  /** 2 点（= 一条往返线）：中间补一个点凑够 3 个 */
  const a = ring[0]!
  const b = ring[ring.length - 1]!
  return [a, { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 }, b]
}
