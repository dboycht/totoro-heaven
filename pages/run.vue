<template>
  <RunWorkspace />
</template>

<script setup lang="ts">
/**
 * 「阳光跑」标签页（2026-09-18 起与「自由跑」拆成两个独立标签、各自有 URL）。
 *
 * 两者共用同一个引擎组件 components/RunWorkspace.vue（跑步机状态本来就是跨页面共享的 useState），
 * 拆成两份页面会让「等待 / 提交 / 自检」这些逻辑立刻漂移，所以这里只负责路由与标题。
 * 当前标签由 URL 决定：/run = 阳光跑，/freerun = 自由跑。
 */
useHead({ title: '阳光跑 · 龙猫天堂' })
</script>
