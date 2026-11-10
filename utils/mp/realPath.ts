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
  /** 原始点数（🆕 2026-11-04 起轨迹**原样整条**保存，本字段就是整场的点数） */
  sourcePoints: number
  /**
   * 🆕 **一圈长度**（米；读不出闭环 ⇒ `null`）。
   * 轨迹改成**原样整条**（不切圈、不降采样）后，切圈只为了**报数**：
   * 预览按它把整条轨迹按圈着色（用户口径"仍按一圈长着色"）；`null` ⇒ 预览整条一色。
   */
  lapLengthM: number | null
  /** 导出时刻（ISO 字符串） */
  exportedAt: string
}

/** 成绩归档里的一条（只取本功能要用的字段；其余原样留着不猜） */export interface RealPathRecord {
  scoreId: string
  /**
   * 🆕 任务 id（服务端 `paperId`）—— 记录里**唯一**指向"哪次任务"的字段。
   * ⚠️ 归档记录**没有线路 id**（字段表见 `_mp-analyze/深挖/D-配置与归档数据模型.md` §4.1），
   *    所以"这次跑的是哪条线路"只能靠 `nearestLineByGeometry()` 用**轨迹位置**判断。
   */
  paperId: string
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
    /** 🆕 2026-11-04：旧数据没有 `lapLengthM` ⇒ `null`（预览整条一色，不猜） */
    lapLengthM: num(v.lapLengthM),
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
      paperId: str(r.paperId),
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
 * ## 判据（**从任意一点起算**，不是只认 `p[0]`）
 * 对每个起点 `i`：找最小的 `j`，使 `dist(p[i], p[j]) ≤ tolM` 且 `arc(i..j) ≥ minM`；
 * 取**第一组**（`i` 最小）命中，返回 `p[i..j]`。
 *
 * ## 为什么不能用 `p[0]` 当基准（2026-11-03 实测踩到）
 * 真人开跑前常常**从场外走进来**（进场几步、站在跑道边调表）⇒ `p[0]` 根本不在跑道上，
 * 于是"回到起点 25 m 内"**永远不会命中**，函数退回整条轨迹 —— 用户看到的就是
 * "原始 1121 点 → 存成预设时用 600 点"（只是降采样，根本没切圈）。
 * 改成从任意点起算后，只要**跑道上任意一处**之后又回到附近，就能切出那一圈。
 *
 * ## 其它口径
 *   · 找不到（不是闭环 / 跑得歪）⇒ **原样返回整条**（绝不凭空造一个闭合环）；
 *   · 输入不足 3 点 ⇒ 原样返回（调用方自己判"不可用"）；
 *   · 返回的片段**首尾都在闭环附近**，因此交给 `freeShape: curve`（首尾自动闭合）语义正确。
 */
export function extractOneLap(points: RealPathPoint[], opts: { tolM?: number; minM?: number } = {}): RealPathPoint[] {
  const list = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) : []
  if (list.length < 3) return list
  const tolM = Math.max(5, Number(opts.tolM ?? 25))
  const minM = Math.max(50, Number(opts.minM ?? 200))
  /** 累计长度（用于 `minM` 判据） */
  const cum = [0]
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1]! + distanceM(list[i - 1]!, list[i]!))
  /**
   * 全量枚举是 O(n²)（1121 点 ≈ 63 万次比较，纯浮点，毫秒级）；
   * 为了让长轨迹也不卡，限制**每个起点只看最多 `SCAN_AHEAD` 个后续点**（覆盖到 ~2 圈足够）。
   */
  const SCAN_AHEAD = Math.min(list.length - 1, 1200)
  for (let i = 0; i < list.length - 2; i++) {
    const a = list[i]!
    for (let j = i + 2; j <= Math.min(list.length - 1, i + SCAN_AHEAD); j++) {
      if (cum[j]! - cum[i]! < minM) continue
      if (distanceM(a, list[j]!) <= tolM) {
        return list.slice(i, j + 1)
      }
    }
  }
  return list
}

