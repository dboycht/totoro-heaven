/**
 * 本地路线库的**纯数据层**（2026-09-17）：类型、键名、归一化/迁移、列表摘要。
 *
 * 为什么与 `composables/useTrackLibrary.ts` 分开：这里是**纯函数**，可离线单测；
 * composable 那层只管 Nuxt 状态（useState）与 localStorage 读写。
 *
 * 数据含义：把"用户在跑道编辑器里描好的内外圈"存成本机可管理的**路线资产**，
 * 附**元信息**（创建日期、创建时的软件版本、线路名快照）—— 用户明确要求列表要显示这些。
 */
import type { LatLng } from './routeSimilarity'
import { ringLengthM, startDirectionLabel, type LoopDirection } from './trackEditor'
import { freePathShapeText, parseFreePathShape, usableFreePathShape, type FreePathShape } from './pathShape'
// 「任务到底有没有下发线路」的判据只允许有一个来源（纯函数，见 `utils/mp/taskShape.ts`）
import { routeRequirementOf } from './taskShape'

export const TRACK_LIBRARY_KEY = 'mp_track_library_v1'
/** 旧格式的键（迁移用；旧版是 `{ [lineId]: {outer, inner} }`） */
export const TRACK_LIBRARY_KEY_LEGACY = 'mp_track_rings_v1'

/**
 * **一次编辑的留痕**（2026-09-20，1.1.12 需求③）。
 *
 * 用户原话："记录编辑保存时间以及编辑使用的版本等一系列数据"——
 * 所以每次保存都往 `TrackRouteEntry.history` 里压一条（最新在前），
 * 只留最近 `TRACK_HISTORY_MAX` 条：localStorage 有 5 MB 量级上限，
 * 而内外圈点列本身就不小（一条路线几百个点），历史**必须**有上限。
 */
export interface TrackEditLog {
  /** 本次保存时间（ISO 字符串；空串 = 时间缺失，界面显示"时间未知"） */
  at: string
  /** 本次保存时的软件版本（空串 = 版本未知） */
  appVersion: string
  /** 本次改了什么（用户可读的一句话，**不含 markdown 标记**） */
  summary: string
}

/** 每条路线最多留几条编辑历史（最新在前） */
export const TRACK_HISTORY_MAX = 5

/**
 * **起跑点**（2026-09-20，1.1.12 需求②）：
 * 轨迹生成器永远从几何数组的第 0 个点起步，所以起跑点在数据上是
 * "把车道线**按弧长旋转**到 `offsetM`、必要时**反向**"（见 `trackEditor.applyStartToLoop`）。
 */
export interface TrackStart {
  /** 沿**所选车道**的弧长偏移（米，0 ~ 该车道周长；从"描圈的第 0 个点"起算） */
  offsetM: number
  /** 绕向：`forward` = 沿描圈方向；`reverse` = 反向（界面按几何翻译成顺/逆时针） */
  direction: LoopDirection
  /** 起跑点坐标（吸附到车道线之后的点；手机端可核对位置。缺省 = 只按 offsetM 旋转） */
  point?: LatLng
}

