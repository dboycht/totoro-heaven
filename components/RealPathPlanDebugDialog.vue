<template>
  <!--
    「截断 / 重采样自检」面板（2026-11-28 用户要求）
    · 用户第一句："把一个调试按钮，我要看一下这个截断的对吗"；
    · 第二句："将插值前和插值后的轨迹也渲染，让我看一下两个轨迹差别有多大"；
    · 第三句："展示效果和我们下面的展示一样，能让我用滚轮来放大" ⇒ 轨迹区域换成可交互的
      `RealPathTraceCompare`（滚轮缩放 / 拖动平移，与「轨迹预览」同一套口径）。
    · 自检判据来自纯函数 `realPathPlanChecks` / `realPathDiffMetrics`（与单测同源），不靠肉眼。
  -->
  <v-dialog :model-value="modelValue" max-width="960" scrollable @update:model-value="(v) => emit('update:modelValue', v)">
    <v-card>
      <v-card-title class="d-flex align-center ga-2 pt-4">
        <v-icon color="primary">mdi-bug-outline</v-icon>
        <span>截断 / 重采样自检</span>
        <v-spacer />
        <v-chip size="x-small" variant="tonal">{{ entryName || '真实路径' }}</v-chip>
      </v-card-title>
      <v-card-text>
        <div v-if="!plan" class="text-body-2 text-medium-emphasis">没有可看的计划（先选一条真实路径预设）。</div>
        <template v-else>
          <!-- 数字速览 -->
          <div class="text-caption mb-2">
            原始 <b>{{ plan.originalKm.toFixed(3) }} km</b>（{{ plan.sourcePoints }} 点）
            → 重采样 <b>{{ plan.resampledKm.toFixed(3) }} km</b>（{{ plan.sampledPoints }} 点）
            → 裁掉末尾 <b>{{ Math.round(plan.trimEndM) }} m</b>
            ⇒ 最终 <b>{{ plan.finalKm.toFixed(3) }} km</b>（{{ plan.points.length }} 点）
            <span class="text-medium-emphasis">· 要求里程 {{ requiredKm.toFixed(2) }} km</span>
          </div>

          <!-- 可交互轨迹：灰=原始 / 绿=最终 / 红=被裁掉的尾巴（滚轮缩放、拖动平移） -->
          <RealPathTraceCompare
            :raw="rawPoints"
            :sampled="plan.sampled"
            :final="plan.points"
            :cut="cutPoints"
          />

          <!-- 「差多少」的量化：形状差 vs 点位移，两个维度分开量 -->
          <v-table v-if="metrics" density="compact" class="bg-transparent mb-2 mt-2">
            <tbody>
              <tr>
                <td class="text-body-2" style="width: 34%">点数 / 平均点距</td>
                <td class="text-caption text-medium-emphasis">
                  {{ metrics.rawCount }} 点 · {{ metrics.rawMeanStepM }} m ⟶
                  {{ metrics.sampledCount }} 点 · {{ metrics.sampledMeanStepM }} m
                </td>
              </tr>
              <tr>
                <td class="text-body-2">形状差（线变了多少）</td>
                <td class="text-caption text-medium-emphasis">
                  原始顶点到重采样折线的最大偏离 <b>{{ metrics.shapeMaxM }} m</b>（点都在原线上，所以极小）
                </td>
              </tr>
              <tr>
                <td class="text-body-2">点位移（点挪了多少）</td>
                <td class="text-caption text-medium-emphasis">
                  重采样点到最近原始点：平均 <b>{{ metrics.shiftMeanM }} m</b> · 最大 <b>{{ metrics.shiftMaxM }} m</b>
                  （≈ 原始点距的 1/4 ⇒ 每个点都换了位置）
                </td>
              </tr>
            </tbody>
          </v-table>

          <!-- 自检项（每条都带数字） -->
          <v-table density="compact" class="bg-transparent">
            <tbody>
              <tr v-for="(c, i) in checks" :key="`c-${i}`">
                <td style="width: 34px" class="text-center">
                  <v-icon v-if="c.ok" color="success" size="18">mdi-check-circle</v-icon>
                  <v-icon v-else color="error" size="18">mdi-close-circle</v-icon>
                </td>
                <td class="text-body-2" style="width: 40%">{{ c.label }}</td>
                <td class="text-caption text-medium-emphasis">{{ c.detail }}</td>
              </tr>
            </tbody>
          </v-table>

          <!-- 首尾坐标对比（最硬的一条：起点必须一模一样） -->
          <div class="text-caption mt-3">
            <div>起点（原始 / 最终）：{{ coordText(rawPoints[0]) }} ／ {{ coordText(plan.points[0]) }}</div>
            <div>终点（原始 / 最终）：{{ coordText(rawPoints[rawPoints.length - 1]) }} ／ {{ coordText(plan.points[plan.points.length - 1]) }}</div>
          </div>
        </template>
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn color="primary" variant="flat" @click="emit('update:modelValue', false)">关闭</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * 哑组件：只画。数据来自 `run.realPathPlan`（引擎与界面同源那一份），
 * 判据来自纯函数（`realPathPlanChecks` / `realPathDiffMetrics`，都有单测）。
 */
import { realPathDiffMetrics, realPathPlanChecks, type RealPathGeometryPlan, type RealPathPoint } from '~/utils/mp/realPath'

const props = defineProps<{
  modelValue: boolean
  plan: RealPathGeometryPlan | null
  requiredKm: number
  rawPoints: RealPathPoint[]
  entryName?: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

/** 被裁掉的尾巴：从"最后一个保留点"到"重采样终点"（含起头那一点，红线才接得上绿线） */
const cutPoints = computed(() => {
  const plan = props.plan
  if (!plan || plan.skipped) return []
  return plan.sampled.slice(Math.max(0, plan.points.length - 1))
})

const metrics = computed(() => (props.plan ? realPathDiffMetrics(props.rawPoints, props.plan.sampled) : null))
const checks = computed(() => realPathPlanChecks(props.plan, { requiredKm: props.requiredKm, rawPoints: props.rawPoints }))

const coordText = (p?: RealPathPoint) => (p ? `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}` : '—')
</script>