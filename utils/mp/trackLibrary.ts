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
// 🆕 2026-11-03（1.3.6 需求③「真实路径」）：预设上记录的来源元信息（纯类型 + 一个解码器）
import { parseRealPathMeta, type RealPathMeta } from './realPath'
import { laneLoop, laneRatioFor, ringLengthM, startDirectionLabel, type LoopDirection } from './trackEditor'
import { freePathShapeText, parseFreePathShape, usableFreePathShape, type FreePathShape } from './pathShape'
import type { TrackEntry } from './pathShape'
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
  /**
   * 🆕 **预设主键**（2026-11-03，1.3.6：「一个地点可以有多条预设」）。
   *
   * ## 为什么要加它（用户原话）
   * > "一个地点的预设只能创建一个，例如「东操场」点位只能创建一个预设；
   * >  相关预设应该一个点位可以创建多个，然后在跑步选择路径的时候可以进行选择"
   *
   * 在这之前 `lineId` 既是"地点"又是主键 ⇒ **一个地点只能存一条**（`upsert` 按 `lineId` 覆盖）。
   * 现在职责拆开：`id` = 这条**预设**的身份，`lineId` = 它属于哪个**地点**（厂商线路 / 本机键）。
   *
   * ## 迁移口径（**旧数据逐字不变**）
   * 旧数据没有这个字段 ⇒ `normalizeLibrary` 迁移时取 `id = lineId`
   * （于是旧的本机路径选择 `mp_free_route_choice_v1` 里存的值照旧能解析到那一条 —— 零迁移风险）。
   */
  id: string
  /** 厂商线路 id（**地点键**：一个地点可有多条预设；**提交时仍用它** —— 我们只换"生成用的几何"，不动报文口径） */
  lineId: string
  /** 线路名快照（任务换版后仍看得懂这条记录是什么；**厂商线路名**，我们不覆写它） */
  lineName: string
  /**
   * **这条预设的名称**（2026-09-18 新增时叫"用户自己起的名字"，1.1.9 需求②：本地路线库支持重命名；
   * 🆕 2026-11-03 起语义扩展为**预设名称** —— 同一个地点下靠它区分）。
   * 与 `lineName`（厂商快照）分开存 —— 改名只动这条本机记录，**不动厂商线路名**；
   * 清空（改成空串/空白）＝ 恢复显示厂商原名快照（**旧数据就是这个状态**，逐字不变）。
   * ⚠️ 新存的预设**一律有名字**（留空由 `autoPresetName()` 自动生成），且**全库不可重名**。
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
  /**
   * 🆕 **进场点**（2026-10-30，1.3.3 需求）：真人在绕圈前从跑道外侧走到跑道上的那个位置。
   * 缺失 = 未设置（轨迹直接从起跑点开始，与旧版逐点一致 —— 这是**向后兼容的回归保证**）。
   * 设置后：轨迹 = `进场点 → 起跑点`（一小段直线）→ 沿跑道绕圈。
   */
  entry?: TrackEntry
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
  /**
   * 🆕 2026-11-03（1.3.6 需求③「真实路径【测试】」）：**这条预设的来源是某一天的真实跑**。
   *
   * 只有"从成绩归档导出"的预设才有这个字段；**没有它 ⇒ 与旧版本逐字一致**（不凭空造）。
   * 用途：① 界面如实显示"这条是哪天/哪一场导出的"；② 换圈那一步**不参与**
   *   （判据本来就是"有没有 `freeShape`"——真实路径带 `freeShape: curve`，两者自动一致）。
   * 🔴 里面**不含**学号/姓名/token（隐私红线，白名单字段见 `utils/mp/realPath.ts`）。
   */
  realPath?: RealPathMeta
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

// ================================================================ 🆕 2026-11-03（1.3.6）：**一个地点多条预设**
//
// 用户原话："一个地点的预设只能创建一个，例如「东操场」点位只能创建一个预设；相关预设应该
//   一个点位可以创建多个，然后在跑步选择路径的时候可以进行选择；用户选择相关路径，保存预设的时候
//   可以输入相关名字进行存储，便于用户区分，**预设名称不可以相同**，且预设存储相关创建日期等等一系列信息"。
//
// 本节的四个纯函数就是那三句话的**唯一判据来源**（界面/组合层/跑步引擎都调它们，不许各写一套）：
//   · `newTrackPresetId()`    —— 预设主键怎么生成；
//   · `nameKey()` / `findNameConflict()` —— "名称不可以相同"怎么判（**全库**比较，不看地点）；
//   · `autoPresetName()`      —— 用户没填名字时怎么自动起一个不重名的；
//   · `presetsOfLine()` / `resolvePresetForLine()` —— "这个地点有哪些预设、这次跑哪一条"。