export interface TrackRouteEntry {
  /** 厂商线路 id（主键；**提交时仍用它** —— 我们只换"生成用的几何"，不动报文口径） */
  lineId: string
  /** 线路名快照（任务换版后仍看得懂这条记录是什么；**厂商线路名**，我们不覆写它） */
  lineName: string
  /**
   * **用户自己起的名字**（2026-09-18 新增，1.1.9 需求②：本地路线库支持重命名）。
   * 与 `lineName`（厂商快照）分开存 —— 重命名只动这条本机记录，**不动厂商线路名**；
   * 清空（改成空串/空白）＝ 恢复显示厂商原名快照。
   */
  customName?: string
  outer: LatLng[]
  inner: LatLng[]
  /** 创建时间（ISO 字符串；旧数据迁移过来时为空 ⇒ 显示"创建日期未知"） */
  createdAt: string
  /** 创建时的软件版本（用户要求"显示对应版本"） */
  appVersion: string
  /** 这条跑道一共几道（默认 6） */
  laneCount?: number
  /** **所选道次**（第 1 道=最内道；生成轨迹就按它，不再随机 —— 用户 2026-09-17 确认） */
  laneNo?: number
  note?: string
  /** 🆕 起跑点（2026-09-20，1.1.12 需求②）：缺失 = 未设置（轨迹仍从车道线第 0 点起跑） */
  start?: TrackStart
  /** 🆕 **最近一次保存（编辑）时间**（ISO；旧数据为空串 = 未记录） */
  updatedAt?: string
  /** 🆕 **最近一次保存时的软件版本**（旧数据为空串 = 未记录） */
  updatedAppVersion?: string
  /** 🆕 **累计编辑次数**（含首次创建；旧数据为 undefined = 未记录） */
  editCount?: number
  /** 🆕 最近几次编辑留痕（最新在前，最多 `TRACK_HISTORY_MAX` 条） */
  history?: TrackEditLog[]
  /**
   * 🆕 **非官方路径形状**（2026-09-22「非官方路径绘制」）：圈型（闭合曲线）/ 直线型（折返）。
   *
   * ## 向后兼容（**老条目必须零变化**）
   * 这是一个**可选**字段：**没有它**（老条目、以及用户在「外圈/内圈」模式里描的跑道）
   * ⇒ 语义**就是**现在的"内外双圈"模式（`outer`/`inner` + `laneNo` + `start`），跑图链路一个字都不变。
   * 读到**不认识的形状**（坏数据/未来版本）时 `normalizeLibrary` 会把它**丢掉**（当作没有），
   * 于是自动退回双圈模式 —— **绝不猜、绝不抛**。
   *
   * ⚠️ 有 `freeShape` 时，`outer`/`inner` 只是"给旧版本应用看的占位几何"（至少各 3 点，
   *    让老版本仍能画出个大概）；**跑图以 `freeShape` 为准**（见 `composables/demo/runner.ts`）。
   * ⚠️ 它**永远不是官方线路几何**：只进本机路线库，绝不进提交报文（`lineId` 仍是本机键名）。
   */
  freeShape?: FreePathShape
}

const isPts = (v: unknown): v is LatLng[] =>
  Array.isArray(v) && v.every((p) => !!p && typeof p === 'object' && 'latitude' in p && 'longitude' in p)

/**
 * 一条路线**放行所需的最少点数**（内外圈各算）。
 *
 * ⚠️ 2026-09-19 审计 S1：`isPts([])` 对**空数组返回 true**（`every` 在空数组上恒真）
 * ⇒ 空圈/残缺圈能被存进路线库，之后跑步页把它当"已描过跑道"，而生成器因点数不足
 * **回落到官方模板**（本版明令禁止）。所以校验必须**带上"点数下限"**，而不只是"元素形状对"。
 * 3 是几何下限（少于 3 点连三角形都构不成，`runner.ts` 也用 `outer.length >= 3`）。
 */
export const MIN_RING_POINTS = 3

/** 内外圈是否都**够点**且形状合法（唯一判据，filter/normalize/upsert 都用它） */
export const hasValidRings = <T extends { outer?: unknown; inner?: unknown }>(
  v: T,
): v is T & { outer: LatLng[]; inner: LatLng[] } =>
  isPts(v.outer) &&
  v.outer.length >= MIN_RING_POINTS &&
  isPts(v.inner) &&
  v.inner.length >= MIN_RING_POINTS

