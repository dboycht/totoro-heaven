/**
 * 彩蛋解锁状态的**浏览器侧缓存**（2026-10-31，§72）
 *
 * 真源在服务端（`server/utils/unlockState.ts`，与 EXE 同生命周期）；浏览器侧只缓存一份，
 * 让路由守卫不必每次导航都打一轮 GET。缓存只需活过**当前页面上下文**
 * （刷新/关页后重新问服务端即可）⇒ 用**普通模块变量**，不用 `useState`
 * —— 实测教训：`useState` 在模块顶层调用会抛
 * "composable ... called outside of a plugin, Nuxt hook, Nuxt middleware, or Vue setup function"，
 * 守卫一抛错就 **fail-open（拦截失效放行）**，比体验问题严重得多（首轮实测抓到）。
 *
 * ## 三个入口
 *   · `ensureUnlockState()`（守卫首跳前调用）：缓存里没有 ⇒ 问一次服务端（`GET /api/local/unlock-state`）；
 *     服务不可达 ⇒ 按**未解锁**处理（安全默认：宁可多拦，绝不漏拦，且绝不让异常逃出守卫）。
 *   · `markUnlockedLocal()`（作弊码命中时立即调用）：本地先置真，让紧接着的 `/app` 跳转
 *     不用等网络往返；同时 `play.vue` 会 POST `/api/local/unlock-notify` 把服务端置位（幂等）。
 *
 * ⚠️ 并发说明：首跳可能有多条导航同时 `ensure` ⇒ 多打一两次只读 GET，幂等无害，不为它做去重。
 */
interface UnlockGateCache {
  loaded: boolean
  unlocked: boolean
}

let cache: UnlockGateCache | null = null

export async function ensureUnlockState(): Promise<boolean> {
  if (cache) return cache.unlocked
  try {
    // 3s 超时（§73）：服务假死时守卫不能把页面卡死 —— 超时按未解锁（安全默认）
    const r = await $fetch<{ unlocked: boolean }>('/api/local/unlock-state', {
      signal: AbortSignal.timeout(3000),
    })
    cache = { loaded: true, unlocked: !!r.unlocked }
  } catch {
    // 服务不可达（理论上页面本身就是它服务的）⇒ 安全默认：未解锁。绝不让异常逃出守卫。
    cache = { loaded: true, unlocked: false }
  }
  return cache.unlocked
}

export function markUnlockedLocal(): void {
  cache = { loaded: true, unlocked: true }
}
