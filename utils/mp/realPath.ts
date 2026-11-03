/**
 * **「真实路径」的纯算法层**（2026-11-03，1.3.6 需求③，功能标注【测试】）
 *
 * ## 用户口径（原话要点）
 * > "新功能在「我的场地」标签页下，为「真实路径」，登录账号后，可以使用相关内部功能来
 * >  导出**某一天真实跑的路径信息**，并可以选择「导出到本地存为路径预设」或者「导出分享给好友」两种选择，
 * >  用户在跑步界面可以选择这些路径并进行跑步，目前先做到**直接原版数据提交**，后面再慢慢补齐
 * >  （相关功能标注为「测试」）"
 * > 另：分享形态 = **输出一个压缩包**；提交口径 = 用这条路径当本机几何、**走现有原版流程**（报文一字不变）。
 *
 * ## 这一层负责什么（都是纯函数，可离线单测）
 *   ① 把 `getSunrunArch` / `getSunrunArchDetail` 的响应**读成**记录列表与点列（坏数据安全降级）；
 *   ② 按**天**分组（用户要的是"某一天"）；
 *   ③ 从一次真实跑里**切出一圈**（真人跑 3 km 是 5~8 圈；整条当"一圈"会让跑图怪怪的）；
 *   ④ 生成**预设草稿**（存进本机路线库的形状：`freeShape` + `realPath` 元信息）；
 *   ⑤ 分享包（zip 里的那份 JSON）的**构造与解析**，以及 zip 的**读写**（store/deflate 两种都认）。
 *
 * ## 三条纪律
 *   · **只读**：本模块不联网、不写盘；取数在组合层（`composables/useRealPathExport.ts`）；
 *   · **隐私红线**：分享包里**只放路径点 + 必要元信息**，绝不放 token / 学号 / 姓名（见 `buildShareBundle`）；
 *   · **不给旧数据添乱**：预设里的 `realPath` 是可选字段，没有它的条目行为与旧版逐字一致。
 */

/** 一个坐标点（与项目其余部分同口径：`latitude`/`longitude`） */
export interface RealPathPoint {
  latitude: number
  longitude: number
}

/**
 * 一条"真实路径"的**来源元信息**（写进预设的 `realPath` 字段；界面与分享包都用它）。
 *
 * ⚠️ 这里**只放能对得上账的事实**：日期、场次号、里程、用时、拟合度、点数、导出时刻。
 *    不放学号/姓名/token（隐私红线，见模块头注释）。
 */
export interface RealPathMeta {
  /** 成绩日期（服务端 `runTime`，`YYYY-MM-DD`） */
  date: string
  /** 场次号（服务端 `scoreId`，形如 `sunrunId202611011234`） */
  scoreId: string
  /** 里程（km；读不出 ⇒ `null`） */
  km: number | null
  /** 用时原文（服务端 `usedTime`，形如 `00:20:25`；读不出 ⇒ 空串） */
  usedTime: string
  /** 拟合度（读不出 ⇒ `null`） */
  fitDegree: number | null
  /** 原始点数（切成"一圈"之前） */
  sourcePoints: number
  /** 导出时刻（ISO 字符串） */
  exportedAt: string
}

/** 成绩归档里的一条（只取本功能要用的字段；其余原样留着不猜） */export interface RealPathRecord {
  scoreId: string
  /** `YYYY-MM-DD`（读不出 ⇒ 空串，界面据此归到"日期未知"） */
  date: string
  /** 时间部分（`startTmie`，`HH:mm:ss`；读不出 ⇒ 空串） */
  startTime: string
  km: number | null
  usedTime: string
  fitDegree: number | null
  /** 判定 0 无效 / 1 有效 / 2 申诉有效 / 3 补录有效（读不出 ⇒ `null`） */
  passType: number | null
}

/**
 * 宽松数字解析 → `null`（**空值必须当"没有"**）。
 *
 * ⚠️ 这里踩过一次：`Number(null) === 0`、`Number('') === 0` —— 直接 `Number.isFinite(Number(v))`
 *    会把"服务端没给坐标"读成 **(0, 0)**（几内亚湾那个点），于是轨迹里凭空多一个飞点、
 *    而且它离真实路径几千公里，拟合度/里程全被它带歪。判据：`null`/`undefined`/空白串一律 `null`。
 */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

