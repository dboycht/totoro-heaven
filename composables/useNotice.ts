/**
 * 全局提示条的**调用契约**（唯一来源，1.1.9 加入）
 *
 * 为什么要有这个文件：`inject('showSnackbar')` 原先在每个页面各自内联写一遍类型
 * （`inject<(msg: string, color?: string) => void>('showSnackbar', () => {})`），
 * 于是"新增一个可选参数"要改十几处、还容易漏（漏了就是 `Expected 1-2 arguments, but got 3`）。
 * 现在**类型与默认值都只在这里定义**，调用方一律 `useNotice()`。
 *
 * 提供方是 `app.vue`：它持有唯一一份提示状态并渲染「顶部条」。
 * （历史：曾计划"流体云"外形，2026-09-18 用户明确否掉；兼容参数 `cloud`/`clickable` 已于 2026-10-31 清理。）
 */
import type { InjectionKey } from 'vue'

/** 提示形态与时长选项 */
export interface NoticeOptions {
  /**
   * 自动消失的毫秒数；`0` = **不自动消失**（只等用户点击）。
   * 不传时默认 **3000 ms**（与 1.1.8 及以前完全一致）。
   */
  timeout?: number
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
