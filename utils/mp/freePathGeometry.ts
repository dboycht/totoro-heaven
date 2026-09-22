/**
 * 非官方路径的**几何装配**（纯函数，2026-09-22 新增）—— 跑步引擎与跑道编辑页**共用同一个入口**。
 *
 * ## 为什么把它从 `runner.ts` 里提出来（审计 B1/B2 的修法）
 * 原先"形状 + 起跑点 → 生成器几何"这套逻辑只写在 `composables/demo/runner.ts` 里（依赖 Nuxt 状态、不可单测），
 * 于是：
 *   · **B1**：跑道编辑页的预览**根本没套起跑点变换** ⇒ "预览的形状"与"真跑的形状"不一致（所见非所跑）；
 *   · **B2**：跑图侧把几何展开了 8 趟、而界面按"画的圈"报圈数 ⇒ 跑步页的"共 N 圈/每圈一色"差着倍数。
 * 现在这一层是**零依赖纯函数** ⇒ 两处调用同一段代码，且能被离线单测钉住（`tests/mp/freePathGeometry.test.ts`）。
 *
 * ## 三条口径
 *   ① **趟数恒为 1**（`FREE_PATH_GEOMETRY_TRIPS`）：生成器内部本来就会按弧长反复走这条几何直到跑满目标里程，
 *      几何再短也会一直绕（`loop` 默认 true）⇒ 多展开几趟**只会**让 `lapLengthM` 虚高、圈数报错。
 *      只展开 1 趟后，生成器算出的 `lapLengthM` 恰好等于"画的一圈"（curve）/ "一来一回"（line）。
 *   ② **圆角必须关掉**（`smooth: false`）：Chaikin 圆角会在 180° 折返点把折返几何抹成极小回环（见 `ERROR.md` E61）。
 *   ③ **圈型保留起跑点语义，但用保点旋转**（`applyStartToLoopKeepingVertices`）：
 *      老的 `rotateLoop` 是"按弧长均匀重采样"，会把用户手点的 3~8 点几何**弦切**掉（审计 B1：
 *      三角形 900.3 m、`offsetM=25` ⇒ 偏离 48 m、总长掉到 1096.7 m）。保点旋转只插一个点、保留全部顶点
 *      ⇒ 几何**逐点仍在用户画的那条线上**、总长不变。直线型没有"沿弧长旋转"的语义，如实忽略起跑点。
 */
import { distanceMeters, type LatLng } from './routeSimilarity'
import { planFreePathTrips, expandFreePathTrajectory, usableFreePathShape, type FreePathShape } from './pathShape'
import { applyStartToLoopKeepingVertices, type TrackStartInput } from './trackEditor'

/**
 * 非官方路径的几何**展开趟数：恒为 1**。
 *
 * 为什么不展开多趟（审计 B2 的根因）：生成器 `generateCorridorRoute` 会一直推进到目标里程，
 * 并把"一圈的弧长"记为**整条几何的长度** ⇒ 展开 N 趟就等于把"一圈"放大 N 倍，
 * 跑步页据此报的圈数会只有真实圈数的 1/N。
 */
export const FREE_PATH_GEOMETRY_TRIPS = 1

/**
 * 一条非官方路径**"一圈"多长**（米）：curve = 画的闭合曲线一圈；line = 一去一回。
 * 不可用 ⇒ `0`。**这是界面上"共 N 圈/趟"与跑步页 `lapLengthM` 的共同基准。**
 */
export function freePathLapLengthM(shape: FreePathShape | null | undefined): number {
  if (!usableFreePathShape(shape)) return 0
  return planFreePathTrips(shape, 1).perTripM
}

/** 装配结果：几何 + "要不要给生成器做圆角" + "一圈多长" */
export interface FreePathGeometry {
  /** 喂给 `generateCorridorRoute` 的几何（curve 首尾同点 = 闭合；line = A→B→A） */
  geometry: LatLng[]
  /** 是否让生成器对几何做 Chaikin 圆角（非官方路径**恒为 false**，见文件头 ②） */
  smooth: boolean
  /** 一条非官方路径"一圈"的长度（米）= `freePathLapLengthM(shape)` */
  lapLengthM: number
}

/**
 * **形状 + 起跑点 → 生成器几何**（唯一入口）。
 * 形状不可用（点数不够 / 长度 0）⇒ `null`（调用方按"没有几何"处理，绝不伪造）。
 */
export function resolveFreePathGeometry(
  shape: FreePathShape | null | undefined,
  start?: TrackStartInput | null,
): FreePathGeometry | null {
  if (!usableFreePathShape(shape)) return null
  const geometry = expandFreePathTrajectory(shape, FREE_PATH_GEOMETRY_TRIPS)
  if (geometry.length < 2) return null
  const withStart = shape!.kind === 'curve' ? applyStartToLoopKeepingVertices(geometry, start ?? null) : geometry
  /** 保点旋转理论上必然成立；万一没生效（退化几何），也照常用它 —— 形状绝不会被改坏 */
  const out = withStart.length >= 2 ? withStart : geometry
  return {
    geometry: out.map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
    smooth: false,
    lapLengthM: freePathLapLengthM(shape),
  }
}

/** 几何总长（米，按数组顺序逐段累加；**不闭合**）—— 单测里用来核对"保点旋转不改变总长" */
export function geometryLengthM(geometry: LatLng[]): number {
  const pts = Array.isArray(geometry) ? geometry : []
  let sum = 0
  for (let i = 1; i < pts.length; i++) {
    sum += distanceMeters(Number(pts[i - 1]!.latitude), Number(pts[i - 1]!.longitude), Number(pts[i]!.latitude), Number(pts[i]!.longitude))
  }
  return sum
}
