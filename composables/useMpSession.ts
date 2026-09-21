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

/**
 * ⚠️ **M2 修复（2026-09-21，用户要求：只"延长寿命/管理存储位置"，不改后面的操作与效果）**
 *
 * 问题：全仓有 3 处**直接写** `session.value` 而没调 `persist()` ——
 * `pages/index.vue:294`（手工粘 token）、`pages/index.vue:397`（一键取 token 成功）、
 * `composables/real/data.ts:123`（切校区改 baseUrl）。于是 `mp_session` 可能压根没被写：
 * token 只活在内存 + 任务缓存 `mp_real_task_v1` 里 ⇒ 刷新后顶栏显示"未连接"，得点一次「恢复」。
 *
 * 判据：**内存态与磁盘态不能靠调用方自觉同步** —— 状态一变就落盘（一处兜底，以后新增的赋值点也自动覆盖）。
 * ⚠️ 只做"落盘"这一件事：**不引入任何自动恢复/自动读取** —— 刷新后仍然要用户点一下「恢复」才重建任务
 * （用户明确要求"后面的操作与效果不要去更改"）。
 */
let persistWatcherBound = false

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

  // 单例注册（模块级开关）：本 composable 会被多处调用，不能每调一次就挂一个 watcher（且组件外注册的 watcher 不会被回收）
  if (import.meta.client && !persistWatcherBound) {
    persistWatcherBound = true
    watch(session, persist, { deep: true })
  }

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
