/**
 * 本地路线库（Nuxt 薄壳）：只管状态与 localStorage；类型/归一化/摘要在纯模块 `utils/mp/trackLibrary.ts`。
 *
 * 用法：
 *   const lib = useTrackLibrary()
 *   lib.load()                       // 读本机（含旧格式迁移）
 *   lib.upsert({lineId, lineName, outer, inner})   // 新建/覆盖（保留原创建日期）
 *   lib.get(lineId)                  // 取一条
 *   lib.entries.value                // 列表（最新在前）
 */
import type { LatLng } from '~/utils/mp/routeSimilarity'
import {
  TRACK_LIBRARY_KEY,
  TRACK_LIBRARY_KEY_LEGACY,
  normalizeLibrary,
  type TrackRouteEntry,
} from '~/utils/mp/trackLibrary'

export function useTrackLibrary() {
  const { appVersion } = useUpdateCheck()
  const entries = useState<TrackRouteEntry[]>('mpTrackLibrary', () => [])

  /** 从本机读取（含旧格式迁移：旧键里有、而新键里没有的，补进来） */
  const load = () => {
    if (!import.meta.client) return entries.value
    let merged: TrackRouteEntry[] = []
    try {
      merged = normalizeLibrary(JSON.parse(localStorage.getItem(TRACK_LIBRARY_KEY) || 'null'), String(appVersion.value ?? '未知'))
    } catch {
      merged = []
    }
    try {
      const legacyRaw = localStorage.getItem(TRACK_LIBRARY_KEY_LEGACY)
      if (legacyRaw) {
        for (const e of normalizeLibrary(JSON.parse(legacyRaw), '旧版')) {
          if (!merged.some((m) => String(m.lineId) === String(e.lineId))) merged.push(e)
        }
      }
    } catch {
      /* 旧数据坏了就忽略 */
    }
    entries.value = merged
    return merged
  }

  const persist = () => {
    if (!import.meta.client) return
    localStorage.setItem(TRACK_LIBRARY_KEY, JSON.stringify(entries.value))
  }

  /** 新建或覆盖（覆盖时**保留原创建日期**，只更新几何与"本次版本"） */
  const upsert = (input: { lineId: string; lineName: string; outer: LatLng[]; inner: LatLng[]; laneNo?: number; laneCount?: number; note?: string }) => {
    const old = entries.value.find((e) => String(e.lineId) === String(input.lineId))
    const entry: TrackRouteEntry = {
      lineId: input.lineId,
      lineName: input.lineName,
      outer: input.outer,
      inner: input.inner,
      createdAt: old?.createdAt || new Date().toISOString(),
      appVersion: String(appVersion.value ?? '未知'),
      laneCount: input.laneCount ?? old?.laneCount,
      laneNo: input.laneNo ?? old?.laneNo,
      note: input.note ?? old?.note,
    }
    entries.value = [entry, ...entries.value.filter((e) => String(e.lineId) !== String(input.lineId))]
    persist()
    return entry
  }

  const remove = (lineId: string) => {
    entries.value = entries.value.filter((e) => String(e.lineId) !== String(lineId))
    persist()
  }

  const get = (lineId: string | undefined | null) =>
    lineId ? entries.value.find((e) => String(e.lineId) === String(lineId)) : undefined

  return { entries, load, persist, upsert, remove, get, appVersion }
}