/**
 * **解码**一条存进路线库的 `realPath` 元信息（`normalizeLibrary` 用；坏数据 ⇒ `undefined`）。
 *
 * 判据：至少要能看出"这是哪一场"（`date` 或 `scoreId` 有一个非空），否则当作没有 ——
 * 一条只有 `{km: 3}` 的残缺元信息没有任何解释力，留着只会让界面显示一堆"未记录"。
 */
export function parseRealPathMeta(raw: unknown): RealPathMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  const date = isIsoDate(v.date) ? str(v.date) : ''
  const scoreId = str(v.scoreId)
  if (!date && !scoreId) return undefined
  return {
    date,
    scoreId,
    km: num(v.km),
    usedTime: str(v.usedTime),
    fitDegree: num(v.fitDegree),
    sourcePoints: Math.max(0, Math.round(Number(v.sourcePoints) || 0)),
    exportedAt: str(v.exportedAt),
  }
}

/** `YYYY-MM-DD` 形态（服务端 `runTime` 就是它；别的时间形态一律当"日期未知"） */
export function isIsoDate(s: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(str(s))
}

/**
 * 解析 `getSunrunArch` 的响应 → 记录列表（**只读、坏数据安全降级**）。
 *
 * 负载口径与 `composables/real/submit.ts` 的读判定**同源**：`MP_ENDPOINTS.sunrunArch.payload`
 * 解包后取 `data[]`。所以这里的入参就是**已解包的负载对象**（`{ data: [...] }`），
 * 也接受**裸数组**（少数端点/旧版会直接回数组）。
 */
export function parseArchRecords(payload: unknown): RealPathRecord[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | null)?.data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : []
  const out: RealPathRecord[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const scoreId = str(r.scoreId)
    if (!scoreId) continue
    out.push({
      scoreId,
      date: isIsoDate(r.runTime) ? str(r.runTime) : '',
      startTime: str(r.startTmie),
      km: num(r.mileage),
      usedTime: str(r.usedTime),
      fitDegree: num(r.trajectorySimilary),
      passType: num(r.scorePassType),
    })
  }
  return out
}

/** 按天分组的容器（日期倒序；"日期未知"排最后） */
export interface RealPathDay {
  date: string
  records: RealPathRecord[]
}

/**
 * 按**天**分组（用户口径："导出某一天真实跑的路径信息"）。
 * 判据：日期倒序（`''` 排最后）；同一天内按开始时间倒序（读不出的排最后）。
 */
export function groupRecordsByDay(records: RealPathRecord[]): RealPathDay[] {
  const map = new Map<string, RealPathRecord[]>()
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object') continue
    const key = isIsoDate(r.date) ? r.date : ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  const days = [...map.entries()].map(([date, list]) => ({
    date,
    records: [...list].sort((a, b) => String(b.startTime).localeCompare(String(a.startTime))),
  }))
  return days.sort((a, b) => {
    if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : 0
    return b.date.localeCompare(a.date)
  })
}

/**
 * 解析 `getSunrunArchDetail` 的响应 → 点列。
 *
 * 口径：负载里 `pointList[]`（`{latitude, longitude}`）；**逐点过滤非法坐标**（NaN/缺字段/越界纬度）。
 * 返回空数组 = "这条没有轨迹"（界面据此如实说，不假装有）。
 */
export function parseArchDetailPoints(payload: unknown): RealPathPoint[] {
  const src = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { pointList?: unknown } | null)?.pointList)
      ? ((payload as { pointList: unknown[] }).pointList as unknown[])
      : []
  const out: RealPathPoint[] = []
  for (const raw of src) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as Record<string, unknown>
    const latitude = num(p.latitude)
    const longitude = num(p.longitude)
    if (latitude === null || longitude === null) continue
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue
    out.push({ latitude, longitude })
  }
  return out
}

