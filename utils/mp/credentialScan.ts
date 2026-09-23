/**
 * **凭证形态的唯一判据**（纯逻辑、零依赖，**线性扫描**）—— 2026-09-22 新增（审计 B6）；
 * 2026-09-22 闸门复验后**重写为线性算法**（见下"为什么不能用正则"）。
 *
 * ## 为什么单独成模块
 * "什么算凭证"这件事同时被**两边**用：
 *   · **落盘掩码**（`utils/mp/logFormat.ts` 的 `maskTokenLike`）；
 *   · **导出红线**（`utils/mp/diagnostics.ts` 的 `assertNoCredentials`）。
 * 两边各写一份时实测出现过两种漏洞：① 老口径只认 `WXXCX…` ⇒ 裸 JWT 在红线侧命中（整份日志被剔、
 * 用户丢证据）、`sk-live-…` 在掩码侧不掩（随包发出）；② 两侧松紧不一致 ⇒ "掩码认了红线不认"或反过来。
 * 收口到本模块后，**判据只有一份**，而且**掩码与红线调用同一个函数、同一粒度（单个字符串片段）**。
 *
 * ## 🔴 为什么不能用正则（闸门复验实测的**崩溃**）
 * 高熵判据第一版写成带嵌套前瞻的正则
 * （`(?<![A-Za-z0-9])(?=[A-Za-z0-9+/=_-]{40,}…)(?=[^\s]*(?:[a-z][A-Z]|…))[A-Za-z0-9+/=_-]{40,}`）：
 * 在**单个 ≥6 MB 的 alnum 串**上直接 `RangeError: Maximum call stack size exceeded`
 * （实测 4/5 MB 能过、6 MB 崩；旧正则 `/WXXCX[A-Za-z0-9+/=]{35,}/g` 对 10 MB 只要 3 ms）——
 * 这一条是**本次修复引入的**。异常从 `summarizeResponseBody()` 抛出，而代理路由当时只有 fetch 段
 * 有 try/catch ⇒ **路由 500、用户拿不到上游数据**（比"漏记一条日志"严重得多）。
 *
 * 现在改成**线性扫描**：按候选字符集切出片段，再对片段做常数时间判定（长度/字符集/熵特征），
 * 完全不用回溯或前瞻。10 MB 串也只是多走几遍字符。
 *
 * ## 判据（按序，任一命中即掩）
 *   ① `WXXCX` 前缀（供应商形态）；
 *   ② **JWT 三段**（`eyJ….….…`）；
 *   ③ 已知密钥前缀（`sk-`/`pk-`/`rk-`/`ghp_`/`xox?`/`AIza`）；
 *   ④ **高熵片段**（≥32 位 base64url、无中文/空白、**不是纯重复字符**、且**含数字或大小写混合**）。
 * 第 ④ 条是"无字段名的裸凭证"兜底（闸门复验 N5：36 位混合串 / 40 位纯小写 / 64 位十六进制都必须掩）。
 *
 * ⚠️ **代价（已知取舍，写清楚免得后人以为是 bug）**：很长的业务串（网页 chunk hash、base64 图片数据）
 * 也会被掩成 `[token len=N]` —— 长度保留（能看出"这里原本有一长串"），内容丢。
 * 宁可少给内容，不可漏凭证。
 * **只有"纯重复模式"（`'x'.repeat(400)`、`abab…`）不掩** —— 那是填充/占位文本。
 * ⚠️ 闸门复验实测提醒：`'x'.repeat(200) + 'A'.repeat(400)` 这种**混合**串**会**被掩（它不是纯重复模式，
 * 字符集与形态上都与"41 位以上的 base64url 凭证"一致，无法区分）—— 上一条注释曾写成"纯小写重复串不再误伤"，
 * 那句话对**纯重复**成立、对**混合填充**不成立，已按实际行为改正。
 */

