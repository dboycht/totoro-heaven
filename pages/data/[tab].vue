<template>
  <TabGroupShell :group="GROUP">
    <RecordsView v-if="tab === 'records'" />
    <LogsView v-else-if="tab === 'logs'" />
    <!-- 2026-09-21：诊断与「记录」「日志」并列（用户要求：诊断和记录、日志并列显示），不再塞在日志页里 -->
    <DiagnosticsView v-else-if="tab === 'diagnostics'" />
  </TabGroupShell>
</template>

<script setup lang="ts">
/**
 * 「数据」分组：`/data/records`、`/data/logs`、`/data/diagnostics`（2026-09-20 分组重构；诊断页 2026-09-21 加）
 *
 * 与「我的场地」共用 `components/TabGroupShell.vue`（分组定义不同，模板与逻辑同一份）。
 * 为什么用动态段 `[tab].vue` —— 见 `pages/field/[tab].vue` 顶部说明（`index.vue` 配子文件会 404）。
 */
import RecordsView from '~/components/RecordsView.vue'
import LogsView from '~/components/LogsView.vue'
import DiagnosticsView from '~/components/DiagnosticsView.vue'

definePageMeta({
  validate: (route) => ['records', 'logs', 'diagnostics'].includes(String(route.params.tab ?? '')),
})

const route = useRoute()
const tab = computed(() => String(route.params.tab ?? ''))

const GROUP = {
  base: '/data',
  label: '数据',
  icon: 'mdi-database-outline',
  hint: '记录、日志与诊断',
  tabs: [
    { key: 'records', label: '记录', icon: 'mdi-format-list-bulleted' },
    { key: 'logs', label: '日志', icon: 'mdi-text-box-search-outline' },
    { key: 'diagnostics', label: '诊断', icon: 'mdi-clipboard-pulse-outline' },
  ],
} as const

useHead({ title: '数据 · 龙猫天堂' })
</script>
