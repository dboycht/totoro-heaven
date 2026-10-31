import { isUnlockedThisRun, markUnlockedThisRun } from '../../utils/unlockState'

/**
 * `POST /api/local/unlock-notify` —— 浏览器端解锁通知（2026-10-31，§71/§72/§73）
 *
 * 用户在游戏页输入作弊码（`utils/game/entryGate.ts` 判定命中）后，`pages/play.vue`
 * best-effort 地 POST 本端点一次。它做两件事：
 *   ① **置位服务端解锁标记**（`server/utils/unlockState.ts`）—— 解锁状态的单一来源在这里，
 *      关闭网页 / 刷新 / 换浏览器都不会丢，重启软件才归零（§72 用户口径："一次运行期间"）；
 *   ② 调用 launcher 的横幅钩子（`globalThis.__TOTORO_ON_UNLOCK__`，launcher 与本服务同进程）
 *      —— 终端此时才打印与原版逐字一致的完整横幅。
 *
 * 🔒 §73 加固：**拒绝跨站驱动（drive-by）**。用户浏览器里任意一个公开网页都可以对
 *    localhost 发 no-cors POST；虽然 Chrome/Edge 的 Private Network Access 已默认拦掉大半，
 *    这里再按 `Sec-Fetch-Site` 明确拒绝 `cross-site`（同源 XHR/fetch 是 `same-origin`、
 *    直接导航是 `none`、无此头的旧客户端/命令行工具放行 —— 探针与脚本不受影响）。
 *    影响面说明：这层是伪装/彩蛋而非安全边界（真实数据仍由 token 与门禁保护），
 *    但"被路过的网页静默解锁"会让伪装对同机使用者失效，值得一拒。
 *
 * ⚠️ 幂等：重复调用只置一次位、横幅只打一次。
 * ⚠️ 本端点不承载"作弊码是否正确"的判定（判定只在浏览器侧），它只记录"已命中"这个事实。
 */
export default defineEventHandler((event) => {
  const site = String(getHeader(event, 'sec-fetch-site') || '')
  if (site === 'cross-site') {
    throw createError({ statusCode: 403, statusMessage: 'cross-site unlock notification rejected' })
  }
  markUnlockedThisRun()
  const hook = (globalThis as { __TOTORO_ON_UNLOCK__?: () => void }).__TOTORO_ON_UNLOCK__
  try {
    hook?.()
  } catch {
    /* 打印横幅失败不影响解锁本身 */
  }
  return { ok: true, unlocked: isUnlockedThisRun() }
})