/**
 * **一条路线能不能进库**（唯一判据，`normalizeLibrary` 与 `useTrackLibrary.upsert` 共用）。
 *
 * 两条**并列**的合法路径（2026-09-22 起）：
 *   ① **内外双圈**：内外圈各 ≥ `MIN_RING_POINTS`（老口径，逐字不变）；
 *   ② **非官方路径形状**（`freeShape`）：圈型（≥2 个不重合的点）/ 直线型（A≠B）。
 *      为什么算合法：跑图链路对这类条目**直接用 `freeShape`**，根本不需要内外圈
 *      （旧版本应用读到它会看到占位几何，仍能画出个大概）。
 *
 * ⚠️ 为什么不能"只要点数够"：`isPts([])` 对空数组恒真（`every` 在空数组上返回 true），
 *    审计 S1 就是被这个坑到 —— 空圈被收进库、跑图时又因点数不足回落到官方模板。
 *    `freeShape` 分支必须同时要求 `usableFreePathShape`（长度 > 0），否则同样是"坏几何"。
 */
export function isValidTrackEntry(v: { outer?: unknown; inner?: unknown; freeShape?: unknown }): boolean {
  return hasValidRings(v) || usableFreePathShape(parseFreePathShape(v.freeShape))
}

/** 自定义路名长度上限（按**码点**算，别把 emoji 截成半个 —— 用户可能起「🏃 西操场」这种名字） */
export const TRACK_NAME_MAX = 24

/**
 * 自定义路名**归一化**（纯函数，唯一入口）：折叠空白、去掉控制字符（含零宽字符）、按码点截断、限长。
 *
 * 判据：
 *   · `sanitizeLineName('  西 操场 ')` → `'西 操场'`（首尾去空白、中间连续空白折成一个空格）
 *   · 控制字符/零宽字符（`\u0000-\u001f`、`\u007f`、`\u200b-\u200f`、`\ufeff`）被删掉
 *   · 超过 `TRACK_NAME_MAX` 个码点则截断；emoji 不会被截成半个
 *   · 结果为空（原样是空白/只有控制字符/不是字符串）→ `''`，含义是「恢复厂商原名」
 */
export function sanitizeLineName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cps = Array.from(cleaned) // 按码点切，emoji/代理对不会被劈开
  return cps.length > TRACK_NAME_MAX ? cps.slice(0, TRACK_NAME_MAX).join('') : cleaned
}

/**
 * 这条路线**该显示什么名字**（纯函数，唯一入口，列表/下拉/摘要都用它）：
 * 自定义名优先 → 厂商名快照 → 线路 id（**绝不返回空串**，免得界面上出现一行空白）。
 */
export function resolveEntryName(e: Pick<TrackRouteEntry, 'lineId' | 'lineName' | 'customName'>): string {
  return sanitizeLineName(e.customName) || String(e.lineName ?? '').trim() || String(e.lineId ?? '')
}

/**
 * **任务未下发线路时，编辑器里那条「本机跑道」的固定键名**（issue #12，2026-09-22）。
 *
 * ## 为什么需要它（用户实测的真 bug）
 * 「研途健行」这类任务的 `runPointList` 为空（`routeRequirementOf(task).kind === 'free'`），
 * 于是跑道编辑器的线路下拉**必然没有可选线路**，用户描完点一点「保存」就被拒
 * ——「需要选择一条路线」。但本版口径是"轨迹必须基于用户自己描的跑道几何"，
 * 自由路线任务**也必须**能描一条本机跑道，否则**永远没有几何可用、永远跑不了**。
 *
 * ## 口径（避免后人误改）
 *   ① 它是一个**本机条目**，`lineId` 是我们自己定的固定键名（**不是服务端线路标识**）⇒
 *      只进本机路线库 `mp_track_library_v1`、只当"本地几何的来源"，**绝不许进提交报文**
 *      （自由路线任务提交时 `lineId` 为空串、任务号走 `paperId` 兜底，见 `RunWorkspace.vue`）；
 *   ② 键名**固定**（不随任务变化）：一个"没有线路的任务"只需要一条本机跑道，
 *      重复保存就是覆盖同一条（用户仍可改名/删除），不至于每描一次就多一条垃圾条目；
 *   ③ 文案只能说「**本任务未下发线路**」（客观事实），不许写成"服务端不判路线"。
 */
