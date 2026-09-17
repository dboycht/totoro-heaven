<template>
  <v-card v-if="run.result" class="mt-4">
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon :color="run.result.check.pass ? 'success' : 'error'" class="mr-2">
        {{ run.result.check.pass ? 'mdi-check-decagram' : 'mdi-alert-circle-outline' }}
      </v-icon>
      结算（本地预判）
      <v-chip :color="run.result.check.pass ? 'success' : 'error'" variant="flat" size="small">
        {{ run.result.check.pass ? '预计合格' : '预计不合格' }}
      </v-chip>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">
        {{ run.result.km.toFixed(2) }} km · {{ formatDuration(run.result.durationSeconds) }} ·
        拟合度 {{ run.result.fitDegree.toFixed(2) }}
      </span>
    </v-card-title>
    <v-card-text>
      <v-table density="compact" class="mb-3">
        <thead>
          <tr>
            <th style="width: 140px">校验项</th>
            <th>实际情况</th>
            <th style="width: 90px">结论</th>
            <th style="width: 90px">口径</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in run.result.check.items" :key="item.key">
            <td>{{ item.label }}</td>
            <td class="text-body-2">{{ item.detail }}</td>
            <td>
              <v-icon v-if="item.ok === true" color="success" size="18">mdi-check</v-icon>
              <v-icon v-else-if="item.ok === false" :color="item.confidence === 'hard' ? 'error' : 'warning'" size="18">
                {{ item.confidence === 'hard' ? 'mdi-close' : 'mdi-alert-outline' }}
              </v-icon>
              <v-icon v-else color="warning" size="18">mdi-help</v-icon>
            </td>
            <td>
              <v-chip
                size="x-small"
                variant="tonal"
                :color="confidenceColor(item.confidence)"
                :title="item.note || undefined"
              >
                {{ confidenceText(item.confidence) }}
              </v-chip>
            </td>
          </tr>
        </tbody>
      </v-table>
      <div v-if="run.result.check.problems.length" class="text-body-2 text-error mb-2">
        硬性不通过：{{ run.result.check.problems.join('；') }}
      </div>
      <div v-if="run.result.statsProblems.length" class="text-body-2 text-warning mb-2">
        自洽校验告警：{{ run.result.statsProblems.join('；') }}
      </div>
      <div class="text-caption text-medium-emphasis mb-3">
        口径说明：<b>硬性</b> = 本地能确定判的（参与预判）；<b>待实测</b> = 单位或"服务端是否强校验"的<b>边界</b>未验证的项，
        只提示、<b>不阻断</b>（这类项的中段数值已随真实提交验证过；边界要验证得做"贴边提交"，会在账号留异常记录，故故意不做）。
        把鼠标停在「口径」标签上可看各项的具体依据。
        步数提交值 <code>"{{ run.result.stepsSubmitted }}"</code>（照实测真包口径）。
      </div>
      <!-- ⚠️ 插槽：拆分前「结算表 + 真实提交」是**同一张卡、同一个 v-card-text**。
           把提交段放在这里（而不是另起一张卡），渲染出来的 DOM 才与拆分前**完全一致**
           —— 否则会多出一层卡片边框与间距（这一处曾被结构对照脚本抓出来）。 -->
      <slot />
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import type { DemoRunState } from '~/composables/useMpDemo'
import { formatDuration } from '~/utils/mp/runData'

/** 结算（本地预判）卡片：自检表 + 硬性/自洽问题 + 口径说明。纯展示（`run.result` 为空时整卡不渲染） */
defineProps<{
  run: DemoRunState
}>()

const confidenceText = (value: string) => ({ hard: '硬性', inferred: '待实测', info: '仅展示' })[value] ?? value
const confidenceColor = (value: string) => ({ hard: 'success', inferred: 'warning', info: 'info' })[value] ?? 'info'
</script>