/**
 * 高熵判定的长度门槛（base64url 片段）。
 *
 * ⚠️ 为什么是 **36**（闸门复验的两条约束夹出来的）：
 *   · 验收要求"**36 位混合串**必须掩" ⇒ 门槛不能高于 36；
 *   · 本程序自己的指纹串（`tokenFingerprint` = `len=101 head=WXXC tail=abcd`，**非空白部分 34 字符**）
 *     必须**不**被判成裸凭证 ⇒ 门槛不能低于/等于 34。
 * 同时要求"含数字或大小写混合"，纯重复串（`'x'.repeat(400)`）不算 —— 那是填充文本。
 */
export const HIGH_ENTROPY_MIN_LEN = 36
/** 已知密钥前缀（逐条小正则，作用域是**单个片段**，不做全串扫描） */
const PREFIX_RULES: RegExp[] = [
  /^(?:sk|pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}$/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^AIza[A-Za-z0-9_-]{20,}$/,
]

/**
 * JWT 三段（线性判定：拆 3 段、每段字符集与长度）。
 * ⚠️ 每段门槛取 **6**（不是 8）：测试/样例里的短 JWT（如 `eyJ….cGF5bG9hZA.c2ln`）每段只有 6~10 字符，
 * 门槛过高会让"裸 JWT 不掩"（闸门复验的反例就是这么漏的）。真 JWT 每段都远长于此。
 */
export function isJwtLike(s: string): boolean {
  const parts = s.split('.')
  if (parts.length !== 3) return false
  if (!parts[0]!.startsWith('eyJ')) return false
  return parts.every((p) => p.length >= 6 && /^[A-Za-z0-9_-]+$/.test(p))
}

/** 片段是否"纯重复模式"（`xxxx…` / `abab…` / `abcabc…`）—— 填充/占位文本，不是凭证 */
export function isRepeatedPattern(s: string): boolean {
  if (s.length < 2) return true
  for (let period = 1; period <= 4 && period * 2 <= s.length; period++) {
    let same = true
    for (let i = period; i < s.length; i++) {
      if (s[i] !== s[i - period]) {
        same = false
        break
      }
    }
    if (same) return true
  }
  return false
}

/**
 * 单个片段是不是"高熵裸凭证"（**O(n) 单遍、常数额外空间**，无回溯）。
 *
 * 两档判据（闸门复验的验收要求夹出来的）：
 *   · **≥36**：任何**非纯重复**的 base64url 片段都算（"40 位纯小写"这种裸串也必须是凭证 —— 没有别的线索）；
 *   · **32~35**：要求**含数字或大小写混合**（避免把普通长单词/指纹误判）。
 * 两档都排除"纯重复模式"（`'x'.repeat(400)` 是填充/占位文本，不是凭证）。
 */
export function looksLikeHighEntropySecret(s: string): boolean {
  if (s.length < 32) return false
  let hasLower = false
  let hasUpper = false
  let hasDigit = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const isLower = c >= 97 && c <= 122
    const isUpper = c >= 65 && c <= 90
    const isDigit = c >= 48 && c <= 57
    const isSymbol = c === 43 /* + */ || c === 47 /* / */ || c === 61 /* = */ || c === 45 /* - */ || c === 95 /* _ */
    if (!isLower && !isUpper && !isDigit && !isSymbol) return false // 含中文/空白/其它符号 ⇒ 不是凭证片段
    hasLower = hasLower || isLower
    hasUpper = hasUpper || isUpper
    hasDigit = hasDigit || isDigit
  }
  if (!hasLower && !hasUpper) return false // 纯符号
  if (isRepeatedPattern(s)) return false // 填充/占位文本
  if (s.length >= HIGH_ENTROPY_MIN_LEN) return true // ≥36：非重复即算（"纯小写裸串"也在内）
  return hasDigit || (hasLower && hasUpper) // 32~35：要求含数字或大小写混合
}

/**
 * 片段是不是凭证（① WXXCX ② JWT ③ 已知前缀 ④ 高熵）。
 *
 * ⚠️ 顺序：**先判有名字的形态**（`WXXCX` / JWT / `sk-`…），它们的门槛由各自的正则决定（不受 16 影响）；
 * 只有"④ 高熵"这一条才要求 ≥16（真正的高熵串远长于此）。
 * 实测踩到：把 16 的门槛放在最前面时，`sk-abcdefghijklmnopq`（前 3 位 `sk-` + 15 位）仍能被
 * `PREFIX_RULES` 认出——但更短的残段（如 `[token len=20]` 里的 `20]`）也会被当成"前缀形态"再掩一次，
 * 把掩码标记自己吃掉（`…[token len=20]0`）。现在由各正则自己把关，不再统一卡 16。
 */
