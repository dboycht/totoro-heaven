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
   * `true` = **流体云**顶部浮层（用于「导入 / 读取数据」这类有过程的操作）：
   * 点一下立即消失，未点则到点自动淡出。默认 `false` = 原来的顶部条。
   */
  cloud?: boolean
  /**
   * 自动消失的毫秒数；`0` = **不自动消失**（只等用户点击）。
   * 不传时：普通提示 3000 ms、云 5500 ms（与各自形态的既有手感一致）。
   */
  timeout?: number
  /** 云是否可点击消失（默认 `true`）。仅 `cloud: true` 时有意义。 */
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
