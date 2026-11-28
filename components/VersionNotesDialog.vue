<template>
  <!--
    「版本更新」弹窗（2026-11-28，用户口径）
    · 启动新版本时弹一次，说明这一版更新了什么；文案由用户用独立小编辑器写进
      `public/version-notes/<版本>.md`（解析规则见 `utils/mp/versionNotes.ts`）；
    · 组件本身不管状态：开关/版本/解析结果全由 `layouts/default.vue` 传进来（哑组件，好测）。
    · ⚠️ 文案渲染只用文本节点（`{{ }}` / `<strong>`），不碰 `v-html` —— 文案里写 HTML 也只是字面文字。
  -->
  <v-dialog :model-value="modelValue" max-width="620" scrollable @update:model-value="onDialogToggle">
    <v-card>
      <v-card-title class="d-flex align-center ga-2 pt-4">
        <v-icon color="primary">mdi-party-popper</v-icon>
        <span>v{{ version }} 更新了什么</span>
      </v-card-title>
      <v-card-subtitle class="text-caption">
        这一版的具体改动（整理自本机版本说明；完整历史见「版本」页）
      </v-card-subtitle>
      <v-card-text class="pt-2">
        <div v-if="notes.isEmpty" class="text-body-2 text-medium-emphasis">
          本版没有填写更新说明。
        </div>
        <template v-else>
          <template v-for="(block, i) in notes.blocks" :key="`b-${i}`">
            <ul v-if="block.kind === 'ul'" class="pl-5 mb-3">
              <li v-for="(item, j) in block.items" :key="`i-${j}`" class="text-body-2 mb-1">
                <template v-for="(seg, k) in item" :key="`s-${k}`">
                  <strong v-if="seg.bold">{{ seg.text }}</strong>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </li>
            </ul>
            <component
              :is="block.kind === 'h' ? `h${block.level ?? 2}` : 'p'"
              v-else
              :class="block.kind === 'h' ? 'text-subtitle-2 text-primary mb-2 mt-4' : 'text-body-2 mb-3'"
            >
              <template v-for="(seg, k) in block.text" :key="`s-${k}`">
                <strong v-if="seg.bold">{{ seg.text }}</strong>
                <template v-else>{{ seg.text }}</template>
              </template>
            </component>
          </template>
        </template>
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-btn variant="text" prepend-icon="mdi-history" @click="goVersionPage">看完整版本说明</v-btn>
        <v-spacer />
        <v-btn color="primary" variant="flat" @click="close">知道了</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * 哑组件：只负责画。状态在 `useVersionNotes()`（被 `layouts/default.vue` 调用）。
 * 关闭有两条路径（点「知道了」/ 点「看完整版本说明」/ 按 Esc / 点遮罩）—— **都要标记已读**，
 * 否则下次启动还会弹同一版（用户会以为弹窗坏了）。
 */
import type { ParsedVersionNotes } from '~/utils/mp/versionNotes'

const props = defineProps<{
  modelValue: boolean
  version: string
  notes: ParsedVersionNotes
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'seen'): void
}>()

const close = () => emit('seen')

/** v-dialog 自己关（Esc / 遮罩 / 关闭按钮）也按"看过"处理 */
const onDialogToggle = (value: boolean) => {
  if (value) emit('update:modelValue', true)
  else emit('seen')
}

const goVersionPage = () => {
  emit('seen')
  void navigateTo('/version-info')
}
</script>