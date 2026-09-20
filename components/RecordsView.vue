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
              <th style="width: 150px">异常标记</th>
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
              <td class="text-body-2">
                <template v-if="warnLabel(record)">
                  <v-chip size="small" variant="tonal" color="warning">{{ warnLabel(record) }}</v-chip>
                </template>
                <span v-else class="text-medium-emphasis">--</span>
              </td>
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
        <div class="text-caption text-medium-emphasis mt-2">
          <b>关于「异常标记」</b>：这是服务端记录里的 <code>warnType</code>（源码 <code>SetwarnType</code> 映射表）。
          <b>实测事实</b>：真人真跑与工具记录都可以带 <code>warnType=3（拟合度异常）</code>——
          它有<b>不代表</b>这段成绩是用工具跑的（2026-09-17 真实提交前后各一条真跑记录实测）。
          ⚠️ 手机端记录详情页那个 ⚠ 图标是<b>厂商自身的显示问题</b>（判据写成
          <code>scorePassType != '0'</code>，且文案取了记录里不存在的 <code>scorePassRemark</code> 字段），
          与我们是否用工具无关。以本表「判定」列的<b>有效/无效</b>为准。
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { MP_SCORE_STATUS, MP_WARN_TYPE } from '~/src/mp/models'
import type { MpRunRecord } from '~/src/mp/types'

const { records, stats, term, resetRecords } = useMpDemo()
const showSnackbar = useNotice()

/**
 * 异常标记文案（`warnType` → 文案）。
 * ⚠️ 两条纪律：
 *   ① 映射表来自源码 `SetwarnType`（`MP_WARN_TYPE`），**不自己编**；
 *   ② **未实测过的取值不外显成"已知异常"** —— 只显示"未知标记（N）"，避免把没验证过的东西讲成结论。
 */
const warnLabel = (record: MpRunRecord): string => {
  const raw = record.warnType
  if (raw === undefined || raw === null || String(raw) === '' || String(raw) === '0') return ''
  const key = Number(raw)
  const known = (MP_WARN_TYPE as Record<number, string>)[key]
  return known ? `${known}（warnType=${key}）` : `未知标记（warnType=${raw}）`
}

/**
 * 成绩状态文案：**改用 `MP_SCORE_STATUS` 单一来源**（2026-09-19 审计 R2）。
 * 这里原先手写了一份 `{0:'无效',1:'有效',2:'申诉有效',3:'补录有效'}`，而 `src/mp/models.ts`
 * 里同名同内容的常量**从没被引用过** —— 两份各写一遍，改一处忘一处就会显示错状态。
 */
const statusText = (value: number | string) =>
  (MP_SCORE_STATUS as Record<number, string>)[Number(value)] ?? '- -'
const statusColor = (value: number | string) =>
  ({ 0: 'error', 1: 'success', 2: 'success', 3: 'success' })[Number(value)] ?? 'warning'

/** 清空本机 localStorage 里的成绩记录（不影响服务端已提交的成绩） */
const doReset = () => {
  resetRecords()
  showSnackbar('已清空本机记录（服务端成绩不受影响）', 'info')
}
</script>
