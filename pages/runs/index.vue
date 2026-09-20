<template>
  <!-- 基路径只做跳转（内容在同目录的动态段页面） -->
  <div />
</template>

<script setup lang="ts">
/**
 * `/runs` → `/runs/sunrun`（2026-09-20 跑步分组重构）
 *
 * 点导航「跑步」时落在本组第一个标签（阳光跑）。`replace: true` ⇒ 不在历史里留这一跳。
 */
onMounted(() => {
  void navigateTo('/runs/sunrun', { replace: true })
})

useHead({ title: '跑步 · 龙猫天堂' })
</script>
