<template>
  <div>
    <!-- 🌙 夜间停用（22:30~06:00）：放<b>页面最顶部</b>，任何模式下都先说明（避免白等一场 20 分钟的跑步） -->
    <v-alert
      v-if="gateStatus.blockedBy === 'night'"
      type="warning"
      variant="flat"
      density="comfortable"
      class="mb-4"
    >
      <div class="font-weight-bold">🌙 夜间停用时段（22:30~06:00）</div>
      <!-- ⚠️ 2026-09-20 审计修复（口径自相矛盾）：这里原先硬编码"已停止**开跑与提交**"，
           而夜间时段**只停真实提交**（本地模拟/预览照旧、开始跑步按钮此刻也是可点的），
           同一页下面 `gateStatus.reason` 又写着"已停止真实提交…本地模拟与预览仍可正常使用" ⇒ 两句话打架。
           现在**只保留 `nightBlockReason()` 这一个文案来源**（`utils/mp/schoolGate.ts`，其注释明确"不再写停止开跑"）。 -->
      <div class="text-body-2">{{ gateStatus.reason }}</div>
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
