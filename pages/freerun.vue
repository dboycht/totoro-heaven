<template>
  <RunWorkspace />
</template>

<script setup lang="ts">
/**
 * 「自由跑」标签页（2026-09-18 新增）。
 *
 * - 与「阳光跑」共用同一个引擎组件 components/RunWorkspace.vue，本文件只声明"这是自由跑这个标签"；
 * - 提交口径：runType=1 + 不带任务号 + 不发路径点明细（厂商源码口径，见 utils/mp/submitPayload.ts）；
 * - 本地附加约束（用户要求"自由跑也要保证线路稳健性"）：仍要求已为当前任务描过跑道，
 *   轨迹走你自己描的几何，不用官方模板。详见 RunWorkspace 里 canStart 的注释。
 */
useHead({ title: '自由跑 · 龙猫天堂' })
</script>