/** 预设 id 的**唯一生成入口**（组合层的 `upsert` 与单测共用；不许在别处自己拼） */
export function newTrackPresetId(seed?: { now?: number; rand?: () => number }): string {
  const now = Math.floor(Number(seed?.now ?? Date.now()))
  const r = Math.floor((seed?.rand ? seed.rand() : Math.random()) * 0x100000000)
  return `p-${now.toString(36)}-${(r >>> 0).toString(36).padStart(7, '0')}`
}

/**
 * 名称的**比较键**（判重专用）：过一遍 `sanitizeLineName`（折空白/去控制字符/限长）再统一小写。
 * 判据：`nameKey('  西 操场 ') === nameKey('西 操场')`（连续空白折成**一个**空格，不删空格）、
 *      `nameKey('Loop') === nameKey('loop')`、`nameKey('东\u200b操场') === nameKey('东操场')`。
 * ⚠️ 于是「东 操场」与「东操场」**算两个不同的名字**（沿用既有的空白归一化口径，不自造新规则）。
 */
export function nameKey(raw: unknown): string {
  return sanitizeLineName(raw).toLowerCase()
}

/**
 * **"预设名称不可以相同"的唯一判据**：在整库范围里找另一条同名（比的是**显示名**，即
 * `resolveEntryName` 的结果 —— 旧数据没有自定义名时显示的是厂商线路名，它同样占住这个名字）。
 *
 * @param exceptId 排除自己（保存/改名时传自己的 id；此时"名字没变"不算冲突）
 * @returns 冲突的那一条；没有冲突 ⇒ `undefined`
 */
export function findNameConflict(
  entries: TrackRouteEntry[] | null | undefined,
  name: unknown,
  exceptId?: string | null,
): TrackRouteEntry | undefined {
  const key = nameKey(name)
  if (!key) return undefined
  const skip = String(exceptId ?? '').trim()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue
    if (skip && String(entryIdOf(e)) === skip) continue
    if (nameKey(resolveEntryName(e)) === key) return e
  }
  return undefined
}

/** 一条本机条目的**预设 id**（读旧数据时退回 `lineId` —— 迁移前的条目 id 就是 lineId） */
export function entryIdOf(e: { id?: unknown; lineId?: unknown } | null | undefined): string {
  const id = String(e?.id ?? '').trim()
  if (id) return id
  return String(e?.lineId ?? '').trim()
}

/**
 * 用户没填名字时**自动起一个不重名的预设名**（唯一入口）。
 * 形状：先试 `lineName`（多数情况就是「东操场」）→ 撞了就 `东操场 · 预设 2` → `… 3` → …
 * ⚠️ 名称有 24 码点上限（`TRACK_NAME_MAX`）⇒ 先按后缀长度给基名留位，再截断，
 *    否则长线路名会让后缀被截掉、候选名与基名相同 ⇒ 死循环（有上限计数兜底，绝不无限循环）。
 */
export function autoPresetName(
  entries: TrackRouteEntry[] | null | undefined,
  lineName: unknown,
  lineId: unknown,
  exceptId?: string | null,
): string {
  const base = sanitizeLineName(lineName) || String(lineId ?? '').trim() || '预设'
  if (!findNameConflict(entries, base, exceptId)) return base
  for (let i = 2; i < 1000; i++) {
    const suffix = ` · 预设 ${i}`
    const room = Math.max(1, TRACK_NAME_MAX - Array.from(suffix).length)
    const head = Array.from(base).slice(0, room).join('')
    const candidate = sanitizeLineName(head + suffix)
    if (candidate && !findNameConflict(entries, candidate, exceptId)) return candidate
  }
  /** 兜底（理论上到不了）：用时间戳造一个一定不重名的 */
  return sanitizeLineName(`${base} · ${Date.now().toString(36)}`)
}

/**
 * 名称冲突时给用户看的"占用者"一句话：`名字（地点：X）`。
 * ⚠️ 同名判定是**全库**的 ⇒ 冲突的那条可能在**别的地点**，只报名字用户会翻不到；
 *    同一个地点内则不重复写一遍地点（噪音）。
 */
export function conflictOwnerText(e: TrackRouteEntry, selfLineId?: string | null): string {
  const name = resolveEntryName(e)
  const place = String(e.lineName ?? '').trim() || String(e.lineId ?? '')
  if (!place || nameKey(place) === nameKey(name)) return name
  if (String(e.lineId ?? '') === String(selfLineId ?? '')) return name
  return `${name}（地点：${place}）`
}

