/**
 * 前端「事件日志」：记录界面上每一步做了什么，方便事后查（用户 2026-09-15 要求）
 *
 * - 单例 ref（SPA 无 SSR，避免 useState 在事件回调里取不到 Nuxt 实例的问题）
 * - 环形缓冲（最近 `LOG_RING_MAX` 条）+ localStorage 持久化（刷新不丢）
 * - **所有 data 先过 redactObject 脱敏**：token/学号/姓名永不进日志
 *
 * 用法：
 *   import { logEvent } from '~/composables/useEventLog'
 *   logEvent('info', 'submit', '开跑成功', { scantronId, km })
 */
import { LOG_RING_MAX, countByLevel, entriesToText, pushRing, redactObject } from '~/utils/mp/logFormat'
import type { LogEntry, LogLevel } from '~/utils/mp/logFormat'

const STORAGE_KEY = 'totoro_event_logs_v1'

/** 单例：整个 App 共用一份 */
const entries = ref<LogEntry[]>([])
let loaded = false

function persist(): void {
  if (!import.meta.client) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.value))
  } catch {
    /* 配额/隐私模式：忽略 */
  }
}

function loadOnce(): void {
  if (!import.meta.client || loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const arr = JSON.parse(raw) as LogEntry[]
    if (Array.isArray(arr)) entries.value = arr.slice(-LOG_RING_MAX)
  } catch {
    /* 损坏的日志直接忽略 */
  }
}

export function useEventLog() {
  loadOnce()

  const log = (level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void => {
    const entry: LogEntry = { t: new Date().toISOString(), level, cat, msg, data: redactObject(data) }
    entries.value = pushRing(entries.value, entry)
    persist()
  }

  const clear = (): void => {
    entries.value = []
    persist()
  }

  return {
    entries,
    log,
    clear,
    counts: computed(() => countByLevel(entries.value)),
    asText: (onlyFiltered?: LogEntry[]) => entriesToText(onlyFiltered ?? entries.value),
  }
}

/** 便捷函数：任何地方都能直接记一条（自动脱敏） */
export function logEvent(level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void {
  useEventLog().log(level, cat, msg, data)
}

export const logInfo = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('info', cat, msg, data)
export const logWarn = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('warn', cat, msg, data)
export const logError = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('error', cat, msg, data)
