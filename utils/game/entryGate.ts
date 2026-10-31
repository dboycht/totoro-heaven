/**
 * 入场拦截的**纯判定**（2026-10-30，1.3.4 新增；2026-10-31 §72 重构状态归属）
 *
 * 单独成一个模块（而不是塞在中间件里导出）：中间件文件在 Nuxt 里是"按路由执行的函数"，
 * 从它 `import` 别的函数容易在打包/按需加载时出意外；纯判定抽到这里，
 * **离线单测**（`tests/mp/entryGuard.test.ts`）可以直接复算。
 *
 * ## 状态在哪（§72，2026-10-31 实测纠偏）
 * "本次运行是否已触发彩蛋"的**真身在服务端**（`server/utils/unlockState.ts`）——
 * 因为"一次运行"指的是 **EXE 进程的生命周期**，而浏览器侧的一切标记
 * （sessionStorage 是标签页级的、页面模块变量随关页销毁）都活不过"关闭网页再打开"。
 * 旧实现把状态记在浏览器里 ⇒ 用户关网页再开就退回游戏，与
 * "运行期间都是彩蛋触发后的效果"的口径相悖（实测被用户抓到）。
 * 浏览器侧只留一份**缓存**（`composables/useUnlockGate.ts`）：
 * 首跳前问一次 `GET /api/local/unlock-state`，作弊码命中时本地立即置真并
 * `POST /api/local/unlock-notify` 通知服务端（幂等）。
 *
 * ## 判定（2026-10-30 用户原话）
 * > 「在一次启动过程中，如果用户输入了作弊码，那么在不关闭软件的情况下，都是跳过游戏界面直接进入到工作台」
 *
 * ⇒ 解锁是**进程级**的：重启软件归零；关网页 / 刷新 / 换浏览器都不影响。
 *
 * ## 路由判定（与用户方案逐条对应）
 *   · `/play`、`/blank` 永远可访问（游戏表面 + 空白承接页）；
 *   · **`/` 与 `/app` 都算"打开软件"** ⇒ 未解锁时进游戏页（默认打开就是小游戏）；
 *   · 其余地址 ⇒ 未解锁时进空白页（输入校园跑链接"什么也没有"）；
 *   · 已解锁 ⇒ 一切放行（与正常软件一致）。
 *
 * ⚠️ 为什么 `/app` 要和 `/` 一视同仁（2026-10-30 实测踩到）：工作台从根路径迁到 `/app` 后，
 *    `pages/index.vue` 用 `definePageMeta({ redirect: "/app" })` 转一手；可 Nuxt 的**全局路由中间件
 *    会在重定向之后**再按**新地址**判一次** ⇒ 未解锁时 `/app` 落进"其余地址"分支被送去 `/blank`，
 *    结果连"打开软件看游戏"都做不到。判据：**凡是"重定向目标"的地址，必须和来源地址得到同一个判定。**
 */

/**
 * 路由拦截的**纯判定**（把"该不该拦"与"怎么拦"分开；状态来源见 `composables/useUnlockGate.ts`）。
 *
 * @param path 目标路径（`to.path`）
 * @param unlocked 本次运行是否已触发彩蛋（服务端真源，见文件头）
 * @returns `allow` = 放行；`game` = 送去游戏页；`blank` = 送去空白页
 */
export function decideRoute(path: string, unlocked: boolean): 'allow' | 'game' | 'blank' {
  const p = path === '' ? '/' : path
  const PUBLIC_PATHS = ['/play', '/blank']
  if (PUBLIC_PATHS.some((x) => p === x || p === `${x}/`)) return 'allow'
  if (unlocked) return 'allow'
  if (p === '/' || p === '/app' || p === '/app/') return 'game'
  return 'blank'
}
