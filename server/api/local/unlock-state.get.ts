/**
 * `GET /api/local/unlock-state` —— 查询本次运行的彩蛋触发状态（2026-10-31，§72）
 *
 * 浏览器路由守卫（`middleware/guard.global.ts`）在**每次页面上下文新建后**的第一跳前
 * 都会来这里问一次："本次运行触发过彩蛋没有？" —— 因为浏览器端的一切标记
 * （sessionStorage / 页面模块变量）都活不过"关网页"，而状态真身在服务端进程里。
 *
 * 返回 `{ unlocked }`：`true` = 本次运行已触发（一切放行）；`false` = 未触发（拦截生效）。
 * 只读端点，不产生任何副作用。
 */
import { isUnlockedThisRun } from '../../utils/unlockState'

export default defineEventHandler(() => {
  return { unlocked: isUnlockedThisRun() }
})
