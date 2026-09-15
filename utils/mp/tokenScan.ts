/**
 * 「一键获取 token」的纯逻辑（零依赖，有单测）
 *
 * 背景：token 以明文存在于 PC 微信小程序宿主进程 `WeChatAppEx.exe` 的内存里
 * （小程序本地存储是真加密，但内存不是）。本地脚本用标准 Win32 调试 API 只读扫描内存，
 * 找出形如 `WXXCX` + base64 的候选串，回传到本地端点，再由服务端**逐个验活**。
 *
 * 本模块只负责"候选的清洗与掩码"这类**纯计算**（可单测，且**不依赖 node 内建**，
 * 以便前端也能安全引用）；真正的内存扫描在 `server/utils/tokenScanScript.ts`
 * （PowerShell + Add-Type P/Invoke），指纹计算在服务端端点里（用 node:crypto）。
 *
 * ⚠️ 纪律：token 本体**不打印、不入库**；日志与界面只出现**指纹**（长度 + sha256 前 12 位）。
 */
/** token 前缀（实测：真实 token 为 `WXXCX` 开头、101 字符、纯 base64 字符集） */
export const TOKEN_PREFIX = 'WXXCX'
/** 最短长度（与扫描器一致；实测 token 101 字符，留足余量） */
export const TOKEN_MIN_LEN = 80
/** 一次最多处理多少个候选（防止内存里大量伪串拖慢验活） */
export const TOKEN_MAX_CANDIDATES = 12

const TOKEN_SHAPE = /^WXXCX[A-Za-z0-9+/=]+$/

/** 是否是"形似 token"的串 */
export function isTokenShape(value: unknown): boolean {
  const t = typeof value === 'string' ? value.trim() : ''
  return t.length >= TOKEN_MIN_LEN && TOKEN_SHAPE.test(t)
}

/**
 * 清洗扫描器回传的候选列表：只留形似 token 的、去重、限量。
 * （**不做有效性判断** —— 那要调服务端验活，属另一层。）
 */
export function sanitizeCandidates(input: unknown): string[] {
  const list = Array.isArray(input) ? input : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const t = typeof item === 'string' ? item.trim() : ''
    if (!isTokenShape(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= TOKEN_MAX_CANDIDATES) break
  }
  return out
}

/** 供界面展示的掩码（前 8 位 + 省略 + 长度；**永不显示完整 token**） */
export function maskToken(token: string): string {
  if (!token) return ''
  return `${token.slice(0, 8)}…（共 ${token.length} 字符）`
}

/**
 * token 过期/失效时的**可操作提示**（界面直接用）。
 * 内容由用户 2026-09-15 指定：提示"退出登录并重新登录龙猫校园小程序"。
 * ⚠️ 附注实情：小程序里的「退出登录」= `unBindInfo`，会**解除微信与学号的绑定**（ERROR.md E21 记过该端点），
 *    所以同时给出更稳的等价做法（删除小程序→重开），并提醒"退出登录前确认记得学号"。
 */
export const TOKEN_EXPIRED_HINT =
  'token 已过期/失效 → 请在「龙猫校园（龙猫体育锻炼）」小程序里【退出登录】，然后用**学号 + 姓名**重新登录；' +
  '回到本页点「一键获取 token」即可。' +
  '（等价且更稳的做法：在微信里**删除该小程序**→重新打开→登录；两者都会解除微信绑定，请确认记得学号）'
