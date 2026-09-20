/**
 * 提交报文里的 **token 掩码**（纯函数，可离线单测）—— 2026-09-20 审计修复
 *
 * 背景（审计发现）：报文预览面板会把 `sunRunExercises` / `sunRunExercisesDetail` 两个报文
 * **原样打印并支持「复制」**，而这两个报文里都有 `token` 字段 = 本机会话凭据
 * ⇒ 屏幕上明文可见、一点「复制」就进剪贴板。
 * 对照既有口径：真实提交那条路径**早就会掩码**（`composables/real/submit.ts` 的 `scoreRequestMasked`
 * 把 token 换成 `***`）；只有"结算后的本地报文预览"这条路径漏了 ⇒ 口径不一致，这里补齐。
 *
 * 判据：**凡是要显示/复制给用户看的报文体，token 一律掩码**（与 `utils/mp/logFormat.ts` 的日志脱敏同一纪律）。
 *
 * ⚠️ 只做"深拷贝 + 掩码"，**不修改入参**（调用方手里的报文仍是真的、可继续用于提交）。
 */
export const MASK_TOKEN_PLACEHOLDER = '***'

/** 需要掩码的键名（大小写不敏感；目前只有厂商契约里的 `token`） */
const SENSITIVE_KEYS = new Set(['token'])

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/**
 * 深拷贝 `value`，并把所有名为 `token` 的字段换成 `placeholder`。
 *
 * 判据：
 *   · 顶层 / 嵌套对象 / 数组元素里的 `token` 都会被掩码；
 *   · **不改动入参**（返回新对象）；
 *   · 非字符串的 `token`（缺省 `''`、`null`）也一并掩码，避免"空值时反而露出原文"的岔路；
 *   · 超过 `maxDepth` 的层级原样保留（报文最多两三层；防病态深结构把界面卡住）。
 */
export function maskPayloadTokens<T>(value: T, placeholder = MASK_TOKEN_PLACEHOLDER, maxDepth = 6): T {
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > maxDepth) return node
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    if (!isPlainObject(node)) return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = placeholder
        continue
      }
      out[k] = walk(v, depth + 1)
    }
    return out
  }
  return walk(value, 0) as T
}
