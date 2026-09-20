<template>
  <TabGroupShell :group="GROUP">
    <RecordsView v-if="tab === 'records'" />
    <LogsView v-else-if="tab === 'logs'" />
  </TabGroupShell>
</template>

<script setup lang="ts">
/**
 * 「数据」分组：`/data/records`、`/data/logs`（2026-09-20）
 *
 * 与「我的场地」共用 `components/TabGroupShell.vue`（分组定义不同，模板与逻辑同一份）。
 * 为什么用动态段 `[tab].vue` —— 见 `pages/field/[tab].vue` 顶部说明（`index.vue` 配子文件会 404）。
 */
import RecordsView from '~/components/RecordsView.vue'
import LogsView from '~/components/LogsView.vue'

definePageMeta({
  validate: (route) => ['records', 'logs'].includes(String(route.params.tab ?? '')),
})

const route = useRoute()
const tab = computed(() => String(route.params.tab ?? ''))

const GROUP = {
  base: '/data',
  label: '数据',
  icon: 'mdi-database-outline',
  hint: '记录与日志',
  tabs: [
    { key: 'records', label: '记录', icon: 'mdi-format-list-bulleted' },
    { key: 'logs', label: '日志', icon: 'mdi-text-box-search-outline' },
  ],
} as const

useHead({ title: '数据 · 龙猫天堂' })
</script>
