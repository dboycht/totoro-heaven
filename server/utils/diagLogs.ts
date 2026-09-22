/**
 * 「一键诊断导出」的**服务端日志读取**（只读）—— 2026-09-21 新增
 *
 * ## 口径单一来源（重要）
 * 日志目录**不在这里算**：一律用 `server/utils/logger.ts` 的 `LOG_DIR`
 * 与 `logDateTag()` / `logFilePath()`（`TOTORO_LOG_DIR` 覆盖、`%TEMP%\totoro-heaven-runtime\logs`、
 * `app-YYYY-MM-DD.log` 命名 —— 全仓只有那一份实现）。
 * 本模块只做三件事：**挑**最近 N 天的文件、**有上限地读**、报告是否截断。
 *
 * ⚠️ 为什么不用"扫目录 + 正则解析文件名"？因为那等于把命名口径**再抄一遍**：
 * 一旦 logger 换了命名（例如改成 `app-2026-09-21.log.gz`），抄的那份会**静默取不到**，
 * 导出包看着正常却一条日志都没有 —— 这类"静默降级"最难查。改为**按日期反推确切文件名**
 * （`LOG_DIR/app-<logDateTag(d)>.log`），只在文件真存在时才收 ⇒ 命名变了就是"没有日志"，测试里能立刻看出。
 *
 * ## 取舍：超上限时截**头部**（前 `maxBytes` 字节），不是尾部
 * 理由是**可读性优先**：JSON 行是顺序追加的，截头部会切在一行中间（那行 `JSON.parse` 失败，
 * 读日志的人本来就跳过），而截尾部会把"这一天里**最早**发生的事"整段丢掉 ——
 * 排障时往往正是那一段说明了"第一次异常出现在哪"。截断与否、原始多大，manifest 里都写清楚。
 *
 * ⚠️ 目录不存在、文件读不了、目录里没有日志 —— 都返回**空数组**而不是抛错：
 * "没有日志"是合法情况（用户刚装好、或刚清空过），不该让整个导出失败。
 * 空 catch 一律写了理由（`scripts/check-wiring.mjs` 的 R8 会查）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DIAG_LOG_DAYS, DIAG_LOG_MAX_BYTES, assertNoCredentials } from '../../utils/mp/diagnostics'
import { LOG_DIR, logDateTag } from './logger'

/**
 * 🔴 **红线分流**（2026-09-21，父代理定）：把"命中凭证样式"的日志**剔除出包**，其余照出。
 *
 * 为什么不是"整包拒绝"：用户原话是"能带什么就带什么"，而这个包的核心价值是快照（任务原始 JSON /
 * 路线库 / 门禁依据）；只要最近 3 天日志里出现过**一处**形似凭证的串就什么都导不出去，等于把功能废掉。
 * 剔除同样满足红线（**不泄漏**），并在清单里如实写明"少了哪个文件、为什么"。
 * ⚠️ 若命中出现在**快照/清单**里（本程序自己生成的），仍是**硬拒** —— 那是客户端的脱敏 bug，必须暴露。
 */
export function partitionLogsByRedline<T extends { name: string; text: string }>(
  logs: T[],
): { safe: T[]; excluded: T[]; reasons: Record<string, string[]> } {
  const safe: T[] = []
  const excluded: T[] = []
  const reasons: Record<string, string[]> = {}
  for (const f of logs) {
    const r = assertNoCredentials([f.text])
    if (r.ok) {
      safe.push(f)
    } else {
      excluded.push(f)
      reasons[f.name] = r.hits
    }
  }
  return { safe, excluded, reasons }
}

/** 一条"已读取"的日志（内容已按上限截断） */
export interface DiagLogFile {
  /** 文件名（不含目录），如 `app-2026-09-21.log` */
  name: string
  /** 文件**完整**字节数（截断前；用于 manifest 里说明"原始多大"） */
  bytes: number
  /** 文本内容（已按 `maxBytes` 截断；**上面那个 bytes 才是原始大小**） */
  text: string
  /** 是否因超过上限被截断 */
  truncated: boolean
}

