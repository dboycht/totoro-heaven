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
 *
 * ⚠️ 2026-09-22：`knownValuePairs()` 用的 `maskId` / `maskPhone` 来自 `./diagnostics`
 * （那里是"学号/姓名/手机怎么打码"的唯一来源）。这两个模块因此**互相引用**：
 *   · `logFormat` → `diagnostics`（取掩码函数）；
 *   · `diagnostics` → `logFormat`（取 `assertNoCredentials` 用的正则思路与类型无关，仅 import 一次）。
 * ESM 下只要**不在模块顶层互相调用**就没有副作用（两边都只在函数体里用），实测 `test:mp` 全绿。
 * 为什么宁可留这个环：把掩码口径各写一份，就会出现"诊断包里是 `张*`、日志里是 `***`"的不一致，
 * 而那正是本轮被反复咬的地方（口径必须单一来源）。
 */
import { maskDigitRuns, maskId, maskName, maskPhone } from './diagnostics'

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

/**
 * 「**这个对象已经脱敏过了**」的标记（非枚举 Symbol，不进 JSON、不改变 deepEqual）。
 *
 * 用途（2026-09-22 审计 B2）：`server/utils/logger.ts` 的 `redactObject()` 会把整行 data 再脱敏一遍，
 * 而它的深度是**从日志行根**起算的 ⇒ `respBody`（响应根）在它下面只剩 ~6 层，`depth≥6` 的值
 * 会被塌成 `[deep]`，与 `respBody.bytes/truncated` 声称的"完整"矛盾（"全记录"名不副实）。
 * 「全记录」在产物上打这个标记，logger 见到就**不再二次降深度**（仍然走值级替换，双保险不变）。
 */
export const REDACTED_MARK: unique symbol = Symbol.for('totoro.redacted')

/** 打标记（返回原对象；非枚举，所以 JSON.stringify 看不到、单测 deepEqual 也不受影响） */
export function markRedacted<T>(value: T): T {
  if (value && typeof value === 'object') {
    try {
      Object.defineProperty(value, REDACTED_MARK, { value: true, enumerable: false, configurable: true })
    } catch {
      // 冻结对象等极端情况：标记失败不影响脱敏本身（只是会多走一次深度限制）
    }
  }
  return value
}

/**
 * 凭证形态与掩码函数**唯一来源**在 `./credentialScan`（2026-09-22 审计 B6 收口）：
 * 落盘掩码（本文件）与导出红线（`./diagnostics`）必须用同一份判据，否则会出现
 * "掩码认了、红线不认（凭证进包）"或"红线认了、掩码不认（文件被误剔）"。
 * 这里**再导出** `maskTokenLike`，保持既有调用方（`composables/**`、`server/**`、单测）零改动。
 */
export { CREDENTIAL_PATTERNS, maskTokenLike } from './credentialScan'
import { maskTokenLike as maskTokenLikeImpl } from './credentialScan'

/**
 * 需要整体掩码的字段名 —— **子串判定**（2026-09-22 审计 B6）。
 *
 * 老口径是"整名精确匹配"，实测漏掉 `accessToken` / `refreshToken` / `X-Auth-Token` / `tokenValue` /
 * `appToken`（以及任何带前缀的变体）。现在只要**名字里含** token/auth/secret/sessionkey/ticket/身份字段就掩。
 *
 * ⚠️ 两处**必须排除**（实测踩到，别再加回来）：
 *   · `fingerprint`：本程序自己的 `tokenFingerprint` 是"长度 + 前后各 4 位"，掩掉它等于把核对手段废掉；
 *   · `paperName` / `pointName` / `lineName` / `campusName` / `schoolName`：这是**业务名称**
 *     （任务名、线路名、校区名），不是人名 —— 用宽 `name` 判会把"研途健行""西操场"一起掩掉，
 *     「全记录」立刻失去意义（实测）。
 * 真正的人名走 `PERSON_NAME_KEY_RE`（见下）单独判。
 */
export const SENSITIVE_KEYS =
  /(?:(?:token|authorization|auth|secret|sessionkey|session_key|ticket|sncode|stunumber|studentname|stuname|realname|idcard|idnumber|phone|phonenumber|mobile|openid|unionid|cookie)(?!fingerprint)|(?<![a-z])(?:name|姓名|学生姓名))/i

