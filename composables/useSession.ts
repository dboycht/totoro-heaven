import type { BasicReq } from '~/src/wrappers/TotoroApiWrapper'

export interface TotoroLogin {
  token: string
  code: string
  stuNumber?: string
  stuName?: string
  campusId?: string
  campusName?: string
  collegeName?: string
  schoolId?: string
  phoneNumber?: string
  [key: string]: unknown
}

const storageKey = 'totoro_session'

/**
 * 全局会话（Nancy/Pinia 亦可，但保持与原件一致的 useState 语义）
 */
export const useTotoroSession = () => useState<TotoroLogin | null>('totoroSession', () => {
  if (import.meta.client) {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as TotoroLogin) : null
    } catch {
      /* ignore */
    }
  }
  return null
})

export function useSession() {
  const session = useTotoroSession()

  const isLoggedIn = computed(() => Boolean(session.value?.token))

  function setSession(payload: TotoroLogin) {
    session.value = payload
    if (import.meta.client) localStorage.setItem(storageKey, JSON.stringify(payload))
  }

  function clearSession() {
    session.value = null
    if (import.meta.client) localStorage.removeItem(storageKey)
  }

  const basicReq = computed<BasicReq>(() => {
    const s = session.value || {}
    return {
      token: s.token,
      campusId: s.campusId,
      schoolId: s.schoolId,
      stuNumber: s.stuNumber,
    }
  })

  return { session, isLoggedIn, setSession, clearSession, basicReq }
}