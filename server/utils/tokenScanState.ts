/**
 * 「一键获取 token」的**服务端状态**（进程内存，不落盘）
 *
 * 生命周期：start → scanning → （扫描器回传）→ validating → ready / error，5 分钟自动过期。
 * ⚠️ token 只在内存里待着：不写文件、不打日志；对外只给**指纹与掩码**（前端拿到后自己存 localStorage）。
 * 🔒 nonce：一次性（import 用过即作废），防止其它本地程序往流程里塞 token。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
/**
 * ⚠️ `createError` 原本靠 Nitro 的**自动导入**（运行时没问题），但 2026-09-20 起
 * `tests/mp/localCallbackOrigin.test.ts` 会 import 本模块 ⇒ 本文件同时被 `tsconfig.mp.json`
 * （纯逻辑层，**没有** Nuxt 自动导入类型）检查 ⇒ 报 `TS2304: Cannot find name 'createError'`。
 * 显式 import 更确定：既不依赖生成出来的 `.nuxt/types`，也不改变运行时行为（同一个 h3 函数）。
 */
import { createError, getRequestIP } from 'h3'
import type { H3Event } from 'h3'

export type TokenScanPhase = 'idle' | 'scanning' | 'validating' | 'ready' | 'error'

export interface TokenScanProfile {
  snCode: string
  schoolName: string
  campus: string
}

export interface TokenScanState {
  nonce: string
  createdAt: number
  phase: TokenScanPhase
  message: string
  /** 验活成功的 token（仅内存） */
  token?: string
  fingerprint?: string
  masked?: string
  profile?: TokenScanProfile
  candidates?: number
  /** 该 nonce 是否已被 import 使用过（一次性） */
  used: boolean
}

/** 状态存活时间（超过即视为过期，避免旧 token 一直留在内存里） */
export const TOKEN_SCAN_TTL_MS = 5 * 60 * 1000

let state: TokenScanState | null = null

/** 生成一次性 nonce（192 bit） */
export const newNonce = (): string => randomBytes(24).toString('hex')

/** token 指纹：`长度:sha256 前 12 位`（不可反推；仅用于展示与排错） */
export const fingerprintOf = (token: string): string =>
  `${token.length}:${createHash('sha256').update(token, 'ascii').digest('hex').slice(0, 12)}`