/**
 * 🆕 2026-09-22（审计 B1）：**按"最终真的进包的那些文件"重算 manifest 的账**。
 *
 * 故障（审计定位）：原先 kept/dropped 在**全部** scoped 文件上聚合，而"命中凭证样式被剔除"
 * 发生在**聚合之后** ⇒ manifest 写着"保留 12 行"，包里其实少了那个文件的若干行；
 * `logFiles` / `logBytes` / `logFilesTruncated` 同样把被剔文件算了进去。
 * 维护者据此判断"日志齐不齐"会被带偏（诊断包最忌讳的就是：**账与内容不自洽**）。
 *
 * ⚠️ 2026-09-22 终检审计补充（B3）：**"原始字节数"与"包内字节数"必须分开写**。
 * `.log` 进包时只保留**窗口内的行**（常常只有几行），而 `bytes` 记的是文件**截断前**的真实大小 ⇒
 * 顶层只有一个 `logBytes` 时，维护者看到"170 KB"会以为包里真有 170 KB 日志（其实包里可能只有 1 行）。
 * 现在三件套齐全：`readBytes`（候选文件读了多少）/ `inPackageBytes`（进包文本的真实字节）/
 * `originalBytes`（进包文件截断前的原始大小，仍保留，用来说明"截断有没有发生"）。
 *
 * 判据（可执行）：返回的每个数字都**只统计 `safeNames` 里的文件**；被剔的那部分单独放 `excluded`。
 * 纯函数（无 IO），有单测 `tests/mp/diagLogs.test.ts`。
 */
export interface DiagLineAccountFile {
  name: string
  bytes: number
  truncated: boolean
  scope: DiagLogWindowResult
}
export interface DiagLineAccount {
  /** 真正进包的文件数 */
  files: number
  /** 真正进包文本的**字节数**（窗口过滤 + 字节截断之后的 `scope.text`，= 包内实际大小） */
  inPackageBytes: number
  /** 进包文件在**截断前**的原始大小之和（≥ `inPackageBytes`；差值即"被窗口过滤/被截断丢掉的部分"） */
  originalBytes: number
  /** 真正进包文件里**保留下来**的日志行数 */
  keptLines: number
  /** 窗口外被剔除的行数（只统计进包文件） */
  droppedLines: number
  /** 时间戳解析不出来的行数（只统计进包文件） */
  unparsableLines: number
  /** 因超过单文件上限被截断的文件数（只统计进包文件） */
  truncatedFiles: number
  /** 被红线剔除的文件数，以及它们"本来会贡献多少行"（单列，便于对照） */
  excluded: { files: number; lines: number }
}
export function summarizeDiagLineAccount(all: DiagLineAccountFile[], safeNames: string[]): DiagLineAccount {
  const safe = new Set(safeNames)
  const inPack = all.filter((f) => safe.has(f.name))
  const outPack = all.filter((f) => !safe.has(f.name))
  return {
    files: inPack.length,
    inPackageBytes: inPack.reduce((s, f) => s + Buffer.byteLength(f.scope.text, 'utf8'), 0),
    originalBytes: inPack.reduce((s, f) => s + f.bytes, 0),
    keptLines: inPack.reduce((s, f) => s + f.scope.kept, 0),
    droppedLines: inPack.reduce((s, f) => s + f.scope.outOfWindow, 0),
    unparsableLines: inPack.reduce((s, f) => s + f.scope.unparsable, 0),
    truncatedFiles: inPack.filter((f) => f.truncated).length,
    excluded: { files: outPack.length, lines: outPack.reduce((s, f) => s + f.scope.kept, 0) },
  }
}

/** 一条日志行的时间戳字段名（`logger.ts` 的 `LogEntry.t`；**全仓只有这一处**写它） */
const LOG_TIME_KEY = 't'

/** 「按记录窗口筛日志行」的结果（计数进 manifest，便于说明"为什么只剩这么几行"） */
export interface DiagLogWindowResult {
  /** 保留下来的行（**原样**拼回，未重新序列化 —— 免得改动用户日志的原貌） */
  text: string
  /** 输入非空行数 */
  total: number
  /** 时间戳落在窗口内的行数（= 结果里的行数） */
  kept: number
  /** 时间戳**明确在窗口外**的行数 */
  outOfWindow: number
  /** 解析不出时间戳的行数（JSON 坏 / 没有 `t` / `t` 不是时间）—— 无法证明它在窗口内，故剔除并单列 */
  unparsable: number
}

