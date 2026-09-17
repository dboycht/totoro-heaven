/**
 * 线路按校区分组（纯函数，零依赖，有单测）
 *
 * 背景（2026-09-15 实测发现）：
 *   `getSunrunPaper` 下发的线路**横跨多个校区**（南航样例 8 条线路分属 3 个地理簇，
 *   最近两簇相距 10.8 km、最远约 90~97 km），而且**线路名称与坐标可能对不上**
 *   （样例里标「将军路」的线路坐标并不在将军路那一簇）。
 *   ⇒ 判断"哪条线路属于哪个校区"**必须用坐标，不能靠名称字符串**。
 *
 * 做法：
 *   1. 对每条线路取其点列中点 → 用**单链聚类**（两点距离 ≤ distanceThresholdM 即同簇）分组；
 *   2. 找出**本校区簇**：名称含学校下发的校区名（如「天目湖」）的那条线路所在簇；
 *      无匹配时取**线路最多**的簇（真实情况通常是主校区），标记为 `inferred`（推断）；
 *   3. 本校区优先排序，其他簇标注与本校区的距离（便于用户判断"这条离我多远"）；
 *   4. 默认选线 = 本校区第一条。
 *
 * ⚠️ 本模块只做**分组与展示**，不阻止用户选择其他校区的线路（用户可能确实要跨校区），
 *    但会给出提示文案（`warnForSelection`）。
 */
import { distanceMeters, pathLengthMeters, type LatLng } from './routeSimilarity'
import type { MpRunLine } from '../../src/mp/types'

/** 聚类阈值（米）：同校区内线路间距通常几百米级，跨校区至少数公里 → 3000 足够区分 */
export const ROUTE_CLUSTER_THRESHOLD_M = 3000

export type RouteCampusKind = 'home' | 'other'

/** 一条线路 + 其分组信息 */
export interface GroupedRoute {
  line: MpRunLine
  /** 所属簇序号（0 起，越小越靠前 = 越可能是本校区） */
  clusterIndex: number
  /** home = 本校区 / other = 其他校区 */
  kind: RouteCampusKind
  /** 与本校区簇的距离（米）；本校区为 0 */
  distanceFromHomeM: number
  /** 线路总长度（米），便于展示 */
  lengthM: number
}

/** 一个校区簇 */
export interface RouteCluster {
  index: number
  kind: RouteCampusKind
  /** 簇内线路数 */
  count: number
  /** 代表坐标（簇内所有线路中点的质心） */
  centroid: LatLng
  /** 与本校区簇的距离（米）；本校区为 0 */
  distanceFromHomeM: number
  /** 分组标签（下拉框标题） */
  label: string
  routes: GroupedRoute[]
}

export interface RouteGroupsResult {
  clusters: RouteCluster[]
  /** 本校区簇（找不到匹配时取线路最多的簇，并置 inferred=true） */
  homeCluster: RouteCluster | null
  /** 本校区是"推断"出来的（没有任何线路名含校区名） */
  inferred: boolean
  /** 拍平后的有序列表（本校区在前） */
  ordered: GroupedRoute[]
  /** 默认应选中的线路 id（本校区第一条；无线路时为空串） */
  defaultLineId: string
  /** 分组依据说明（界面提示用） */
  note: string
}

/** 极简并查集 */
function createUnionFind(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)))
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  return { find, union }
}

