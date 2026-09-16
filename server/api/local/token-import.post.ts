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
import { logInfo, logWarn } from '../../utils/logger'

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
        ? '未找到微信小程序进程：请先用「电脑版微信」打开并登录「龙猫体育锻炼」，保持小程序窗口开着，再点一次「一键获取 token」'
        : body?.error === 'NO_TOKEN'
          ? '进程里没找到 token：请在小程序里点开任意页面（触发一次请求）后重试；「务必保持小程序窗口开着」（关掉后内存里就没有新 token 了）'
          : '扫描器没有回传可用候选（可能被杀软拦截或微信版本不兼容）——可改用 Fiddler 抓包粘贴 token'
    patchScan({ phase: 'error', message: hint })
    logWarn('token', '扫描未拿到候选', { scannerError: body?.error ?? '(无)', processes: body?.processes })
    return { ok: true, validated: 0 }
  }

  logInfo('token', `扫描到 ${candidates.length} 个候选，开始逐个验活`, { candidates: candidates.length })
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
      logInfo('token', 'token 验活成功', {
        candidates: candidates.length,
        fingerprint: fingerprintOf(token),
        campus: profile.campus,
        school: profile.schoolName,
      })
      return { ok: true, validated: 1, candidates: candidates.length }
    }
  }

  patchScan({
    phase: 'error',
    message:
      `扫到 ${candidates.length} 个候选，但都没通过验活（多半是内存里残留的旧串）。` +
      '请在「龙猫校园（龙猫体育锻炼）」小程序里【退出登录】→ 用「学号 + 姓名」重新登录 → ' +
      '「保持小程序窗口开着」→ 回到本页再点一次「一键获取 token」。' +
      '（等价且更稳：在微信里删除该小程序→重新打开→登录；两者都会解除微信绑定，请确认记得学号）',
  })
  logWarn('token', '候选都没通过验活', { candidates: candidates.length })
  return { ok: true, validated: 0, candidates: candidates.length }
})
