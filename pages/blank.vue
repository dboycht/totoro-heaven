<script setup lang="ts">
/**
 * 空白承接页（2026-10-30，1.3.4）
 *
 * 未解锁时访问工具地址会被送到这里 —— 它**故意什么都不显示**：
 * 不放游戏（暗示"这里有东西"）、不放文案（"无权访问"同样是一种线索）、不放导航。
 *
 * ⚠️⚠️ **必须 `definePageMeta({ layout: false })`**
 *    第一版忘了这一步，实测发现：URL 确实跳到了 `/blank`，但 `layouts/default.vue` 是**全局布局**
 *    ⇒ 顶栏的「工作台 / 跑步 / 我的场地 / 数据 / 鸣谢」**照样渲染出来**，
 *    伪装当场泄漏（截图见 `.tmp/verify-game/02-blank.png` 的第一版）。
 *    判据：**空白页只要挂任何布局，就不是"空白"**。
 *
 * ⚠️ 也不设 `useHead` 标题：标签页标题沿用站点默认，不额外提供线索。
 */
definePageMeta({ layout: false })
</script>

<template>
  <div class="blank" aria-hidden="true" />
</template>

<style scoped>
.blank {
  min-height: 100vh;
  background: #111018;
}
</style>
