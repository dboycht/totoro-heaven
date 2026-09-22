/**
 * **凭证形态的唯一判据**（纯逻辑、零依赖）—— 2026-09-22 新增（审计 B6）
 *
 * ## 为什么单独成模块
 * "什么算凭证"这件事同时被**两边**用：
 *   · **落盘侧**（`utils/mp/logFormat.ts` 的 `maskTokenLike`）：形似凭证的片段必须就地掩成 `[token len=N]`；
 *   · **导出红线**（`utils/mp/diagnostics.ts` 的 `assertNoCredentials`）：包内任何文本出现凭证形态就拒/剔。
 * 两边各写一份正则时实测出现过两种漏洞（审计 B6）：
 *   ① 老口径只认 `WXXCX…` ⇒ **裸 JWT** 在红线侧命中（整份日志被剔、用户丢证据）、`sk-live-…`
 *      与含 `-`/`_` 的 base64url 在落盘侧不掩 ⇒ **随包发出**；
 *   ② 两边松紧不一致时，"掩码认了、红线不认"会让凭证进包，"红线认了、掩码不认"会让文件被误剔。
 * 收口到本模块后，**判据只有一份**（`CREDENTIAL_PATTERNS` 既用于掩码也用于红线）。
 *
 * ## 误报的代价（实测踩到，别再把第 ④ 条写宽）
 * 第 ④ 条（高熵长串）第一版写成"35+ 的 `[A-Za-z0-9+/=_-]`"⇒ 把 `'x'.repeat(400)` 这种**填充文本**
 * 也当成凭证掩掉，非 JSON 预览被吃成 21 字符（诊断内容凭空变短）。
 * 现在要求 **40+ 且同时含大小写或数字**（真正的高熵凭证必然混合），纯小写重复串不再误伤。
 */

/** 已知的密钥前缀形态（供应商 / 常见服务） */
const PREFIXED_SECRET = /\b(?:sk|pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})/

/** JWT 三段（`eyJ…..…`） */
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/

/** 供应商 token 形态（`WXXCX` + base64url，长度放宽到 20+） */
const WXXCX_LIKE = /WXXCX[A-Za-z0-9+/=_-]{20,}/

/** 高熵长串：40+ 的 base64url，且**同时含大小写或数字**（排除 `xxxx…` 这类填充） */
const HIGH_ENTROPY = /(?<![A-Za-z0-9])(?=[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-]))(?=[^\s]*(?:[a-z][A-Z]|[A-Z][a-z]|\d))[A-Za-z0-9+/=_-]{40,}/

/**
 * 落盘掩码用的**总正则**（`g` 标志：一次把一行里所有凭证片段换掉）。
 * 顺序：前缀明确的形态在前（`sk-…`/JWT 等），高熵兜底在后。
 */
export const CREDENTIAL_LIKE_RE = new RegExp(
  `${WXXCX_LIKE.source}|${JWT_LIKE.source}|${PREFIXED_SECRET.source}|${HIGH_ENTROPY.source}`,
  'g',
)

/** 导出红线用的**逐条判据**（带人话原因；`assertNoCredentials()` 直接展开使用） */
export const CREDENTIAL_PATTERNS: { re: RegExp; why: string }[] = [
  { re: WXXCX_LIKE, why: 'WXXCX 形态凭证' },
  { re: JWT_LIKE, why: 'JWT 样式串' },
  { re: PREFIXED_SECRET, why: '疑似密钥（sk-/ghp_/AIza… 形态）' },
  { re: HIGH_ENTROPY, why: '高熵长串（疑似裸凭证）' },
]

/** 把字符串里形似凭证的片段替换为 `[token len=N]`（**长度保留**，便于核对是不是同一个） */
export function maskTokenLike(text: string): string {
  return String(text).replace(CREDENTIAL_LIKE_RE, (m) => `[token len=${m.length}]`)
}
