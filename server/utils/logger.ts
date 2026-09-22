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

/**
 * 运行目录（`%TEMP%\totoro-heaven-runtime`）—— **本机运行时数据的总根**。
 *
 * ⚠️ 2026-09-22 新增导出（口径单一来源）：记录窗口要落在"与日志同级"的地方
 * （`server/utils/diagSession.ts` 用 `RUNTIME_DIR/diagnostics/session.json`），
 * 如果那边自己再拼一次 `tmpdir()/totoro-heaven-runtime`，一旦这里换了目录口径就会**静默分叉**
 * （日志写在这儿、窗口写在那儿，导出时读不到窗口，表现为"刷新又丢了"）。
 * 所以运行目录只有这一份实现，日志目录由它派生。
 */
export const RUNTIME_DIR = join(tmpdir(), 'totoro-heaven-runtime')
export const LOG_DIR = process.env.TOTORO_LOG_DIR?.trim() || join(RUNTIME_DIR, 'logs')
const KEEP_DAYS = 7
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

const pad = (n: number) => String(n).padStart(2, '0')
const dateTag = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * 日志文件的**日期标签**（`YYYY-MM-DD`，本地时间）。
 *
 * ⚠️ 2026-09-21 起**导出**给「一键诊断导出」用（`server/utils/diagLogs.ts`）：
 * 它要按日期反推"最近 N 天该有哪些文件"，如果自己再写一份 `YYYY-MM-DD` 拼法，
 * 一旦这里换了命名口径就会**静默取不到日志**（导出包看起来正常、但没有日志）。
 * 导出它只新增可见性，**不改任何现有行为**（`dateTag` 本体与 `logFilePath()` 一字未动）。
 */
export const logDateTag = dateTag

/** 日志保留天数（自动清理与「诊断导出」的"最近几天"口径必须一致） */
export const LOG_KEEP_DAYS = KEEP_DAYS

export function logFilePath(d = new Date()): string {
  return join(LOG_DIR, `app-${dateTag(d)}.log`)
}

/**
 * 轮转节流的**上次运行时刻**（2026-09-22 审计 B9）：老实现只在**进程启动时**跑一次 `rotateOldLogs()`，
 * 于是一个常驻几天的进程里日志会一直涨；而"下次启动"时那份**当天日志**又会被容量回收整份删掉
 * ⇒ **用户刚复现的最新证据消失**。现在改成"每次写日志前按小时跑一次"，并且**当天文件永不回收**。
 */
let lastRotateAt = 0
const ROTATE_INTERVAL_MS = 60 * 60 * 1000

/** 追加一条日志（自动脱敏 data 与 msg、自动建目录、吞掉一切异常） */
export function logEvent(level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void {
  try {
    // ⚠️ `msg` 也必须过掩码：否则把 token 拼进消息文本就绕过「绝不落盘」的硬规则
    const entry: LogEntry = { t: new Date().toISOString(), level, cat, msg: maskTokenLike(msg), data: redactObject(data) }
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(logFilePath(), JSON.stringify(entry) + '\n', 'utf8')
    /**
     * 🆕 按小时节流地跑一次轮转（审计 B9）：放在**写之后**，这样"这一条已经落盘"，
     * 即使轮转删文件也不会把刚写的这条删掉（当天文件本来也受保护）。
     * 失败一律吞掉（轮转是尽力而为，绝不能影响业务日志写入）。
     */
    const now = Date.now()
    if (now - lastRotateAt >= ROTATE_INTERVAL_MS) {
      lastRotateAt = now
      try {
        rotateOldLogs()
      } catch {
        /* 轮转失败不影响日志写入本身 */
      }
    }
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

/**
 * 🆕 2026-09-22（闸门复验第二轮）：写一条**已经渲染好**的日志行（整行 JSON 文本）。
 *
 * 为什么需要：代理的响应记录要按**整行字节**收敛（`convergeLogLine()`），而"整行"必须包含
 * `{t,level,cat,msg}` 这层包装与时间戳 —— 只有调用方知道最终要写的文本，也只有它能**收敛后复检**。
 * 老做法是"调用方收敛 → logger 再包一层 stringify"，等于**量错了对象**（复验实测最坏行 44,203 B）。
 *
 * 约定：`lineJson` 必须是**单行 JSON**（调用方已脱敏 + 已收敛）。目录、轮转、失败吞掉等行为与本文件一致。
 */
export function logRawLine(level: LogLevel, cat: string, lineJson: string): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(logFilePath(), `${lineJson}\n`, 'utf8')
    const now = Date.now()
    if (now - lastRotateAt >= ROTATE_INTERVAL_MS) {
      lastRotateAt = now
      try {
        rotateOldLogs()
      } catch {
        /* 轮转失败不影响日志写入本身 */
      }
    }
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(`[${level.toUpperCase()}] [${cat}] ${lineJson.slice(0, 400)}`)
    }
  } catch {
    /* 日志失败不影响业务 */
  }
}

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

