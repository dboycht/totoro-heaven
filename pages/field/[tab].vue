<template>
  <TabGroupShell :group="GROUP">
    <!-- ⚠️ 这里挂的是**现有页面组件**（不复制逻辑）；与 `pages/*.vue` 那些薄页面是同一个组件 -->
    <TrackEditorView v-if="tab === 'track-editor'" />
    <MornsignZoneView v-else-if="tab === 'mornsign-zone'" />
    <!-- 2026-09-22 结构调整：非官方路径绘制从「跑道编辑」里搬出来，与上面两个子页**同级** -->
    <FreePathView v-else-if="tab === 'free-path'" />
    <!-- 2026-11-03（1.3.6 需求③）：「真实路径」【测试】—— 某天真实跑的轨迹 → 本机预设 / 分享包 -->
    <RealPathView v-else-if="tab === 'real-path'" />
  </TabGroupShell>
</template>

<script setup lang="ts">
/**
 * 「我的场地」分组：`/field/track-editor`、`/field/mornsign-zone`、`/field/free-path`、`/field/real-path`
 * （2026-09-20 分组重构；本机路径页 2026-09-22 加；2026-09-29 改名为「研途健行路径编辑器」；
 *  🆕 2026-11-03 加「真实路径」【测试】）
 *
 * ⚠️ 为什么是**动态段** `[tab].vue` 而不是 `index.vue + 两个子文件`：
 *    Nuxt 按**文件**生成路由 —— `pages/field/index.vue` 只对应 `/field` 本身，
 *    写成那样时 `/field/track-editor` 会 404（实测报 `Page not found`，14 条断言失败）。
 *    用一个 `[tab].vue` 吃下本组所有子标签，既不需要把外壳复制两份，也不用三个文件。
 *
 * `validate` 把非法 tab 直接判为 404（**不静默回落到第一个**）：URL 写错时应当看得见，
 * 而不是"地址是错的、内容却是别的页"。
 *
 * 🆕 2026-09-22（用户原话："非官方路径编辑放到与**签到区域**、**跑道编辑**同级的地方"）：
 *    子页 key `free-path`、组件 `components/FreePathView.vue`。
 *    ⚠️ 三处必须**同时**改，漏一处就是"URL 能开、内容却是别的页"或 404：
 *      ① 本文件的 `validate` 白名单；② 本文件的 `GROUP.tabs`；③ 模板分支 + 显式 import。
 *    （照「数据 → 诊断」那一支的先例：`pages/data/[tab].vue` 的 `diagnostics`。）
 *
 * 🆕 2026-09-29（用户口径："将非法路径编辑器重命名为研途健行路径编辑器"）：
 *    **只改显示名**（label + 页面内的标题/文案）——
 *    路由 `/field/free-path`、tab key `free-path`、固定存储键 `local:free` **一律保留**
 *    （用户明确选择"只改显示名，路由与存储键全保留" ⇒ 零迁移风险，旧书签与旧数据都不动）。
 *
 * 🆕 2026-11-03（需求③）：新增子页 key `real-path`、组件 `components/RealPathView.vue`，
 *    标签名「真实路径」，按钮/卡片上标【测试】（用户要求"相关功能标注为「测试」"）。
 *    同样三处一起改：`validate` 白名单 / `GROUP.tabs` / 模板分支 + import。
 */
import TrackEditorView from '~/components/TrackEditorView.vue'
import MornsignZoneView from '~/components/MornsignZoneView.vue'
import FreePathView from '~/components/FreePathView.vue'
import RealPathView from '~/components/RealPathView.vue'

definePageMeta({
  validate: (route) => ['track-editor', 'mornsign-zone', 'free-path', 'real-path'].includes(String(route.params.tab ?? '')),
})

const route = useRoute()
const tab = computed(() => String(route.params.tab ?? ''))

const GROUP = {
  base: '/field',
  label: '我的场地',
  icon: 'mdi-map-marker-radius',
  hint: '与"你描的几何 / 签到落点 / 真实路径"有关',
  tabs: [
    { key: 'track-editor', label: '跑道编辑', icon: 'mdi-vector-polyline' },
    { key: 'mornsign-zone', label: '签到区域', icon: 'mdi-map-marker-radius-outline' },
    { key: 'free-path', label: '研途健行路径', icon: 'mdi-vector-curve' },
    { key: 'real-path', label: '真实路径【测试】', icon: 'mdi-map-marker-path' },
  ],
} as const

useHead({ title: '我的场地 · 龙猫天堂' })
</script>