/**
 * 🆕 2026-11-03（1.3.6）：**保存预设的结果**（组合层 `upsert` 的返回值，界面按 `ok` 分支渲染）。
 *
 * 为什么不再用"`undefined` = 失败"：现在有**两种失败**（几何不合法 / 名称撞车），
 * 而"名称撞车"必须把**是谁占了**告诉用户 —— 一个 `undefined` 说不清，界面就只能自己猜措辞。
 */
export type TrackSaveResult =
  | { ok: true; entry: TrackRouteEntry; persisted: boolean }
  | { ok: false; reason: 'invalid-geometry' | 'duplicate-name'; message: string }

/** 改名结果（`not-found` = 这条预设已经不在库里了） */
export type TrackRenameResult =
  | { ok: true; entry: TrackRouteEntry; persisted: boolean }
  | { ok: false; reason: 'not-found' | 'duplicate-name'; message: string }

/** 某个**地点**（`lineId`）下的全部预设（保持库内顺序：最新保存的在前） */
export function presetsOfLine(
  entries: TrackRouteEntry[] | null | undefined,
  lineId: unknown,
): TrackRouteEntry[] {
  const key = String(lineId ?? '').trim()
  if (!key) return []
  return (Array.isArray(entries) ? entries : []).filter((e) => e && String(e.lineId) === key)
}

/**
 * 按**引用**找一条预设：先按预设 `id` 精确找，找不到再按 `lineId` 退回（＝该地点最新保存的那条）。
 *
 * ⚠️ 为什么要退回：`mp_free_route_choice_v1`（本机路径选择）里可能存着**旧版本写进去的 `lineId`**
 *    （那时 id 就是 lineId），也可能是用户手输的 `local:free`。退回保证这些值**照旧解析得到**。
 */
export function findEntryByRef(
  entries: TrackRouteEntry[] | null | undefined,
  ref: unknown,
): TrackRouteEntry | undefined {
  const key = String(ref ?? '').trim()
  if (!key) return undefined
  const list = Array.isArray(entries) ? entries : []
  return list.find((e) => e && entryIdOf(e) === key) ?? list.find((e) => e && String(e.lineId) === key)
}

/** 「这个地点这次跑哪一条预设」的判定结果 */
export interface PresetResolution {
  /** 选中的预设（这个地点一条都没有 ⇒ `undefined`） */
  entry?: TrackRouteEntry
  /** `true` = 用户上次选的那条已不可用（被删 / 几何坏了）⇒ 已落回本地点别的预设，界面要如实说明 */
  preferredUnavailable: boolean
}

/**
 * **"这个地点这次用哪条预设"的唯一判据**（跑步引擎与跑步页共用，不许出现第二套）。
 *
 * 顺序（即优先级）：
 *   ① 用户选过（`preferredId`）且那条**确实属于这个地点**且几何可用 ⇒ 用它；
 *   ② 否则本地点**第一条几何可用**的预设；
 *   ③ 否则本地点第一条（几何不完整也如实返回 —— 由调用方按"没有几何"处理，这里不假装有）。
 *
 * ⚠️ 跨地点**绝不串味**：`preferredId` 指向的是别的地点/已被删的条目 ⇒ 一律落回本地点。
 */
export function resolvePresetForLine(
  entries: TrackRouteEntry[] | null | undefined,
  lineId: unknown,
  preferredId?: string | null,
): PresetResolution {
  const list = presetsOfLine(entries, lineId)
  if (!list.length) return { preferredUnavailable: false }
  const want = String(preferredId ?? '').trim()
  const picked = want ? list.find((e) => entryIdOf(e) === want) : undefined
  if (picked && entryGeometryUsable(picked)) return { entry: picked, preferredUnavailable: false }
  const preferredUnavailable = Boolean(want)
  const usable = list.find((e) => entryGeometryUsable(e))
  return { entry: usable ?? list[0], preferredUnavailable }
}

/** 一个地点下有几条预设（跑步页/编辑器显示"这个地点有几条"用） */
export function presetCountOfLine(entries: TrackRouteEntry[] | null | undefined, lineId: unknown): number {
  return presetsOfLine(entries, lineId).length
}

/**
 * 🆕 **同名预设的检测**（只报不改）：返回"显示名相同"的分组。
 * 用途：**旧数据**里可能本来就有两条同名（那时没有唯一性约束，我们**绝不自动改名**）
 * ⇒ 界面上如实提示一句，让用户自己去重命名。
 */
export function duplicateNameGroups(
  entries: TrackRouteEntry[] | null | undefined,
): { name: string; ids: string[] }[] {
  const byKey = new Map<string, { name: string; ids: string[] }>()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue
    const name = resolveEntryName(e)
    const key = nameKey(name)
    if (!key) continue
    const g = byKey.get(key)
    if (g) g.ids.push(entryIdOf(e))
    else byKey.set(key, { name, ids: [entryIdOf(e)] })
  }
  return [...byKey.values()].filter((g) => g.ids.length > 1)
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