/**
 * 清一天前的日志（保留 7 天 / 上限 20MB）——自动策略的入口，见文件头。
 *
 * 🆕 2026-09-22 审计 B9 两条加固：
 *   ① **当天文件永不回收**（`app-<今天>.log` 受保护）：它是"用户刚复现的那一段"，
 *      被容量回收整份删掉 = 证据消失（实测就是这么发生的：单日超 20MB，下次启动被整份删）。
 *      超期清理与容量回收**都跳过**当天文件（宁可让总量暂时超过 20MB，也不丢当天的证据）。
 *   ② 调用时机从"只在进程启动"改成"每次写日志前按小时节流"（见 `logEvent`）。
 *
 * @param now 可注入（单测用固定日期）
 */
export function rotateOldLogs(now: Date = new Date()): void {
  try {
    if (!existsSync(LOG_DIR)) return
    /** 🔒 当天文件（受保护，绝不因为"超期"或"超量"被删） */
    const todayName = `app-${dateTag(now)}.log`
    const files = readdirSync(LOG_DIR).filter((f) => f.startsWith('app-') && f.endsWith('.log'))
    const cutoff = now.getTime() - KEEP_DAYS * 24 * 3600 * 1000
    /**
     * ⚠️ 2026-09-19 审计 M6：上一段已按"超期"删掉一批文件，但 `meta` 是**同一份快照**
     * （里面还留着那些已被删掉的文件）。原来第二段对"已删文件"再 `unlinkSync` 会抛 **ENOENT**，
     * 而 `catch { break }` 会**直接跳出整个容量回收循环** ⇒ 只要本次删过超期文件，
     * **20MB 上限就完全不生效**（日志会一直涨下去）。
     * 修法：跳过"已被删掉"的条目（用 `deleted` 集合标记），并且**失败时 `continue` 而不是 `break`**
     * ——单个文件删不掉不该让整轮回收停摆。
     */
    const deleted = new Set<string>()
    let total = 0
    const meta = files
      .map((f) => {
        const p = join(LOG_DIR, f)
        const st = statSync(p)
        return { p, name: f, mtime: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => a.mtime - b.mtime)
    for (const m of meta) {
      if (m.name === todayName) {
        total += m.size // 当天文件照常计入总量，但不参与任何删除
        continue
      }
      if (m.mtime < cutoff) {
        try {
          unlinkSync(m.p)
          deleted.add(m.p)
        } catch {
          /* 删不掉就留着（下一段会把它计入总量） */
        }
        continue
      }
      total += m.size
    }
    // 总量超限：从最旧的开始删（跳过已删的与**当天文件**）
    for (const m of meta) {
      if (total <= MAX_TOTAL_BYTES) break
      if (deleted.has(m.p) || m.name === todayName) continue
      try {
        unlinkSync(m.p)
        deleted.add(m.p)
        total -= m.size
      } catch {
        continue // ⚠️ 不能 break：一个删不掉不该让整轮回收停摆（审计 M6）
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
