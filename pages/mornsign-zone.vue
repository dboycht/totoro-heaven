<template>
  <!-- 旧路由保留：只做跳转，不渲染内容（见 script 里的说明） -->
  <div />
</template>

<script setup lang="ts">
/**
 * 旧路由「签到区域」→ `/field/mornsign-zone`（2026-09-20 分组重构）
 *
 * 为什么要留这一页：用户可能已有**书签**或手输过 URL。直接把路由删掉会变成 404，
 * 而这里跳一次就到了新位置（分组壳 + 对应小标签），**旧链接不会失效**。
 *
 * ⚠️ 用 `replace: true`：不在历史里留"旧地址"这一跳，否则用户点后退会卡在重定向上来回弹。
 */
onMounted(() => {
  void navigateTo('/field/mornsign-zone', { replace: true })
})

useHead({ title: '签到区域 · 龙猫天堂' })
</script>
