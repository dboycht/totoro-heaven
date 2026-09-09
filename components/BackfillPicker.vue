<template>
  <div>
    <!-- 补跑日期选择（测试） -->
    <v-alert type="info" variant="tonal" density="compact" class="mb-2">
      补跑为<strong>测试阶段</strong>：下方日期取自「本学期阳光跑归档」，已跑过的日期置灰、可补跑的日期可勾选。功能未经验证服务端是否接受历史日期。
    </v-alert>

    <div v-if="loading" class="text-body-2 text-medium-emphasis pa-2">正在加载本月跑步归档…</div>

    <div v-else-if="error" class="text-body-2 text-error pa-2">
      {{ error }}
    </div>

    <div v-else-if="days.length">
      <div class="text-subtitle-2 mb-1">
        {{ monthName }}（已跑 {{ ranDates.size }} 天 / 共 {{ days.length }} 天）
      </div>
      <v-row dense>
        <v-col v-for="d in days" :key="d.value" cols="3" sm="2">
          <v-btn
            size="small"
            :disabled="!d.selectable"
            :color="selectedSet.has(d.value) ? 'primary' : undefined"
            :variant="selectedSet.has(d.value) ? 'tonal' : 'outlined'"
            block
            @click="toggle(d.value)"
          >
            <template #default>
              <div class="d-flex flex-column align-center">
                <span :class="{ 'text-medium-emphasis': d.selectable }">{{ d.day }}</span>
                <span
                  v-if="d.ran"
                  class="text-caption"
                  :class="d.selectable ? 'text-primary' : 'text-medium-emphasis'"
                  style="line-height: 1"
                >{{ d.ran ? '✓ 已跑' : '' }}</span>
                <span v-else-if="d.selectable" class="text-caption text-success" style="line-height: 1">可补跑</span>
              </div>
            </template>
          </v-btn>
        </v-col>
      </v-row>
      <div class="d-flex align-center justify-space-between mt-2">
        <span class="text-caption text-medium-emphasis">
          {{ selectedList.length ? `已选 ${selectedList.map((v) => v.slice(8)).join('、')} 号` : '未选择日期' }}
        </span>
        <v-btn v-if="selectedList.length" size="small" variant="text" @click="$emit('clear')">清空</v-btn>
      </div>
    </div>

    <div v-else class="text-body-2 text-medium-emphasis pa-2">暂无可用归档数据。</div>
  </div>
</template>

<script setup lang="ts">
import { TotoroApiWrapper } from '~/src/wrappers/TotoroApiWrapper'
import type { BasicReq } from '~/src/wrappers/TotoroApiWrapper'
import { useSession } from '~/composables/useSession'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'clear': []
}>()

const { isDebug, basicReq } = useSession()

const selected = ref(props.modelValue)
const selectedSet = computed(() => new Set(selected.value.split(',').filter(Boolean)))
const selectedList = computed(() => [...selectedSet.value])

const loading = ref(false)
const error = ref('')
const monthName = ref('')
const days = ref<{ value: string; day: string; selectable: boolean; ran: boolean }[]>([])
const ranDates = ref(new Set<string>())

watch(
  () => props.modelValue,
  (v) => { selected.value = v },
)
watch(selected, (v) => {
  emit('update:modelValue', v)
})

function toggle(value: string) {
  const s = new Set(selectedSet.value)
  if (s.has(value)) s.delete(value)
  else s.add(value)
  selected.value = [...s].sort().join(',')
}

async function load() {
  if (isDebug.value) {
    // 调试模式无真实归档：生成当月全部可补跑（已跑=[今天]示例）
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    monthName.value = `${y} 年 ${m} 月`
    const count = new Date(y, m, 0).getDate()
    const today = now.getDate()
    days.value = Array.from({ length: count }, (_, i) => {
      const day = (i + 1).toString().padStart(2, '0')
      return {
        value: `${y}-${m.toString().padStart(2, '0')}-${day}`,
        day: day,
        selectable: i + 1 < today,
        ran: i + 1 === today,
      }
    })
    return
  }

  loading.value = true
  error.value = ''
  try {
    const breq = basicReq.value as BasicReq
    // 1. 取当前学期
    const termRes = await TotoroApiWrapper.getSchoolTerm(breq)
    const terms = ((termRes as { data?: { termId: string; termName: string; isCurrent: string }[] }).data || [])
    const current = terms.find((t) => t.isCurrent === '1') || terms[terms.length - 1]
    if (!current) { error.value = '未取到学期数据'; return }

    // 2. 取当前月份
    const monthRes = await TotoroApiWrapper.getSchoolMonthByTerm(current.termId, breq)
    const months = ((monthRes as { monthList?: { monthId: string; monthName: string; ifCurrent: string }[] }).monthList || [])
    const curMonth = months.find((m) => m.ifCurrent === '1') || months[months.length - 1]
    if (!curMonth) { error.value = '未取到月份数据'; return }
    monthName.value = curMonth.monthName

    // 3. 取该月归档（已跑日期）
    const archRes = await TotoroApiWrapper.getSunRunArch(curMonth.monthId, current.termId, breq)
    const scores = ((archRes as { data?: { runTime?: string; status?: string }[] }).data || [])
    const ran = new Set<string>()
    for (const s of scores) {
      const t = s.runTime || ''
      // 兼容 yyyy-MM-dd 与 MM-dd
      const full = /^\d{4}-\d{2}-\d{2}$/.test(t)
        ? t
        : /^\d{2}-\d{2}$/.test(t)
          ? `${curMonth.monthName.includes('年') ? curMonth.monthName.match(/\d{4}/)?.[0] || new Date().getFullYear() : new Date().getFullYear()}-${t}`
          : t
      if (full) ran.add(full)
    }
    ranDates.value = ran

    // 4. 生成当月日期
    const ym = curMonth.monthName // 形如 "2024年9月"
    const ymMatch = ym.match(/(\d{4})\s*[年\-.\/]\s*(\d{1,2})\s*月?/)
    const year = ymMatch ? parseInt(ymMatch[1], 10) : new Date().getFullYear()
    const month = ymMatch ? parseInt(ymMatch[2], 10) : (new Date().getMonth() + 1)
    const count = new Date(year, month, 0).getDate()
    const now = new Date()
    const pad2 = (n: number) => n.toString().padStart(2, '0')
    const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    days.value = Array.from({ length: count }, (_, i) => {
      const day = pad2(i + 1)
      const value = `${year}-${pad2(month)}-${day}`
      const isRan = ran.has(value)
      // 可补跑 = 当天已跑？灰；未来？灰；否则可点
      const selectable = !isRan && value < todayStr
      return { value, day, selectable, ran: isRan }
    })
  } catch (e) {
    error.value = `加载归档失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>