/** 两点距离（米，haversine；与 `routeSimilarity.distanceMeters` 同口径，但本模块不引它以免多一层依赖） */
export function distanceM(p1: RealPathPoint, p2: RealPathPoint): number {
  const R = 6378137
  const rad = Math.PI / 180
  const dLat = (p2.latitude - p1.latitude) * rad
  const dLng = (p2.longitude - p1.longitude) * rad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.latitude * rad) * Math.cos(p2.latitude * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 点列总长（米） */
export function pathLengthM(points: RealPathPoint[]): number {
  const list = Array.isArray(points) ? points : []
  let sum = 0
  for (let i = 1; i < list.length; i++) sum += distanceM(list[i - 1]!, list[i]!)
  return sum
}

/**
 * **从一次真实跑里切出"一圈"**（本功能的关键一步，纯函数）。
 *
 * ## 为什么必须切
 * 真人一次跑 3 km = 5~8 圈。若把**整条**轨迹当成"一圈"存进路线库，
 * 跑图时"一圈"就变成 3 km（`lapLengthM` 报 3000 m、按圈着色只有 1 圈、换圈剖面 n=1）——
 * 那不是用户想要的"用这条路径跑"。
 *
 * ## 判据（**从前往后**找第一段闭合，不是从后往前）
 * 依次检查 `p[i]`：累计长度 ≥ `minM` **且** `distance(p[i], p[0]) ≤ tolM` ⇒ 取 `p[0..i]` 作为一圈。
 *   · 取**第一段**：多圈轨迹里"从后往前找"会落在**最后一圈**（甚至整条），
 *     实测 5 圈 241 点的轨迹被整条返回（`❌ 应取回约一圈，实际 241`）；
 *   · 找不到（不是闭环 / 跑得歪）⇒ **原样返回整条**（绝不凭空造一个闭合环）；
 *   · 输入不足 3 点 ⇒ 原样返回（调用方自己判"不可用"）。
 */
export function extractOneLap(points: RealPathPoint[], opts: { tolM?: number; minM?: number } = {}): RealPathPoint[] {
  const list = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) : []
  if (list.length < 3) return list
  const tolM = Math.max(5, Number(opts.tolM ?? 25))
  const minM = Math.max(50, Number(opts.minM ?? 200))
  const start = list[0]!
  /** 累计长度（用于 `minM` 判据） */
  const cum = [0]
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1]! + distanceM(list[i - 1]!, list[i]!))
  let best = -1
  for (let i = 2; i < list.length; i++) {
    if (cum[i]! < minM) continue
    if (distanceM(list[i]!, start) <= tolM) {
      best = i
      break
    }
  }
  if (best < 0) return list
  return list.slice(0, best + 1)
}

/**
 * **等距降采样**（`maxPoints` 上限）：真实轨迹动辄 1000+ 点，全存进 localStorage 会让库变小胖。
 * 判据：`points.length ≤ maxPoints` 时**原样返回**（不做任何改动）；否则按步长抽，**首末必留**。
 * ⚠️ 这不是"简化形状"（那要看垂直距离），只是为了控制体积 —— 所以别指望它保拐角，
 *    真正会毁形状的场景（例如折返尖角）由调用方传足够大的上限来避免。
 */
export function downsamplePath(points: RealPathPoint[], maxPoints = 600): RealPathPoint[] {
  const list = Array.isArray(points) ? points : []
  const max = Math.max(8, Math.round(Number(maxPoints) || 600))
  if (list.length <= max) return list
  const step = (list.length - 1) / (max - 1)
  const out: RealPathPoint[] = []
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]!)
  /** 首末必须精确是原来的首末（四舍五入可能落到次末点） */
  out[0] = list[0]!
  out[out.length - 1] = list[list.length - 1]!
  return out
}

/**
 * 拟一个**默认的预设名**（用户可改）：`真实路径 2026-11-01`（同一天多条时带时刻 `· 0812`）。
 * ⚠️ 名字的**唯一性不在这里判**（那是 `autoPresetName` / `findNameConflict` 的事），
 *    本函数只负责"给一个像样的起点"。
 */
