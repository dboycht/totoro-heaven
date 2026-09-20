<template>
  <div>
    <!-- `flat` 模式：**只渲染分组标题与标签条，不用 v-card 包内容**。
         为什么需要它：跑步页（RunWorkspace）自带上百行的多张卡片布局，
         再套一层 `v-card` + `v-card-text` 会出现"两层标题区"、且 `v-row` 的负外边距与卡内边距打架
         （视觉上手感不对）。判据：**内容自带卡片布局时用 flat；内容是普通表单/表格时用默认（带卡）**。 -->
    <template v-if="flat">
      <div class="d-flex align-center flex-wrap ga-2 mb-2">
        <v-icon>{{ group.icon }}</v-icon>
        <span class="text-subtitle-1">{{ group.label }}</span>
        <v-chip size="small" variant="tonal">{{ group.tabs.length }} 个子页</v-chip>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">{{ group.hint }}</span>
      </div>
      <v-tabs :model-value="activeKey" density="compact" color="primary" class="mb-2">
        <v-tab v-for="t in group.tabs" :key="t.key" :value="t.key" :to="`${group.base}/${t.key}`" :prepend-icon="t.icon">
          {{ t.label }}
        </v-tab>
      </v-tabs>
      <v-divider class="mb-4" />
      <slot />
    </template>

    <v-card v-else>
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon>{{ group.icon }}</v-icon>
        <span class="text-subtitle-1">{{ group.label }}</span>
        <v-chip size="small" variant="tonal">{{ group.tabs.length }} 个子页</v-chip>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">{{ group.hint }}</span>
      </v-card-title>

      <!-- 小标签：**每个子页都是独立路由**（`to=...`）⇒ 刷新/后退/分享都正确，
           也让"标签状态"没有额外状态可维护（避免 watch 时序那类坑）。 -->
      <v-tabs :model-value="activeKey" density="compact" color="primary" class="px-4">
        <v-tab v-for="t in group.tabs" :key="t.key" :value="t.key" :to="`${group.base}/${t.key}`" :prepend-icon="t.icon">
          {{ t.label }}
        </v-tab>
      </v-tabs>
      <v-divider />

      <v-card-text>
        <slot />
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 「大标签分组」通用外壳（2026-09-20）
 *
 * 用户 2026-09-20 要求把 4 个平级页面收成 2 个分组：
 *   我的场地 = 跑道编辑 + 签到区域；数据 = 记录 + 日志。
 *
 * 设计要点（为什么这么做）：
 *   · **小标签 = 独立路由**（`/field/track-editor`），不是纯前端状态：
 *     刷新、浏览器后退、分享链接都正确；也省掉了"切大标签时归位小标签"那类状态同步
 *     （示例版用 watch 赋值时正好踩了 flush 时序的坑 ⇒ 内容空白，见 `DEVELOPMENT §24`）。
 *   · **两个分组共用这一个组件**：分组定义传进来，避免两份几乎一样的模板/脚本。
 *   · `activeKey` 从**当前路径**派生（`/field/mornsign-zone` ⇒ `mornsign-zone`）；
 *     若路径不在本组子页里（例如误访问 `/field`），回落到第一个子页，**永远有内容可渲染**。
 */
export interface TabGroupTab {
  key: string
  label: string
  icon: string
}
export interface TabGroupDef {
  /** 分组基路径，如 `/field` */
  base: string
  label: string
  icon: string
  hint: string
  /**
   * ⚠️ 用 `readonly` 数组：调用方为了拿到字面量类型会写 `as const`（例如 `base: '/field'`），
   *    那样得到的是 `readonly [...]`；若这里声明成可变数组，`as const` 的对象就**赋不进来**（TS2322）。
   *    判据：**库/组件的入参类型要接受只读形态**（`readonly T[]` / `ReadonlyArray<T>`），
   *    否则调用方被迫去掉 `as const`，反而丢掉字面量类型与拼写检查。
   */
  tabs: readonly TabGroupTab[]
}

const props = defineProps<{ group: TabGroupDef; flat?: boolean }>()
const route = useRoute()

/** 当前生效的小标签：从路径最后一段派生，**带兜底**（不在本组就回落到第一个） */
const activeKey = computed(() => {
  const seg = String(route.path ?? '').split('/').filter(Boolean).pop() ?? ''
  return props.group.tabs.some((t) => t.key === seg) ? seg : (props.group.tabs[0]?.key ?? '')
})
</script>
