/**
 * `POST /api/local/token-import` —— 扫描器回传候选 token（仅本机 + 一次性 nonce）
 *
 * 关键设计：**扫描器只回传候选，验活由服务端做** ——
 * 内存里可能残留旧 token（用户 2026-09-15 实测就撞到过），只取第一个会拿到失效的。
 * 这里逐个调 `GetStudentInfoByToken`，取第一个真正有效的。
 *
 * 🔒 token 不打印、不落盘；对外只返回"验活了几条"，token 本体由前端通过 status 端点取走。
 */
import { MP_ENDPOINTS, MP_HOST } from '../../../src/mp/types'
import { judgeMpResponse, unwrapMpResponse } from '../../../src/mp/envelope'
import { maskToken, sanitizeCandidates } from '../../../utils/mp/tokenScan'
import type { TokenScanProfile } from '../../utils/tokenScanState'
import { assertLocalRequest, fingerprintOf, getScan, nonceMatches, patchScan } from '../../utils/tokenScanState'

/** 用候选 token 调 GetStudentInfoByToken 验活；有效返回档案摘要，否则 null */
async function validateToken(token: string): Promise<TokenScanProfile | null> {
  try {
    const res = await fetch(`${MP_HOST}${MP_ENDPOINTS.studentInfoByToken.path}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) return null
    const verdict = judgeMpResponse(json, MP_ENDPOINTS.studentInfoByToken.payload)
    if (!verdict.ok) return null
    const obj = unwrapMpResponse<Record<string, unknown>>(json, MP_ENDPOINTS.studentInfoByToken.payload)
    if (!obj?.snCode) return null
    return {
      snCode: String(obj.snCode),
      schoolName: obj.schoolName ? String(obj.schoolName) : '',
      campus: obj.schoolCampusName ? String(obj.schoolCampusName) : '',
    }
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  assertLocalRequest(event)

  const body = (await readBody(event).catch(() => ({}))) as {
    nonce?: string
    tokens?: unknown
    error?: string
    processes?: number
  }

  const st = getScan()
  if (!st) throw createError({ statusCode: 409, statusMessage: '没有进行中的扫描（请重新点「获取 token」）' })
  if (!nonceMatches(st.nonce, body?.nonce)) throw createError({ statusCode: 403, statusMessage: 'nonce 不匹配' })
  if (st.used) throw createError({ statusCode: 409, statusMessage: '该 nonce 已使用过' })

  patchScan({ used: true, phase: 'validating', message: '正在逐个验活候选 token…' })

  const candidates = sanitizeCandidates(body.tokens)
  patchScan({ candidates: candidates.length })

  if (!candidates.length) {
    const hint =
      body?.error === 'NO_PROCESS'
        ? '未找到微信小程序进程：请先用**电脑版微信**打开并登录「龙猫体育锻炼」，保持开着再点一次'
        : body?.error === 'NO_TOKEN'
          ? '进程里没找到 token：请在小程序里点开任意页面（触发一次请求）后重试；若刚重新登录过，稍等几秒'
          : '扫描器没有回传可用候选（可能被杀软拦截或微信版本不兼容）'
    patchScan({ phase: 'error', message: hint })
    return { ok: true, validated: 0 }
  }

  for (const token of candidates) {
    const profile = await validateToken(token)
    if (profile) {
      patchScan({
        phase: 'ready',
        message: 'token 已就绪',
        token,
        fingerprint: fingerprintOf(token),
        masked: maskToken(token),
        profile,
      })
      return { ok: true, validated: 1, candidates: candidates.length }
    }
  }

  patchScan({
    phase: 'error',
    message: `${candidates.length} 个候选都没通过验活（很可能都是内存里残留的过期 token）——请在小程序里**删除小程序→重开→重新登录**后再试（切勿点解绑）`,
  })
  return { ok: true, validated: 0, candidates: candidates.length }
})
