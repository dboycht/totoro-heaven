/**
 * 全局提示条的**调用契约**（唯一来源，1.1.9 加入）
 *
 * 为什么要有这个文件：`inject('showSnackbar')` 原先在每个页面各自内联写一遍类型
 * （`inject<(msg: string, color?: string) => void>('showSnackbar', () => {})`），
 * 于是"新增一个可选参数"要改十几处、还容易漏（漏了就是 `Expected 1-2 arguments, but got 3`）。
 * 现在**类型与默认值都只在这里定义**，调用方一律 `useNotice()`。
 *
 * 提供方是 `app.vue`：它持有唯一一份提示状态，并决定用「顶部条」还是「流体云」渲染。
 */
import type { InjectionKey } from 'vue'

/** 提示形态与时长选项 */
export interface NoticeOptions {
  /**
   * ⚠️ **兼容参数，已无语义**（2026-09-18）：曾用于切换"流体云"外形，用户看过一版后**明确否掉**
   * （要求换成正常矩形提示条），云朵组件已删除。保留此字段**只是为了不改动 7 处调用方**；
   * 新代码**不要**再传它，后续轮次可安全清理。
   */
  cloud?: boolean
  /**
   * 自动消失的毫秒数；`0` = **不自动消失**（只等用户点击）。
   * 不传时默认 **3000 ms**（与 1.1.8 及以前完全一致）。
   */
  timeout?: number
  /**
   * ⚠️ **兼容参数，已无语义**：矩形提示条**总是**可点击关闭（用户明确要求），故不再需要区分。
   */
  clickable?: boolean
}

/** 提示函数签名（提供方与调用方共用这一个类型） */
export type ShowNotice = (msg: string, color?: string, options?: NoticeOptions) => void

/** 注入键：**必须与 `app.vue` 的 `provide` 用同一个键**（改键只改这里） */
export const NOTICE_KEY: InjectionKey<ShowNotice> = Symbol('showSnackbar')

/**
 * 取全局提示函数。
 * 兜底为空实现：**组件被单独挂载（如测试）时调用提示不该炸**（宁可没提示，也不能整页黑屏）。
 */
export function useNotice(): ShowNotice {
  return inject(NOTICE_KEY, (() => {}) as ShowNotice)
}
