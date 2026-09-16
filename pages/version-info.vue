<template>
  <div>
    <v-alert type="info" variant="flat" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-information-outline</v-icon>版本建议
      </div>
      <div class="text-body-2">
        建议使用 <b>{{ VERSION_ADVICE.recommended }}</b> 的发行版（预计 <b>{{ VERSION_ADVICE.recommendedEta }}</b> 发布）；
        目前 <b>{{ VERSION_ADVICE.preview }}</b> 均为<b>预览测试版</b>。
        <br />每个版本会配一张贺图，下面是各版本的<b>贺图 + 更新日志</b>（最新在最前）。
      </div>
    </v-alert>

    <v-card v-for="v in VERSION_ENTRIES" :key="v.version" class="mb-4">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon :color="v.channel === 'stable' ? 'success' : 'primary'" class="mr-1">
          {{ v.channel === 'stable' ? 'mdi-star-circle-outline' : 'mdi-test-tube' }}
        </v-icon>
        <span class="text-h6">{{ v.version }}</span>
        <v-chip size="small" :color="v.channel === 'stable' ? 'success' : 'primary'" variant="tonal">
          {{ channelText(v.channel) }}
        </v-chip>
        <v-chip v-if="v.planned" size="small" variant="tonal" color="warning">计划 / 开发中</v-chip>
        <v-chip size="small" variant="text">{{ v.date }}</v-chip>
        <v-spacer />
        <span class="text-body-2 text-medium-emphasis">{{ v.title }}</span>
      </v-card-title>

      <v-card-text>
        <v-row dense>
          <v-col cols="12" md="7">
            <VersionArt :version="v.version" />
          </v-col>
          <v-col cols="12" md="5">
            <div class="text-body-2 font-weight-bold mb-1">更新日志</div>
            <ul class="text-body-2 pl-4">
              <li v-for="(h, i) in v.highlights" :key="i" class="mb-1">{{ h }}</li>
            </ul>
            <div v-if="v.note" class="text-caption text-medium-emphasis mt-2">{{ v.note }}</div>
            <div class="text-caption text-medium-emphasis mt-2">
              贺图路径：<code>public/version-art/{{ v.version }}.png</code>
            </div>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-alert type="info" variant="tonal" density="compact">
      想让某个版本的贺图出现？把图片按 <code>public/version-art/&lt;版本号&gt;.png</code> 命名放进那个目录即可
      （详见 <code>public/version-art/README.md</code>）；更新日志在 <code>src/mp/releaseArt.ts</code> 里维护。
    </v-alert>
  </div>
</template>

<script setup lang="ts">
import { VERSION_ADVICE, VERSION_ENTRIES, channelText } from '~/src/mp/releaseArt'

useHead({ title: '版本信息 · 龙猫天堂' })
</script>
