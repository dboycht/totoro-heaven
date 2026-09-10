/**
 * 轨迹相似度（拟合度）算法 —— 与小程序端逐行等价实现
 *
 * 逆向来源：小程序 `8D736DE50A0D562FEB1505E291D0EFA3.js`
 *   calculateRouteSimilarity(route, userRoute, sampleStep = 5, tolerance = 25)
 *
 * 语义：把候选轨迹按每 5 米**加密采样**，对每个采样点求到参考折线各段的**最短距离**，
 *       距离 ≤ 25 米即记为命中；命中率（0~1）即「拟合度」。
 *
 * ⚠️ 服务端是否用同一算法复算、阈值多少，需真包验证（见 _mp-analyze/疑难与决策清单.md Q4）。
 */

export interface LatLng {
  latitude: number | string
  longitude: number | string
}

/** 地球平均半径（米），与小程序源码常量一致（源码写作 6371e3） */
const EARTH_RADIUS_M = 6371e3

const toRad = (deg: number) => (deg * Math.PI) / 180

/** 两点球面距离（米），与小程序源码的 haversine 实现一致 */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return EARTH_RADIUS_M * (2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)))
}

/** 点 P 到线段 AB 的最短距离（米）—— 等距圆柱近似下的投影，与源码一致 */
export function pointToSegmentDistance(
  plat: number,
  plng: number,
  alat: number,
  alng: number,
  blat: number,
  blng: number,
): number {
  const dx = blat - alat
  const dy = blng - alng
  const lenSq = dx * dx + dy * dy
  let t = -1
  if (lenSq !== 0) t = ((plat - alat) * dx + (plng - alng) * dy) / lenSq

  let clat: number
  let clng: number
  if (t < 0) {
    clat = alat
    clng = alng
  } else if (t > 1) {
    clat = blat
    clng = blng
  } else {
    clat = alat + t * dx
    clng = alng + t * dy
  }
  return distanceMeters(plat, plng, clat, clng)
}

/** 归一化为 [lat, lng] 数值数组（源码内部用 [lat, lng] 顺序） */
function normalize(list: LatLng[]): [number, number][] {
  return list.map((p) => [Number(p.latitude), Number(p.longitude)])
}

/**
 * 拟合度计算
 * @param route     参考路线（官方 pointList）
 * @param userRoute 用户/候选轨迹
 * @param sampleStepM 加密采样间隔（米），默认 5
 * @param toleranceM  命中容差（米），默认 25
 * @returns 0~1 的相似度（点不足时返回 0）
 */
export function calculateRouteSimilarity(
  route: LatLng[],
  userRoute: LatLng[],
  sampleStepM = 5,
  toleranceM = 25,
): number {
  if (!route || route.length < 2 || !userRoute || userRoute.length < 2) return 0

  const ref = normalize(route)
  const usr = normalize(userRoute)

  let matched = 0
  let checked = 0

  for (let i = 0; i < ref.length - 1; i++) {
    const [alat, alng] = ref[i]!
    const [blat, blng] = ref[i + 1]!
    const segLen = distanceMeters(alat, alng, blat, blng)
    let steps = Math.ceil(segLen / sampleStepM)
    if (steps < 1) steps = 1

    for (let s = 0; s < steps; s++) {
      const ratio = s / steps
      const plat = alat + (blat - alat) * ratio
      const plng = alng + (blng - alng) * ratio

      let minDist = Infinity
      for (let j = 0; j < usr.length - 1; j++) {
        const d = pointToSegmentDistance(plat, plng, usr[j]![0], usr[j]![1], usr[j + 1]![0], usr[j + 1]![1])
        if (d < minDist) minDist = d
        if (minDist <= toleranceM) break
      }
      if (minDist <= toleranceM) matched++
      checked++
    }
  }

  if (checked === 0) return 0
  return matched / checked
}

/** 轨迹累计长度（米） */
export function pathLengthMeters(points: LatLng[]): number {
  if (!points || points.length < 2) return 0
  const p = normalize(points)
  let total = 0
  for (let i = 0; i < p.length - 1; i++) {
    total += distanceMeters(p[i]![0], p[i]![1], p[i + 1]![0], p[i + 1]![1])
  }
  return total
}
