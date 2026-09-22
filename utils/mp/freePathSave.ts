/**
 * 「非官方路径」保存报文的**纯构造函数**（2026-09-22，审计 B1 的修法）
 *
 * ## 为什么要有它（真 bug 回顾）
 * 「非官方路径【测试】」页保存形状时，原来**没有传 `start`**，而 `composables/useTrackLibrary.ts`
 * 的 `upsert` 对 `start` 的口径是「`undefined` = **沿用旧值**」⇒
 *   · 先在「跑道编辑」给这条记录设过起跑点（`start.offsetM` 是对**当时那条几何**量的）；
 *   · 回自由路径页改画形状再保存 ⇒ 几何换了，**旧 `offsetM` 被无条件沿用**；
 *   · `applyStartToLoopKeepingVertices` 内部是 `((off % total) + total) % total`（`utils/mp/trackEditor.ts`）
 *     ⇒ 超长的偏移**只按模绕回、不报错**，用户以为起点还在原处（极端时还会多插一个与首点重合的点）。
 *
 * 判据（可执行）：**形状变了 ⇒ 起跑点必须显式清掉**（`start: null`），而不是"悄悄沿用"。
 * 起跑点只能由用户在「跑道编辑」里按**新形状**重设 —— 见 `startClearedNote()` 的如实提示。
 *
 * ## 为什么做成纯函数
 * 这条不变式（"保存形状的报文里 `start` 必须是**显式的 null**"）要能被**离线单测**钉住，
 * 否则下一次有人"顺手不传"就又悄悄回归了。构造与文案都在这里，界面只负责调用与显示。
 *
 * ## 边界（**故意不传**的字段）
 *   · `laneNo` / `laneCount`：那是「跑道编辑」里双圈几何的选项，本页不碰（`upsert` 的
 *     "不传 = 沿用旧值"正是我们要的）；
 *   · `outer` / `inner`：放**占位几何**（≥3 点，见 `freeShapePlaceholderRing`）——给旧版本应用看，
 *     跑图**不看它**，只认 `freeShape`（审计 B3）。
 */
import { freeShapePlaceholderRing, usableFreePathShape, type FreePathShape } from './pathShape'
import type { LatLng } from './routeSimilarity'

/** 保存形状时要交给 `lib.upsert()` 的字段（`start` 是**显式的 `null`**，不是"没传"） */
export interface FreeShapeSavePayload {
  lineId: string
  lineName: string
  /** 占位几何（≥3 点；旧版本按"内外圈各 ≥3 点"判这条记录合不合法） */
  outer: LatLng[]
  inner: LatLng[]
  freeShape: FreePathShape
  /**
   * ⭐ **显式清掉起跑点**（审计 B1）：形状换了，旧 `offsetM` 是按旧几何量的 ⇒ 必须失效。
   * `undefined`（= 不传）会让 `upsert` 沿用旧值，那正是这个 bug 的成因。
   */
  start: null
}

/**
 * 用形状构造保存报文；形状不可用（点数不够 / 长度 0）⇒ `null`（调用方如实报"还存不了"）。
 * `lineName` 由调用方按"本机记录上已有的名字 → 本机跑道默认名"的顺序给（保持既有口径）。
 */
export function buildFreeShapeSave(input: {
  shape: FreePathShape | null | undefined
  lineId: string
  lineName: string
}): FreeShapeSavePayload | null {
  if (!usableFreePathShape(input.shape)) return null
  const shape = input.shape as FreePathShape
  const placeholder = freeShapePlaceholderRing(shape)
  /** 占位几何拿不到（形状退化）⇒ 也当"存不了"，绝不写一条没有几何的记录进库 */
  if (placeholder.length < 3) return null
  return {
    lineId: String(input.lineId),
    lineName: String(input.lineName),
    outer: placeholder,
    inner: placeholder.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    freeShape: shape,
    start: null,
  }
}

/**
 * 保存成功后**如实补的那一句**：这次确实清掉了一个原本存在的起跑点时才说
 * （没有起跑点时说"已清除"是假话；审计 B4 的 `hadFreeShapeAtSave` 用的是同一口径）。
 */
export function startClearedNote(hadStartBefore: boolean): string {
  if (!hadStartBefore) return ''
  return '（形状已更新，原先的起跑点已清除 —— 请回「跑道编辑」按新形状重新设置）'
}
