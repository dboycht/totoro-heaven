/**
 * 入场解锁状态（2026-10-30，1.3.4 新增）
 *
 * 单独成一个模块（而不是塞在中间件里导出）：中间件文件在 Nuxt 里是"按路由执行的函数"，
 * 从它 `import` 别的函数容易在打包/按需加载时出意外；状态与判定抽到这里，
 * **中间件与游戏页共用同一份实现**（两处口径不可能漂移）。
 *
 * ## 判定（2026-10-30 用户原话）
 * > 「在一次启动过程中，如果用户输入了作弊码，那么在不关闭软件的情况下，都是跳过游戏界面直接进入到工作台」
 *
 * ⇒ 解锁是**进程级**的，不是"页面级"的。两道标记一起用：
 *   ① `sessionStorage`（键 `totoro_play_unlocked`）：标签页级，关标签/关浏览器即忘；
 *   ② **进程级内存标记**（模块级变量）：`sessionStorage` 只活在一个标签页里，**刷新页面也会清**，
 *      而打包版 EXE 里用户刷新（或 dev 热更新重载）**不等于关软件** ⇒ 只靠 ① 会出现"刷新一下又退回游戏"，
 *      这正是本判定要排除的情况。模块变量随进程存活，退出软件才消失。
 *
 * ⚠️ 为什么不用 `localStorage`：那样一旦解锁就**永久**跳过游戏，下次开机也不再看到小游戏（用户要的是"本次启动内"）。
 *    判据见 `tests/mp/entryGuard.test.ts` 的「入口拦截 E/F」。
 */
export const UNLOCK_KEY = 'totoro_play_unlocked'

/**
 * 进程级解锁标记（本次启动内有效）。
 * 模块只被加载一次 ⇒ 刷新页面后这个变量仍在（同一进程），退出软件才重新加载并归零。
 */
let unlockedThisRun = false

/** 是否已解锁（未解锁时一切工具页都不可达） */
export function isUnlocked(): boolean {
  if (typeof window === 'undefined') return unlockedThisRun
  if (unlockedThisRun) return true
  try {
    if (window.sessionStorage.getItem(UNLOCK_KEY) === '1') {
      // 会话里已经有了 ⇒ 同步到进程级，避免再次读存储
      unlockedThisRun = true
      return true
    }
  } catch {
    /* 隐私模式/禁用存储：退回进程级标记即可 */
  }
  return unlockedThisRun
}

/** 写入解锁标记（作弊码命中时调用）：两道一起写 */
export function unlock(): void {
  unlockedThisRun = true
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(UNLOCK_KEY, '1')
  } catch {
    /* 写不进去也不影响本次跳转：调用方紧接着 navigateTo，走的是同一份内存判定 */
  }
}

/**
 * 路由拦截的**纯判定**（把"该不该拦"与"怎么拦"分开）。
 *
 * @param path 目标路径（`to.path`）
 * @param unlocked 是否已解锁（会话/进程级，见上方 `isUnlocked`）
 * @returns `allow` = 放行；`game` = 送去游戏页；`blank` = 送去空白页
 *
 * 规则（与用户方案逐条对应）：
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
export function decideRoute(path: string, unlocked: boolean): 'allow' | 'game' | 'blank' {
  const p = path === '' ? '/' : path
  const PUBLIC_PATHS = ['/play', '/blank']
  if (PUBLIC_PATHS.some((x) => p === x || p === `${x}/`)) return 'allow'
  if (unlocked) return 'allow'
  if (p === '/' || p === '/app' || p === '/app/') return 'game'
  return 'blank'
}
