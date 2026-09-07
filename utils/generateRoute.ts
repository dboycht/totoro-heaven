/**
 * 模拟轨迹生成（与原版一致）
 * 在真实路线上做高斯抖动 + 等距插值，生成到目标公里数的"伪"跑步轨迹
 */
export interface RoutePoint {
  longitude: string
  latitude: string
  pointId?: string
  pointName?: string
  pointList?: { longitude: string; latitude: string }[]
}

class Vector {
  vectorArray: number[]
  norm: number
  unitVector: number[]

  constructor(o: number[]) {
    this.vectorArray = o
    this.norm = Math.hypot(...this.vectorArray)
    this.unitVector = this.vectorArray.map((t) => t / this.norm)
  }
}

/** 两点间近似距离（米） */
const distanceMeters = (n: number[], o: number[]) => {
  const t = 0.0174532925194329 // pi/180
  let [i, r] = n
  let [d, h] = o
  i *= t
  r *= t
  d *= t
  h *= t
  const M = Math.sin(i)
  const s = Math.sin(r)
  const e = Math.cos(i)
  const u = Math.cos(r)
  const c = Math.sin(d)
  const a = Math.sin(h)
  const m = Math.cos(d)
  const l = Math.cos(h)
  const p = u * e
  const g = u * M
  const f = s
  const P = l * m
  const L = l * c
  const R = a
  const w = Math.sqrt((p - P) ** 2 + (g - L) ** 2 + (f - R) ** 2)
  return Math.asin(w / 2) * 12740015798544e-6
}

/** 多点累计距离（米） */
const totalDistance = (n: number[][]): number => {
  let o = 0
  for (let t = 0; t < n.length - 1; t += 1) {
    o += distanceMeters(n[t], n[t + 1])
  }
  return o
}

/** 高斯分布采样（拒绝采样，夹在 [n-3σ, n+3σ]） */
export const gaussian = (n: number, o: number): number => {
  let t = 0
  let i = 0
  let r = 0
  let d = 0
  let h = n + t * d * o
  do {
    t = Math.random() * 2 - 1
    i = Math.random() * 2 - 1
    r = t * t + i * i
    d = Math.sqrt((-2 * Math.log(r)) / r)
    h = n + t * d * o
  } while (r === 0 || r >= 1 || h < n - 3 * o || h > n + 3 * o)
  return h
}

/** 抖动幅度（度），约为 2.2 米 */
const JITTER = 1 / 5e4

/**
 * 依据目标公里数与真实点列表生成模拟轨迹
 * @param n 里程（km）
 * @param o 包含真实 pointList 的路由
 */
export const generateRoute = (n: number, o: { pointList?: { longitude: string; latitude: string }[] }) => {
  const t = (s: number[]) => s.map((e) => gaussian(e, JITTER))
  const i = (s: number[], e: number[]) => {
    const a = new Vector([e[0] - s[0], e[1] - s[1]])
    const m = Math.floor(a.norm / 1e-4)
    const l: number[][] = [s]
    for (let p = 1; p < m; p += 1) {
      const g = s[0] + p * 1e-4 * a.unitVector[0]
      const f = s[1] + p * 1e-4 * a.unitVector[1]
      l.push([g, f])
    }
    return l
  }
  const r = () => {
    const { pointList } = o
    if (!pointList || !pointList[0] || !pointList[0].latitude) throw new Error('任务为空')
    const e = pointList.map((p) => [Number(p.longitude), Number(p.latitude)])
    const u: number[][] = []
    for (let c = 0; c < e.length; c += 1) {
      if (c === e.length - 1) {
        u.push(e[c])
        break
      }
      const a = e[c]
      const m = e[c + 1]
      i(a, m).forEach((l) => {
        u.push(l)
      })
    }
    return u
  }
  const d = (s: number[][]) => {
    let e = 0
    const u = Math.floor(Math.random() * s.length)
    let c = u
    const a: number[][] = [t(s[u]!) ?? s[u]!]
    const m = Number(n) * 1000
    for (; e < m; ) {
      const l = t(s[c] ?? s[u]!)
      a.push(l)
      e = totalDistance(a)
      c += 1
      c >= s.length - 2 && (c = 0)
    }
    return { points: a, distance: e }
  }
  const h = r()
  const M = d(h)
  return {
    mockRoute: M.points.map((s) => ({
      longitude: s[0].toFixed(6),
      latitude: s[1].toFixed(6),
    })),
    distance: (M.distance / 1000).toFixed(2),
  }
}