/** 常量时间比较（避免 nonce 被逐字节探测） */
export function nonceMatches(expected: string, given: unknown): boolean {
  const a = Buffer.from(String(expected), 'utf8')
  const b = Buffer.from(String(given ?? ''), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function beginScan(): TokenScanState {
  state = {
    nonce: newNonce(),
    createdAt: Date.now(),
    phase: 'scanning',
    message: '正在扫描微信小程序进程内存…（约 1~3 秒）',
    used: false,
  }
  return state
}

/** 取当前状态；过期自动清空 */
export function getScan(): TokenScanState | null {
  if (state && Date.now() - state.createdAt > TOKEN_SCAN_TTL_MS) state = null
  return state
}

export function patchScan(patch: Partial<TokenScanState>): void {
  if (state) state = { ...state, ...patch }
}

/* ⚠️ 2026-09-19 删除**零引用**的 `clearScan()`：扫描状态由 `beginScan()` 重置，
   没有调用方需要单独清空（grep 全仓仅声明处）。 */

/**
 * 🔒 回环 Host 的**唯一判据**（`assertLocalRequest` 与本机回调地址**共用这一份**）。
 * 允许 `127.0.0.1` / `localhost` / `[::1]`，端口可选。
 */
export const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/

/**
 * 子进程（内存扫描器）要把结果 **POST 回来**的本机 origin —— **跟着"服务实际绑定"的地址族走**。
 *
 * ⚠️ 2026-09-20 血的教训（`ERROR.md` E59）：这里原来把地址**写死成 `http://127.0.0.1`**，
 *    而 dev 不带 `--host` 时只监听 `::1`（本机 `localhost` 先解析成 IPv6）⇒ 回传 POST 连接被拒 ⇒
 *    扫描器 `exit 1`、界面报"扫描器未回传结果（退出码 1）"（看起来像被杀软拦截，实为地址族不匹配）。
 *
 * 规则（按优先级）：
 *   ① 服务绑的是 IPv6 回环（`NITRO_HOST=::1`）⇒ 回传也必须用 `[::1]`；
 *   ② 绑的是 IPv4 回环 / 所有接口（`0.0.0.0`、`::`）⇒ 用 **IPv4 字面量**（子进程少一次名字解析，
 *      就少一个"解析成 ::1 又连不上"的坑）；
 *   ③ 绑定未知（dev 场景：`devServer.host` 不写进环境变量）⇒ **跟请求的 Host 同族**：
 *      Host 是 `[::1]` 就用 IPv6，其余（`127.0.0.1` / `localhost`）统一用 IPv4 字面量。
 *   ④ 非回环 / 缺失 ⇒ 回落到 IPv4 回环（`assertLocalRequest` 早已把非本机请求挡掉了）。
 *
 * @param hostHeader  请求的 Host 头（拿端口 + 未知绑定时的地址族线索）
 * @param fallbackPort Host 头里没有端口时用它
 * @param boundHost   服务实际绑定的 host（默认读 `NITRO_HOST`/`HOST`）
 */
export function localCallbackOrigin(
  hostHeader: unknown,
  fallbackPort: string | number = '3000',
  boundHost: unknown = process.env.NITRO_HOST || process.env.HOST || '',
): string {
  const m = LOCAL_HOST_RE.exec(String(hostHeader ?? '').trim().toLowerCase())
  const bind = String(boundHost ?? '').trim().toLowerCase()
  const port = String(m?.[2] || fallbackPort)
  // ① 绑 IPv6 回环 ⇒ 必须 IPv6
  if (bind === '::1' || bind === '[::1]') return `http://[::1]:${port}`
  // ③ 绑定未知（dev 的常见情况）⇒ 看请求来的地址族
  if (!bind && m?.[1] === '[::1]') return `http://[::1]:${port}`
  // ②④ 其余一律 IPv4 回环字面量
  return `http://127.0.0.1:${port}`
}

/**
 * 🔒 只允许**本机**访问，且拒绝跨站来源。
 * 这类端点能读进程内存的结果，绝不能暴露给局域网或网页。
 */
export function assertLocalRequest(event: H3Event): void {
  // 优先用 h3 的 getRequestIP（能正确处理 IPv4-mapped）；显式关闭 x-forwarded-for（防伪造）
  const raw = String(event.node?.req?.socket?.remoteAddress || '')
  const ip = (getRequestIP(event, { xForwardedFor: false }) || raw).replace(/^::ffff:/, '').toLowerCase()
  const host = String(event.node?.req?.headers?.host || '').toLowerCase()
  const localIp = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '0:0:0:0:0:0:0:1'
  /**
   * ⚠️ 某些环境（本机 Windows loopback 经沙箱/代理时实测）socket 远端地址是**空串**。
   * 此时退一步用 **Host 头必须为本机形式** 判定（`LOCAL_HOST_RE`，与回调地址同一份判据）——
   * 安全性由"服务只绑 loopback"保证
   * （`pack/sea/launcher.mjs` 显式设 `NITRO_HOST=127.0.0.1`；`nuxt.config.ts` 的 `devServer.host` 也已固定）。
   */
  const localHostHeader = LOCAL_HOST_RE.test(host)
  const localOk = localIp || (ip === '' && localHostHeader)
  if (!localOk) {
    console.warn(`[token-scan] 拒绝非本机来源：ip=${JSON.stringify(ip)} raw=${JSON.stringify(raw)} host=${JSON.stringify(host)}`)
    throw createError({ statusCode: 403, statusMessage: 'token 助手仅允许本机访问' })
  }
  const origin = String(event.node?.req?.headers?.origin || '')
  if (origin) {
    // 同源才算合法：本机任意端口（dev/EXE 端口不固定）
    const okOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)
    if (!okOrigin) {
      throw createError({ statusCode: 403, statusMessage: '拒绝跨站请求' })
    }
  }
}