export function defaultRealPathName(meta: Pick<RealPathMeta, 'date' | 'usedTime'> & { startTime?: string }): string {
  const d = isIsoDate(meta.date) ? meta.date : '日期未知'
  const t = String(meta.startTime ?? '').replace(/:/g, '').slice(0, 4)
  return t ? `真实路径 ${d} · ${t}` : `真实路径 ${d}`
}

/** 生成预设草稿需要的输入（组合层从"选中的那天那条记录 + 它的点列"组装） */
export interface RealPathPresetDraftInput {
  meta: RealPathMeta
  /** 切成"一圈"并且降采样之后的点（顺序即跑向） */
  points: RealPathPoint[]
  /** 保存到哪个**地点**（厂商线路 `pointId` 或本机键；界面让用户选） */
  lineId: string
  /** 那个地点的名字快照 */
  lineName: string
  /** 用户填的预设名（留空则由组合层自动命名） */
  presetName?: string
}

/**
 * 由"真实路径 + 目标地点"生成**预设草稿**（还不落库；落库走 `lib.upsert`）。
 *
 * 口径与「研途健行路径编辑器」保存的那条**完全一致**（这样才能被跑步页当几何用）：
 *   · 几何权威是 `freeShape`（`kind: 'curve'`，首尾自动闭合）；
 *   · `outer`/`inner` 放**占位几何**（≥3 点，给旧版本应用看）—— 复用 `freeShapePlaceholderRing`；
 *   · `start` 显式 `null`（形状就是路径本身，"起跑点 = 第 1 个点"）。
 *
 * ⚠️ 返回的是**给 `upsert` 的入参**，不是已经归一化的 `TrackRouteEntry`；
 *    `realPath` 元信息一并带上（可选字段，旧数据没有它 ⇒ 行为不变）。
 */
export function buildRealPathPresetDraft(input: RealPathPresetDraftInput): {
  lineId: string
  lineName: string
  presetName: string
  outer: RealPathPoint[]
  inner: RealPathPoint[]
  freeShape: { kind: 'curve'; points: RealPathPoint[] }
  start: null
  realPath: RealPathMeta
} {
  const points = (Array.isArray(input.points) ? input.points : []).map((p) => ({
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
  }))
  /** 占位几何：把真实路径**均匀取 3 点**充数（旧版本只要求"内外圈各 ≥3 点"） */
  const placeholder = (() => {
    if (points.length < 3) return points
    const idx = [0, Math.floor(points.length / 2), points.length - 1]
    return idx.map((i) => points[i]!)
  })()
  return {
    lineId: String(input.lineId ?? ''),
    lineName: String(input.lineName ?? ''),
    presetName: String(input.presetName ?? ''),
    outer: placeholder.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    inner: placeholder.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    freeShape: { kind: 'curve', points },
    start: null,
    realPath: { ...input.meta },
  }
}

// ---------------------------------------------------------------- 分享包（zip 里那份 JSON）

/** 分享包的格式版本（改了它就要考虑旧包还能不能读） */
export const REAL_PATH_BUNDLE_VERSION = 1
/** 分享包里的**唯一**条目名（固定，便于人肉排查） */
export const REAL_PATH_BUNDLE_FILE = 'totoro-real-path.json'
/** 分享包的种类标记（防止把别的 JSON 当路径包导入） */
export const REAL_PATH_BUNDLE_KIND = 'totoro-real-path'

/** 分享包里的**一条**路径（只放几何 + 元信息，**绝不放 token/学号/姓名**） */
export interface RealPathBundleItem {
  name: string
  lineId: string
  lineName: string
  points: RealPathPoint[]
  meta: RealPathMeta
}

/** 分享包（会被序列化进 zip 的唯一 JSON） */
export interface RealPathBundle {
  kind: typeof REAL_PATH_BUNDLE_KIND
  version: number
  /** 导出时刻（ISO） */
  exportedAt: string
  items: RealPathBundleItem[]
}

/**
 * 构造分享包（**只有几何与必要元信息**）。
 * 🔴 隐私红线：这里**只挑白名单字段**，绝不整对象透传（`TrackRouteEntry` 里将来加了什么都不会漏出去）。
 */
