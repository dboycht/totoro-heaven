/**
 * 入场解锁状态（2026-10-30，1.3.4 新增）
 *
 * 单独成一个模块（而不是塞在中间件里导出）：中间件文件在 Nuxt 里是"按路由执行的函数"，
 * 从它 `import` 别的函数容易在打包/按需加载时出意外；状态与判定抽到这里，
 * **中间件与游戏页共用同一份实现**（两处口径不可能漂移）。
 *
 * ## 为什么是 `sessionStorage` 而不是 `localStorage`
 * 关掉浏览器再打开 ⇒ 标记消失 ⇒ 又回到游戏表面。
 * 用 `localStorage` 的话，一旦解锁就永久"露馅"（判据见 `tests/mp/entryGuard.test.ts`）。
 */
export const UNLOCK_KEY = 'totoro_play_unlocked'

/** 是否已解锁（未解锁时一切工具页都不可达） */
export function isUnlocked(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage.getItem(UNLOCK_KEY) === '1'
  } catch {
    return false
  }
}

/** 写入解锁标记（作弊码命中时调用） */
export function unlock(): void {
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
 * @returns `'allow'` = 放行；`'game'` = 送去游戏页；`'blank'` = 送去空白页
 *
 * 规则（与用户方案逐条对应）：
 *   · `/play`、`/blank` 永远可访问（游戏表面 + 空白承接页）；
 *   · `/` = "打开软件" ⇒ 未解锁时进游戏页（默认打开就是小游戏）；
 *   · 其余地址 ⇒ 未解锁时进空白页（输入校园跑链接"什么也没有"）；
 *   · 已解锁 ⇒ 一切放行（与正常软件一致）。
 */
export function decideRoute(path: string, unlocked: boolean): 'allow' | 'game' | 'blank' {
  const p = path === '' ? '/' : path
  const PUBLIC_PATHS = ['/play', '/blank']
  if (PUBLIC_PATHS.some((x) => p === x || p === `${x}/`)) return 'allow'
  if (unlocked) return 'allow'
  if (p === '/') return 'game'
  return 'blank'
}
