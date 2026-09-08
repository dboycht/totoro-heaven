<template>
  <div>
    <template v-if="!isLoggedIn">
      <v-alert type="warning" variant="tonal">请先扫码登录</v-alert>
      <v-btn color="primary" class="mt-4" to="/">返回首页</v-btn>
    </template>

    <template v-else>
      <v-row class="mb-2">
        <v-col cols="12" sm="6" md="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">总跑步次数</div>
            <div class="text-h5">{{ stats.totalRuns }}</div>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">总距离 (km)</div>
            <div class="text-h5">{{ stats.totalDistance.toFixed(2) }}</div>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">总时长</div>
            <div class="text-h5">{{ formatSeconds(stats.totalTime) }}</div>
          </v-card>
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <v-card variant="tonal" class="pa-3">
            <div class="text-caption text-medium-emphasis">平均速度 (km/h)</div>
            <div class="text-h5">{{ stats.avgSpeed.toFixed(2) }}</div>
          </v-card>
        </v-col>
      </v-row>

      <v-card class="pa-4 mb-4">
        <v-card-title class="text-subtitle-1">跑步记录</v-card-title>
        <v-card-text>
          <v-row>
            <v-col cols="12" md="4">
              <v-text-field v-model="search" label="搜索记录" :append-inner-icon="'mdi-magnify'" density="compact" hide-details />
            </v-col>
            <v-col cols="12" md="8" class="d-flex align-center justify-end ga-2">
              <v-menu location="bottom">
                <template #activator="{ props }">
                  <v-btn v-bind="props" variant="tonal" density="compact" :prepend-icon="'mdi-filter-variant'">高级筛选</v-btn>
                </template>
                <v-card min-width="320" class="pa-4">
                  <v-text-field v-model.number="minDistance" label="最小距离 (km)" type="number" density="compact" />
                  <v-text-field v-model.number="maxDistance" label="最大距离 (km)" type="number" density="compact" />
                  <v-select v-model="statusFilter" :items="['completed', 'failed']" label="状态" clearable density="compact" />
                  <v-text-field v-model="dateFrom" label="开始日期" type="date" density="compact" class="mt-2" />
                  <v-text-field v-model="dateTo" label="结束日期" type="date" density="compact" class="mt-2" />
                  <v-btn color="primary" density="compact" class="mt-2" @click="applyFilters">应用筛选</v-btn>
                </v-card>
              </v-menu>
              <v-btn
                color="primary"
                density="compact"
                variant="outlined"
                :prepend-icon="'mdi-file-export'"
                @click="exportRecords"
              >
                导出记录
              </v-btn>
            </v-col>
          </v-row>

          <v-table density="compact" class="mt-3">
            <thead>
              <tr>
                <th>记录ID</th>
                <th>距离</th>
                <th>速度</th>
                <th>时长</th>
                <th>开始时间</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in visibleRecords" :key="item.recordId">
                <td class="text-caption">{{ item.recordId }}</td>
                <td>{{ item.distance }} km</td>
                <td>{{ item.avgSpeed }} km/h</td>
                <td>{{ formatSeconds(parseFloat(item.duration)) }}</td>
                <td class="text-caption">{{ item.startTime }}</td>
                <td>
                  <v-chip :color="item.status === 'completed' || item.status === 'success' ? 'success' : 'error'" size="small">
                    {{ item.status }}
                  </v-chip>
                </td>
                <td>
                  <v-btn
                    size="small"
                    variant="text"
                    :append-icon="'mdi-eye'"
                    :to="`/records/free/${item.recordId}`"
                  >
                    查看
                  </v-btn>
                </td>
              </tr>
            </tbody>
          </v-table>

          <v-alert v-if="!loading && !visibleRecords.length" type="info" variant="tonal" class="mt-4">
            暂无匹配的记录，去 <router-link to="/freerun">开始你的第一次自由跑</router-link>
          </v-alert>
        </v-card-text>
      </v-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { RecordManager, type FreeRunRecord } from '~/utils/RecordManager'
import { useSession } from '~/composables/useSession'

definePageMeta({ title: '跑步记录' })

const { isLoggedIn, basicReq } = useSession()

const manager = new RecordManager()
const allRecords = ref<FreeRunRecord[]>([])
const loading = ref(false)

const search = ref('')
const minDistance = ref<number | undefined>(undefined)
const maxDistance = ref<number | undefined>(undefined)
const statusFilter = ref<string>('')
const dateFrom = ref('')
const dateTo = ref('')

const stats = ref({ totalRuns: 0, totalDistance: 0, totalTime: 0, avgSpeed: 0, totalCalories: 0, completedRuns: 0, failedRuns: 0 })

const visibleRecords = computed(() => {
  let list = manager.searchRecords(allRecords.value, search.value)
  list = manager.filterRecords(list, {
    minDistance: minDistance.value,
    maxDistance: maxDistance.value,
    status: statusFilter.value || undefined,
    startDate: dateFrom.value || undefined,
    endDate: dateTo.value || undefined,
  })
  return list
})

function applyFilters() {
  // filters are reactive; just refresh view
}

function formatSeconds(sec: number) {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}` : `${m}分${Math.floor(sec % 60)}秒`
}

function exportRecords() {
  const blob = new Blob([manager.exportRecords(visibleRecords.value)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `totoro-records-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  if (!isLoggedIn.value) return
  loading.value = true
  try {
    const records = await manager.getFreeRunRecords(basicReq.value)
    allRecords.value = records
    stats.value = manager.calculateStats(records)
  } catch (e) {
    console.error('加载记录失败:', e)
  } finally {
    loading.value = false
  }
})
</script>