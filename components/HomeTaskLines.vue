<template>
  <v-card height="100%">
    <v-card-title class="text-subtitle-1 d-flex align-center">
      <v-icon color="primary" class="mr-2">mdi-run-fast</v-icon>
      任务与约束
      <v-chip class="ml-2" size="x-small" :color="usingRealTask ? 'success' : 'accent'" variant="tonal">
        {{ usingRealTask ? '真实' : '演示' }}
      </v-chip>
    </v-card-title>
    <v-card-text>
      <v-list density="compact">
        <v-list-item title="任务" :subtitle="activeTask?.paperName ?? '—'" prepend-icon="mdi-clipboard-text-outline" />
        <v-list-item title="目标里程" :subtitle="`${activeTask?.mileage ?? '—'} km`" prepend-icon="mdi-map-marker-distance" />
        <v-list-item title="拟合度阈值" :subtitle="String(activeTask?.fitDegree ?? '—')" prepend-icon="mdi-chart-bell-curve" />
        <v-list-item
          title="速度区间"
          :subtitle="`${activeTask?.minSpeed ?? '—'} ~ ${activeTask?.maxSpeed ?? '—'} km/h`"
          prepend-icon="mdi-speedometer"
        />
        <v-list-item
          title="时长区间"
          :subtitle="`${activeTask?.minTime ?? '—'} ~ ${activeTask?.maxTime ?? '—'} 分钟`"
          prepend-icon="mdi-timer-outline"
        />
        <v-list-item title="有效期" :subtitle="activeTask ? formatTaskPeriod(activeTask) : '—'" prepend-icon="mdi-calendar-range" />
        <!-- 线路：按坐标校区分组展示（本校区在前；跨校区标距离），避免"名称看不出是哪个校区" -->
        <template v-if="routeGroups.clusters.length">
          <v-list-item
            v-for="c in routeGroups.clusters"
            :key="c.index"
            :title="c.label"
            :subtitle="c.routes.map((r) => r.line.pointName).join('、')"
            :prepend-icon="c.kind === 'home' ? 'mdi-map-marker-check-outline' : 'mdi-map-marker-distance'"
          />
          <v-list-item
            v-if="routeGroups.inferred"
            title="分组提示"
            :subtitle="routeGroups.note"
            prepend-icon="mdi-alert-circle-outline"
          />
        </template>
        <v-list-item v-else title="线路" :subtitle="lineNames" prepend-icon="mdi-map-outline" />
      </v-list>
      <v-alert v-if="!usingRealTask" type="warning" variant="tonal" density="compact" class="mt-2">
        当前是<b>演示取值</b>。点「读取真实账号与任务」换成真实约束（自动识别学校）。
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import type { MpSunrunTask } from '~/src/mp/types'
import { formatTaskPeriod } from '~/utils/mp/taskRules'
import type { RouteGroupsResult } from '~/utils/mp/routeGroups'

/** 工作台「任务与约束」卡：任务字段 + 线路（按坐标校区分组展示，本校区在前） */
defineProps<{
  activeTask: MpSunrunTask | null
  routeGroups: RouteGroupsResult
  lineNames: string
  usingRealTask: boolean
}>()
</script>
