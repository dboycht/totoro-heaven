/**
 * 版本号比较（纯逻辑，可单测）—— 用于"发现新版本"提示
 *
 * 约定：版本形如 `1.1.5`（可带 `v` 前缀，可带 `-beta.1` 这类后缀，后缀在比较时忽略）。
 * 判据：按数字段逐段比较；段数不同时短的补 0（`1.2` == `1.2.0`）。
 */

/** 解析为数字数组（无法解析返回 null） */
export function parseVersion(input: string | undefined | null): number[] | null {
  if (!input) return null
  const core = String(input).trim().replace(/^v/i, '').split(/[-+]/)[0]
  if (!/^\d+(\.\d+)*$/.test(core)) return null
  return core.split('.').map((n) => Number(n))
}

/**
 * 比较两个版本：a > b → 1；a < b → -1；相等 → 0；无法解析 → 0（保守：不提示）。
 */
export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return 0
  const len = Math.max(va.length, vb.length)
  for (let i = 0; i < len; i++) {
    const x = va[i] ?? 0
    const y = vb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** `latest` 是否比 `current` 新（两个都要能解析，否则 false） */
export function isNewerVersion(latest: string | undefined | null, current: string | undefined | null): boolean {
  return compareVersions(latest, current) > 0
}