/**
 * 🆕 2026-09-22（用户反馈 + 负责人批准改选择逻辑）：**自由路线任务用哪一条本机几何** —— **唯一判据**。
 *
 * ## 为什么"优先 `local:free`"（原先只看"最近保存"）
 * 跑步引擎原先取"本机路线库第一条（= 最近保存的那条）"。可用户**刚在「非官方路径【测试】」画完**
 * 之后又保存了**别的东西**（另一条任务的跑道等）时，被采用的就不是他刚画的那条 ⇒ 他会以为"我画的没用上"
 * （他反馈"无法选择"，我们上一轮把这件事**显示出来**后，暴露的正是这条判据本身会"串味"）。
 * 现在：**自由路线任务优先认「非官方路径【测试】」那条固定键 `local:free`**；没有它（老用户从没画过）
 * 才退回"最近保存的那条"，且**回退必须如实说明**（`fallback: true` + `reason`，界面直接显示，别自己另写措辞）。
 *
 * ## 判据（顺序即优先级；2026-09-22 二次扩展：把"用户自己选的那条"放最前）
 * ① `routeRequirementOf(task).kind === 'line'`（服务端下发了线路）⇒ `entry: undefined`
 *    —— **官方线路任务零变化**（几何来自任务线路，与本机库无关）；
 * ② `kind === 'free'` 且**用户在「本机路径」下拉里选过**（`preferredLineId`）**且那条几何可用** ⇒ 用它；
 * ③ 否则 `lineId === LOCAL_FREE_LINE_ID` 且几何可用（**复用常量，不写死字符串**）；
 * ④ 否则退回"最近保存的**几何可用**条目"（`fallback: true`）；
 * ⑤ 库空/全不可用 ⇒ `entry: undefined`（调用方按"还没有几何"提示，绝不假装有一条）。
 * ⚠️ 用户选过的那条**被删了/几何坏了** ⇒ 落回 ③/④，并把 `preferredUnavailable: true` 交给界面
 *    （界面据此如实提示"你上次选的那条已不可用，已改用 X"）。
 *
 * ⚠️ **界面与跑步引擎共用这一个函数**（`composables/demo/runner.ts` 与 `RunWorkspace.vue`），
 *    不许出现第二套判据 —— 否则"界面说用 A、实际用 B"会立刻骗到用户。
 * 🔴 **红线**：这个选择**只决定本机几何**；提交报文一个字都不变（`lineId` 仍空串、`paperId` 仍 taskId、
 *    `sunrunPathPointList` 仍按现口径），`local:free` **绝不**进报文。
 */
export interface FreeRouteGeometryChoice {
  /** 选中的本机条目（没有 ⇒ `undefined`：有线路的任务 / 本机库为空 / 全不可用） */
  entry?: TrackRouteEntry
  /** `true` = 用的是"最近保存"的回退项（不是用户选的、也不是 `local:free`）⇒ **界面必须如实说明** */
  fallback: boolean
  /** 给人看的一句依据（界面直接复用，避免各处各写一套说法） */
  reason: string
  /** 🆕 用户上次选的那条已不可用（被删/几何坏了）⇒ 界面要如实提示 */
  preferredUnavailable: boolean
}

/** 一条本机条目的几何**能不能拿来跑图**（与跑步引擎 `resolveTrackGeometry` 同判据：形状可用 或 内外圈各 ≥3 点） */
export function entryGeometryUsable(e: TrackRouteEntry | null | undefined): boolean {
  if (!e || typeof e !== 'object') return false
  if (usableFreePathShape(e.freeShape)) return true
  const outer = Array.isArray(e.outer) ? e.outer.length : 0
  const inner = Array.isArray(e.inner) ? e.inner.length : 0
  return outer >= 3 && inner >= 3
}

