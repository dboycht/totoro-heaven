<template>
  <TabGroupShell :group="GROUP">
    <!-- ⚠️ 这里挂的是**现有页面组件**（不复制逻辑）；与 `pages/*.vue` 那些薄页面是同一个组件 -->
    <TrackEditorView v-if="tab === 'track-editor'" />
    <MornsignZoneView v-else-if="tab === 'mornsign-zone'" />
  </TabGroupShell>
</template>

<script setup lang="ts">
/**
 * 「我的场地」分组：`/field/track-editor`、`/field/mornsign-zone`（2026-09-20）
 *
 * ⚠️ 为什么是**动态段** `[tab].vue` 而不是 `index.vue + 两个子文件`：
 *    Nuxt 按**文件**生成路由 —— `pages/field/index.vue` 只对应 `/field` 本身，
 *    写成那样时 `/field/track-editor` 会 404（实测报 `Page not found`，14 条断言失败）。
 *    用一个 `[tab].vue` 吃下本组所有子标签，既不需要把外壳复制两份，也不用三个文件。
 *
 * `validate` 把非法 tab 直接判为 404（**不静默回落到第一个**）：URL 写错时应当看得见，
 * 而不是"地址是错的、内容却是别的页"。
 */
import TrackEditorView from '~/components/TrackEditorView.vue'
import MornsignZoneView from '~/components/MornsignZoneView.vue'

definePageMeta({
  validate: (route) => ['track-editor', 'mornsign-zone'].includes(String(route.params.tab ?? '')),
})

const route = useRoute()
const tab = computed(() => String(route.params.tab ?? ''))

const GROUP = {
  base: '/field',
  label: '我的场地',
  icon: 'mdi-map-marker-radius',
  hint: '与"你描的几何 / 签到落点"有关',
  tabs: [
    { key: 'track-editor', label: '跑道编辑', icon: 'mdi-vector-polyline' },
    { key: 'mornsign-zone', label: '签到区域', icon: 'mdi-map-marker-radius-outline' },
  ],
} as const

useHead({ title: '我的场地 · 龙猫天堂' })
</script>
