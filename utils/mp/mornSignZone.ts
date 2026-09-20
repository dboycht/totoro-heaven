/**
 * 早操签到「区域编辑」的**纯逻辑层**（2026-09-20）
 *
 * ## 它解决什么问题
 * 签到提交要带一个坐标。厂商的模型是"人站在点位 300 m 圈内的某处"。
 * 早先的实现只是"在点位坐标上做 ≤5 m 随机抖动" —— 那有个一眼可辨的特征：
 * **坐标永远紧贴官方点位坐标、且呈以它为中心的圆**。真人不是这样：
 *
 *   真人 → 从某条路**走过来** → 停在圈内某个位置 → 手机 GPS 读数再叠一点**测量噪声**
 *
 * 本模块就按这个模型生成坐标（"走到圈里、停在偏内一点的地方"）：
 *   · **落点距离**：在 `[内圈下限, 内圈上限]` 之间取（相对"可用半径"的比例），
 *     默认停在圆心 → 半径 60% 的带内 ⇒ 看起来像"从入口走进来站定"，而不是贴着圆心或贴边；
 *   · **进场方向**：个人偏置（有人总从东门进）+ 每次小扰动；
 *   · **GPS 噪声**：固定 σ 的二维高斯，模拟手机定位本身的抖动。
 *
 * ## ⚠️ 性质（与 `mornSignSubmit.ts` 同一层，别粉饰）
 * 它**不改变**"人是否到场"这件事 —— 那一步在"用服务端下发的 `qrCode` 提交"时就已经越过了。
 * 本模块只让**坐标这一项**不再呈现"程序生成"的特征。**点位标识字段（taskId/pointId/qrCode）一律原样。**
 *
 * ## 实现要点（判据都可执行）
 *   · 米↔度：纬度 `111320 m/度`，经度 `× cos(纬度)`（否则高纬度东西向偏短）；
 *   · 圆盘**均匀**采样要 `d = R·√U`（开根号）——但要"偏内"分布时用**比例区间**取，
 *     这样"内圈下限 0.3 / 上限 0.9"能直白地控制"离圆心多远"；
 *   · 一切输入非法时**原样透传**（绝不产出 NaN、绝不阻断提交）。
 */

/** 每个点位一份"落点区域"配置 */
export interface MornSignZone {
  /**
   * 允许的最大落点距离（米）。`null` = **自动**：用服务端下发的 `offsetRange`（实测 300 m）。
   * 为什么要能覆盖：有些学校下发 500/1000，有些只给 100 —— 自动跟随最稳，手动留作例外。
   */
  radiusM: number | null
  /**
   * 落点距离的**下限比例**（相对"可用半径"）。避免"总是紧贴圆心"。
   * 例如 0.3 ⇒ 至少离圆心 30% × 可用半径。
   */
  innerFraction: number
  /** 落点距离的**上限比例**（相对"可用半径"）。避免"总贴着围栏边"（那也假）。 */
  outerFraction: number
  /** 进场方向的个人偏置（度，0=正北，顺时针）；`null` = 每次随机方向 */
  approachBearingDeg: number | null
  /** 进场方向的每次扰动幅度（度）。0 = 固定方向（太整齐），默认 35° */
  bearingJitterDeg: number
  /** GPS 测量噪声（米，1σ）。真人手机定位常态 5~15 m；默认 6 */
  gpsSigmaM: number
  /** 关掉本配置（用于"完全按服务端下发坐标提交"的对照） */
  disabled?: boolean
}

/** 配置缺省值（**每个点位各自一份**，可在编辑器里改） */
export const DEFAULT_MORN_SIGN_ZONE: MornSignZone = {
  radiusM: null, // 自动跟随服务端的 offsetRange
  innerFraction: 0.15,
  outerFraction: 0.6,
  approachBearingDeg: null,
  bearingJitterDeg: 35,
  gpsSigmaM: 6,
}

/** 合法范围（编辑器用它们做滑杆边界，测试用它们钉住"非法值会被夹紧"） */
export const ZONE_LIMITS = {
  innerFraction: { min: 0, max: 0.95 },
  outerFraction: { min: 0.05, max: 0.95 },
  bearingJitterDeg: { min: 0, max: 180 },
  gpsSigmaM: { min: 0, max: 50 },
  radiusM: { min: 20, max: 2000 },
} as const

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo)