/**
 * **看起来就是一个人名**的键名（审计 B5：姓名可能被当成**键名**，如 `{"张小明":{...}}`）。
 * 判据：整键是 2~4 个汉字（可带 ·／空格），或 `name` / `姓名` / `studentName`（已并入 `SENSITIVE_KEYS`）。
 * 为什么不把"任意含 name 的键"都算：`pointName="西操场"` 是业务名，掩掉会让诊断失去内容。
 */
export const PERSON_NAME_KEY_RE = /^(?:[\u4e00-\u9fa5]{2,4}|[\u4e00-\u9fa5]{1,2}[·•][\u4e00-\u9fa5]{1,3})$/

/** 掩码一个敏感值：只保留长度（数字/布尔等短值直接原样，避免把 `0` 也掩掉） */
export function maskSensitive(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return `[masked len=${s?.length ?? 0}]`
}

/**
 * 一个"已知原值 → 掩码形态"的对照表（**长的在前**，避免长串被短串先替换掉）。
 * 输入是任意对象（实际用**请求体**）：名字敏感、且值是字符串/数字的字段被收进对照表。
 *
 * 用途：`redactObject()` 的值级替换（同一批值可能以别的拼写出现在别处）。
 * 为什么放在本模块（而不是「全记录」模块）：`redactObject` 要用它 ⇒ 放这里**没有循环依赖**。
 */
export function knownValuePairs(input: unknown): { raw: string; masked: string }[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const pairs: { raw: string; masked: string }[] = []
  const add = (raw: unknown, masked: string) => {
    const v = String(raw ?? '').trim()
    if (v.length < 2) return // 太短的值（如 "1"）全局替换会误伤正常文本
    if (v === masked) return
    if (pairs.some((p) => p.raw === v)) return
    pairs.push({ raw: v, masked })
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!SENSITIVE_KEYS.test(key)) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const raw = String(value)
    /**
     * 掩码口径**与诊断包完全一致**（同一组函数）：学号/姓名/手机分别用
     * `maskId` / `maskName` / `maskPhone`。⚠️ 别把姓名也丢给 `maskId` ——
     * 那会让 `张小明` 变成 `**`（连姓都不剩），而界面上是 `张**`，两边对不上会让人以为漏了。
     */
    if (/^(phone|phonenumber|mobile)$/i.test(key) || /^\d{11}$/.test(raw)) add(raw, maskPhone(raw))
    else if (/^(studentname|stuname|realname|name)$/i.test(key)) add(raw, maskName(raw))
    else add(raw, maskId(raw))
  }
  return pairs.sort((a, b) => b.raw.length - a.raw.length)
}

/**
 * 递归脱敏：按字段名掩码 + 把任何形似 token 的字符串片段掩掉。
 *
 * @param values 🆕 2026-09-22「全记录」用：**已知原值 → 掩码形态**的对照表（来自请求体里的学号/姓名/手机）。
 *   为什么会走到这里（而 `redactObject` 的调用方没传）：`SENSITIVE_KEYS` 只按**字段名**掩码，
 *   而同一批值可能又以**别的拼写**出现在别处（如错误文案里的"未找到用户 2021101234"）——
 *   这一层负责把"已知的那几个原值"在**任意字符串**里就地换掉。
 */
