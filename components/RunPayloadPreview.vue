<template>
  <v-expansion-panels v-if="run.result" variant="accordion" class="mt-3">
    <v-expansion-panel title="sunRunExercises 提交报文（18 字段）">
      <v-expansion-panel-text>
        <div class="d-flex justify-end mb-1">
          <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy(run.result?.scoreRequest)">复制</v-btn>
        </div>
        <pre class="json-box">{{ pretty(run.result?.scoreRequest) }}</pre>
      </v-expansion-panel-text>
    </v-expansion-panel>
    <v-expansion-panel title="sunRunExercisesDetail 轨迹报文">
      <v-expansion-panel-text>
        <div class="text-caption text-medium-emphasis mb-1">
          共 {{ run.result?.detailRequest?.pointList?.length ?? 0 }} 个轨迹点（此处只预览前 3 个）
        </div>
        <pre class="json-box">{{ pretty(detailPreview) }}</pre>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<script setup lang="ts">
import type { DemoRunState } from '~/composables/useMpDemo'
import { maskPayloadTokens } from '~/utils/mp/maskPayload'

/**
 * 两个提交报文预览（`sunRunExercises` / `sunRunExercisesDetail`）的折叠面板 + 复制按钮。
 * 轨迹报文只预览前 3 个点（与页面上原本的 `detailPreview` 口径一致）。
 *
 * ⚠️ 2026-09-20 审计修复（隐私口径）：这两个报文里都带 `token`（本机会话凭据），
 * 原先**原样打印 + 一点「复制」就进剪贴板**。真实提交那条路径早就会掩码
 * （`real/submit.ts` 的 `scoreRequestMasked`），只有这里漏了 ⇒ 现在统一走
 * `maskPayloadTokens()`（纯函数、有单测）：**显示与复制都以掩码为准**，底层报文不动。
 */
const props = defineProps<{
  run: DemoRunState
}>()

const showSnackbar = useNotice()

/** 统一的展示/复制口径：先把 token 掩码，再序列化（显示与复制共用同一份，避免两处不一致） */
const pretty = (value: unknown) => JSON.stringify(maskPayloadTokens(value), null, 2)
const detailPreview = computed(() => {
  const detail = props.run.result?.detailRequest
  if (!detail) return null
  return { ...detail, pointList: detail.pointList.slice(0, 3) }
})

const copy = async (value: unknown) => {
  try {
    await navigator.clipboard.writeText(pretty(value))
    showSnackbar('已复制到剪贴板', 'success')
  } catch {
    showSnackbar('复制失败（浏览器未授权剪贴板）', 'warning')
  }
}
</script>

<style scoped>
.json-box {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: #101418;
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
