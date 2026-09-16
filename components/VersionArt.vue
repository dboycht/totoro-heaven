<template>
  <div class="art-wrap">
    <img v-if="current" :src="current" :alt="`${version} 贺图`" class="art-img" @error="tryNext" />
    <div v-else class="art-placeholder">
      <v-icon size="44" color="medium-emphasis">mdi-image-outline</v-icon>
      <div class="text-body-2 mt-2">该版本的贺图待补充</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 版本贺图：按 `public/version-art/<版本号>.<扩展名>` 依次尝试（png→jpg→jpeg→webp→svg）。
 *
 * ⚠️ 2026-09-16 用户要求：**界面上不显示任何文件路径**（占位文案只写"待补充"）。
 */
import { VERSION_ART_EXTS, versionArtPath } from '~/src/mp/releaseArt'

const props = defineProps<{ version: string }>()

const idx = ref(0)
const current = computed(() => (idx.value < VERSION_ART_EXTS.length ? `${versionArtPath(props.version)}.${VERSION_ART_EXTS[idx.value]}` : ''))

/** 当前扩展名加载失败 → 换下一个；全试过则显示占位 */
const tryNext = () => {
  idx.value += 1
}
</script>

<style scoped>
.art-wrap {
  width: 100%;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.art-img {
  display: block;
  width: 100%;
  height: auto;
}
.art-placeholder {
  padding: 28px 16px;
  text-align: center;
}
</style>