export function buildShareBundle(items: RealPathBundleItem[], exportedAt = new Date().toISOString()): RealPathBundle {
  return {
    kind: REAL_PATH_BUNDLE_KIND,
    version: REAL_PATH_BUNDLE_VERSION,
    exportedAt: String(exportedAt),
    items: (Array.isArray(items) ? items : []).map((it) => ({
      name: String(it.name ?? ''),
      lineId: String(it.lineId ?? ''),
      lineName: String(it.lineName ?? ''),
      points: (Array.isArray(it.points) ? it.points : []).map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
      meta: {
        date: String(it.meta?.date ?? ''),
        scoreId: String(it.meta?.scoreId ?? ''),
        km: it.meta?.km === null || it.meta?.km === undefined ? null : Number(it.meta.km),
        usedTime: String(it.meta?.usedTime ?? ''),
        fitDegree: it.meta?.fitDegree === null || it.meta?.fitDegree === undefined ? null : Number(it.meta.fitDegree),
        sourcePoints: Number(it.meta?.sourcePoints ?? 0) || 0,
        exportedAt: String(it.meta?.exportedAt ?? ''),
      },
    })),
  }
}

/** 解析分享包的结果（`error` 非空 = 读不了，且**说明原因**） */
export interface ParsedBundle {
  ok: boolean
  /** 失败原因（人话；成功时为空串） */
  error: string
  items: RealPathBundleItem[]
}

/**
 * 解析分享包（**坏数据一律拒绝并说明原因**，绝不半信半疑地导入）。
 * 判据：`kind` 必须是 `totoro-real-path`；`version` 认 1（更高的版本如实提示"需要更新软件"）；
 * 每条至少 3 个**合法**坐标点，否则丢掉那一条（并计数报告）。
 */
export function parseShareBundle(raw: unknown): ParsedBundle {
  const fail = (error: string): ParsedBundle => ({ ok: false, error, items: [] })
  let obj = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return fail('这不是一个有效的 JSON（文件可能损坏，或者不是路径包）')
    }
  }
  if (!obj || typeof obj !== 'object') return fail('路径包内容为空')
  const b = obj as Record<string, unknown>
  if (str(b.kind) !== REAL_PATH_BUNDLE_KIND) return fail('这不是「龙猫天堂」导出的路径包（缺少 kind 标记）')
  const version = Number(b.version)
  if (!Number.isFinite(version) || version < 1) return fail('路径包版本号不合法')
  if (version > REAL_PATH_BUNDLE_VERSION) return fail(`这个包是更新版本导出的（v${version}），请先更新软件再导入`)
  const list = Array.isArray(b.items) ? b.items : []
  const items: RealPathBundleItem[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const v = it as Record<string, unknown>
    const points = parseArchDetailPoints(v.points)
    if (points.length < 3) continue
    const meta = (v.meta && typeof v.meta === 'object' ? v.meta : {}) as Record<string, unknown>
    items.push({
      name: str(v.name),
      lineId: str(v.lineId),
      lineName: str(v.lineName),
      points,
      meta: {
        date: isIsoDate(meta.date) ? str(meta.date) : '',
        scoreId: str(meta.scoreId),
        km: num(meta.km),
        usedTime: str(meta.usedTime),
        fitDegree: num(meta.fitDegree),
        sourcePoints: Number(meta.sourcePoints) || 0,
        exportedAt: str(meta.exportedAt),
      },
    })
  }
  if (!items.length) return fail('路径包里没有可用的路径（可能是空包，或坐标全部损坏）')
  return { ok: true, error: '', items }
}

/**
 * 从路径包里挑出**一条**要导入的（用户在界面上选；这里只做"选中"的纯逻辑）。
 * 传索引越界 ⇒ 返回 `undefined`（界面据此说"没选中"）。
 */
export function pickBundleItem(items: RealPathBundleItem[], index: number): RealPathBundleItem | undefined {
  const list = Array.isArray(items) ? items : []
  const i = Math.trunc(Number(index))
  if (!Number.isFinite(i) || i < 0 || i >= list.length) return undefined
  return list[i]
}

