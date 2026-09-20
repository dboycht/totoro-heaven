<template>
  <!-- 基路径只做跳转，不渲染内容（内容在同目录 `[tab].vue`） -->
  <div />
</template>

<script setup lang="ts">
/**
 * `/data` → `/data/records`（2026-09-20 分组重构）
 *
 * 用户直接输入 `/data`（或点导航「数据」）时，落到本组第一个子标签。
 * `replace: true` ⇒ **不在历史里留这一跳**（否则点后退会在基路径与子页之间来回弹）。
 */
onMounted(() => {
  void navigateTo('/data/records', { replace: true })
})

useHead({ title: '数据 · 龙猫天堂' })
</script>
