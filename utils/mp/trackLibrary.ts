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

export const TRACK_LIBRARY_KEY = 'mp_track_library_v1'
/** 旧格式的键（迁移用；旧版是 `{ [lineId]: {outer, inner} }`） */
export const TRACK_LIBRARY_KEY_LEGACY = 'mp_track_rings_v1'

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
 * 把任意历史数据**归一化**成新格式（纯函数，便于单测与迁移）：
 *   · 新格式数组 → 原样（补齐缺失字段）
 *   · 旧格式对象映射 → 转成数组（创建日期标空、版本用 fallback）
 *   · 其它垃圾 → 丢掉
 */
export function normalizeLibrary(raw: unknown, fallbackVersion = '未知'): TrackRouteEntry[] {
  const out: TrackRouteEntry[] = []
  const push = (lineId: string, v: Record<string, unknown>) => {
    // ⚠️ 审计 S1：不是"元素形状对"就收 —— 必须**内外圈都够 3 点**（空圈曾能被收进来）
    if (!lineId || !hasValidRings(v)) return
    // 用户自定义名：归一化后为空（历史数据里可能存过空白）⇒ 归一化成 undefined，一律走 `resolveEntryName` 兜底
    const customName = sanitizeLineName(v.customName)
    out.push({
      lineId,
      lineName: String(v.lineName ?? lineId),
      ...(customName ? { customName } : {}),
      outer: v.outer,
      inner: v.inner,
      createdAt: String(v.createdAt ?? ''),
      appVersion: String(v.appVersion ?? fallbackVersion),
      laneCount: typeof v.laneCount === 'number' && v.laneCount > 0 ? v.laneCount : undefined,
      laneNo: typeof v.laneNo === 'number' && v.laneNo > 0 ? v.laneNo : undefined,
      note: typeof v.note === 'string' ? v.note : undefined,
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

/** 一条路线的摘要（列表展示用）：点位数 · 创建日期（本机时间） · 创建版本 */
export function entrySummaryText(e: TrackRouteEntry): string {
  const when = e.createdAt ? formatLocalDateTime(e.createdAt) : '创建日期未知'
  const version = e.appVersion ? `v${e.appVersion.replace(/^v/, '')}` : '版本未知'
  const lane = e.laneNo ? `第 ${e.laneNo} 道${e.laneCount ? `/${e.laneCount}` : ''}` : '道次未记录'
  // 改过名时**顺带标出厂商原名**：改的是本机显示名，提交用的仍是厂商 lineId，
  // 把原名留在摘要里，用户才不会"改完就不知道这条对应哪条官方线路"（2026-09-18）。
  const renamed = sanitizeLineName(e.customName) ? `（官方名：${String(e.lineName ?? '').trim() || e.lineId}）` : ''
  return `外圈 ${e.outer.length} 点 · 内圈 ${e.inner.length} 点 · ${lane} · ${when} · ${version}${renamed}`
}
