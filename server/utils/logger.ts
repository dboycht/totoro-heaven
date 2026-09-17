/**
 * 服务端文件日志（按天轮转，只写本机 runtime 目录，绝不进仓库）
 *
 * - 位置：`%TEMP%\totoro-heaven-runtime\logs\app-YYYY-MM-DD.log`（可用 `TOTORO_LOG_DIR` 覆盖，便于测试）
 * - 每条**一行 JSON**（`data` 走 `redactObject` 按字段名脱敏，`msg` 走 `maskTokenLike` 掩掉形似 token 的片段）
 * - 启动时清一次过期文件（保留 7 天 / 总量上限 20MB）
 * - 记录是尽力而为：**绝不让日志错误影响业务**（全部 try/catch）
 *
 * ⚠️ 2026-09-17 加固（健壮化 A 轮）：原先**只对 `data` 脱敏，`msg` 原样落盘** ——
 *    只要有人把 token 拼进消息文本（`logInfo('x', 'token=' + t)`），硬规则「token 绝不落盘」就被绕过。
 *    现在 `msg` 也过 `maskTokenLike`，并有单测 `tests/mp/logger.test.ts` 读**文件内容**做端到端断言。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogEntry, LogLevel } from '../../utils/mp/logFormat'
import { maskTokenLike, redactObject } from '../../utils/mp/logFormat'

export const LOG_DIR = process.env.TOTORO_LOG_DIR?.trim() || join(tmpdir(), 'totoro-heaven-runtime', 'logs')
const KEEP_DAYS = 7
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

const pad = (n: number) => String(n).padStart(2, '0')
const dateTag = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function logFilePath(d = new Date()): string {
  return join(LOG_DIR, `app-${dateTag(d)}.log`)
}

/** 追加一条日志（自动脱敏 data 与 msg、自动建目录、吞掉一切异常） */
export function logEvent(level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void {
  try {
    // ⚠️ `msg` 也必须过掩码：否则把 token 拼进消息文本就绕过「绝不落盘」的硬规则
    const entry: LogEntry = { t: new Date().toISOString(), level, cat, msg: maskTokenLike(msg), data: redactObject(data) }
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(logFilePath(), JSON.stringify(entry) + '\n', 'utf8')
    // dev 下也镜像到控制台（缩略显示；用**已脱敏**的 entry.msg，不打印原始 msg）
    if (process.env.NODE_ENV !== 'production') {
      const d = entry.data && Object.keys(entry.data).length ? ` ${JSON.stringify(entry.data)}` : ''
      // eslint-disable-next-line no-console
      console.log(`[${entry.level.toUpperCase()}] [${cat}] ${entry.msg}${d}`)
    }
  } catch {
    /* 日志失败不影响业务 */
  }
}

export const logInfo = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('info', cat, msg, data)
export const logWarn = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('warn', cat, msg, data)
export const logError = (cat: string, msg: string, data?: Record<string, unknown>) => logEvent('error', cat, msg, data)

/** 读今天的日志尾部（行文本，供界面展示） */
export function tailLog(lines = 200): { lines: string[]; dir: string; totalBytes: number } {
  try {
    const p = logFilePath()
    if (!existsSync(p)) return { lines: ['（今天还没有服务端日志）'], dir: LOG_DIR, totalBytes: 0 }
    const text = readFileSafe(p)
    const all = text.split('\n').filter(Boolean)
    return { lines: all.slice(Math.max(0, all.length - lines)), dir: LOG_DIR, totalBytes: Buffer.byteLength(text) }
  } catch {
    return { lines: ['（读取日志失败）'], dir: LOG_DIR, totalBytes: 0 }
  }
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 清理模式：`today` 只删今天的日志文件；`all` 删全部日志文件 */
export type ClearLogMode = 'today' | 'all'

/**
 * 手动清理日志（界面「清空今日 / 清空全部」用）。
 * - 只动 `app-*.log`，不动目录里其它文件；
 * - 返回删了哪些、释放了多少字节；**清理动作本身会被记进新日志**（便于追溯）。
 */
export function clearLogs(mode: ClearLogMode = 'today'): { deleted: string[]; dir: string; freedBytes: number } {
  const deleted: string[] = []
  let freedBytes = 0
  try {
    if (!existsSync(LOG_DIR)) return { deleted, dir: LOG_DIR, freedBytes }
    const today = `app-${dateTag(new Date())}.log`
    for (const f of readdirSync(LOG_DIR)) {
      if (!f.startsWith('app-') || !f.endsWith('.log')) continue
      if (mode === 'today' && f !== today) continue
      const p = join(LOG_DIR, f)
      try {
        freedBytes += statSync(p).size
        unlinkSync(p)
        deleted.push(f)
      } catch {
        /* 单个文件删不掉就跳过（可能被占用） */
      }
    }
  } catch {
    /* 忽略 */
  }
  return { deleted, dir: LOG_DIR, freedBytes }
}

/** 清一天前的日志（保留 7 天 / 上限 20MB）——自动策略的入口，见文件头 */
export function rotateOldLogs(): void {
  try {
    if (!existsSync(LOG_DIR)) return
    const files = readdirSync(LOG_DIR).filter((f) => f.startsWith('app-') && f.endsWith('.log'))
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
    let total = 0
    const meta = files
      .map((f) => {
        const p = join(LOG_DIR, f)
        const st = statSync(p)
        return { p, name: f, mtime: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => a.mtime - b.mtime)
    for (const m of meta) {
      if (m.mtime < cutoff) {
        unlinkSync(m.p)
        continue
      }
      total += m.size
    }
    // 总量超限：从最旧的开始删
    for (const m of meta) {
      if (total <= MAX_TOTAL_BYTES) break
      try {
        unlinkSync(m.p)
        total -= m.size
      } catch {
        break
      }
    }
  } catch {
    /* 忽略 */
  }
}

export function logDirInfo(): { dir: string; files: { name: string; bytes: number; mtime: string }[]; totalBytes: number } {
  try {
    if (!existsSync(LOG_DIR)) return { dir: LOG_DIR, files: [], totalBytes: 0 }
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('app-') && f.endsWith('.log'))
      .map((f) => {
        const st = statSync(join(LOG_DIR, f))
        return { name: f, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() }
      })
      .sort((a, b) => b.name.localeCompare(a.name))
    return { dir: LOG_DIR, files, totalBytes: files.reduce((s, f) => s + f.bytes, 0) }
  } catch {
    return { dir: LOG_DIR, files: [], totalBytes: 0 }
  }
}

/** 提交类端点允许记录的字段（数值/标识，**不含 token 与轨迹内容**） */
const METRIC_FIELDS = [
  'scantronId', 'taskId', 'runType', 'km', 'usedTime', 'fitDegree', 'avgSpeed', 'steps',
  'startTime', 'endTime', 'evaluateDate', 'lineId',
] as const

/**
 * 代理请求体的**可记录摘要**：只记字段名 + 少量白名单数值；
 * 轨迹点列这类大数组只记**长度**（不记内容）。解析失败只记字节数。
 */
export function summarizeRequestBody(suffix: string, rawBody: string | undefined): Record<string, unknown> | undefined {
  if (rawBody === undefined) return undefined
  const out: Record<string, unknown> = { bytes: Buffer.byteLength(rawBody) }
  try {
    const obj = JSON.parse(rawBody) as Record<string, unknown>
    if (!obj || typeof obj !== 'object') return out
    out.keys = Object.keys(obj).sort()
    for (const k of METRIC_FIELDS) if (obj[k] !== undefined) out[k] = obj[k]
    for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) out[`${k}Count`] = v.length
    if (suffix.includes('sunRunExercisesDetail')) {
      // 明细里有 base64 人脸等大字段，这里只保留长度（上面已统计）
      out.kind = 'detail'
    }
    return out
  } catch {
    return out
  }
}

// 启动即清理一次旧日志
try {
  rotateOldLogs()
} catch {
  /* 忽略 */
}
