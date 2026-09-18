<template>
  <div>
    <!-- 版本建议（文字说明保留；用户 2026-09-16 要求：只显示"当前版本"的贺图与文字，且不出现任何文件路径） -->
    <v-alert type="info" variant="flat" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-information-outline</v-icon>版本建议
      </div>
      <div class="text-body-2">
        建议使用 <b>{{ VERSION_ADVICE.recommended }}</b> 的发行版（预计 <b>{{ VERSION_ADVICE.recommendedEta }}</b> 发布）；
        目前 <b>{{ VERSION_ADVICE.preview }}</b> 均为<b>预览测试版</b>。
      </div>
    </v-alert>

    <!-- 当前版本：贺图 + 更新日志 -->
    <v-card>
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

useHead({ title: '版本信息 · 龙猫天堂' })
</script>
