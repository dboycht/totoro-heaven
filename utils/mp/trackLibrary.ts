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
  /** 线路名快照（任务换版后仍看得懂这条记录是什么） */
  lineName: string
  outer: LatLng[]
  inner: LatLng[]
  /** 创建时间（ISO 字符串；旧数据迁移过来时为空 ⇒ 显示"创建日期未知"） */
  createdAt: string
  /** 创建时的软件版本（用户要求"显示对应版本"） */
  appVersion: string
  /** 这条跑道一共几道（生成时"随机一道 + 缓慢换道"用；默认 6） */
  laneCount?: number
  note?: string
}

const isPts = (v: unknown): v is LatLng[] =>
  Array.isArray(v) && v.every((p) => !!p && typeof p === 'object' && 'latitude' in p && 'longitude' in p)

/**
 * 把任意历史数据**归一化**成新格式（纯函数，便于单测与迁移）：
 *   · 新格式数组 → 原样（补齐缺失字段）
 *   · 旧格式对象映射 → 转成数组（创建日期标空、版本用 fallback）
 *   · 其它垃圾 → 丢掉
 */
export function normalizeLibrary(raw: unknown, fallbackVersion = '未知'): TrackRouteEntry[] {
  const out: TrackRouteEntry[] = []
  const push = (lineId: string, v: Record<string, unknown>) => {
    if (!lineId || !isPts(v.outer) || !isPts(v.inner)) return
    out.push({
      lineId,
      lineName: String(v.lineName ?? lineId),
      outer: v.outer,
      inner: v.inner,
      createdAt: String(v.createdAt ?? ''),
      appVersion: String(v.appVersion ?? fallbackVersion),
      laneCount: typeof v.laneCount === 'number' && v.laneCount > 0 ? v.laneCount : undefined,
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
  return `外圈 ${e.outer.length} 点 · 内圈 ${e.inner.length} 点 · ${when} · ${version}`
}