/** 线路代表点：点列中点（比首点更稳，避免首点采集异常） */
function representativePoint(line: MpRunLine): LatLng | null {
  const pts = line.pointList ?? []
  if (!pts.length) return null
  const p = pts[Math.floor(pts.length / 2)]!
  const lat = Number(p.latitude)
  const lng = Number(p.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { latitude: lat, longitude: lng }
}

function centroidOf(points: LatLng[]): LatLng {
  if (!points.length) return { latitude: 0, longitude: 0 }
  let latSum = 0
  let lngSum = 0
  for (const p of points) {
    latSum += Number(p.latitude)
    lngSum += Number(p.longitude)
  }
  return { latitude: latSum / points.length, longitude: lngSum / points.length }
}

const kmText = (m: number) => (m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`)

/**
 * 把线路按校区（地理簇）分组。
 * @param lines 线路列表（来自 `getSunrunPaper` 的 `runPointList`）
 * @param campusName 学校下发的校区名（如「天目湖」）；用于识别本校区簇
 * @param thresholdM 聚类阈值（默认 3000 m）
 */
export function groupRoutesByCampus(
  lines: MpRunLine[],
  campusName?: string | null,
  thresholdM = ROUTE_CLUSTER_THRESHOLD_M,
): RouteGroupsResult {
  const valid = lines.filter((l) => representativePoint(l))
  if (!valid.length) {
    return {
      clusters: [],
      homeCluster: null,
      inferred: false,
      ordered: [],
      defaultLineId: '',
      note: '当前任务没有可用线路。',
    }
  }

  // ① 单链聚类：任意两条线路代表点距离 ≤ 阈值即同簇
  const reps = valid.map((l) => representativePoint(l)!)
  const uf = createUnionFind(valid.length)
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      const d = distanceMeters(
        Number(reps[i]!.latitude),
        Number(reps[i]!.longitude),
        Number(reps[j]!.latitude),
        Number(reps[j]!.longitude),
      )
      if (d <= thresholdM) uf.union(i, j)
    }
  }

  // ② 汇总各簇
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < valid.length; i++) {
    const root = uf.find(i)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root)!.push(i)
  }

  interface RawCluster {
    members: number[]
    centroid: LatLng
    hasCampusName: boolean
  }
  const raw: RawCluster[] = [...byRoot.values()].map((members) => {
    const centroid = centroidOf(members.map((i) => reps[i]!))
    const hasCampusName = Boolean(
      campusName && campusName.trim() && members.some((i) => String(valid[i]!.pointName ?? '').includes(campusName.trim())),
    )
    return { members, centroid, hasCampusName }
  })

  // ③ 定本校区簇：优先"线路名含校区名"，否则取线路最多的簇（标 inferred）
  let homeRawIndex = raw.findIndex((c) => c.hasCampusName)
  let inferred = false
  if (homeRawIndex < 0) {
    inferred = raw.length > 1
    homeRawIndex = raw.reduce((best, c, i) => (c.members.length > raw[best]!.members.length ? i : best), 0)
  }
  const homeCentroid = raw[homeRawIndex]!.centroid

  // ④ 组装（本校区排第一，其余按距离升序）
  const clusters: RouteCluster[] = raw
    .map((c, i) => {
      const distanceFromHomeM =
        i === homeRawIndex
          ? 0
          : Math.round(
              distanceMeters(
                Number(homeCentroid.latitude),
                Number(homeCentroid.longitude),
                Number(c.centroid.latitude),
                Number(c.centroid.longitude),
              ),
            )
      const routes: GroupedRoute[] = c.members.map((mi) => {
        const line = valid[mi]!
        const pts: LatLng[] = (line.pointList ?? []).map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }))
        return {
          line,
          clusterIndex: i,
          kind: (i === homeRawIndex ? 'home' : 'other') as RouteCampusKind,
          distanceFromHomeM,
          lengthM: Math.round(pathLengthMeters(pts)),
        }
      })
      const isHome = i === homeRawIndex
      // ⚠️ 措辞必须区分"确认"与"推断"：档案没加载（如刷新后只有缓存任务）时无法知道本校区，
      //    此时把线路最多的簇叫"本校区"是误导 → 明确写成"推断"。
      const label = isHome
        ? inferred
          ? `线路最多的一组（推断为本校区） · ${routes.length} 条`
          : `本校区${campusName ? `（${campusName}）` : ''} · ${routes.length} 条`
        : inferred
          ? `另一组线路（约 ${kmText(distanceFromHomeM)}） · ${routes.length} 条`
          : `其他校区（约 ${kmText(distanceFromHomeM)}） · ${routes.length} 条`
      return { index: i, kind: (isHome ? 'home' : 'other') as RouteCampusKind, count: routes.length, centroid: c.centroid, distanceFromHomeM, label, routes }
    })
    .sort((a, b) => (a.kind === b.kind ? a.distanceFromHomeM - b.distanceFromHomeM : a.kind === 'home' ? -1 : 1))
    .map((c, i) => ({ ...c, index: i }))

  const ordered = clusters.flatMap((c) => c.routes.map((r) => ({ ...r, clusterIndex: c.index })))
  const homeCluster = clusters.find((c) => c.kind === 'home') ?? null
  const defaultLineId = homeCluster?.routes[0]?.line.pointId ?? ordered[0]?.line.pointId ?? ''

  const note = inferred
    ? `没找到名称含「${campusName || '本校区'}」的线路 → 已按"线路最多的簇"推断本校区（${homeCluster?.count ?? 0} 条），选线时请核对。`
    : `已按坐标把 ${clusters.length} 个校区共 ${ordered.length} 条线路分组（本校区优先）。`

  return { clusters, homeCluster, inferred, ordered, defaultLineId, note }
}

/** 用户选了其他校区线路时的提示语（没跨校区返回空串） */
export function warnForSelection(groups: RouteGroupsResult, lineId: string): string {
  const hit = groups.ordered.find((r) => String(r.line.pointId) === String(lineId))
  if (!hit || hit.kind === 'home') return ''
  // ⚠️ 2026-09-17 修：**校区未知时不许下"其他校区"的结论**。
  //    实测（用户真实反馈）：刷新后只剩缓存任务、档案没加载 ⇒ 拿不到校区名 ⇒ 代码按"线路最多的一组"推断本校区
  //    （将军路 4 条），于是把**用户真正的天目湖校区**判成"其他校区，约 91 km" —— 纯误导。
  if (groups.inferred) {
    return 'ℹ️ 暂时无法判定校区归属（档案未加载或档案里没有校区名）：请确认所选线路属于你的校区；' +
      '回「工作台」点「一键获取 token / 读取真实账号与任务」后会自动识别。'
  }
  return `⚠️ 你选的是【其他校区】的线路，距本校区约 ${kmText(hit.distanceFromHomeM)}：轨迹会生成在该校区，请确认这是你要跑的。`
}

/** 下拉框选项（v-select 的 items）：分组标题（禁用项）+ 「名称（点数 · 长度 · 跨校区提示）」 */
export interface RouteSelectItem {
  title: string
  value?: string
  props?: { disabled: boolean }
}

export function toSelectItems(groups: RouteGroupsResult): RouteSelectItem[] {
  const items: RouteSelectItem[] = []
  for (const c of groups.clusters) {
    items.push({ title: c.label, props: { disabled: true } })
    for (const r of c.routes) {
      // ⚠️ 线路名缺失时**不要裸显示 ID** —— 用户看到 `sunrunLine-2021...` 会以为是 bug（2026-09-17 反馈）
    const rawName = String(r.line.pointName ?? '').trim()
    const name = rawName || `未命名线路（${String(r.line.pointId)}）`
      const count = r.line.pointList?.length ?? 0
      const len = r.lengthM >= 1000 ? `${(r.lengthM / 1000).toFixed(2)} km` : `${r.lengthM} m`
      const away = r.kind === 'home' ? '' : ` · 跨校区 ${kmText(r.distanceFromHomeM)}`
      items.push({ title: `　${name}（${count} 点 · ${len}${away}）`, value: String(r.line.pointId) })
    }
  }
  return items
}
