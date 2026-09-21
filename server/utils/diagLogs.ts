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