/**
 * 保留 n 位小数。
 * ⚠️ 为什么要它：滑杆以 0.05 步进累加会积累浮点噪声（实测拖出 `0.6000000000000001`），
 *    界面就会显示成"60.00000000000001%"、写盘也存脏值。归一化时统一取整即可。
 */
const round = (v: number, n = 4): number => {
  const f = 10 ** n
  return Math.round(v * f) / f
}

/**
 * 把任意输入**归一化**成合法配置（纯函数，唯一入口）。
 * 判据：`inner > outer` 时**交换**（而不是夹紧成相等，否则区间退化成一个点、失去随机性）。
 */
export function normalizeZone(raw: Partial<MornSignZone> | null | undefined): MornSignZone {
  const d = DEFAULT_MORN_SIGN_ZONE
  const src = raw ?? {}
  let inner = clamp(Number(src.innerFraction ?? d.innerFraction), ZONE_LIMITS.innerFraction.min, ZONE_LIMITS.innerFraction.max)
  let outer = clamp(Number(src.outerFraction ?? d.outerFraction), ZONE_LIMITS.outerFraction.min, ZONE_LIMITS.outerFraction.max)
  if (inner > outer) [inner, outer] = [outer, inner]
  inner = round(inner, 2)
  outer = round(outer, 2)
  const radiusRaw = src.radiusM
  const radiusM =
    radiusRaw === null || radiusRaw === undefined || !Number.isFinite(Number(radiusRaw))
      ? null
      : clamp(Number(radiusRaw), ZONE_LIMITS.radiusM.min, ZONE_LIMITS.radiusM.max)
  const bearingRaw = src.approachBearingDeg
  const bearing = bearingRaw === null || bearingRaw === undefined || !Number.isFinite(Number(bearingRaw)) ? null : ((Number(bearingRaw) % 360) + 360) % 360
  return {
    radiusM,
    innerFraction: inner,
    outerFraction: outer,
    approachBearingDeg: bearing === null ? null : round(bearing, 2),
    bearingJitterDeg: round(clamp(Number(src.bearingJitterDeg ?? d.bearingJitterDeg), ZONE_LIMITS.bearingJitterDeg.min, ZONE_LIMITS.bearingJitterDeg.max), 2),
    gpsSigmaM: round(clamp(Number(src.gpsSigmaM ?? d.gpsSigmaM), ZONE_LIMITS.gpsSigmaM.min, ZONE_LIMITS.gpsSigmaM.max), 2),
    disabled: Boolean(src.disabled),
  }
}

/** 1 度纬度约多少米（与 `mornSignSubmit.ts` 同一常量口径） */
const M_PER_DEG_LAT = 111_320

/** 两个坐标之间的**近似距离（米）**（等距近似，供编辑器显示/测试校验） */
export function offsetMeters(aLat: string | number, aLng: string | number, bLat: string | number, bLng: string | number): number {
  const la1 = Number(aLat)
  const ln1 = Number(aLng)
  const la2 = Number(bLat)
  const ln2 = Number(bLng)
  if (![la1, ln1, la2, ln2].every(Number.isFinite)) return 0
  const dNorth = (la2 - la1) * M_PER_DEG_LAT
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((((la1 + la2) / 2) * Math.PI) / 180)
  return Math.hypot(dNorth, (ln2 - ln1) * mPerDegLng)
}

