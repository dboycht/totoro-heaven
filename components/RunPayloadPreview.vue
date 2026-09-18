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
          共 {{ run.result?.detailRequest.pointList.length }} 个轨迹点（此处只预览前 3 个）
        </div>
        <pre class="json-box">{{ pretty(detailPreview) }}</pre>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>

<script setup lang="ts">
import type { DemoRunState } from '~/composables/useMpDemo'

/**
 * 两个提交报文预览（`sunRunExercises` / `sunRunExercisesDetail`）的折叠面板 + 复制按钮。
 * 轨迹报文只预览前 3 个点（与页面上原本的 `detailPreview` 口径一致）。
 */
const props = defineProps<{
  run: DemoRunState
}>()

const showSnackbar = useNotice()

const pretty = (value: unknown) => JSON.stringify(value, null, 2)
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
