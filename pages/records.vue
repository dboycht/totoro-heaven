<template>
  <div>
    <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">成绩记录</div>
      <div class="text-body-2">
        默认<b>不含任何假数据</b>：在跑步页结算一条成绩会追加到最前面（存本机 localStorage）。
        点工作台/跑步页的「载入演示数据」后，列表里是演示记录（Mock）；真实记录来自
        <code>getSunrunArch</code> 的顶层 <code>data[]</code> 与汇总字段。
      </div>
    </v-alert>

    <v-row dense class="mb-2">
      <v-col cols="6" sm="3">
        <v-card variant="tonal">
          <v-card-text class="text-center py-3">
            <div class="text-caption text-medium-emphasis">有效次数 / 要求</div>
            <div class="text-h5 font-weight-bold text-success">{{ stats.passed }} / {{ stats.requireNumber ?? '—' }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card variant="tonal">
          <v-card-text class="text-center py-3">
            <div class="text-caption text-medium-emphasis">无效次数</div>
            <div class="text-h5 font-weight-bold text-error">{{ stats.invalid }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card variant="tonal">
          <v-card-text class="text-center py-3">
            <div class="text-caption text-medium-emphasis">累计里程</div>
            <div class="text-h5 font-weight-bold">{{ stats.totalMileage }}<span class="text-body-2"> km</span></div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="6" sm="3">
        <v-card variant="tonal">
          <v-card-text class="text-center py-3">
            <div class="text-caption text-medium-emphasis">学期</div>
            <div class="text-body-1 font-weight-bold">{{ term?.name ?? '—' }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-card>
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon color="primary" class="mr-2">mdi-format-list-bulleted</v-icon>
        成绩记录
        <v-chip size="small" variant="tonal">{{ records.length }} 条</v-chip>
        <v-spacer />
        <v-btn
          v-if="records.length"
          size="small"
          variant="text"
          color="warning"
          prepend-icon="mdi-delete-sweep-outline"
          @click="doReset"
        >
          清空本机记录
        </v-btn>
      </v-card-title>
      <v-card-text>
        <v-table v-if="records.length" density="compact" hover>
          <thead>
            <tr>
              <th style="width: 110px">日期</th>
              <th style="width: 150px">时段</th>
              <th style="width: 90px">里程</th>
              <th style="width: 100px">用时</th>
              <th style="width: 110px">拟合度</th>
              <th style="width: 90px">类型</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in records" :key="record.scoreId">
              <td>{{ record.runTime }}</td>
              <td class="text-body-2">{{ record.startTmie || '--' }} - {{ record.endTmie || '--' }}</td>
              <td>{{ record.mileage ?? '--' }} km</td>
              <td class="text-body-2">{{ record.usedTime ?? '--' }}</td>
              <td>{{ record.trajectorySimilary ?? '--' }}</td>
              <td class="text-body-2">{{ record.runType === 0 ? '阳光跑' : '自由跑' }}</td>
              <td>
                <v-chip size="small" variant="flat" :color="statusColor(record.scorePassType)">
                  {{ statusText(record.scorePassType) }}
                </v-chip>
                <span v-if="record.scorePassRemark" class="text-caption text-error ml-2">
                  {{ record.scorePassRemark }}
                </span>
              </td>
            </tr>
          </tbody>
        </v-table>
        <v-alert v-else type="info" variant="tonal">暂无记录 —— 去跑步页跑一条。</v-alert>

        <v-divider class="my-4" />
        <div class="text-caption text-medium-emphasis">
          状态映射（源码 SetValue，逐字）：0 无效 / 1 有效 / 2 申诉有效 / 3 补录有效；
          <code>startTmie</code> / <code>endTmie</code> 是服务端拼写错误，逐字保留。
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
const { records, stats, term, resetRecords } = useMpDemo()
const showSnackbar = useNotice()

const statusText = (value: number | string) =>
  ({ 0: '无效', 1: '有效', 2: '申诉有效', 3: '补录有效' })[Number(value)] ?? '- -'
const statusColor = (value: number | string) =>
  ({ 0: 'error', 1: 'success', 2: 'success', 3: 'success' })[Number(value)] ?? 'warning'

/** 清空本机 localStorage 里的成绩记录（不影响服务端已提交的成绩） */
const doReset = () => {
  resetRecords()
  showSnackbar('已清空本机记录（服务端成绩不受影响）', 'info')
}
</script>
