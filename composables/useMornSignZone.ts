/**
 * 签到区域配置的**本地持久化**（Nuxt 薄壳）：`utils/mp/mornSignZone.ts` 只管纯逻辑。
 *
 * key：`mp_mornsign_zone_v1` → `{ [pointId]: MornSignZone }`
 *
 * 容错（照 `useTrackLibrary` 的既有模式）：
 *   · 解析失败/结构不对 ⇒ 当作空表（**不抛**，否则整个页面白屏）；
 *   · 写入失败（配额/隐私模式）⇒ 返回 false，调用方可提示"只存在内存里"；
 *   · 读取时**逐条归一化**（`normalizeZone`），坏字段被夹到合法区间，不让脏数据影响提交。
 */
import { DEFAULT_MORN_SIGN_ZONE, normalizeZone, type MornSignZone } from '~/utils/mp/mornSignZone'

export const MORNSIGN_ZONE_KEY = 'mp_mornsign_zone_v1'

export type ZoneMap = Record<string, MornSignZone>

export function useMornSignZone() {
  const zones = useState<ZoneMap>('mpMornSignZones', () => ({}))
  const loaded = useState('mpMornSignZonesLoaded', () => false)

  /** 从 localStorage 读（幂等；每次读都会归一化） */
  const load = (): ZoneMap => {
    if (!import.meta.client) return zones.value
    try {
      const raw = localStorage.getItem(MORNSIGN_ZONE_KEY)
      if (!raw) {
        zones.value = {}
        loaded.value = true
        return zones.value
      }
      const parsed = JSON.parse(raw) as unknown
      const out: ZoneMap = {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [pointId, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (!pointId) continue
          out[pointId] = normalizeZone(v as Partial<MornSignZone>)
        }
      }
      zones.value = out
    } catch {
      // 坏数据 ⇒ 空表（并把坏键留着不动，避免"悄悄删用户数据"）
      zones.value = {}
    }
    loaded.value = true
    return zones.value
  }

  /** 写盘；返回是否成功（配额满/隐私模式会失败，但不抛） */
  const persist = (): boolean => {
    if (!import.meta.client) return false
    try {
      localStorage.setItem(MORNSIGN_ZONE_KEY, JSON.stringify(zones.value))
      return true
    } catch {
      return false
    }
  }

  /**
   * 取某点位的配置（没有则给默认值，**不落盘**）。
   *
   * ⚠️ 2026-09-20 审计修复（**静默失效**那类）：原先只有「签到区域编辑」页在 `onMounted` 里调 `load()`，
   * 而**提交路径**（`useMpMorningSign` 的 `submitMornSign`）直接 `get(pointId)` —— 用户刷新后直接进
   * 「早操签到」页提交时，`zones` 还是空的 ⇒ **用户调好的落点分布/进场方向被静默忽略、按默认值提交**。
   * 判据：**取配置的入口必须自己保证"已加载"**（懒加载），不能依赖"某个页面恰好先来过"。
   */
  const get = (pointId: string): MornSignZone => {
    if (import.meta.client && !loaded.value) load()
    return normalizeZone(zones.value[pointId] ?? DEFAULT_MORN_SIGN_ZONE)
  }

  /** 存某点位的配置（归一化后存） */
  const set = (pointId: string, zone: Partial<MornSignZone>): boolean => {
    if (!pointId) return false
    zones.value = { ...zones.value, [pointId]: normalizeZone(zone) }
    return persist()
  }

  /** 恢复某点位为默认（等价于删掉覆盖项；用默认值显式存一份，语义更直白） */
  const resetToDefault = (pointId: string): boolean => set(pointId, DEFAULT_MORN_SIGN_ZONE)

  /** 删掉某点位的配置 */
  const remove = (pointId: string): boolean => {
    const next = { ...zones.value }
    delete next[pointId]
    zones.value = next
    return persist()
  }

  /** 已经自定义过的点位 id 列表（用于界面标"已改过"） */
  const customizedIds = computed(() => Object.keys(zones.value))

  return { zones, loaded, load, get, set, resetToDefault, remove, customizedIds }
}
