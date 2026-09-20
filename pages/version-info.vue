<template>
  <div>
    <!-- 🚫 谢绝公开分享（2026-09-20 用户要求：软件内要有这条说明；与 README /「关于」同一口径） -->
    <v-alert type="error" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-share-off-outline</v-icon>谢绝公开分享
      </div>
      <div class="text-body-2">
        本工具<b>仅供本人自用</b>：请勿公开分享、转发或二次分发，也不要代他人运行、代他人提交
        —— 传播范围越大，校方与厂商收紧风控越快，最后大家都用不了；
        而且<b>真实提交是你本人的账号行为</b>，替别人跑等于把风险转嫁给别人。
      </div>
      <div class="text-caption mt-1">本项目完全免费、无任何收费或推广；若在别处看到有人收费售卖，与本项目无关。</div>
    </v-alert>

    <!-- 版本建议（文字说明保留；用户 2026-09-16 要求：只显示"当前版本"的贺图与文字，且不出现任何文件路径）
         ⚠️ 2026-09-20：不再显示"预计发布日期"（写死的日期一过期就变成错信息），改为**从版本条目里取当前正式版**。 -->
    <v-alert type="info" variant="flat" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-information-outline</v-icon>版本建议
      </div>
      <div class="text-body-2">
        建议使用 <b>{{ VERSION_ADVICE.recommended }}</b> 的发行版（当前正式版 <b>{{ stableVersion }}</b>）；
        此前 <b>{{ VERSION_ADVICE.preview }}</b> 均为<b>预览测试版</b>。
      </div>
    </v-alert>

    <!-- 当前版本：贺图 + 更新日志 -->
    <v-card class="version-card">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon :color="entry.channel === 'stable' ? 'success' : 'primary'" class="mr-1">
          {{ entry.channel === 'stable' ? 'mdi-star-circle-outline' : 'mdi-test-tube' }}
        </v-icon>
        <span class="text-h6">{{ entry.version }}</span>
        <v-chip size="small" :color="entry.channel === 'stable' ? 'success' : 'primary'" variant="tonal">
          {{ channelText(entry.channel) }}
        </v-chip>
        <v-chip v-if="isCurrentEntry" size="small" color="primary" variant="flat">当前版本</v-chip>
        <v-chip v-else size="small" variant="tonal" color="warning">当前运行 v{{ currentVersion }}（开发中）</v-chip>
        <v-chip v-if="entry.date" size="small" variant="text" class="text-medium-emphasis">{{ entry.date }}</v-chip>
      </v-card-title>

      <v-card-text>
        <!-- 一句话标题：**放在正文第一行**（原先挂在标题栏右侧、被 spacer 顶到最右，读起来别扭） -->
        <div class="text-subtitle-1 font-weight-medium mb-3">{{ entry.title }}</div>
        <v-row dense>
          <v-col cols="12" md="7">
            <VersionArt :version="entry.version" />
          </v-col>
          <v-col cols="12" md="5">
            <div class="text-body-2 font-weight-bold mb-1">更新日志</div>
            <ul class="text-body-2 pl-4">
              <li v-for="(h, i) in entry.highlights" :key="i" class="mb-1">{{ h }}</li>
            </ul>
            <div v-if="entry.note" class="text-caption text-medium-emphasis mt-2">{{ entry.note }}</div>
            <div v-if="!isCurrentEntry" class="text-caption text-medium-emphasis mt-2">
              当前运行的是 v{{ currentVersion }}（开发中，暂无独立更新日志），上面显示的是最近一个有记录的版本。
            </div>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 「版本信息」：只展示**当前运行版本**的贺图与更新日志（用户 2026-09-16 要求）。
 *
 * - 当前版本来自 `app.config.ts`（单一来源：`package.json` 的 version）；
 * - ⚠️ 版本号刚 +1（如 1.1.6 → 1.1.7）时，新版本往往**还没有条目**：
 *   此时**退回显示"最新的、且不晚于当前版本"的已记录版本**（跳过 `planned` 计划项），
 *   并在卡片上标明「当前运行 vX（开发中）」，避免出现空的"贺图待补充 / 暂无更新日志"；
 * - 贺图按 `/version-art/<版本号>.<ext>` 自动匹配，找不到就显示"待补充"（**不显示任何文件路径**）。
 */
import { VERSION_ADVICE, VERSION_ENTRIES, channelText } from '~/src/mp/releaseArt'
import type { VersionEntry } from '~/src/mp/releaseArt'
import { isNewerVersion } from '~/utils/mp/version'

const appConfig = useAppConfig()
const currentVersion = computed(() => String(appConfig.version || 'dev'))

const entry = computed<VersionEntry>(() => {
  const v = currentVersion.value
  // ① 当前版本自己有记录 → 直接用
  const exact = VERSION_ENTRIES.find((e) => e.version === v && !e.planned)
  if (exact) return exact
  // ② 没有（刚 +1 的开发版本）→ 退回到"最新且不晚于当前版本"的已记录版本
  const fallback = VERSION_ENTRIES.find((e) => !e.planned && !isNewerVersion(e.version, v))
  if (fallback) return fallback
  // ③ 连可退回的都没有 → 最小条目
  return {
    version: v,
    date: '',
    channel: 'preview',
    title: '当前版本',
    highlights: ['本版本暂无更新日志条目。'],
  }
})

/** 卡片上的版本是否就是"当前运行版本"（否则说明这里显示的是最近一个有记录的版本） */
const isCurrentEntry = computed(() => entry.value.version === currentVersion.value)

/**
 * 当前**已发布的正式版**：取条目里第一个"非 planned 的 stable 版本"。
 * ⚠️ 2026-09-20：原先这里显示 `VERSION_ADVICE.recommendedEta`（"预计 X.X 发布"）——
 * 那是个**写死的日期**，一旦过期就变成错误信息（1.2.0 那次就是这样）。
 * 现在改成从版本列表里**推导**，不会再过期。
 */
const stableVersion = computed(() => VERSION_ENTRIES.find((e) => e.channel === 'stable' && !e.planned)?.version ?? '—')

useHead({ title: '版本信息 · 龙猫天堂' })
</script>

<style scoped>
/*
 * 进场动画（2026-09-18）：卡片淡入上浮，贺图再晚一点点淡入 —— 只有页面首次进入时播一次。
 * ⚠️ 刻意不用 `#__nuxt` 级或全局选择器，避免与 Vuetify 的过渡打架；也不做循环动画（会分心）。
 */
.version-card {
  animation: version-card-in 0.42s cubic-bezier(0.22, 0.61, 0.36, 1) both;
}
@keyframes version-card-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 贺图本身淡入+轻微放大（延迟到卡片基本落位之后，观感更连贯） */
.version-card :deep(.art-img),
.version-card :deep(.art-placeholder) {
  animation: version-art-in 0.5s ease 0.08s both;
}
@keyframes version-art-in {
  from {
    opacity: 0;
    transform: scale(1.015);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* 尊重"减少动态效果"偏好 */
@media (prefers-reduced-motion: reduce) {
  .version-card,
  .version-card :deep(.art-img),
  .version-card :deep(.art-placeholder) {
    animation: none;
  }
}
</style>
