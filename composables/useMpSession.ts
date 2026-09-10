/**
 * 小程序后端会话（token + 用户档案）
 *
 * 与旧 `useSession`（App 版）分开存储，互不影响：
 *   - 旧：localStorage `totoro_session`
 *   - 新：localStorage `mp_session`
 *
 * ⚠️ 小程序 token 的来源与有效期待真包/实测确认（`_mp-analyze/疑难与决策清单.md` Q8/Q9）。
 */
import type { MpSession, MpUserInfo } from '~/src/mp/types'

const storageKey = 'mp_session'

export const useMpSessionState = () =>
  useState<MpSession | null>('mpSession', () => {
    if (import.meta.client) {
      try {
        const raw = localStorage.getItem(storageKey)
        return raw ? (JSON.parse(raw) as MpSession) : null
      } catch {
        /* ignore */
      }
    }
    return null
  })

export function useMpSession() {
  const session = useMpSessionState()

  const token = computed(() => session.value?.token || '')
  const userInfo = computed<MpUserInfo | undefined>(() => session.value?.userInfo)
  const isLoggedIn = computed(() => Boolean(session.value?.token))

  function setToken(nextToken: string) {
    session.value = { ...(session.value || { token: '' }), token: nextToken }
    persist()
  }

  function setUserInfo(info: MpUserInfo) {
    session.value = { token: session.value?.token || '', userInfo: info }
    persist()
  }

  function setSession(payload: MpSession) {
    session.value = payload
    persist()
  }

  function clearSession() {
    session.value = null
    if (import.meta.client) localStorage.removeItem(storageKey)
  }

  function persist() {
    if (import.meta.client && session.value) {
      localStorage.setItem(storageKey, JSON.stringify(session.value))
    }
  }

  return { session, token, userInfo, isLoggedIn, setToken, setUserInfo, setSession, clearSession }
}