export function freeRouteGeometryChoice(
  entries: TrackRouteEntry[],
  task: unknown,
  preferredLineId?: string | null,
): FreeRouteGeometryChoice {
  const none: FreeRouteGeometryChoice = { fallback: false, reason: '', preferredUnavailable: false }
  if (routeRequirementOf(task).kind !== 'free') return none
  const list = Array.isArray(entries) ? entries : []
  const usable = list.filter((e) => entryGeometryUsable(e))
  const want = String(preferredLineId ?? '').trim()
  /** 用户选过就不算"没选"；选过但不可用 ⇒ 下面如实提示并落回 ③/④ */
  // 🆕 2026-11-03（1.3.6）：引用现在可能是**预设 id**（一个地点多条预设）⇒ 统一走 `findEntryByRef`
  //   （先按 id 找、再按 lineId 退回 ⇒ 旧版本写进 localStorage 的 lineId 值照旧解析得到）
  const picked = want ? findEntryByRef(list, want) : undefined
  if (picked && entryGeometryUsable(picked)) {
    return { entry: picked, fallback: false, reason: '用你在「本机路径」里选的那条本机几何', preferredUnavailable: false }
  }
  const preferredUnavailable = Boolean(want)
  const localFree = usable.find((e) => String(e?.lineId) === LOCAL_FREE_LINE_ID)
  if (localFree) {
    return {
      entry: localFree,
      fallback: false,
      reason: preferredUnavailable
        ? `你上次选的那条已不可用（可能被删或几何不完整），已改用「研途健行路径编辑器」保存的那条`
        : '本任务未下发线路 ⇒ 用你在「研途健行路径编辑器」保存的那条本机几何',
      preferredUnavailable,
    }
  }
  const recent = usable[0]
  if (!recent) {
    return {
      ...none,
      preferredUnavailable,
      reason: preferredUnavailable ? '你上次选的那条已不可用，而且本机现在没有别的可用几何' : '本机还没有任何已保存的几何',
    }
  }
  return {
    entry: recent,
    fallback: true,
    reason: preferredUnavailable
      ? `你上次选的那条已不可用（可能被删或几何不完整），暂用最近保存的那条跑道几何`
      : '本机还没有本机路径形状 ⇒ 暂用最近保存的那条跑道几何；建议去「研途健行路径编辑器」画一条',
    preferredUnavailable,
  }
}

/** 只要"哪一条"的调用方（跑步引擎）用它 —— **同一实现的薄包装**，判据只有 `freeRouteGeometryChoice()` 一处 */
export function freeRouteLocalEntry(
  entries: TrackRouteEntry[],
  task: unknown,
  preferredLineId?: string | null,
): TrackRouteEntry | undefined {
  return freeRouteGeometryChoice(entries, task, preferredLineId).entry
}

// ---------- 🆕 2026-09-22：把"本机路径"的选择按任务持久化（**纯函数**；IO 在 composable 里） ----------
/**
 * 「自由路线任务用哪条本机路径」的持久化键。
 *
 * ⚠️ **刻意不写进 `mp_real_task_v1`**：那份缓存的契约是 `{at, task, lineId, token}` 四项
 *    （见 `utils/mp/realCache.ts` 与其单测），塞进去会破坏"恢复会话"的既有语义。
 *    这里按 **taskId** 各记各的（换任务互不影响）。
 */
export const FREE_ROUTE_CHOICE_KEY = 'mp_free_route_choice_v1'

/**
 * 🆕 2026-11-03（1.3.6）：**"这个地点用哪条预设"的选择**（`{ [lineId]: 预设 id }`）。
 *
 * 为什么要持久化：一个地点可以有多条预设了（用户要求），跑步页的两级下拉里
 * "线路 → 预设"的第二级选择必须**记住**，否则每次进页都落回默认那条，
 * 用户会以为"我选的没生效"（与 `mp_free_route_choice_v1` 当初的教训同一类）。
 *
 * ⚠️ 沿用**同一条实现**（`parseRefChoiceMap` / `withRefChoice`）—— 形状都是 `{[键]: 条目引用}`，
 *    分成两套只会让两边慢慢漂移。它同样**只决定本机几何**，绝不进任何提交报文。
 */
export const PRESET_CHOICE_KEY = 'mp_preset_choice_v1'

/**
 * 「按某个键记住用了哪一条本机条目」的**通用解析**（纯函数；坏数据/异形一律安全降级成空表，绝不抛错）。
 * 两个调用方：`FREE_ROUTE_CHOICE_KEY`（按 taskId 记本机路径）与 `PRESET_CHOICE_KEY`（按 lineId 记预设）。
 */
export function parseRefChoiceMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k ?? '').trim()
    const val = typeof v === 'string' ? v.trim() : ''
    if (key && val) out[key] = val
  }
  return out
}

/** 写入/覆盖一条选择（返回**新对象**，不改原对象；`ref` 为空串 = 清掉该键的选择） */
export function withRefChoice(
  map: Record<string, string> | null | undefined,
  key: string | null | undefined,
  ref: string | null | undefined,
): Record<string, string> {
  const out = { ...parseRefChoiceMap(map) }
  const k = String(key ?? '').trim()
  if (!k) return out
  const val = String(ref ?? '').trim()
  if (val) out[k] = val
  else delete out[k]
  return out
}