export function isCredentialFragment(s: string): boolean {
  if (!s) return false
  if (s.startsWith('WXXCX')) return s.length >= 24
  if (isJwtLike(s)) return true
  for (const re of PREFIX_RULES) if (re.test(s)) return true
  if (s.length < 16) return false
  return looksLikeHighEntropySecret(s)
}

/** 候选片段的字符集（base64url + 常见 base64）：切分用，与判定用的字符集一致 */
const RUN_CHAR = /[A-Za-z0-9+/=_-]/

/**
 * **"载明是凭证"的形态**（闸门复验第二轮必修）：只要写明了 `Bearer` / `token=` / token 字段名，
 * 值**短一点也算凭证** —— 低熵的 22 位串同样是凭证（只是熵不够、会被高熵判据漏掉）。
 *
 * 为什么必须有这一条：红线侧原本**自带**这几条正则（`Bearer …` / `token=…` / token 字段），
 * 而掩码侧只认高熵 ⇒ 出现分叉：`Authorization: Bearer abcdefghijklmnopqrst`（22 位纯小写）
 * **掩码侧不掩** ⇒ 真落盘 ⇒ **红线命中 ⇒ 整个日志文件被剔出包**（正是 B6 要消灭的现象）。
 * 现在把这几条搬进**掩码侧**，并**删掉红线的自有正则** ⇒ "掩码安全 ⇒ 红线安全"成立（有断言）。
 *
 * 阈值（与旧红线**逐条对齐**，只严不松）：`Bearer` ≥16、`token=` ≥16、token 字段值 ≥24。
 */