// ---------------------------------------------------------------- zip 读取（store + deflate）

/** 读出来的一个条目 */
export interface ZipReadEntry {
  name: string
  data: Uint8Array
}

/**
 * **读 ZIP**（本功能只需要"读回自己导出的那个包"）。
 *
 * 支持两种 method：**0 = store**（我们自己写的包就是这个）与 **8 = deflate**
 * （好友可能用微信/7-Zip 重新压过；deflate 走平台的 `DecompressionStream('deflate-raw')`，
 * Node 18+ 与 Chrome 都内置，不引第三方库）。
 *
 * ⚠️ 只认 **local file header + central directory 之前的条目**：按 central directory 逐个定位，
 *    不靠"顺序扫描签名"（后者遇到文件名里带 `PK` 字节会读错）。
 * 判据：找不到 EOCD / central 段损坏 ⇒ 抛错（调用方转成人话）；不静默返回空包。
 */
export async function readZip(bytes: Uint8Array): Promise<ZipReadEntry[]> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(0)
  if (buf.length < 22) throw new Error('zip 太小（不是有效压缩包）')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  /** ① 找 EOCD（从尾部往前扫，最多 65557 字节） */
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip 里找不到目录（EOCD）')
  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (!(count > 0) || cdOffset <= 0 || cdOffset >= buf.length) throw new Error('zip 目录段不合法')
  const decoder = new TextDecoder('utf-8')
  const out: ZipReadEntry[] = []
  let at = cdOffset
  for (let k = 0; k < count; k++) {
    if (at + 46 > buf.length) throw new Error('zip 目录段越界')
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('zip 目录项签名不对')
    const method = view.getUint16(at + 10, true)
    const compSize = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const name = decoder.decode(buf.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen
    /** ② 按 local header 定位真实数据 */
    if (localOffset + 30 > buf.length) throw new Error(`zip 条目「${name}」的本地头越界`)
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`zip 条目「${name}」的本地头签名不对`)
    const lNameLen = view.getUint16(localOffset + 26, true)
    const lExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error(`zip 条目「${name}」的数据越界`)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (method === 0) {
      out.push({ name, data: raw })
    } else if (method === 8) {
      out.push({ name, data: await inflateRaw(raw) })
    } else {
      throw new Error(`zip 条目「${name}」用了不支持的压缩方式（method=${method}）`)
    }
  }
  return out
}

/** deflate-raw 解压（平台内置 `DecompressionStream`；不可用就如实报错，不假装成功） */
async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: new (format: string) => DecompressionStream }).DecompressionStream
  if (!Ctor) throw new Error('当前环境不支持解压 deflate（请让好友直接发原包，或用「导出到本地」的那份）')
  /** ⚠️ 先拷成独立的 `ArrayBuffer` 再交给 Blob：`Uint8Array<ArrayBufferLike>` 可能是 SharedArrayBuffer 视图，
   *  而 `BlobPart` 只收 `ArrayBuffer`/`ArrayBufferView<ArrayBuffer>`（TS 会拦，运行时也可能行为不同）。 */
  const copy = new Uint8Array(raw.byteLength)
  copy.set(raw)
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new Ctor('deflate-raw'))
  const out = new Uint8Array(await new Response(stream).arrayBuffer())
  return out
}

/**
 * 从 zip 里取出路径包 JSON 并解析（**一步到位**，界面只调这一个）。
 * 找不到 JSON ⇒ 明确报错（说明"包里没有路径数据"），不静默当空包。
 */
export async function readShareBundleFromZip(bytes: Uint8Array): Promise<ParsedBundle> {
  let entries: ZipReadEntry[]
  try {
    entries = await readZip(bytes)
  } catch (err) {
    return { ok: false, error: `读不了这个压缩包：${err instanceof Error ? err.message : '未知错误'}`, items: [] }
  }
  const entry = entries.find((e) => /\.json$/i.test(e.name)) ?? entries[0]
  if (!entry) return { ok: false, error: '压缩包里没有文件', items: [] }
  const text = new TextDecoder('utf-8').decode(entry.data)
  return parseShareBundle(text)
}