/**
 * **按几何位置判断"这一跑属于哪条官方线路"**（2026-11-03，用户实测反馈"没识别到任务记录的线路"）。
 *
 * ## 为什么必须靠几何
 * `getSunrunArch` 的记录里**只有 `paperId`（任务 id），没有线路 id**（字段表见
 * `_mp-analyze/深挖/D-配置与归档数据模型.md` §4.1）—— 也就是说**服务端不告诉我们那次跑的是哪条线**。
 * 而任务的线路之间通常相隔很远（东操场/西操场/图书馆…）⇒ 用轨迹与各线路 `pointList` 的**最近距离**
 * 判断，既准确又不需要额外接口。
 *
 * ## 判据
 * 对每条线路算"轨迹点到该折线的**最小**距离"，取最小者；
 *   · 若最小距离 > `maxDistM`（默认 150 m）⇒ 认定为"匹配不上"，返回 `null`
 *     （宁可让用户自己选，也不硬塞一条错的地点）；
 *   · 相同距离时按传入顺序取第一条（稳定、可测）。
 * ⚠️ 纯函数、无副作用；只做"建议"，最终存到哪个地点仍由界面上的下拉决定。
 */
export function nearestLineByGeometry(
  points: RealPathPoint[],
  lines: { pointId: string; pointName?: string; pointList?: RealPathPoint[] }[],
  opts: { maxDistM?: number; stride?: number } = {},
): { pointId: string; pointName: string; distM: number } | null {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
  if (pts.length < 3) return null
  /** 点太多没必要全算（每隔 `stride` 取一个，默认让 1000 点降到 ~200 点） */
  const stride = Math.max(1, Math.round(Number(opts.stride ?? Math.ceil(pts.length / 200))))
  const sampled: RealPathPoint[] = []
  for (let i = 0; i < pts.length; i += stride) sampled.push(pts[i]!)
  if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]!)
  const maxDistM = Math.max(10, Number(opts.maxDistM ?? 150))

  let best: { pointId: string; pointName: string; distM: number } | null = null
  for (const line of Array.isArray(lines) ? lines : []) {
    const poly = (Array.isArray(line?.pointList) ? line.pointList : []).filter(
      (p) => p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)),
    ) as RealPathPoint[]
    const id = String(line?.pointId ?? '').trim()
    if (!id || poly.length < 2) continue
    /** 轨迹点到这条线路折线的**最小距离**（逐段求点到线段距离） */
    let minD = Number.POSITIVE_INFINITY
    for (const p of sampled) {
      for (let k = 1; k < poly.length; k++) {
        const d = pointToSegmentM(p, poly[k - 1]!, poly[k]!)
        if (d < minD) minD = d
      }
      if (minD <= 1) break
    }
    if (!Number.isFinite(minD)) continue
    if (!best || minD < best.distM) best = { pointId: id, pointName: String(line?.pointName ?? id), distM: minD }
  }
  if (!best || best.distM > maxDistM) return null
  return best
}

// ---------------------------------------------------------------- 地点归属判定（2026-11-10）

/** 一个可选地点（界面上的「存到哪个地点」就是这么来的） */
export interface PlaceOption {
  /** 厂商线路 pointId 或本机键（如 local:free） */
  value: string
  /** 显示名（厂商线路名 / 本机键的说明） */
  title: string
  /** 这条线路的官方点列（有才能做几何匹配；本机键通常没有） */
  pointList?: RealPathPoint[]
}

/** 一条路径**归到哪个地点**的判定结果 */
export interface PlaceResolution {
  /** 定下来的地点（null = 认不出来，要用户自己选） */
  place: PlaceOption | null
  /** 怎么定下来的：包里的地点 / 按名字对上 / 按轨迹位置对上 / 认不出 */
  via: 'bundle-id' | 'bundle-name' | 'geometry' | 'none'
  /** 人话说明（界面上如实展示「为什么归到这儿」） */
  reason: string
  /** 按几何匹配时的最近距离（米；没走几何匹配 ⇒ null） */
  distM?: number | null
}

