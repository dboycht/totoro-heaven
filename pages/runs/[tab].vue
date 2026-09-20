<template>
  <!-- `flat`：跑步页自带卡片布局，不要再套一层卡（见 TabGroupShell 的注释） -->
  <TabGroupShell :group="GROUP" flat>
    <RunWorkspace />
  </TabGroupShell>
</template>

<script setup lang="ts">
/**
 * 「跑步」分组：`/runs/sunrun`（阳光跑）与 `/runs/freerun`（自由跑）—— 2026-09-20
 *
 * 用户要求："把自由跑阳光跑放到一个标签页"（此前是导航里两个平级入口）。
 * 两者**共用同一个引擎组件** `components/RunWorkspace.vue`（跑步机状态本来就是跨页面共享的 `useState`），
 * 所以这里只是给同一份内容套上"分组标签"外壳，**不需要复制任何逻辑**。
 *
 * ⚠️ 关键：`RunWorkspace` 靠**路由末段**判断当前是哪种跑法（`sunrun` / `freerun`），
 *    所以本页只需给出正确的 URL；口径与提交逻辑都在 RunWorkspace / runner / submitPayload 里，
 *    **本次改动一字未动那些口径**（自由跑提交仍是空 lineId/paperId、空路径点列）。
 */
import RunWorkspace from '~/components/RunWorkspace.vue'

definePageMeta({
  validate: (route) => ['sunrun', 'freerun'].includes(String(route.params.tab ?? '')),
})

const GROUP = {
  base: '/runs',
  label: '跑步',
  icon: 'mdi-run-fast',
  hint: '阳光跑 / 自由跑（同一套引擎，仅提交口径不同）',
  tabs: [
    { key: 'sunrun', label: '阳光跑', icon: 'mdi-white-balance-sunny' },
    { key: 'freerun', label: '自由跑', icon: 'mdi-run' },
  ],
} as const
</script>
