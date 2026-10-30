/**
 * `POST /api/local/unlock-notify` —— 浏览器端解锁通知（2026-10-31，§71）
 *
 * 用户在游戏页输入作弊码（`utils/game/entryGate.ts` 的 `unlock()`）后，`pages/play.vue`
 * 会 best-effort 地 POST 本端点一次。本地服务与 SEA launcher **同进程**（launcher.mjs
 * 末尾 in-process `import(server/index.mjs)`），所以 launcher 启动时挂到
 * `globalThis.__TOTORO_ON_UNLOCK__` 的钩子在这里被调用 —— 终端窗口此时才打印
 * 与原版逐字一致的完整横幅（「阳光跑助手 · 本地 Web 服务」）；启动时终端只有
 * 伪装口径（「像素小游戏 · 单机离线版」）。
 *
 * ⚠️ 尽力而为：钩子不存在（dev 直跑 `npm run dev`，不经过 launcher）或抛错都**不影响解锁**；
 *    本端点本身不承载任何解锁判定（解锁判定只在浏览器侧 `entryGate`），重复调用幂等。
 */
export default defineEventHandler(() => {
  const hook = (globalThis as { __TOTORO_ON_UNLOCK__?: () => void }).__TOTORO_ON_UNLOCK__
  try {
    hook?.()
  } catch {
    /* 打印横幅失败不影响解锁本身 */
  }
  return { ok: true }
})