export const LOCAL_FREE_LINE_ID = 'local:free'

/** 本机跑道在路线库里的名字快照（任务确实存在、只是没下发线路） */
export const LOCAL_FREE_LINE_NAME = '本机跑道（本任务未下发线路）'
/** 连任务都还没读就描的情况：如实说"还没读取任务"，不冒充"本任务未下发线路" */
export const LOCAL_FREE_LINE_NAME_NO_TASK = '本机跑道（还没读取任务）'

/**
 * 当前任务在编辑器里**该不该出现那条「本机跑道」**，出现时它叫什么（纯函数，唯一判据）。
 *
 * 判据（可执行）：
 *   · `routeRequirementOf(task).kind === 'line'`（服务端下发了线路）⇒ 返回 `null`
 *     —— **有线路的任务零回归**：下拉里只有服务端线路，保存仍按线路 `pointId` 落库；
 *   · `kind === 'free'` ⇒ 返回固定键名 `local:free` + 如实名字（有任务 / 没任务两种措辞）。
 */
export function localFreeTrackLine(task: unknown): { lineId: string; lineName: string } | null {
  if (routeRequirementOf(task).kind !== 'free') return null
  const hasTask = Boolean(task) && typeof task === 'object'
  return {
    lineId: LOCAL_FREE_LINE_ID,
    lineName: hasTask ? LOCAL_FREE_LINE_NAME : LOCAL_FREE_LINE_NAME_NO_TASK,
  }
}

/** 坐标是否可解析成一对有限数（**不要求是数字类型**：契约层允许字符串坐标） */
const isFinitePoint = (v: unknown): v is LatLng =>
  !!v && typeof v === 'object' && Number.isFinite(Number((v as LatLng).latitude)) && Number.isFinite(Number((v as LatLng).longitude))

/**
 * 归一化一条**起跑点设置**（纯函数）：`offsetM` 必须是有限的非负数，`direction` 只认 `reverse`，
 * 其余一律 `forward`。整块不可解析 ⇒ `undefined`（= 未设置，与旧数据同义）。
 * ⚠️ 坐标点坐标统一成 `number` 存储（字符串坐标写回 JSON 会变成字符串，比较/算术都要先 Number）。
 */
export function normalizeTrackStart(raw: unknown): TrackStart | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  const offsetM = Number(v.offsetM)
  if (!Number.isFinite(offsetM) || offsetM < 0) return undefined
  const direction: LoopDirection = v.direction === 'reverse' ? 'reverse' : 'forward'
  const offset = Math.round(offsetM * 10) / 10
  if (!isFinitePoint(v.point)) return { offsetM: offset, direction }
  return {
    offsetM: offset,
    direction,
    point: { latitude: Number(v.point.latitude), longitude: Number(v.point.longitude) },
  }
}

/** 归一化编辑历史：丢掉不可解析的条目、只留最近 `TRACK_HISTORY_MAX` 条（纯函数） */
export function normalizeHistory(raw: unknown): TrackEditLog[] {
  if (!Array.isArray(raw)) return []
  const out: TrackEditLog[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const v = it as Record<string, unknown>
    const at = String(v.at ?? '')
    const summary = String(v.summary ?? '')
    // 时间与摘要**都空**的条目没有任何信息量（多半是坏数据）⇒ 丢掉
    if (!at && !summary) continue
    out.push({ at, appVersion: String(v.appVersion ?? ''), summary })
    if (out.length >= TRACK_HISTORY_MAX) break
  }
  return out
}

/**
 * 把一条新的编辑留痕**压到最前面**并裁到上限（纯函数，唯一的"写历史"入口）。
 * ⚠️ 上限**只在这一个地方**执行：界面/调用方都不许自己 slice，否则两边上限会漂移。
 */