const DECLARED_CREDENTIAL_RULES: { re: RegExp; why: string }[] = [
  /**
   * ⚠️ **字符集里绝不能写 `+/-`**：在字符类中 `-` 会构成**区间**（`+`(43) 到 `/`(47)，顺带把 `.`/`-` 也吞进去），
   * 于是"值的结束边界"整体错位、替换后**多吐一个字符**（`?token=abcdefghijklmnopqrst` ⇒ `…[token len=20]6`）。
   * 必须把 `-` 放在**末尾**（或转义）：`[A-Za-z0-9._~+/=-]`。反向的**负向前瞻必须用同一套字符集**，否则又错位。
   *
   * ⚠️ 分组要"head 含前缀与空白、value 只含凭证本体"（第一版把空白单独成组，替换时把空格也吞了）。
   * ⚠️ 每组都带**显式边界前瞻**：`{16,}` 只保证"至少 16 个"，加上前瞻才是"值到此结束"。
   */
  { re: /(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})(?![A-Za-z0-9._~+/=-])/gi, why: 'Bearer 凭证' },
  { re: /([?&][^=&\s]*(?:token|auth|secret|ticket)[^=&\s]*=)([A-Za-z0-9._~+/=-]{16,})(?![A-Za-z0-9._~+/=-])/gi, why: 'token= 查询串' },
  // `fingerprint` 例外：`tokenFingerprint` 是"长度 + 前后各 4 位"的指纹，不是凭证本体
  { re: /("[^"]*(?:token|auth|secret|sessionkey|ticket)(?!fingerprint)[^"]*"\s*:\s*")([^"]{24,})(")/gi, why: 'token 字段明文' },
  { re: /('[^']*(?:token|auth|secret|sessionkey|ticket)(?!fingerprint)[^']*'\s*:\s*')([^']{24,})(')/gi, why: 'token 字段明文' },
]

/** 掩掉"载明是凭证"的**值**（保留字段名 / `Bearer` 前缀，便于人读）；线性、无嵌套前瞻。 */
const DECLARED_TAIL_RULES = new Set(DECLARED_CREDENTIAL_RULES.filter((r) => /\)\("\)|\)\('\)/.test(r.re.source)).map((r) => r.re.source))

function maskDeclaredCredentials(text: string): string {
  let s = text
  for (const { re } of DECLARED_CREDENTIAL_RULES) {
    const hasTail = DECLARED_TAIL_RULES.has(re.source)
    s = s.replace(re, (...args: unknown[]) => {
      const head = String(args[1] ?? '')
      const value = String(args[2] ?? '')
      const tail = hasTail ? String(args[3] ?? '') : ''
      return `${head}[token len=${value.length}]${tail}`
    })
  }
  return s
}

/**
 * 找 JWT 三段（**线性**）：`eyJ…` 开头、形如 `A.B.C`、三段都是 base64url。
 * 为什么单独一条（闸门复验踩到）：JWT 里的 `.` **不是** `RUN_CHAR`，所以"按 run 切分"会把 JWT 切成三段，
 * 而每段常常 <16（如 `cGF5bG9hZA` 只有 10）⇒ `findCredentialRuns()` 看不见它 ⇒ **裸 JWT 漏掩**。
 */
function findJwtSpans(s: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let i = 0
  while (i < s.length) {
    const at = s.indexOf('eyJ', i)
    if (at < 0) break
    // 从 `eyJ` 起扫出一段 `[A-Za-z0-9_.-]`（JWT 允许 base64url + `.`）
    let j = at
    while (j < s.length && /[A-Za-z0-9_.-]/.test(s[j]!)) j++
    const frag = s.slice(at, j)
    if (isJwtLike(frag)) out.push({ start: at, end: j })
    i = j > at ? j : at + 3
  }
  return out
}

/**
 * 找出文本里**像凭证的片段**（**线性扫描**，无回溯、无前瞻）。
 *
 * @param minLen 片段最小长度（默认 16；低于它的片段不必走完整判定）
 * @returns 命中片段的 `[start, end)` 区间（已按起点排序、去掉互相包含的重复项）
 */
export function findCredentialRuns(text: string, minLen = 16): { start: number; end: number }[] {
  const s = String(text ?? '')
  const spans: { start: number; end: number }[] = findJwtSpans(s)
  let i = 0
  while (i < s.length) {
    if (!RUN_CHAR.test(s[i]!)) {
      i++
      continue
    }
    const start = i
    while (i < s.length && RUN_CHAR.test(s[i]!)) i++
    const frag = s.slice(start, i)
    if (frag.length >= minLen && isCredentialFragment(frag)) spans.push({ start, end: i })
  }
  // 排序 + 去重叠（JWT span 与其内部 run 可能重叠：保留更长的那个）
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: { start: number; end: number }[] = []
  for (const span of spans) {
    const last = out[out.length - 1]
    if (last && span.start < last.end) continue // 已被上一个更长的覆盖
    out.push(span)
  }
  return out
}

/**
 * 🔴 **掩码唯一入口**：先掩"载明是凭证"的形态（保留字段名/`Bearer` 前缀），再按线性扫描掩"裸凭证"。
 * 顺序很重要：先处理载明的，剩下的裸片段再按熵判据处理。
 */
export function maskTokenLike(text: string): string {
  const s = String(text ?? '')
  const declared = maskDeclaredCredentials(s)
  const runs = findCredentialRuns(declared)
  if (!runs.length) return declared
  let out = ''
  let last = 0
  for (const r of runs) {
    out += declared.slice(last, r.start) + `[token len=${r.end - r.start}]`
    last = r.end
  }
  return out + declared.slice(last)
}

/**
 * **导出红线**用的判据：这段文本里还有没有**未被掩掉**的凭证形态。
 *
 * 🔴 判据就是**掩码侧本身**：`maskTokenLike(t) !== t` ——
 * "掩码会不会改动它"**等价于**"这里还有需要掩的东西"。这样两侧**在定义上**就不可能分叉。
 * （2026-09-23 实测踩到的边界：红线原先自己先"判定"、掩码则是"判定 + 替换"，
 * 两者在"已经脱敏过的指纹串"上不一致 ⇒ 红线判"未掩" ⇒ **导出被打成 500**。
 * 改成"以改了没有为准"之后，掩过的文本必然判为安全。）
 */
export function hasUnmaskedCredential(text: string): boolean {
  const s = String(text ?? '')
  return maskTokenLike(s) !== s
}
