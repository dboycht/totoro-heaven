/**
 * 「一键获取 token」的**服务端状态**（进程内存，不落盘）
 *
 * 生命周期：start → scanning → （扫描器回传）→ validating → ready / error，5 分钟自动过期。
 * ⚠️ token 只在内存里待着：不写文件、不打日志；对外只给**指纹与掩码**（前端拿到后自己存 localStorage）。
 * 🔒 nonce：一次性（import 用过即作废），防止其它本地程序往流程里塞 token。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { getRequestIP } from 'h3'
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

export function clearScan(): void {
  state = null
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
   * 此时退一步用 **Host 头必须为本机形式** 判定 —— 安全性由"服务只绑 loopback"保证
   * （`pack/sea/launcher.mjs` 已显式设 `NITRO_HOST=127.0.0.1`；dev 用 `--host 127.0.0.1`）。
   */
  const localHostHeader = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
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
