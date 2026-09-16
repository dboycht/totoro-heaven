<template>
  <div class="art-wrap">
    <img v-if="current" :src="current" :alt="`${version} 贺图`" class="art-img" @error="tryNext" />
    <div v-else class="art-placeholder">
      <v-icon size="44" color="medium-emphasis">mdi-image-outline</v-icon>
      <div class="text-body-2 mt-2 font-weight-bold">这个版本的贺图还没放进来</div>
      <div class="text-caption text-medium-emphasis mt-1">
        把图片放到 <code>public/version-art/{{ version }}.png</code>
        （也支持 <code>.jpg</code> / <code>.jpeg</code> / <code>.webp</code> / <code>.svg</code>）即可自动显示
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 版本贺图：按 `public/version-art/<版本号>.<扩展名>` 依次尝试，全部失败则显示占位提示。
 * （用户 2026-09-16 要求：每个版本他会做一张贺图，网页「版本信息」里展示。）
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
