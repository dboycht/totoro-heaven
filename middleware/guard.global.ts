/**
 * 入口拦截（2026-10-30，1.3.4 新增）
 *
 * ## 用户方案（原话）
 * > "默认拦截那些校园跑的链接，也就是输入那些链接是什么也没有的；然后游戏是在 game 那个页面，
 * >  输入作弊码后自动跳转到真实网站，然后那个拦截此时关闭，然后就和正常的一样了"
 *
 * ## 本文件只做"接线"，判定逻辑在 `utils/game/entryGate.ts`
 * 这样做的原因：判定要能被**离线单测**复算（`tests/mp/entryGuard.test.ts`），
 * 而中间件本身依赖 Nuxt 运行时、测不了。两处口径由"共用同一份 `decideRoute`"保证不漂移。
 *
 * ## 行为一览
 *   · `/play`  = 游戏页（唯一表面，永远可访问）
 *   · `/`      = 工具页；**未解锁 ⇒ 进游戏页**（"下载后运行，默认打开的就是小游戏"）
 *   · 其余地址 = 工具本体；**未解锁 ⇒ 进空白页**（输入校园跑链接得到"什么也没有"）
 *   · 作弊码命中 ⇒ 写会话级解锁标记 ⇒ 此后一切放行，与正常软件完全一样
 *
 * ⚠️ 本项目 `ssr: false`（纯 SPA，见 `nuxt.config.ts`）⇒ 中间件只在浏览器端跑、
 *    `sessionStorage` 可读，不存在"服务端先吐工具页再被前端替换"的泄漏窗口。
 */
import { decideRoute, isUnlocked } from '~/utils/game/entryGate'

export default defineNuxtRouteMiddleware((to) => {
  const verdict = decideRoute(to.path, isUnlocked())
  if (verdict === 'allow') return
  // ⚠️ `replace: true`：不要在被拦的地址上留下历史记录（回退键一按就露馅）
  if (verdict === 'game') return navigateTo('/play', { replace: true })
  return navigateTo('/blank', { replace: true })
})
