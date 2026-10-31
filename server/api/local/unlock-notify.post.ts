/**
 * `POST /api/local/unlock-notify` —— 浏览器端解锁通知（2026-10-31，§71/§72）
 *
 * 用户在游戏页输入作弊码（`utils/game/entryGate.ts` 判定命中）后，`pages/play.vue`
 * best-effort 地 POST 本端点一次。它做两件事：
 *   ① **置位服务端解锁标记**（`server/utils/unlockState.ts`）—— 解锁状态的单一来源在这里，
 *      关闭网页 / 刷新 / 换浏览器都不会丢，重启软件才归零（§72 用户口径："一次运行期间"）；
 *   ② 调用 launcher 的横幅钩子（`globalThis.__TOTORO_ON_UNLOCK__`，launcher 与本服务同进程）
 *      —— 终端此时才打印与原版逐字一致的完整横幅。
 *
 * ⚠️ 幂等：重复调用只置一次位、横幅只打一次。
 * ⚠️ 本端点不承载"作弊码是否正确"的判定（判定只在浏览器侧），它只记录"已命中"这个事实。
 */
import { isUnlockedThisRun, markUnlockedThisRun } from '../../utils/unlockState'

export default defineEventHandler(() => {
  markUnlockedThisRun()
  const hook = (globalThis as { __TOTORO_ON_UNLOCK__?: () => void }).__TOTORO_ON_UNLOCK__
  try {
    hook?.()
  } catch {
    /* 打印横幅失败不影响解锁本身 */
  }
  return { ok: true, unlocked: isUnlockedThisRun() }
})