/** 从日志行里取时间戳（epoch ms）；支持 ISO 字符串与数字两种写法，取不到返回 null */
function lineTimeMs(line: string): number | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null // 单行坏掉（半截写入/被截断切在中间）：**只跳这一行**，绝不让整包失败
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const t = (obj as Record<string, unknown>)[LOG_TIME_KEY]
  if (typeof t === 'number') return Number.isFinite(t) ? t : null
  if (typeof t === 'string') {
    const n = Date.parse(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 🔴 **按记录窗口过滤日志行**（纯函数，可离线单测）—— 2026-09-22 新增。
 *
 * 用户在界面上选的是"这一次记录"，那包里就**只该有这一段**的服务端日志：
 * 日志是 JSONL（一天一个文件、顺序追加），每行的 `t` 是**服务端自己写的 ISO 时间戳**，
 * 与窗口的 `startedAtMs / endedAtMs`（同样服务端时钟）同源 ⇒ 直接按毫秒比即可，没有时区/跨机器问题。
 *
 * 三条纪律：
 * 1. **逐行解析，坏行只跳这一行**（`unparsable` 计数），绝不让一行坏 JSON 把整个导出搞失败；
 * 2. 窗口生效时，**解析不出时间的行一律剔除**（无法证明它在窗口内）；不生效时（`window=null`）原样返回；
 * 3. 保留的行**原样拼回**（不重新 `JSON.stringify`）—— 导出包里的日志应当与磁盘上一字不差。
 *
 * @param text   日志文件文本（可能已被 `recentLogFiles()` 按字节上限截断过）
 * @param window 记录窗口（`null` = 不按窗口过滤，退回"最近 N 天全量"）
 */
export function diagLogsLinesInWindow(
  text: string,
  window: { startedAtMs: number; endedAtMs: number } | null,
): DiagLogWindowResult {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim() !== '')
  if (!window) return { text: lines.join('\n'), total: lines.length, kept: lines.length, outOfWindow: 0, unparsable: 0 }
  const end = window.endedAtMs > 0 ? window.endedAtMs : Number.POSITIVE_INFINITY
  const kept: string[] = []
  let outOfWindow = 0
  let unparsable = 0
  for (const line of lines) {
    const t = lineTimeMs(line)
    if (t === null) {
      unparsable++
      continue
    }
    if (t < window.startedAtMs || t > end) {
      outOfWindow++
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), total: lines.length, kept: kept.length, outOfWindow, unparsable }
}

/** `YYYY-MM-DD`（只认这一种；`logDateTag()` 的输出就是它） */
const DATE_TAG_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 取出"最近 `days` 天里**存在**的日志文件"，按**日期升序**（最旧在前，便于人读时间线）。
 *
 * @param days     向前数几天（含今天），默认 `DIAG_LOG_DAYS`
 * @param maxBytes 每个文件的读取上限（超出即截断），默认 `DIAG_LOG_MAX_BYTES`
 * @param dir      日志目录（默认 = logger 的 `LOG_DIR`；**只给单测注入临时目录用**，生产不传）
 * @param now       "今天"（默认当前时间；只给单测固定日期用）
 */
export function recentLogFiles(
  days: number = DIAG_LOG_DAYS,
  maxBytes: number = DIAG_LOG_MAX_BYTES,
  dir: string = LOG_DIR,
  now: Date = new Date(),
): DiagLogFile[] {
  const out: DiagLogFile[] = []
  const span = Math.max(0, Math.floor(days))
  if (!span || !Number.isFinite(maxBytes) || maxBytes <= 0) return out
  try {
    // 目录清单只在"判断有没有这个文件"时用一次；文件名由 logDateTag 反推（口径单一来源）
    const present = new Set(readdirSync(dir))
    for (let back = span - 1; back >= 0; back--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
      const tag = logDateTag(d)
      if (!DATE_TAG_RE.test(tag)) continue // 防呆：logger 的日期口径变了就在这里显式跳过，而不是拼出别的文件名
      const name = `app-${tag}.log`
      if (!present.has(name)) continue
      const p = join(dir, name)
      if (!existsSync(p)) continue
      const raw = readFileSync(p)
      const truncated = raw.byteLength > maxBytes
      /**
       * 截断时按**字节**切，再按 UTF-8 解回字符串：末尾若正好切在多字节字符中间，
       * `toString('utf8')` 会把它变成 U+FFFD（而不是让包里的文本成为非法 UTF-8 ——
       * 有些文本编辑器/JSON 解析器看到非法序列会整段显示不出来）。
       */
      const text = truncated ? raw.subarray(0, maxBytes).toString('utf8') : raw.toString('utf8')
      out.push({ name, bytes: raw.byteLength, text, truncated })
    }
  } catch {
    // 目录不存在（还没写过日志）或权限异常 ⇒ 视作"没有日志"：导出照样要能用
  }
  return out
}
