<template>
  <div>
    <v-card class="pa-4">
      <v-card-title class="d-flex align-center justify-space-between">
        <span>自由跑详情</span>
        <v-chip :color="record?.status === 'completed' || record?.status === 'success' ? 'success' : 'error'">
          {{ record?.status }}
        </v-chip>
      </v-card-title>

      <v-card-text v-if="loading">
        <v-progress-circular indeterminate color="primary" />
      </v-card-text>

      <v-card-text v-else-if="record">
        <v-table density="compact">
          <tbody>
            <tr v-for="row in rows" :key="row.label">
              <th class="text-left text-medium-emphasis" style="width: 40%">{{ row.label }}</th>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </v-table>

        <v-divider class="my-4" />

        <div class="text-subtitle-1 mb-2">操作</div>
        <div class="d-flex flex-wrap ga-2">
          <v-btn color="primary" variant="tonal" :prepend-icon="'mdi-share-variant'" @click="share">分享记录</v-btn>
          <v-btn variant="tonal" :prepend-icon="'mdi-database-export'" @click="exportData">导出数据</v-btn>
          <v-btn variant="tonal" :prepend-icon="'mdi-link-variant'" @click="copyLink">复制链接</v-btn>
          <v-btn variant="tonal" :prepend-icon="'mdi-image-outline'" @click="genImage">生成图片</v-btn>
        </div>
      </v-card-text>

      <v-card-text v-else-if="errorMsg">
        <v-alert type="error" variant="tonal">{{ errorMsg }}</v-alert>
        <v-btn color="primary" class="mt-3" to="/records">返回记录</v-btn>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { RecordManager, type FreeRunRecord } from '~/utils/RecordManager'
import { useSession } from '~/composables/useSession'

definePageMeta({ title: '自由跑详情' })

const route = useRoute()
const { session, basicReq } = useSession()
const manager = new RecordManager()

const loading = ref(false)
const errorMsg = ref('')
const record = ref<FreeRunRecord | null>(null)

const rows = computed(() => {
  const r = record.value
  if (!r) return []
  return [
    { label: '记录ID', value: r.recordId },
    { label: '开始时间', value: r.startTime },
    { label: '结束时间', value: r.endTime },
    { label: '提交时间', value: r.evaluateDate },
    { label: '状态', value: r.status },
    { label: '距离', value: `${r.distance} km` },
    { label: '平均速度', value: `${r.avgSpeed} km/h` },
    { label: '用时', value: r.usedTime || formatSeconds(parseFloat(r.duration)) },
    { label: '卡路里', value: `${r.calorie}` },
    { label: '步数', value: r.steps },
    { label: '路线ID', value: r.routeId },
    { label: '设备', value: r.phoneInfo || r.mac || '—' },
  ]
})

function formatSeconds(sec: number) {
  if (!isFinite(sec) || sec < 0) return '0:00'
  return `${Math.floor(sec / 3600)}:${Math.floor((sec % 3600) / 60).toString().padStart(2, '0')}:${Math.floor(sec % 60).toString().padStart(2, '0')}`
}

const snack = (msg: string, color = 'info') => {
  const show = inject<(m: string, c?: string) => void>('showSnackbar')
  show?.(msg, color)
}

async function share() {
  if (navigator.share) {
    try {
      await navigator.share({
        title: '自由跑记录',
        text: `跑步 ${record.value?.distance} km @${record.value?.avgSpeed} km/h`,
        url: location.href,
      })
      return
    } catch {
      /* cancelled */
    }
  }
  copyLink()
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href)
    snack('链接已复制到剪贴板', 'success')
  } catch {
    snack('复制失败', 'error')
  }
}

function exportData() {
  const blob = new Blob([JSON.stringify(record.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `record-${record.value?.recordId}.json`
  a.click()
  URL.revokeObjectURL(url)
  snack('导出成功', 'success')
}

function genImage() {
  snack('图片分享功能开发中，敬请期待', 'warning')
}

onMounted(async () => {
  if (!session.value?.token) {
    navigateTo('/')
    return
  }
  loading.value = true
  try {
    record.value = await manager.getFreeRunDetail(String(route.params.id), basicReq.value)
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    loading.value = false
  }
})
</script>