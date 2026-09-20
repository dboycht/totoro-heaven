<template>
  <div>
    <v-alert type="warning" variant="flat" density="comfortable" class="mb-4">
      <div class="font-weight-bold">⚠️ 这是<b>示例页（原型）</b>，不是正式结构</div>
      <div class="text-body-2">
        目的：让你先看「大标签 + 内部小标签」的实际效果与跳转方式。确认后我再改真项目的导航与路由。
        本页<b>没有改动</b>任何现有页面，配置也读的是<b>同一份本机数据</b>（改这里=改真的，注意）。
        <br />⚠️ 注意守卫的一个盲区：模板里写 <code>**…**</code> 不会被 Vue 渲染成加粗（会显示字面星号），
        这里用 <code>&lt;b&gt;</code>。既有守卫只抓"包住中文"的形态 —— 夹了英文就漏了（我这次就漏了一处）。
      </div>
    </v-alert>

    <!-- 大标签：与将来导航一一对应 -->
    <v-tabs v-model="group" density="compact" class="mb-2">
      <v-tab v-for="g in GROUPS" :key="g.key" :value="g.key" :prepend-icon="g.icon">{{ g.label }}</v-tab>
    </v-tabs>

    <v-card v-if="current">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon>{{ current.icon }}</v-icon>
        <span class="text-subtitle-1">{{ current.label }}</span>
        <v-chip size="small" variant="tonal">{{ current.tabs.length }} 个子页</v-chip>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">{{ current.hint }}</span>
      </v-card-title>

      <!-- 小标签：内部切换（`v-model` 绑到 `wanted`；显示用的是带兜底的 `sub`） -->
      <v-tabs :model-value="sub" density="compact" color="primary" class="px-4" @update:model-value="(v: unknown) => (wanted = String(v))">
        <v-tab v-for="t in current.tabs" :key="t.key" :value="t.key" :prepend-icon="t.icon">{{ t.label }}</v-tab>
      </v-tabs>
      <v-divider />

      <v-card-text>
        <!-- ⚠️ 关键点：小标签里**直接挂载现有页面组件**（不复制逻辑）。
             实测确认：Vuetify 的 v-tabs 默认不 keep-alive，切走会卸载、切回会重新挂载 ——
             与本项目"两个薄页面共用 RunWorkspace"的做法一致，可行。 -->
        <TrackEditorPage v-if="sub === 'track-editor'" />
        <MornsignZonePage v-else-if="sub === 'mornsign-zone'" />
        <RecordsPage v-else-if="sub === 'records'" />
        <LogsPage v-else-if="sub === 'logs'" />
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 「大标签 + 内部小标签」**示例页**（2026-09-20，用户要求先做示例再动真项目）
 *
 * 想验证/展示的三件事：
 *  ① 嵌套标签里能不能**直接挂载现有页面组件**（不复制任何逻辑）；
 *  ② 合并后导航会从 9 项缩到 6 项，且**每个子页仍可深链**（正式版会用 query 参数，如 `/tools?tab=logs`）；
 *  ③ 切走再切回时组件会重新挂载（Vuetify `v-tabs` 默认不 keep-alive）—— 这决定了"页面里的状态是否要外提"。
 *
 * ⚠️ 本页**只读现有页面组件**、不改它们；但它挂载的是**真组件**，所以在这里的改动会落到本机真实配置
 *    （例如在「跑道编辑」里保存、在「签到区域」里拖滑杆）。示例阶段请只做"看一眼"的操作。
 */
import TrackEditorPage from '~/pages/track-editor.vue'
import MornsignZonePage from '~/pages/mornsign-zone.vue'
import RecordsPage from '~/pages/records.vue'
import LogsPage from '~/pages/logs.vue'

const GROUPS = [
  {
    key: 'field',
    label: '我的场地',
    icon: 'mdi-map-marker-radius',
    hint: '与"你描的几何 / 签到落点"有关',
    tabs: [
      { key: 'track-editor', label: '跑道编辑', icon: 'mdi-vector-polyline' },
      { key: 'mornsign-zone', label: '签到区域', icon: 'mdi-map-marker-radius-outline' },
    ],
  },
  {
    key: 'data',
    label: '数据',
    icon: 'mdi-database-outline',
    hint: '记录与日志',
    tabs: [
      { key: 'records', label: '记录', icon: 'mdi-format-list-bulleted' },
      { key: 'logs', label: '日志', icon: 'mdi-text-box-search-outline' },
    ],
  },
] as const

type GroupKey = (typeof GROUPS)[number]['key']
const group = ref<GroupKey>('field')
/** 期望的小标签（可能与当前大标签不匹配 —— 见下面的兜底） */
const wanted = ref<string>('track-editor')
const current = computed(() => GROUPS.find((g) => g.key === group.value) ?? null)

/**
 * 实际生效的小标签：**如果期望值不属于当前大标签，就回落到该组第一个**。
 *
 * ⚠️ 这里踩过坑（示例第一版就是错的）：我原来用 `watch(group, () => { sub.value = current.tabs[0].key })`，
 *    点大标签后**小标签没归位 ⇒ 内容空白**。原因是 `watch` 回调里读 `current` 有 **flush 时序**问题
 *    （默认 `pre`，回调执行时 `group` 变了但派生值未必已更新；实测拿到的是上一组）。
 *    **改成"派生 + 兜底"就没有时序问题了** —— 不依赖任何回调顺序，永远自洽。
 *    判据：**跨状态设置另一个状态时，优先用 computed 派生而不是 watch 赋值。**
 */
const sub = computed(() => {
  const tabs = current.value?.tabs ?? []
  return tabs.some((t) => t.key === wanted.value) ? wanted.value : (tabs[0]?.key ?? '')
})

useHead({ title: '示例：合并标签页 · 龙猫天堂' })
</script>
