<template>
  <!-- 基路径只做跳转，不渲染内容（内容在同目录 `[tab].vue`） -->
  <div />
</template>

<script setup lang="ts">
/**
 * `/field` → `/field/track-editor`（2026-09-20 分组重构）
 *
 * 用户直接输入 `/field`（或点导航「我的场地」）时，落到本组第一个子标签。
 * `replace: true` ⇒ **不在历史里留这一跳**（否则点后退会在基路径与子页之间来回弹）。
 */
onMounted(() => {
  void navigateTo('/field/track-editor', { replace: true })
})

useHead({ title: '我的场地 · 龙猫天堂' })
</script>
