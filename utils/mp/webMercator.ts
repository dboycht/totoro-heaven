/**
 * **Web Mercator 瓦片投影的单一来源**（2026-11-05 整理轮收敛）。
 *
 * 此前「自由跑路径」「跑道编辑」「轨迹预览」三个组件各内联一份逐字相同的
 * `lng2x / lat2y / x2lng / y2lat` 与 `TILE = 256` —— 三份手抄一旦一处改了口径
 * 就会出现"编辑器画的与预览画的不是同一个位置"这类静默漂移 ⇒ 收敛到这里，
 * 三个组件只 import（探针 `_mp-analyze/scratch/verify_free_path.mjs` 自带同式
 * 对照实现属于**独立裁判**，故意不共享，别把它们改成本模块的调用方）。
 *
 * 口径：EPSG:3857 伪墨卡托，`z` 允许小数（滚轮缩放平滑），原点左上角。
 */

/** 一个瓦片的边长（像素）；与 Leaflet/OSM 惯例一致 */
export const TILE = 256

/** 经度 → 瓦片平面 x（z 允许小数） */
export const lng2x = (lng: number, z: number): number => ((lng + 180) / 360) * 2 ** z

/** 纬度 → 瓦片平面 y（墨卡托；纬度 ±90 的正切在极点发散，调用方负责不送入极点） */
export const lat2y = (lat: number, z: number): number => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z
}

/** 瓦片平面 x → 经度 */
export const x2lng = (x: number, z: number): number => (x / 2 ** z) * 360 - 180

/** 瓦片平面 y → 纬度（墨卡托逆变换） */
export const y2lat = (y: number, z: number): number => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}