/** 标准正态（Box–Muller）；`rand` 可注入以便单测 */
function gaussian(rand: () => number): number {
  const u1 = Math.max(1e-12, rand())
  const u2 = rand()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

export interface ZoneSample {
  latitude: string
  longitude: string
  /** 距点位中心的实际距离（米，含 GPS 噪声后的最终值） */
  distanceM: number
  /** 本次使用的进场方位（度） */
  bearingDeg: number
}

/**
 * 按配置生成一个"看起来像人走进去站定"的坐标。
 *
 * @param centerLat 点位中心纬度（服务端下发）
 * @param centerLng 点位中心经度
 * @param serverRadiusM 服务端下发的 `offsetRange`（米）；配置里 `radiusM=null` 时用它
 * @param zone 区域配置（会先 `normalizeZone`）
 * @param rand 随机源（默认 `Math.random`）；测试注入固定序列
 *
 * 判据：
 *  1. 结果**必落在 `serverRadiusM` 之内**（因为上限比例 ≤0.95 且噪声按"可用半径的 20%"夹紧，
 *     再加一道最终夹紧 —— 绝不越出服务端围栏）；
 *  2. `disabled` 或半径非法 ⇒ 返回中心点原值（`distanceM=0`）；
 *  3. 与中心的距离**会变化**（不是每次同一个值）。
 */
export function sampleZoneCoord(
  centerLat: string | number,
  centerLng: string | number,
  serverRadiusM: number | null | undefined,
  zone: Partial<MornSignZone> | null | undefined,
  rand: () => number = Math.random,
): ZoneSample {
  const lat = Number(centerLat)
  const lng = Number(centerLng)
  const z = normalizeZone(zone)
  const serverR = Number(serverRadiusM)
  const usableR = z.radiusM ?? (Number.isFinite(serverR) && serverR > 0 ? serverR : 0)

  // 输入非法 / 关掉 / 没有可用半径 ⇒ 原样返回中心点（不猜、不阻断）
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || z.disabled || !(usableR > 0)) {
    return { latitude: String(centerLat), longitude: String(centerLng), distanceM: 0, bearingDeg: 0 }
  }

  // ① 落点距离：在 [inner, outer] × 可用半径 之间取（"停在偏内的位置"）
  const frac = z.innerFraction + rand() * Math.max(0, z.outerFraction - z.innerFraction)
  let dist = frac * usableR

  // ② 进场方向：个人偏置（有人总从东门进）+ 每次扰动
  const baseBearing = z.approachBearingDeg ?? rand() * 360
  const bearing = baseBearing + (z.bearingJitterDeg > 0 ? (rand() * 2 - 1) * z.bearingJitterDeg : 0)

  // ③ GPS 测量噪声（二维高斯）——分方向叠加，再夹紧
  const noiseNorth = z.gpsSigmaM > 0 ? gaussian(rand) * z.gpsSigmaM : 0
  const noiseEast = z.gpsSigmaM > 0 ? gaussian(rand) * z.gpsSigmaM : 0

  const rad = (bearing * Math.PI) / 180
  let dNorth = dist * Math.cos(rad) + noiseNorth
  let dEast = dist * Math.sin(rad) + noiseEast

  // ④ **最终夹紧**：绝不越出服务端围栏（宁可牺牲一点随机性，也不能跨出 300 m 圈）
  const finalDist = Math.hypot(dNorth, dEast)
  if (finalDist > usableR) {
    const k = usableR / finalDist
    dNorth *= k
    dEast *= k
  }

  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
  const outLat = lat + dNorth / M_PER_DEG_LAT
  const outLng = lng + (Math.abs(mPerDegLng) > 1e-6 ? dEast / mPerDegLng : 0)
  return {
    latitude: outLat.toFixed(7),
    longitude: outLng.toFixed(7),
    distanceM: Math.hypot(dNorth, dEast),
    bearingDeg: ((bearing % 360) + 360) % 360,
  }
}

/** 用当前配置跑 n 次采样，给出**落点分布摘要**（编辑器用来显示"跑出来的点都落在哪"） */
export function sampleDistribution(
  centerLat: string | number,
  centerLng: string | number,
  serverRadiusM: number | null | undefined,
  zone: Partial<MornSignZone> | null | undefined,
  n = 200,
  rand: () => number = Math.random,
): { points: ZoneSample[]; minM: number; maxM: number; meanM: number } {
  const points: ZoneSample[] = []
  for (let i = 0; i < n; i++) points.push(sampleZoneCoord(centerLat, centerLng, serverRadiusM, zone, rand))
  const ds = points.map((p) => p.distanceM)
  const minM = ds.length ? Math.min(...ds) : 0
  const maxM = ds.length ? Math.max(...ds) : 0
  const meanM = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0
  return { points, minM, maxM, meanM }
}