export function prependHistory(prev: TrackEditLog[] | undefined, log: TrackEditLog): TrackEditLog[] {
  return [log, ...(Array.isArray(prev) ? prev : [])].slice(0, TRACK_HISTORY_MAX)
}

/**
 * 把任意历史数据**归一化**成新格式（纯函数，便于单测与迁移）：
 *   · 新格式数组 → 原样（补齐缺失字段）
 *   · 旧格式对象映射 → 转成数组（创建日期标空、版本用 fallback）
 *   · 其它垃圾 → 丢掉
 *
 * 🆕 2026-09-22：放行条件从"必须内外圈够点"改为 `isValidTrackEntry`（多认一种 `freeShape`）；
 *    同时把 `freeShape` 归一化（不认识的形状一律丢掉 ⇒ 退回双圈模式，**老条目零变化**）。
 */
export function normalizeLibrary(raw: unknown, fallbackVersion = '未知'): TrackRouteEntry[] {
  const out: TrackRouteEntry[] = []
  const push = (lineId: string, v: Record<string, unknown>) => {
    // ⚠️ 审计 S1：不是"元素形状对"就收 —— 必须内外圈都够 3 点，**或**带一个可用的非官方形状
    if (!lineId || !isValidTrackEntry(v)) return
    // 用户自定义名：归一化后为空（历史数据里可能存过空白）⇒ 归一化成 undefined，一律走 `resolveEntryName` 兜底
    const customName = sanitizeLineName(v.customName)
    const start = normalizeTrackStart(v.start)
    const history = normalizeHistory(v.history)
    const editCount = Number(v.editCount)
    /** 非官方形状：不认识的形状/坏数据一律 undefined（= 退回双圈模式），绝不抛 */
    const freeShape = parseFreePathShape(v.freeShape)
    out.push({
      lineId,
      lineName: String(v.lineName ?? lineId),
      ...(customName ? { customName } : {}),
      // 带 freeShape 的条目可能**没有**内外圈（自由路径不需要双圈）⇒ 如实留空数组，不伪造几何
      outer: isPts(v.outer) ? v.outer : [],
      inner: isPts(v.inner) ? v.inner : [],
      createdAt: String(v.createdAt ?? ''),
      appVersion: String(v.appVersion ?? fallbackVersion),
      laneCount: typeof v.laneCount === 'number' && v.laneCount > 0 ? v.laneCount : undefined,
      laneNo: typeof v.laneNo === 'number' && v.laneNo > 0 ? v.laneNo : undefined,
      note: typeof v.note === 'string' ? v.note : undefined,
      // 🆕 起跑点与编辑留痕：旧数据**没有**这些字段 ⇒ 不凭空造（用展开语法，保持 `'start' in e === false`）
      ...(start ? { start } : {}),
      updatedAt: String(v.updatedAt ?? ''),
      updatedAppVersion: String(v.updatedAppVersion ?? ''),
      editCount: Number.isFinite(editCount) && editCount > 0 ? Math.round(editCount) : undefined,
      ...(history.length ? { history } : {}),
      // 🆕 只有**合法**的非官方形状才写回；没有这个字段的老条目**不会**多出这个键
      ...(freeShape ? { freeShape } : {}),
    })
  }
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (e && typeof e === 'object') push(String((e as Record<string, unknown>).lineId ?? ''), e as Record<string, unknown>)
    }
    return out
  }
  if (raw && typeof raw === 'object') {
    for (const [lineId, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === 'object') push(lineId, v as Record<string, unknown>)
    }
  }
  return out
}

/**
 * ISO 字符串 → **本机时间** "yyyy-MM-dd HH:mm"。
 * ⚠️ 必须转本地：`createdAt` 存的是 `toISOString()`（UTC），直接截前 16 位会显示成 UTC 时间
 * （实测：本机 22:21 存进去、列表却显示 14:21 —— 用户看的是本机时间）。
 */
