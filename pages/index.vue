<script setup lang="ts">
/**
 * 根路径 `/` → 工作台 `/app`（2026-10-30）
 *
 * 为什么要有这一页：顶栏「工作台」按钮指向 `/app`（此前工程里没有这一页，点过去 404，用户 2026-10-30 报障）。
 * 现在工作台正文在 `pages/app.vue`，根路径只是**转一手**：
 *   · 旧书签、打包 EXE 的默认入口用的都是 `/`，不能失效；
 *   · 地址统一成 `/app`，`/` 立刻重定向（不留历史记录，按回退键也不会在两页之间来回跳）。
 *
 * ⚠️ 用 `definePageMeta({ redirect })` 而不是在 `onMounted` 里 `navigateTo`：
 *    后者会先把页面渲染一遍再跳走，视觉上闪一下。
 * ⚠️ 本页**不要**再写任何界面内容 —— 正文只在 `pages/app.vue` 一处，双份必然漂移。
 */
definePageMeta({
  redirect: '/app',
})
</script>

<template>
  <!-- 重定向期间不渲染任何东西（redirect 不会走到这里，留空以防万一） -->
  <div />
</template>
