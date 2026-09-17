<template>
  <v-card height="100%">
    <v-card-title class="d-flex align-center flex-wrap ga-2">
      <v-icon color="secondary" class="mr-2">mdi-account-details-outline</v-icon>
      真实账号
      <v-spacer />
      <v-btn
        v-if="realStatus === 'ready' || realStatus === 'loading'"
        size="small"
        variant="text"
        prepend-icon="mdi-refresh"
        :loading="realStatus === 'loading'"
        @click="emit('load-real')"
      >
        刷新任务
      </v-btn>
    </v-card-title>
    <v-card-text>
      <template v-if="realProfileMasked">
        <v-list density="compact">
          <v-list-item title="学号 / 姓名" :subtitle="`${realProfileMasked.snCode} · ${realProfileMasked.studentName}`" prepend-icon="mdi-card-account-details-outline" />
          <v-list-item title="学校" :subtitle="realProfileMasked.schoolName" prepend-icon="mdi-school-outline" />
          <v-list-item title="校区（campusId）" :subtitle="realProfileMasked.campusId" prepend-icon="mdi-map-marker-outline" />
          <v-list-item title="班级" :subtitle="realProfileMasked.className || '—'" prepend-icon="mdi-account-group-outline" />
        </v-list>
      </template>
      <v-alert v-else type="info" variant="tonal" density="compact">
        还没读取真实账号。填入 token 后点左侧「读取真实账号与任务」。
      </v-alert>

      <!-- 未验证学校：只提示"判分口径未实测"，不阻断（**读到档案后才显示**，否则还不知道是哪所学校） -->
      <v-alert v-if="realProfileMasked && realSchoolNotice" type="info" variant="tonal" density="compact" class="mt-3">
        {{ realSchoolNotice }}
      </v-alert>

      <v-divider class="my-3" />
      <div class="text-caption text-medium-emphasis mb-2">一票否决项（真实数据读取后自动查）</div>
      <v-list density="compact">
        <v-list-item
          title="开场人脸 sunrunStartFace"
          :subtitle="switchText(realSwitches?.sunrunStartFace, '开启（需实时拍脸）', '关闭')"
          prepend-icon="mdi-camera-outline"
        />
        <v-list-item
          title="随机抽查 sunrunPointRandom"
          :subtitle="switchText(realSwitches?.sunrunPointRandom, '开启（跑动中可能弹脸）', '关闭')"
          prepend-icon="mdi-shuffle-variant"
        />
        <v-list-item
          title="摄像头杆 getCameraConfig.flag"
          :subtitle="cameraFlag === null ? '未读取' : cameraFlag ? '当前选中线路启用（需人到杆附近）' : '当前选中线路未启用'"
          prepend-icon="mdi-video-outline"
        />
      </v-list>
      <v-alert v-if="!gateStatus.allow" type="error" variant="tonal" density="compact" class="mt-2">
        <div class="font-weight-bold">⛔ 开跑前门禁未通过（真实提交会被阻止，不会创建场次）</div>
        <div class="text-body-2">{{ gateStatus.reason }}</div>
        <div v-if="cameraFlagError" class="text-caption mt-1">读取异常：{{ cameraFlagError }}</div>
        <v-btn
          v-if="gateStatus.blockedBy === 'camera_unknown'"
          size="small"
          variant="tonal"
          class="mt-2"
          prepend-icon="mdi-refresh"
          @click="emit('retry-camera-flag')"
        >
          重新读取该线路的开关
        </v-btn>
      </v-alert>
      <v-alert v-else type="success" variant="tonal" density="compact" class="mt-2">
        ✅ 开跑前门禁通过：三项（开场人脸 / 随机抽查 / 摄像头杆）均无阻碍。
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import type { RunGateResult } from '~/utils/mp/schoolGate'

/** 工作台「真实账号」卡：脱敏档案 + 未验证学校提示 + 一票否决项 + 三合一门禁状态（含读取失败重试） */
defineProps<{
  realProfileMasked: {
    snCode: string
    studentName: string
    schoolName: string
    campusId: string
    className: string
  } | null
  realStatus: 'idle' | 'loading' | 'ready' | 'error'
  realSchoolNotice: string
  realSwitches: Record<string, string> | null
  cameraFlag: boolean | null
  gateStatus: RunGateResult
  cameraFlagError: string
}>()

const emit = defineEmits<{
  'load-real': []
  'retry-camera-flag': []
}>()

const switchText = (value: string | undefined, on: string, off: string) =>
  value === undefined ? '未读取' : value === '1' ? on : off
</script>
