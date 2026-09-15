/**
 * `GET /api/local/token-scan/status` —— 前端轮询扫描/验活状态（需带 nonce）
 *
 * - phase=ready 时返回 token（本机 + nonce 校验）；前端取到后立即存入 localStorage 会话。
 * - phase=error / idle 时只返回消息，token 字段为 undefined。
 */
import { assertLocalRequest, getScan, nonceMatches } from '../../../utils/tokenScanState'

export default defineEventHandler((event) => {
  assertLocalRequest(event)

  const q = getQuery(event)
  const st = getScan()
  if (!st) {
    return { ok: true, phase: 'idle', message: '没有进行中的扫描' }
  }
  if (!nonceMatches(st.nonce, q?.nonce)) {
    throw createError({ statusCode: 403, statusMessage: 'nonce 不匹配' })
  }

  return {
    ok: true,
    phase: st.phase,
    message: st.message,
    fingerprint: st.fingerprint,
    masked: st.masked,
    profile: st.profile,
    candidates: st.candidates,
    // 只有 ready 才给出 token；错误/进行中一律不给
    token: st.phase === 'ready' ? st.token : undefined,
  }
})
