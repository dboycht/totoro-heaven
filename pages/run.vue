<template>
  <!-- 旧路由保留：只做跳转，不渲染内容（见 script 里的说明） -->
  <div />
</template>

<script setup lang="ts">
/**
 * 旧路由「阳光跑」→ `/runs/sunrun`（2026-09-20 跑步分组重构）
 *
 * 分组后阳光跑/自由跑成为「跑步」下的两个小标签（各自独立 URL）。
 * 旧地址保留**跳转**而不是删掉：用户可能已有书签或手输过 URL，删掉会变成 404。
 * `replace: true` ⇒ 不在历史里留这一跳，否则点后退会在旧地址与新地址之间来回弹。
 */
onMounted(() => {
  void navigateTo('/runs/sunrun', { replace: true })
})

useHead({ title: '阳光跑 · 龙猫天堂' })
</script>
