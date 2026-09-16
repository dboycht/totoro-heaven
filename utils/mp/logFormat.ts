/**
 * 日志的**纯逻辑**（零依赖、可单测、前端与服务端共用）
 *
 * 设计要点：
 *   - **脱敏是硬约束**：token / Authorization / 学号 / 姓名 一律不进日志（只留长度或掩码）；
 *   - 每条日志统一结构 `{t, level, cat, msg, data}`，落盘为**一行 JSON**、导出为**一行文本**；
 *   - 环形缓冲（前端保留最近 `LOG_RING_MAX` 条）。
 *
 * 为什么脱敏放在这一层：无论是文件日志还是界面日志，都必须先过这里，
 * 避免"某个调用点忘了脱敏"就漏出去（见 ERROR.md 的纪律：token 不落盘、不打印）。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /** ISO 时间戳 */
  t: string
  level: LogLevel
  /** 类别：proxy / token / real / gate / run / submit / ui …（便于过滤） */
  cat: string
  msg: string
  /** 附加字段（**必须已经脱敏**；本模块的 redact* 负责） */
  data?: Record<string, unknown>
}

/** 前端环形缓冲上限 */
export const LOG_RING_MAX = 500

/** 与 token 形态匹配：WXXCX + base64，长度 ≥40（真实 101） */
const TOKEN_LIKE = /WXXCX[A-Za-z0-9+/=]{35,}/g

/** 需要整体掩码的字段名（大小写不敏感） */
const SENSITIVE_KEYS =
  /^(token|authorization|auth|sncode|stunumber|studentname|stuname|realname|name|idcard|idnumber|phone|phonenumber|mobile|openid|unionid|sessionkey|cookie)$/i

/** 把字符串里形似 token 的片段替换为 `[token len=101]` */
export function maskTokenLike(text: string): string {
  return String(text).replace(TOKEN_LIKE, (m) => `[token len=${m.length}]`)
}

/** 掩码一个敏感值：只保留长度（数字/布尔等短值直接原样，避免把 `0` 也掩掉） */
export function maskSensitive(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return `[masked len=${s?.length ?? 0}]`
}

/** 递归脱敏：按字段名掩码 + 把任何形似 token 的字符串片段掩掉 */
export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]'
  if (SENSITIVE_KEYS.test(key)) return maskSensitive(value)
  if (typeof value === 'string') return maskTokenLike(value)
  if (Array.isArray(value)) {
    // 数组里的元素若形似 token 也要掩（例如扫描器回传的候选列表）
    return value.slice(0, 20).map((v) => (typeof v === 'string' ? maskTokenLike(v) : redactValue(key, v, depth + 1)))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(k, v, depth + 1)
    return out
  }
  return value
}

/** 脱敏一个对象（用于 data 字段） */
export function redactObject(input: Record<string, unknown> | undefined | null): Record<string, unknown> | undefined {
  if (!input) return undefined
  return redactValue('', input) as Record<string, unknown>
}

/** 截断过长文本（避免一条日志几 MB） */
export function truncate(text: string, max = 2000): string {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…[截断，共 ${s.length} 字符]`
}

/** 从上游响应里取状态摘要（用于代理日志） */
export function summarizeUpstream(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') return { kind: typeof json }
  const r = json as Record<string, unknown>
  const header = (r.header ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['status', 'code', 'msg', 'message', 'total']) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '') out[k] = r[k]
  }
  if (header.bizCode !== undefined) out.bizCode = header.bizCode
  return out
}

/** 追加到环形缓冲（返回新数组；超出上限丢最旧的） */
export function pushRing<T>(arr: readonly T[], item: T, max = LOG_RING_MAX): T[] {
  const next = [...arr, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/** 一行文本（导出/文件用） */
export function formatEntryLine(e: LogEntry): string {
  const data = e.data && Object.keys(e.data).length ? ` ${JSON.stringify(e.data)}` : ''
  return `${e.t} [${e.level.toUpperCase().padEnd(5)}] [${e.cat}] ${e.msg}${data}`
}

/** 导出为可复制的多行文本（最新的在后；空日志给提示） */
export function entriesToText(entries: readonly LogEntry[]): string {
  if (!entries.length) return '（暂无日志）'
  return entries.map(formatEntryLine).join('\n')
}

/** 统计各等级条数（界面徽标用） */
export function countByLevel(entries: readonly LogEntry[]): Record<LogLevel, number> {
  const out: Record<LogLevel, number> = { info: 0, warn: 0, error: 0 }
  for (const e of entries) out[e.level] = (out[e.level] ?? 0) + 1
  return out
}