export function redactValue(key: string, value: unknown, depth = 0, values: { raw: string; masked: string }[] = [], maxDepth = 8): unknown {
  /**
   * ⚠️ 深度上限**可传参**（2026-09-22）。默认从 4 放宽到 **8**：实测 `getSunRunSchoolList` 的响应里
   * `body[0].schoolName` 这种"数组元素的对象的字段"在第 4 层，默认 4 会让它变成 `[deep]`
   * ⇒ 「全记录」把**内容**丢了（只剩键名）。真正的体积约束由**字节上限**负责（`RESP_BODY_MAX_BYTES`），
   * 不靠砍层数；传更小的值时旧行为仍然可用。
   */
  if (depth > maxDepth) return '[deep]'
  /**
   * 🔒 已经脱敏过的子树（「全记录」的 `respBody` 等）**原样返回**：它内部早在更靠根的深度上脱敏完了，
   * 再降一次深度只会把 `depth≥6` 的内容塌成 `[deep]`（审计 B2），与"已脱敏"这个事实无关。
   */
  if (value && typeof value === 'object' && (value as Record<PropertyKey, unknown>)[REDACTED_MARK] === true) return value
  if (SENSITIVE_KEYS.test(key) || PERSON_NAME_KEY_RE.test(key)) return maskSensitive(value)
  if (typeof value === 'string') {
    let s = value
    for (const p of values) s = s.split(p.raw).join(p.masked)
    return maskTokenLikeImpl(s)
  }
  if (typeof value === 'number') {
    /**
     * 🔴 数字型学号/手机也要掩（审计 B4）：`{"list":[2021101234,13812345678]}` 里的值是 JSON **number**，
     * 只判 string 会原样落盘。判据与 `maskDigitRuns` 同口径：**8~18 位整数**（无小数/无科学计数）。
     */
    if (Number.isInteger(value)) {
      const s = String(value)
      if (s.length >= 8 && s.length <= 18) return /^1\d{10}$/.test(s) ? maskPhone(s) : maskId(s)
    }
    return value
  }
  if (Array.isArray(value)) {
    // 数组里的元素若形似 token 也要掩（例如扫描器回传的候选列表）
    return value.slice(0, 20).map((v) => redactValue(key, v, depth + 1, values, maxDepth))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 键名同样脱敏（审计 B5：学号/姓名可能被当成**键**）
      const safeKey = maskDigitRuns(maskTokenLikeImpl(k))
      out[safeKey] = redactValue(safeKey, v, depth + 1, values, maxDepth)
    }
    return out
  }
  return value
}

/**
 * 脱敏一个对象（用于 data 字段）。
 *
 * 🆕 2026-09-22「全记录」加固：**默认就把"同一对象里名字敏感的字段值"当作对照表**再跑一遍值级替换
 * （`redactValue` 的 `values`）。为什么需要：字段名脱敏只掩"那一处"，而同一个学号/姓名
 * 可能又以别的拼写出现在同一行的其它字符串里（错误文案、上游原话引用）——
 * 不传对照表就会漏。对**不含敏感字段**的对象，对照表为空 ⇒ 行为与旧版**逐字节一致**。
 *
 * @param values 额外补充的对照表（例如从请求体里取到的值）；默认由 `input` 自身推导。
 */
export function redactObject(
  input: Record<string, unknown> | undefined | null,
  values: { raw: string; masked: string }[] = [],
): Record<string, unknown> | undefined {
  if (!input) return undefined
  const derived = values.length ? values : knownValuePairs(input)
  return redactValue('', input, 0, derived) as Record<string, unknown>
}

/** 截断过长文本（避免一条日志几 MB） */
export function truncate(text: string, max = 2000): string {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}…[截断，共 ${s.length} 字符]`
}

/**
 * 从上游响应里取状态摘要（用于代理日志）。
 *
 * 🔴 2026-09-22 审计 B3：这里的 `msg`/`message` 是**上游自由文本**（实测 `"未找到用户 2021101234 登录失败"`），
 * 老实现**原样放进日志行** ⇒ 学号/姓名/手机明文落盘（而同一行的 `respBody.msg` 却是掩过的，前后矛盾）。
 * 现在每个值都过 `redactValue`（字段名掩码 + 值级替换 + token 样式）与 `maskDigitRuns`（数字兜底）。
 */
export function summarizeUpstream(json: unknown, known: { raw: string; masked: string }[] = []): Record<string, unknown> {
  if (!json || typeof json !== 'object') return { kind: typeof json }
  const r = json as Record<string, unknown>
  const header = (r.header ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['status', 'code', 'msg', 'message', 'total']) {
    if (r[k] === undefined || r[k] === null || r[k] === '') continue
    // 自由文本字段（msg/message）必须脱敏；标量码（status/code/total）也走一遍（代价极小、不会误伤短码）
    const v = r[k]
    out[k] = typeof v === 'string' ? maskDigitRuns(String(redactValue(k, v, 0, known))) : v
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