export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ')
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 版本号展示：`1.1.12` → `v1.1.12`；空串 → `未记录`（**唯一的版本文案出口**） */
export function versionText(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim()
  return s ? `v${s.replace(/^v/, '')}` : '未记录'
}

/**
 * 起跑点的一句话（摘要与详情共用；未设置返回"未设置"）。
 * 形状：`逆时针 · 沿跑道 12 m 处` —— 方向由几何算出来（不写死顺/逆），偏移按米。
 */
export function startSummaryText(e: Pick<TrackRouteEntry, 'outer' | 'start'>): string {
  const s = e.start
  if (!s) return '未设置'
  const dir = startDirectionLabel(e.outer ?? [], s.direction)
  const m = `${Math.round(s.offsetM * 10) / 10} m`
  return `${dir} · 沿跑道 ${m} 处`
}

/**
 * 一条路线的摘要（**列表每行的副标题**）：点位数 · 道次 · 创建日期/版本 · 官方原名
 * ＋ 🆕 最近保存（时间/版本）与编辑次数（2026-09-20，1.1.12 需求③）。
 *
 * ⚠️ 旧的字段顺序与措辞**不许改**：`tests/mp/trackEditor.test.ts` 与验证脚本都按它断言
 *（"外圈 N 点 / 第 3 道/6 / 创建日期未知 / 版本未知 / 官方名：…"）。
 */
export function entrySummaryText(e: TrackRouteEntry): string {
  const when = e.createdAt ? formatLocalDateTime(e.createdAt) : '创建日期未知'
  const version = e.appVersion ? `v${e.appVersion.replace(/^v/, '')}` : '版本未知'
  const lane = e.laneNo ? `第 ${e.laneNo} 道${e.laneCount ? `/${e.laneCount}` : ''}` : '道次未记录'
  // 改过名时**顺带标出厂商原名**：改的是本机显示名，提交用的仍是厂商 lineId，
  // 把原名留在摘要里，用户才不会"改完就不知道这条对应哪条官方线路"（2026-09-18）。
  const renamed = sanitizeLineName(e.customName) ? `（官方名：${String(e.lineName ?? '').trim() || e.lineId}）` : ''
  // 🆕 最近一次保存（时间 + 版本）：旧数据无此字段 ⇒ **一个字都不加**（不显示"未记录"噪音）
  const saved = e.updatedAt
    ? ` · 最近保存 ${formatLocalDateTime(e.updatedAt)}${e.updatedAppVersion ? `（${versionText(e.updatedAppVersion)}）` : ''}`
    : ''
  const edits = e.editCount ? ` · 编辑 ${e.editCount} 次` : ''
  const start = e.start ? ` · 起跑点 ${startSummaryText(e)}` : ''
  /**
   * 🆕 非官方路径形状（2026-09-22）：有它就在摘要最前面说明"这条是圈型/直线型"。
   * ⚠️ 没有它时**一个字都不加**（老条目/双圈条目的摘要逐字不变 —— 既有验证脚本按它断言）。
   */
  const free = freePathShapeText(e.freeShape)
  const freePrefix = free ? `${free} · ` : ''
  return `${freePrefix}外圈 ${e.outer.length} 点 · 内圈 ${e.inner.length} 点 · ${lane} · ${when} · ${version}${renamed}${start}${saved}${edits}`
}

/**
 * 路线条目的**详情行**（管理界面展开后显示；2026-09-20，1.1.12 需求③）。
 * 纯函数：只做"数据 → 可读文本"，界面不再自己拼字符串（避免详情与摘要两处口径漂移）。
 */
