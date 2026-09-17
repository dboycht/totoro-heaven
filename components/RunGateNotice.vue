<template>
  <div>
    <!-- 🌙 夜间停用（22:30~06:00）：放**页面最顶部**，任何模式下都先说明（避免白等一场 20 分钟的跑步） -->
    <v-alert
      v-if="gateStatus.blockedBy === 'night'"
      type="warning"
      variant="flat"
      density="comfortable"
      class="mb-4"
    >
      <div class="font-weight-bold">🌙 夜间停用时段（22:30~06:00）</div>
      <div class="text-body-2">
        为避免不必要的麻烦，此时间段<b>已停止开跑与提交</b>（只读功能仍可用）。请在每天 <b>06:00 之后</b>再使用。
      </div>
      <div class="text-caption mt-1">{{ gateStatus.reason }}</div>
    </v-alert>

    <v-alert v-if="!isLoggedIn" type="warning" variant="tonal" density="comfortable" class="mb-4">
      未建立会话 —— 回到 <NuxtLink to="/">工作台</NuxtLink> 填 token 并点「读取真实账号与任务」。
    </v-alert>
  </div>
</template>

<script setup lang="ts">
import type { RunGateResult } from '~/utils/mp/schoolGate'

/** 页面最顶部的门禁/会话提示（夜间停用 + 未建立会话），纯展示 */
defineProps<{
  gateStatus: RunGateResult
  isLoggedIn: boolean
}>()
</script>
