<template>
  <v-card>
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
      {{ activeTask?.paperName ?? '（未载入任务）' }}
      <v-chip size="small" variant="tonal" :color="statusColor">{{ statusText }}</v-chip>
      <v-spacer />
      <v-chip v-if="run.plan && run.status !== 'idle'" size="small" variant="tonal" color="info">
        本次计划 {{ run.plan.targetKm }} km · {{ formatDuration(run.plan.durationSeconds) }} ·
        {{ formatPace(run.paceSecPerKm) }}/km
      </v-chip>
    </v-card-title>
    <v-card-subtitle v-if="activeTask">
      目标 {{ activeTask.mileage }} km · 拟合度阈值 {{ activeTask.fitDegree }} · 有效期 {{ formatTaskPeriod(activeTask) }}
    </v-card-subtitle>
    <v-card-text>
      <v-row dense>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">已跑里程</div>
          <div class="text-h5 font-weight-bold">{{ (run.distanceM / 1000).toFixed(2) }}<span class="text-body-2"> km</span></div>
        </v-col>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">已用时长</div>
          <div class="text-h5 font-weight-bold">{{ formatDuration(run.elapsedS) }}</div>
        </v-col>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">平均配速</div>
          <div class="text-h5 font-weight-bold">{{ paceText }}</div>
        </v-col>
        <v-col cols="6" sm="3">
          <div class="text-caption text-medium-emphasis">拟合度（自算）</div>
          <div class="text-h5 font-weight-bold" :class="fitClass">{{ run.fitDegree.toFixed(2) }}</div>
        </v-col>
      </v-row>

      <v-progress-linear :model-value="progress * 100" height="10" rounded color="primary" class="mt-4" />
      <div class="d-flex justify-space-between text-caption text-medium-emphasis mt-1">
        <span>{{ (progress * 100).toFixed(1) }}% / 目标 {{ run.targetKm }} km</span>
        <span>轨迹点 {{ run.visibleCount }} / {{ run.points.length }}</span>
      </div>

      <v-row dense class="mt-4">
        <v-col cols="4">
          <v-card variant="tonal" color="info">
            <v-card-text class="text-center py-2">
              <div class="text-caption">应过点</div>
              <div class="text-h6">{{ run.passPoints.all }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="4">
          <v-card variant="tonal" color="success">
            <v-card-text class="text-center py-2">
              <div class="text-caption">已过点</div>
              <div class="text-h6">{{ run.passPoints.done }}</div>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="4">
          <v-card variant="tonal" color="warning">
            <v-card-text class="text-center py-2">
              <div class="text-caption">未过点</div>
              <div class="text-h6">{{ run.passPoints.notPassed }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import type { DemoRunState } from '~/composables/useMpDemo'
import type { MpSunrunTask } from '~/src/mp/types'
import { formatTaskPeriod } from '~/utils/mp/taskRules'
import { formatDuration, formatPace } from '~/utils/mp/runData'

/**
 * 「阳光跑」左栏实时指标卡（计划 / 里程 / 时长 / 配速 / 拟合度 / 进度 / 过点）。
 * 纯展示：数据与三个算好的展示串（statusText / statusColor / paceText / fitClass）都由页面传入。
 */
defineProps<{
  activeTask: MpSunrunTask | null
  run: DemoRunState
  statusText: string | undefined
  statusColor: string | undefined
  paceText: string
  fitClass: string
  progress: number
}>()
</script>