export function entryDetailRows(e: TrackRouteEntry): { label: string; value: string }[] {
  return [
    { label: '线路（厂商标识）', value: String(e.lineId ?? '') || '—' },
    { label: '官方线路名', value: String(e.lineName ?? '').trim() || '（厂商未提供名称）' },
    { label: '创建时间', value: e.createdAt ? formatLocalDateTime(e.createdAt) : '未记录（旧数据）' },
    { label: '创建时版本', value: versionText(e.appVersion) },
    { label: '最近保存时间', value: e.updatedAt ? formatLocalDateTime(e.updatedAt) : '未记录（旧数据）' },
    { label: '最近保存版本', value: versionText(e.updatedAppVersion) },
    { label: '编辑次数', value: e.editCount ? `${e.editCount} 次` : '未记录（旧数据）' },
    /**
     * 🆕 非官方路径（2026-09-22）：**只有这条记录真的有形状时才多出这一行**。
     * ⚠️ 审计 B9：原先无条件加 ⇒ 没带形状的条目（含全部老条目、以及有线路任务的条目）详情表
     *    会凭空多一行 `非官方路径【测试】`，违反"有线路任务的所有既有行为一字不变"。
     *    判据：**行数由数据决定**，不由版本决定。
     */
    ...(freePathShapeText(e.freeShape) ? [{ label: '非官方路径【测试】', value: String(freePathShapeText(e.freeShape)) }] : []),
    { label: '内外圈点数', value: `外圈 ${e.outer.length} 点 · 内圈 ${e.inner.length} 点` },
    { label: '外圈周长', value: e.outer.length >= 3 ? `${Math.round(ringLengthM(e.outer))} m` : '—' },
    {
      label: '道次',
      value: e.laneNo ? `第 ${e.laneNo} 道${e.laneCount ? `（共 ${e.laneCount} 道）` : ''}` : '未记录',
    },
    { label: '起跑点', value: startSummaryText(e) },
    ...(e.start?.point
      ? [
          {
            label: '起跑点坐标',
            value: `${Number(e.start.point.latitude).toFixed(6)}, ${Number(e.start.point.longitude).toFixed(6)}`,
          },
        ]
      : []),
    { label: '备注', value: String(e.note ?? '').trim() || '（无）' },
  ]
}

/** 一条编辑留痕的展示文本：`2026-09-20 17:12 · v1.1.12 · 外圈 32 点 · 内圈 24 点 …` */
export function historyLogText(log: TrackEditLog): string {
  const when = log.at ? formatLocalDateTime(log.at) : '时间未知'
  // 列表里用"版本未知"（与 `entrySummaryText` 同一措辞）；`versionText` 的"未记录"留给详情表
  const ver = log.appVersion ? versionText(log.appVersion) : '版本未知'
  return `${when} · ${ver} · ${log.summary || '（未记录改动内容）'}`
}

/**
 * 一次**保存**的改动摘要（写进编辑历史的那句话，纯函数）。
 * 只说"存成了什么样"，不说"改了什么"——因为我们不存旧几何做 diff（那会让 localStorage 翻倍）。
 *
 * 🆕 2026-09-22：存的是**非官方路径形状**（圈型/直线型）时，摘要要说清"存的是形状"，
 *    不能只报"外圈 3 点 / 内圈 3 点"（那是给旧版本看的占位几何，会让人以为存错了）。
 */
export function saveSummaryText(input: {
  outer: LatLng[]
  inner: LatLng[]
  laneNo?: number
  laneCount?: number
  start?: TrackStart | null
  freeShape?: FreePathShape | null
}): string {
  const free = freePathShapeText(input.freeShape)
  if (free) return `${free}${input.start ? ` · 起跑点 ${startSummaryText({ outer: input.outer, start: input.start })}` : ''}`
  const parts = [`外圈 ${input.outer.length} 点`, `内圈 ${input.inner.length} 点`]
  if (input.laneNo) parts.push(`第 ${input.laneNo} 道${input.laneCount ? `/${input.laneCount}` : ''}`)
  parts.push(input.start ? `起跑点 ${startSummaryText({ outer: input.outer, start: input.start })}` : '起跑点未设置')
  return parts.join(' · ')
}