/** 名字归一化：去括号里的备注、去空白、统一小写 */
const placeNameKey = (raw: unknown): string =>
  String(raw ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()

/**
 * **一条路径属于哪个地点**（唯一判据；导入时逐条调它）。
 *
 * 按顺序取第一个命中的（用户口径：「先看包里的地点，再看轨迹坐标」）：
 *   ① lineId **精确命中**本机可选地点 ⇒ bundle-id（最可靠：ID 不会重名）；
 *   ② lineName 与某个地点的显示名**同名**（归一化后比；唯一命中才算）⇒ bundle-name
 *      （好友那边线路 ID 可能不同，但操场名通常一致）；
 *   ③ 用**轨迹坐标**与各线路点列比最近距离（nearestLineByGeometry，>150 m 不算）⇒ geometry
 *      （旧包里没有地点信息时，这是唯一能自动归位的办法）；
 *   ④ 都不行 ⇒ none，界面据此**弹出「选择存档地点」**。
 *
 * ⚠️ 纯函数、无副作用；**不猜**地点 —— 宁可就 none 让用户选，也不要硬塞一个错的。
 */
export function resolvePlace(
  item: { lineId?: unknown; lineName?: unknown; points?: unknown },
  options: PlaceOption[],
  opts: { maxDistM?: number } = {},
): PlaceResolution {
  const list = (Array.isArray(options) ? options : []).filter((o) => o && String(o.value ?? '').trim())
  const lineId = String(item?.lineId ?? '').trim()
  const lineName = String(item?.lineName ?? '').trim()

  if (lineId) {
    const byId = list.find((o) => String(o.value) === lineId)
    if (byId) return { place: byId, via: 'bundle-id', reason: '包里写明属于「' + byId.title + '」' }
  }

  const key = placeNameKey(lineName)
  if (key) {
    /** 同名多条时**不猜**（例如两个校区都有「东操场」）—— 交给几何或用户 */
    const byName = list.filter((o) => placeNameKey(o.title) === key)
    if (byName.length === 1) {
      return { place: byName[0]!, via: 'bundle-name', reason: '按地点名「' + byName[0]!.title + '」对上' }
    }
  }

  const pts = (Array.isArray(item?.points) ? item.points : []) as RealPathPoint[]
  const geo = nearestLineByGeometry(
    pts,
    list
      .filter((o) => Array.isArray(o.pointList) && o.pointList.length >= 2)
      .map((o) => ({ pointId: String(o.value), pointName: o.title, pointList: o.pointList })),
    { maxDistM: opts.maxDistM ?? 150 },
  )
  if (geo) {
    return {
      place: list.find((o) => String(o.value) === geo.pointId) ?? null,
      via: 'geometry',
      reason: '按轨迹位置匹配到「' + geo.pointName + '」（最近约 ' + Math.round(geo.distM) + ' m）',
      distM: geo.distM,
    }
  }

  const why =
    lineName || lineId
      ? '包里写的地点「' + (lineName || lineId) + '」在本机不存在，轨迹也匹配不上任何线路'
      : '包里没有地点信息，轨迹也匹配不上任何线路'
  return { place: null, via: 'none', reason: why, distM: null }
}

/**
 * 点到**线段**的距离（米；局部等距近似，够用且便宜）。
 * 与 `routeSimilarity.pointToSegmentDistance` 同口径（那边是"度"为单位），这里出口是米。
 */
export function pointToSegmentM(p: RealPathPoint, a: RealPathPoint, b: RealPathPoint): number {
  const mLat = 111320
  const mLng = 111320 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180)
  const px = p.longitude * mLng
  const py = p.latitude * mLat
  const ax = a.longitude * mLng
  const ay = a.latitude * mLat
  const bx = b.longitude * mLng
  const by = b.latitude * mLat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

/**
 * **等距降采样**（`maxPoints` 上限）：`points.length ≤ maxPoints` 时**原样返回**；否则按步长抽，**首末必留**。
 * ⚠️ 2026-11-04 起**产品代码不再使用它**（用户口径：真实路径**原样整条**保存/上传，不切圈不降采样）；
 *    函数与单测保留 —— 万一以后要给超长轨迹做个"体量保护"，判据已经钉在这里。
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
 * 拟一个**默认的预设名**（用户可改）：`东操场 · 真实路径 2026-11-01 · 0812`。
 * 🆕 2026-11-04（用户口径"默认名携带路径名称"）：`lineName` 非空时**前缀地点名**（如「天目湖-东操场」）；
 * 空白/缺省 = 不带（与旧版逐字一致）。
 * ⚠️ 名字的**唯一性不在这里判**（那是 `autoPresetName` / `findNameConflict` 的事），
 *    本函数只负责"给一个像样的起点"。
 */
export function defaultRealPathName(
  meta: Pick<RealPathMeta, 'date' | 'usedTime'> & { startTime?: string },
  lineName = '',
): string {
  const d = isIsoDate(meta.date) ? meta.date : '日期未知'
  const t = String(meta.startTime ?? '').replace(/:/g, '').slice(0, 4)
  const base = t ? `真实路径 ${d} · ${t}` : `真实路径 ${d}`
  const loc = String(lineName ?? '').trim()
  return loc ? `${loc} · ${base}` : base
}

/** 随机后缀的字符集（只用小写字母 + 数字：好念、好打进搜索框、不会有大小写歧义） */
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 造一段**短随机后缀**（默认 4 位，如 `2b9c`）—— 用户口径："生成的路径名称后加上一段随机字符防止相同导致异常"。
 *
 * 为什么需要：同一场成绩在不同机器上导出、或同一天跑两场、或好友把包发回来再导，
 * 默认名会**逐字相同**；而本项目"预设名称全库不可重复"是硬判据 ⇒ 后到的那个会被直接拒收。
 * 加上随机后缀，同名概率降到 36^4 ≈ 1/168 万，正常使用不会再撞。
 *
 * @param rand 注入随机源（单测用；默认 `Math.random`）
 */
export function randomNameSuffix(len = 4, rand: () => number = Math.random): string {
  /** 非法长度（0/负数/NaN）⇒ 回默认 4；上限 12（再长就不是"短后缀"了） */
  const wanted = Math.trunc(Number(len))
  const n = Number.isFinite(wanted) && wanted >= 1 ? Math.min(12, wanted) : 4
  let out = ''
  for (let i = 0; i < n; i++) {
    const r = Number(rand())
    const idx = Math.trunc((Number.isFinite(r) ? Math.abs(r) % 1 : 0) * SUFFIX_ALPHABET.length)
    out += SUFFIX_ALPHABET[Math.min(idx, SUFFIX_ALPHABET.length - 1)]
  }
  return out
}

/**
 * 给一个名字**追加随机后缀**（用户口径：只加在**自动生成**的名字上，手打的保留原样）。
 *
 * 判据：`withRandomSuffix('东操场 · 真实路径 2026-09-17 · 1910', () => 0)` → `'… · 1910-2b9c'` 形状
 *      （后缀与主干之间用 `-` 连接，读起来像版本号/批号，不干扰主干的可读性）。
 * ⚠️ 限长由 `sanitizeLineName()` 在落库那一步统一处理；这里只保证"后缀在最尾部、不会被自己挤掉"。
 */
export function withRandomSuffix(name: string, rand: () => number = Math.random): string {
  const base = String(name ?? '').trim()
  if (!base) return base
  const suffix = randomNameSuffix(4, rand)
  /** 已经带过后缀形状（`-xxxx`，4 位小写字母数字）就别再叠一层 */
  if (/-[a-z0-9]{4}$/.test(base)) return base
  return `${base}-${suffix}`
}

/**
 * 清洗 zip **包内条目名**（批量导出的每条路径一个 JSON）。
 *
 * 判据（与 `server/api/local/real-path/share.post.ts` 同一口径，那边也调它）：
 *   · 去掉 `/`、`\`、控制字符与 Windows 保留字符（`createZip` 只收"以 / 分隔的相对路径"）；
 *   · 保留中文与空格；折叠连续空白；
 *   · 收尾补 `.json`；空白输入 ⇒ 兜底名；
 *   · 按**码点**限长 80（ZIP 条目名上限是 65535 **字节**，80 码点远够用，也免得一个超长名把包撑怪）。
 */
export function sanitizeZipEntryName(raw: unknown): string {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cps = Array.from(s || '真实路径')
  const clipped = cps.length > 80 ? cps.slice(0, 80).join('') : cps.join('')
  return /\.json$/i.test(clipped) ? clipped : `${clipped}.json`
}

/** 把一条路径的**分享包**序列化出来（批量导出时每条一个文件；与单条导出的结构逐字相同） */
export function bundleJsonOf(item: RealPathBundleItem, exportedAt = new Date().toISOString()): string {
  return JSON.stringify(buildShareBundle([item], exportedAt))
}

/**
 * 读归档时**当前生效的月份**：给了 `monthId` 就用它；没给就选「当前月份」。
 *
 * 判据（按顺序，取第一个命中）：
 *   ① 列表里 `isCurrent` 的那一条；
 *   ② 没有（服务端没标 / 标了两条以上）⇒ 用 `now` 推出 `YYYYMM`，按 `monthId` **或** `monthName`
 *      （`2026年11月` / `2026-11` 都认）对上那一条；
 *   ③ 还选不出 ⇒ 空串（**不猜月份**：猜错了界面上会"高亮一个月份、读的却是另一个月份的成绩"）。
 *
 * 返回值就是发给 `getSunrunArch` 的 `monthId`，界面据此高亮，两边同源。
 */
export function pickMonthId(
  months: { monthId: string; monthName: string; isCurrent: boolean }[],
  monthId?: string,
  now: Date = new Date(),
): string {
  const picked = String(monthId ?? '').trim()
  if (picked) return picked
  const list = (Array.isArray(months) ? months : []).filter((m) => m && String(m.monthId ?? '').trim())
  const nameOf = (m: { monthName?: unknown }) => String(m.monthName ?? '').trim()
  const marked = list.filter((m) => m.isCurrent)
  if (marked.length === 1) return String(marked[0]!.monthId).trim()
  const yearMonth = `${now.getFullYear()}年${now.getMonth() + 1}月`
  const alt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const byName = (m: { monthName?: unknown }) => nameOf(m) === yearMonth || nameOf(m) === alt
  const hit = (marked.length > 1 ? marked.find(byName) : undefined) ?? list.find(byName)
  return hit ? String(hit.monthId).trim() : ''
}

/** 生成预设草稿需要的输入（组合层从"选中的那天那条记录 + 它的点列"组装） */
export interface RealPathPresetDraftInput {
  meta: RealPathMeta
  /**
   * **原样整条轨迹**（🆕 2026-11-04 用户口径"直接原样上传，而不是只保留几圈"）：
   * **不切圈、不降采样**，点列顺序即跑向。一圈长度（预览着色用）由 `meta.lapLengthM` 携带。
   */
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
  /**
   * 这条路径**属于哪个地点**（厂商线路 pointId，或本机键如 local:free）。
   *
   * 🔴 2026-11-10：导出时**必须写值**。此前一律写空串，包里没有地点信息 ⇒
   * 导入时只能落到界面下拉当前选中的地点（默认「本机跑道」），用户反馈的就是这个
   * （「导入东操场的路径，没有被录入到东操场」）。
   * 空串仍有意义：**旧包**（这一版之前导出的）里就是空串，导入时走「几何匹配 / 让用户选」。
   */
  lineId: string
  /** 那个地点的**名字快照**（好友那里可能没有同名线路，所以只作提示与名字匹配用） */
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
        /** 🆕 2026-11-04：一圈长度（预览按圈着色用）；没有 ⇒ null */
        lapLengthM: it.meta?.lapLengthM === null || it.meta?.lapLengthM === undefined ? null : Number(it.meta.lapLengthM),
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
        lapLengthM: num(meta.lapLengthM),
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

// ---------------------------------------------------------------- 批量选择与批量结果（2026-11-10）

/**
 * **批量选择**的开关（纯函数，界面只读它的返回值）：加进去 / 拿掉 / 全选 / 清空。
 *
 * 为什么要有它：批量导出与批量导入都要"点一条加一条、再点一下拿掉"，若各写一遍
 * `Set` 操作，两处对"重复点、点了不存在的项"的行为迟早不一致。
 *
 * 判据：返回的是**新集合**（不改入参）；`ids` 里的空串/空白一律忽略（界面可能把 `undefined` 传进来）。
 */
export function toggleSelection(current: Iterable<string>, id: string): Set<string> {
  const out = new Set<string>()
  for (const x of current) {
    const s = String(x ?? '').trim()
    if (s) out.add(s)
  }
  const key = String(id ?? '').trim()
  if (!key) return out
  if (out.has(key)) out.delete(key)
  else out.add(key)
  return out
}

/** 把一批 id **整体**加入或移出选择（全选/全不选用；同样忽略空串） */
export function setSelection(current: Iterable<string>, ids: Iterable<string>, on: boolean): Set<string> {
  const out = new Set<string>()
  for (const x of current) {
    const s = String(x ?? '').trim()
    if (s) out.add(s)
  }
  for (const raw of ids) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    if (on) out.add(s)
    else out.delete(s)
  }
  return out
}

/** 一次批量动作里**单条**的结果（成功或失败都要留名，绝不静默丢） */
export interface BatchOutcome {
  /** 这一条的显示名（失败时用它指出"是哪个包/哪一天出的问题"） */
  name: string
  ok: boolean
  /** 人话原因（成功时是"已导入…"，失败时是拒绝的理由） */
  message: string
}

/** 批量动作的汇总（界面据此给一句话 + 可展开的逐条清单） */
export interface BatchSummary {
  total: number
  okCount: number
  failCount: number
  /** 成功的那几条（顺序与调用方给的一致） */
  ok: BatchOutcome[]
  /** 失败的那几条（**必须在界面上列出来**，否则用户以为都成功了） */
  failed: BatchOutcome[]
  /** 一句话总结（成功 + 失败数都在里面；全成功时不提失败） */
  text: string
}

/**
 * 把逐条结果收敛成**一句总结 + 两份清单**。
 *
 * 🔴 判据（这是"导入失败要有提示"的机械保证）：`okCount + failCount === total`，
 *    且失败项的 `message` 非空 —— 任何一条被吞掉都会让这个等式不成立。
 */
export function summarizeBatch(outcomes: BatchOutcome[]): BatchSummary {
  const list = Array.isArray(outcomes) ? outcomes : []
  const ok = list.filter((o) => o.ok)
  const failed = list.filter((o) => !o.ok)
  const total = list.length
  let text: string
  if (!total) text = '没有可处理的条目'
  else if (!failed.length) text = `全部成功：${ok.length} 条`
  else if (!ok.length) text = `全部失败：${failed.length} 条（原因见下面逐条说明）`
  else text = `成功 ${ok.length} 条，失败 ${failed.length} 条（失败原因见下面逐条说明）`
  return { total, okCount: ok.length, failCount: failed.length, ok, failed, text }
}

/**
 * 按索引挑出要导入的那几条（**老口径**：单条导入时"只要包里第 N 条"）。
 *
 * ⚠️ 批量导入**不走它** —— 批量口径是"包里每条都收"（见 `readAllShareItemsFromZip` 与
 *    `importManyShareZips`），那样"包 A 1 条 + 包 B 2 条 ⇒ 3 条"才对得上。
 *    这里保留给"指定第几条"的单入口场景（`pickBundleItem` 的复数版），索引越界/重复都安全。
 */
export function batchImportCandidates(items: RealPathBundleItem[], index?: number[]): RealPathBundleItem[] {
  const list = Array.isArray(items) ? items : []
  if (!index || !index.length) return list
  const want = new Set(index.map((i) => Math.trunc(Number(i))).filter((i) => Number.isFinite(i) && i >= 0))
  return list.filter((_, i) => want.has(i))
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

/** 一个 zip 里解析出来的**一条**路径（带它是从哪个包内文件来的，便于逐条报错） */
export interface ZipBundleItem {
  /** 包内条目名（`totoro-real-path.json` 或批量包里的 `某路径.json`） */
  entryName: string
  item: RealPathBundleItem
}

/** 读**一个 zip 里的全部路径**的结果（批量导入用；坏条目只跳它自己） */
export interface ParsedZipItems {
  /** 这个包整体能不能读（读不了 ⇒ `error` 非空，`items` 为空） */
  ok: boolean
  /** 包级失败原因（人话；能读出条目时为空串） */
  error: string
  /** 读出来的路径（可能来自包内多个 JSON 文件） */
  items: ZipBundleItem[]
  /** 被跳过的条目及其原因（**必须回报**，否则"包里 3 条只进来 2 条"没人知道） */
  skipped: { entryName: string; reason: string }[]
}

/**
 * **读一个 zip 里的全部路径**（2026-11-10 用户口径：批量导出"大压缩包的内部就是相关的各个路径"，
 * 所以导入一个包可能拿到**多条**）。
 *
 * 与 `readShareBundleFromZip()` 的区别：后者只认**第一个** JSON（单条口径，保持旧行为不变），
 * 本函数遍历包内**所有** `.json` 条目，逐个 `parseShareBundle()`：
 *   · 某个条目不是路径包 / 坐标全坏 ⇒ **只跳它自己**，原因进 `skipped`；
 *   · 一个包几条路径都读不出来 ⇒ 包级 `ok:false` 并说明（这才是真的坏包）。
 */
export async function readAllShareItemsFromZip(bytes: Uint8Array): Promise<ParsedZipItems> {
  let entries: ZipReadEntry[]
  try {
    entries = await readZip(bytes)
  } catch (err) {
    return { ok: false, error: `读不了这个压缩包：${err instanceof Error ? err.message : '未知错误'}`, items: [], skipped: [] }
  }
  /** 只认 `.json`；一个都没有 ⇒ 拿第一个条目兜底试一次（好友可能把 JSON 改过名） */
  const jsonEntries = entries.filter((e) => /\.json$/i.test(e.name))
  const targets = jsonEntries.length ? jsonEntries : entries.slice(0, 1)
  if (!targets.length) return { ok: false, error: '压缩包里没有文件', items: [], skipped: [] }
  const decoder = new TextDecoder('utf-8')
  const items: ZipBundleItem[] = []
  const skipped: { entryName: string; reason: string }[] = []
  for (const entry of targets) {
    const parsed = parseShareBundle(decoder.decode(entry.data))
    if (!parsed.ok) {
      skipped.push({ entryName: entry.name, reason: parsed.error })
      continue
    }
    for (const item of parsed.items) items.push({ entryName: entry.name, item })
  }
  if (!items.length) {
    const why = skipped[0]?.reason || '包里没有可用的路径'
    return { ok: false, error: why, items: [], skipped }
  }
  return { ok: true, error: '', items, skipped }
}
