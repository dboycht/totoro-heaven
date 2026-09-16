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
        <v-chip size="small" variant="text">当前版本</v-chip>
        <v-chip v-if="entry.date" size="small" variant="text">{{ entry.date }}</v-chip>
        <v-spacer />
        <span class="text-body-2 text-medium-emphasis">{{ entry.title }}</span>
      </v-card-title>

      <v-card-text>
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
 * - 贺图按 `/version-art/<版本号>.<ext>` 自动匹配，找不到就显示"待补充"（**不显示任何文件路径**）；
 * - 历史版本的更新日志仍保留在 `src/mp/releaseArt.ts`，需要时可再开启列表展示。
 */
import { VERSION_ADVICE, VERSION_ENTRIES, channelText } from '~/src/mp/releaseArt'
import type { VersionEntry } from '~/src/mp/releaseArt'

const appConfig = useAppConfig()
const currentVersion = computed(() => String(appConfig.version || 'dev'))

/** 当前版本的条目；`releaseArt.ts` 里没有该版本时，退化成一个最小条目（贺图仍会尝试加载） */
const entry = computed<VersionEntry>(() => {
  const v = currentVersion.value
  return (
    VERSION_ENTRIES.find((e) => e.version === v) ?? {
      version: v,
      date: '',
      channel: 'preview',
      title: '当前版本',
      highlights: ['本版本暂无更新日志条目。'],
    }
  )
})

useHead({ title: '版本信息 · 龙猫天堂' })
</script>