/** 旧名（本机路径选择用）：与 `parseRefChoiceMap` **同一实现** —— 保留旧名只为不动既有 import 与单测 */
export const parseFreeRouteChoices = parseRefChoiceMap
/** 旧名（本机路径选择用）：与 `withRefChoice` **同一实现** */
export const withFreeRouteChoice = withRefChoice

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

/**
 * 归一化**进场点**（2026-10-30，1.3.3）：坐标必须是一对有限数，否则 `undefined`（= 未设置）。
 * ⚠️ 与 `normalizeTrackStart` 同口径：坐标统一成 `number` 存储。
 * ⚠️ **不在这里校验距离**（离起跑点太近/太远由 `prependEntrySegment` 在生成时判并回报原因）——
 *    数据层只保证"这是个能用的坐标"，避免"存不进去"与"用了会出错"两件事混在一个函数里。
 */
export function normalizeTrackEntry(raw: unknown): TrackEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  if (!isFinitePoint(v.point)) return undefined
  return { point: { latitude: Number(v.point.latitude), longitude: Number(v.point.longitude) } }
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
  /**
   * 🆕 2026-11-03（1.3.6）：已用掉的**预设 id**（保证同一份数据里 id 唯一）。
   * 迁移口径：旧数据没有 `id` ⇒ **取 `lineId`**（于是旧的本机路径选择里存的值照旧解析得到）；
   * 万一 `lineId` 已被另一条占用（坏数据）⇒ 加 `#2/#3…` 后缀，**绝不丢掉条目**。
   */
  const usedIds = new Set<string>()
  const assignId = (v: Record<string, unknown>, lineId: string): string => {
    const raw = String(v.id ?? '').trim()
    let id = ''
    if (raw) {
      if (!usedIds.has(raw)) id = raw
      else {
        // 存量数据里 id 撞车（坏数据/手工拷贝）：加后缀保住**两条都在**，且保留原 id 的痕迹
        let n = 2
        while (usedIds.has(`${raw}#${n}`)) n++
        id = `${raw}#${n}`
      }
    }
    if (!id) {
      const base = lineId || 'preset'
      id = base
      let n = 2
      while (usedIds.has(id)) id = `${base}#${n++}`
    }
    usedIds.add(id)
    return id
  }
  const push = (lineId: string, v: Record<string, unknown>) => {
    // ⚠️ 审计 S1：不是"元素形状对"就收 —— 必须内外圈都够 3 点，**或**带一个可用的非官方形状
    if (!lineId || !isValidTrackEntry(v)) return
    // 用户自定义名：归一化后为空（历史数据里可能存过空白）⇒ 归一化成 undefined，一律走 `resolveEntryName` 兜底
    const customName = sanitizeLineName(v.customName)
    const start = normalizeTrackStart(v.start)
    // 🆕 进场点（1.3.3）：旧数据没有这个字段 ⇒ 不凭空造（保持 `'entry' in e === false`，老条目零变化）
    const entry = normalizeTrackEntry(v.entry)
    const history = normalizeHistory(v.history)
    const editCount = Number(v.editCount)
    /** 非官方形状：不认识的形状/坏数据一律 undefined（= 退回双圈模式），绝不抛 */
    const freeShape = parseFreePathShape(v.freeShape)
    /** 🆕 2026-11-03（需求③）：真实路径的来源元信息（坏数据/空 ⇒ undefined，老条目不会多出这个键） */
    const realPath = parseRealPathMeta(v.realPath)
    out.push({
      // 🆕 2026-11-03（1.3.6）：预设主键（旧数据 = lineId ⇒ 既有引用零迁移）
      id: assignId(v, lineId),
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
      ...(entry ? { entry } : {}),
      updatedAt: String(v.updatedAt ?? ''),
      updatedAppVersion: String(v.updatedAppVersion ?? ''),
      editCount: Number.isFinite(editCount) && editCount > 0 ? Math.round(editCount) : undefined,
      ...(history.length ? { history } : {}),
      // 🆕 只有**合法**的非官方形状才写回；没有这个字段的老条目**不会**多出这个键
      ...(freeShape ? { freeShape } : {}),
      /** 🆕 同上：只有**看得出是哪一场**的元信息才写回 */
      ...(realPath ? { realPath } : {}),
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
 * 🆕 2026-09-22（用户反馈："自由路线任务的跑步页没说清**会用哪一条本机几何**"）：
 * **一条本机条目"长什么样"的一句话**（纯函数，有单测）—— 专供跑步页那条提示用。
 *
 * 口径（**必须与跑步引擎/跑步页同源**，不许自己另算一套）：
 *   · 有 `freeShape`（非官方路径）⇒ 直接复用 `freePathShapeText()`（圈型 / 折线型的同一套读数与单位）；
 *   · 没有形状的老条目（内外双圈）⇒ 用**跑步引擎真正喂给生成器的那条车道线**的同一算式算"一圈"：
 *     `ringLengthM(laneLoop({outer,inner}, laneRatioFor(laneNo ?? 3, laneCount ?? 6), 240))`
 *     （与 `RunWorkspace.vue` 的 `selectedLaneLengthM`、`composables/demo/runner.ts` 的 `resolveTrackGeometry` 逐字同源）；
 *   · 内外圈点数不够（跑图时会被当作"没几何"）⇒ **如实说不可用**，绝不假装有几何。
 *
 * 时间用 `updatedAt ?? createdAt`（"最近保存"）；两者都没有 ⇒ 不显示这一节（不写"时间未知"这类噪音）。
 */
export function localEntryGeometryText(e: TrackRouteEntry): string {
  const saved = e.updatedAt || e.createdAt
  const when = saved ? ` · 最近保存 ${formatLocalDateTime(String(saved))}` : ''
  return `${localEntryShapeText(e)}${when}`
}

/**
 * 🆕 2026-09-22：**只讲形状**的那半句（不带"最近保存"时间）—— 给「本机路径」下拉的选项标题用
 * （下拉里每一行要短，时间由旁边的说明承担）。
 *
 * 口径与 `localEntryGeometryText()` **完全同源**（后者就是"这一句 + 最近保存时间"）：
 *   · 有 `freeShape` ⇒ `freePathShapeText()`（圈型/折线型的同一套读数）；
 *   · 老双圈条目 ⇒ `内外双圈（第 N 道/M）：外圈 X 点 · 内圈 Y 点 · 一圈约 Z m`（跑步引擎同一条车道线算式）；
 *   · 内外圈点数不够 ⇒ **如实说不可用**（`entryGeometryUsable()` 会把它排除在下拉之外）。
 */
export function localEntryShapeText(e: TrackRouteEntry): string {
  const shape = freePathShapeText(e.freeShape)
  if (shape) return shape
  const outer = Array.isArray(e.outer) ? e.outer.length : 0
  const inner = Array.isArray(e.inner) ? e.inner.length : 0
  const lane = e.laneNo ? `第 ${e.laneNo} 道${e.laneCount ? `/${e.laneCount}` : ''}` : '道次未记录'
  if (outer < 3 || inner < 3) {
    return `内外双圈几何不完整（外圈 ${outer} 点 · 内圈 ${inner} 点）——跑步页拿不到几何，请回「跑道编辑」补好内外圈并保存`
  }
  const loop = laneLoop({ outer: e.outer, inner: e.inner }, laneRatioFor(e.laneNo ?? 3, e.laneCount ?? 6), 240)
  const lap = ringLengthM(loop)
  return `内外双圈（${lane}）：外圈 ${outer} 点 · 内圈 ${inner} 点 · 一圈约 ${Math.round(lap)} m`
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
  // 🆕 2026-11-03（1.3.6）：显示名与厂商名**只是大小写/空白不同**（自动命名常常就是取厂商名）时不再重复标一遍。
  const renamed =
    nameKey(resolveEntryName(e)) !== nameKey(String(e.lineName ?? '').trim())
      ? `（官方名：${String(e.lineName ?? '').trim() || e.lineId}）`
      : ''
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
    /** 🆕 2026-11-03（1.3.6）：预设名与编号 —— 一个地点多条预设后，列表里"哪一条"必须有据可查 */
    { label: '预设名称', value: resolveEntryName(e) },
    { label: '预设编号', value: entryIdOf(e) || '—' },
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
    ...(freePathShapeText(e.freeShape) ? [{ label: '研途健行路径', value: String(freePathShapeText(e.freeShape)) }] : []),
    { label: '内外圈点数', value: `外圈 ${e.outer.length} 点 · 内圈 ${e.inner.length} 点` },
    { label: '外圈周长', value: e.outer.length >= 3 ? `${Math.round(ringLengthM(e.outer))} m` : '—' },
    { label: '道次',
      value: e.laneNo ? `第 ${e.laneNo} 道${e.laneCount ? `（共 ${e.laneCount} 道）` : ''}` : '未记录',
    },
    /**
     * 🆕 2026-11-03（需求③「真实路径」）：**只有这条预设真的是从成绩归档导出时才多出这几行**
     * （行数由数据决定，旧条目不会凭空多出"真实路径"字样）。
     */
    ...(e.realPath
      ? [
          { label: '来源', value: '真实路径（从成绩归档导出，测试功能）' },
          { label: '真实跑日期', value: e.realPath.date || '未记录' },
          { label: '真实场次号', value: e.realPath.scoreId || '未记录' },
          {
            label: '那场里程 / 用时',
            value: `${e.realPath.km === null ? '未记录' : `${e.realPath.km.toFixed(2)} km`} · ${e.realPath.usedTime || '未记录'}`,
          },
          {
            label: '那场拟合度 / 原始点数',
            value: `${e.realPath.fitDegree === null ? '未记录' : e.realPath.fitDegree.toFixed(2)} · ${e.realPath.sourcePoints || 0} 点`,
          },
          { label: '导出时间', value: e.realPath.exportedAt ? formatLocalDateTime(e.realPath.exportedAt) : '未记录' },
        ]
      : []),
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

// ---------- 🆕 2026-09-29：老版本路径识别（用户口径"老版本路径文件提示需要更新"） ----------

/**
 * **老版本路径**的判定结果：给界面直接渲染用（`legacy` 为假时 `detail` 为空串）。
 *
 * ## 为什么要"提示更新"（用户 2026-09-29 口径）
 * > "老版本路径文件提示需要更新"
 *
 * 本轮「研途健行路径编辑器」有两处变化：**长度/趟数不再由编辑器设置**、**起跑点固定用你标的第一个点**。
 * 形状的数据格式本身**没有变**（`FreePathShape` 仍然只有 `kind` + `points`）⇒ **旧数据不会坏**，
 * 但有两类本机记录确实"该更新"（判据见 `legacyFreePathUpdate`）：
 *   ① **没有 `freeShape`**：1.2.5 之前根本没有"画路径"这个功能 ⇒ 这类记录是用**旧的占位几何**
 *      或**内外双圈**在凑合（"未下发线路"的任务会拿它当几何跑）；
 *   ② **有 `freeShape` 但 `outer` 与 `inner` 逐点相同**：那是 `freeShapePlaceholderRing()` 生成的
 *      **占位几何**（给 1.2.4 及更早版本看的），用户从来没描过真正的圆。
 *
 * ## 三条纪律（照用户 2026-09-29 的选择：**提示 + 一键重画，不自动迁移**）
 *   · 只**提示**：`legacy` 为真**不影响**这条记录能不能用（跑步页照旧会拿它生成轨迹）；
 *   · **绝不自动迁移、绝不自动删除**任何本机数据（判定是**纯读**，不写回、不清洗）；
 *   · ⚠️ 判据①**允许假阳性**（比如你确实描过两个一模一样的圈，或旧记录其实够用）——
 *      所以文案必须写成"**建议**更新"，并且给「知道了，这次不改」这个出口，不制造"必须改"的压力。
 */
export interface LegacyFreePathUpdate {
  /** 是不是"老版本路径"（建议更新） */
  legacy: boolean
  /** 给人看的一句依据（界面直接渲染；不是老版本时为空串） */
  detail: string
}

/** 两串坐标是否**逐点相同**（占位几何的判据：`freeShapePlaceholderRing` 把同一份点放进 outer/inner） */
function samePoints(a: LatLng[] | undefined, b: LatLng[] | undefined): boolean {
  const x = Array.isArray(a) ? a : []
  const y = Array.isArray(b) ? b : []
  if (x.length < 3 || x.length !== y.length) return false
  return x.every((p, i) => {
    const q = y[i]!
    return Number(p?.latitude) === Number(q?.latitude) && Number(p?.longitude) === Number(q?.longitude)
  })
}

/**
 * 判定一条本机记录是不是**老版本路径**（纯函数，可在跑步页与编辑器两处复用 —— **判据只能有一处**）。
 * 没有记录（`undefined`）⇒ 不是老版本（那种情况界面该说的是"还没画过"，不是"该更新"）。
 */
export function legacyFreePathUpdate(entry: TrackRouteEntry | null | undefined): LegacyFreePathUpdate {
  if (!entry || typeof entry !== 'object') return { legacy: false, detail: '' }
  if (usableFreePathShape(entry.freeShape)) {
    /** 有形状了 —— 除非它其实是"占位双圈"（outer 与 inner 逐点相同），否则就是新格式，不用提示 */
    return samePoints(entry.outer, entry.inner)
      ? {
          legacy: true,
          detail: '这条记录用的还是旧的占位几何（内外圈是同一份点），从来没在本页画过真正的路径',
        }
      : { legacy: false, detail: '' }
  }
  /** 没有 `freeShape`：旧版（1.2.5 之前）画的记录 —— 建议在本页画一条真正的路径 */
  return {
    legacy: true,
    detail: '这条记录里没有本页画的路径形状，只有旧的几何（内外圈 / 占位几何）',
  }
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
