/**
 * 客户端诊断事件采集（2026-09-23 新增，用户要求 1️⃣）
 *
 * ## 干什么
 * 在页面最早的时刻装好三类采集，让"用户那边到底报了什么"能进诊断包：
 *   ① **全局异常**：`window.onerror` / `unhandledrejection`（`installClientErrorHooks`，含截断后的栈摘要）；
 *   ② **Vue 组件异常**：链式接在 `app.config.errorHandler` 上（**不覆盖**已有处理器 —— 谁先装的照旧生效）；
 *   ③ **关键交互失败**由各处显式调 `logEvent` / `reportBlocked` 上报（见 `useEventLog` / `useDiagEventReporter`）。
 *
 * ## 为什么放 plugin
 * 三条理由：**最早**（早于任何组件挂载 ⇒ 页面初始化阶段的异常也能抓到）、**只装一次**、
 * 且不依赖任何界面组件存在（诊断能力不该绑在某个卡片上）。
 *
 * ⚠️ 全程**只上报、不改变行为**：任何异常都吞掉（采集坏了也不能影响用户）。
 */
import { installClientErrorHooks, newEventId, reportBlocked, reportDiagEvent } from '~/composables/useDiagEventReporter'

export default defineNuxtPlugin((nuxtApp) => {
  try {
    /**
     * 🆕 2026-09-23：把上报入口挂到 `window` 上（**只在 dev**）。
     *
     * 为什么需要：验收/排查时要能**从页面外**确认"这条链路通不通"（端到端探针必须驱动到真实函数，
     * 而不是另写一份逻辑）；而 `import('/_nuxt/…')` 这种路径在不同页面/不同刷新后**不一定拿得到命名空间**
     * （实测：同一路径在第一页能拿到、刷新后拿到空对象）。挂一个稳定入口最省事也最可靠。
     * 🔒 生产构建**不挂**（`import.meta.dev` 判定）⇒ 不给正式包留调试入口。
     */
    if (import.meta.dev) {
      ;(window as unknown as Record<string, unknown>).__diagReport = reportDiagEvent
      ;(window as unknown as Record<string, unknown>).__diagNewId = newEventId
      ;(window as unknown as Record<string, unknown>).__diagBlocked = reportBlocked
    }

    /** ① 全局异常（onerror / unhandledrejection） */
    installClientErrorHooks({ source: 'plugin' })

    /** ② Vue 组件异常：**链式**接（保留已有 handler，别人装了也照旧调用） */
    const app = nuxtApp.vueApp
    const prev = app.config.errorHandler
    app.config.errorHandler = (err, instance, info) => {
      try {
        const msg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? String(err.stack ?? '').slice(0, 400) : ''
        const where = String(info ?? '')
        const comp = instance ? String((instance as { $options?: { name?: string } }).$options?.name ?? '') : ''
        reportDiagEvent({
          id: newEventId(),
          at: new Date().toISOString(),
          level: 'error',
          cat: 'client-error',
          text: `Vue 组件异常：${msg}${where ? `（${where}）` : ''}`,
          data: { kind: 'vue-error', ...(comp ? { component: comp } : {}), ...(stack ? { stack } : {}) },
        })
      } catch {
        /* 采集失败不能让页面再抛一次 */
      }
      /** 交回给已有处理器（Nuxt 默认那个会往控制台打并提示） */
      if (typeof prev === 'function') prev(err, instance, info)
    }

    /**
     * ②b Nuxt 的 `vue:error` 钩子（同一类来源的**双保险**）：不依赖"别人没换掉 `app.config.errorHandler`"。
     * 采集能力不该因为别人改了 handler 就静默失效。
     *
     * ⚠️ 为什么需要双保险（实测）：浏览器对**跨源脚本**抛出的错误会给 `window.onerror` 一个
     * `"Script error."` **且不给 `error`/栈**（安全策略）⇒ 光靠全局钩子可能拿不到栈。
     * Vue 的错误处理发生在**我们自己的代码**里，栈是完整的 ⇒ 组件内异常能给出真正有用的栈摘要。
     */
    nuxtApp.hook('vue:error', (err, instance, info) => {
      try {
        const msg = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error ? String(err.stack ?? '').slice(0, 400) : ''
        reportDiagEvent({
          id: newEventId(),
          at: new Date().toISOString(),
          level: 'error',
          cat: 'client-error',
          text: `Vue 错误钩子：${msg}${info ? `（${String(info)}）` : ''}`,
          data: { kind: 'vue-error-hook', ...(stack ? { stack } : {}), ...(instance ? { component: 'component' } : {}) },
        })
      } catch {
        /* 同上：采集失败不影响页面 */
      }
    })
  } catch {
    /* 环境不支持就算了：采集是加分项，不该影响启动 */
  }
})
