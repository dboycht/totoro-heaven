<template>
  <div>
    <!-- 补跑日期选择（测试） -->
    <v-alert type="info" variant="tonal" density="compact" class="mb-2">
      补跑为<strong>测试阶段</strong>：日期取自「本学期阳光跑归档」。已跑过的日期置灰、可补跑的日期可勾选；功能未经验证服务端是否接受历史日期。
    </v-alert>

    <div v-if="loading" class="text-body-2 text-medium-emphasis pa-2">正在加载跑步归档…</div>
    <div v-else-if="error" class="text-body-2 text-error pa-2">{{ error }}</div>

    <template v-else-if="ready">
      <!-- 月份切换头 -->
      <div class="d-flex align-center mb-1">
        <v-btn
          icon="mdi-chevron-left"
          size="small"
          variant="text"
          :disabled="monthIdx <= 0"
          aria-label="上一月"
          @click="goMonth(-1)"
        />
        <div class="flex-grow-1 text-center">
          <div class="text-subtitle-1 font-weight-medium">{{ monthName }}</div>
          <div class="text-caption text-medium-emphasis">
            该月已跑 {{ ranDates.size }} 天 / 共 {{ dayCells.length }} 天
          </div>
        </div>
        <v-btn
          icon="mdi-chevron-right"
          size="small"
          variant="text"
          :disabled="monthIdx >= monthList.length - 1"
          aria-label="下一月"
          @click="goMonth(1)"
        />
      </div>

      <!-- 星期表头 -->
      <div class="calendar-grid">
        <div v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w" class="week-head">
          {{ w }}
        </div>
      </div>

      <!-- 日期网格 -->
      <div class="calendar-grid">
        <template v-for="(d, i) in dayCells" :key="i">
          <div v-if="d.blank" class="day-cell day-blank" />
          <button
            v-else
            type="button"
            class="day-cell"
            :class="[
              { ran: d.ran },
              { selectable: d.selectable },
              { future: d.future },
              { selected: selectedSet.has(d.value!) },
            ]"
            :disabled="!d.selectable && !d.ran"
            @click="toggle(d.value!)"
          >
            <span class="day-num">{{ d.day }}</span>
            <span
              v-if="d.ran"
              class="day-flag"
              :class="selectedSet.has(d.value!) ? 'flag-selected' : 'flag-ran'"
            >{{ selectedSet.has(d.value!) ? '✓' : '已跑' }}</span>
            <span v-else-if="d.selectable" class="day-flag flag-ok">可补</span>
          </button>
        </template>
      </div>

      <!-- 已选总结 -->
      <div class="d-flex align-center justify-space-between mt-2">
        <span class="text-caption text-medium-emphasis">
          <template v-if="selectedList.length">
            已选
            <template v-for="(v, i) in selectedList" :key="v">
              {{ i ? '、' : '' }}{{ v.slice(8) }} 号
            </template>
          </template>
          <template v-else>未选择日期</template>
        </span>
        <v-btn v-if="selectedList.length" size="small" variant="text" @click="$emit('clear')">清空</v-btn>
      </div>
    </template>

    <div v-else class="text-body-2 text-medium-emphasis pa-2">暂无可用归档数据。</div>
  </div>
</template>

<script setup lang="ts">
import { TotoroApiWrapper } from '~/src/wrappers/TotoroApiWrapper'
import type { BasicReq } from '~/src/wrappers/TotoroApiWrapper'
import { useSession } from '~/composables/useSession'

const props = defineProps<{ modelValue: string; single?: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'clear': []
}>()

const { isDebug, basicReq } = useSession()

const selected = ref(props.modelValue)
const selectedSet = computed(() => new Set(selected.value.split(',').filter(Boolean)))
const selectedList = computed(() => [...selectedSet.value])

const ready = ref(false)
const loading = ref(false)
const error = ref('')

interface DayCell {
  blank: boolean
  value?: string
  day?: string
  selectable?: boolean
  ran?: boolean
  future?: boolean
}

// 学期下的所有月份（升序）
const monthList = ref<{ monthId: string; monthName: string; ifCurrent: string }[]>([])
const monthIdx = ref(0)
const monthName = ref('')
const dayCells = ref<DayCell[]>([])
const ranDates = ref(new Set<string>())
const termId = ref('')

const pad2 = (n: number) => n.toString().padStart(2, '0')

// 解析 "2024年9月" -> {year, month}
const parseMonthName = (name: string) => {
  const m = name.match(/(\d{4})\s*[年\-.\/]\s*(\d{1,2})\s*月?/)
  if (!m) return null
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) }
}

// 月份是否可切换（向前/向后）
async function goMonth(dir: number) {
  const nxt = monthIdx.value + dir
  if (nxt < 0 || nxt >= monthList.value.length) return
  monthIdx.value = nxt
  await loadMonth()
}

watch(selected, (v) => emit('update:modelValue', v))
watch(
  () => props.modelValue,
  (v) => { selected.value = v },
)

function toggle(value: string) {
  if (props.single) {
    selected.value = selectedSet.value.has(value) ? '' : value
    return
  }
  const s = new Set(selectedSet.value)
  if (s.has(value)) s.delete(value)
  else s.add(value)
  selected.value = [...s].sort().join(',')
}

// 根据当月信息生成格子数组（含星期偏移补位）
function buildCells(year: number, month: number, ran: Set<string>) {
  const totalDays = new Date(year, month, 0).getDate()
  const firstDow = new Date(year, month - 1, 1).getDay() // 0=周日
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`

  const cells: DayCell[] = []
  for (let i = 0; i < firstDow; i++) cells.push({ blank: true })
  for (let d = 1; d <= totalDays; d++) {
    const value = `${year}-${pad2(month)}-${pad2(d)}`
    const isRan = ran.has(value)
    const isFuture = value > todayStr
    cells.push({
      blank: false,
      value,
      day: pad2(d),
      ran: isRan,
      future: isFuture,
      // 可补跑 = 过去且未跑；当天不算未来但也不可补（value < todayStr）
      selectable: !isRan && !isFuture && value < todayStr,
    })
  }
  dayCells.value = cells
}

async function loadMonth() {
  const month = monthList.value[monthIdx.value]
  if (!month) return
  loading.value = true
  error.value = ''
  try {
    monthName.value = month.monthName
    const parsed = parseMonthName(month.monthName)
    if (!parsed) {
      dayCells.value = []
      ranDates.value = new Set()
      return
    }
    const breq = basicReq.value as BasicReq
    const archRes = await TotoroApiWrapper.getSunRunArch(month.monthId, termId.value, breq)
    const scores = ((archRes as { data?: { runTime?: string; status?: string }[] }).data || [])
    const ran = new Set<string>()
    for (const s of scores) {
      const t = s.runTime || ''
      // 兼容 yyyy-MM-dd 与 MM-dd（本月前缀）
      const full = /^\d{4}-\d{2}-\d{2}$/.test(t)
        ? t
        : /^\d{2}-\d{2}$/.test(t)
          ? `${parsed.year}-${t}`
          : t
      if (full) ran.add(full)
    }
    ranDates.value = ran
    buildCells(parsed.year, parsed.month, ran)
  } catch (e) {
    error.value = `加载归档失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

async function load() {
  if (isDebug.value) {
    // 调试模式：生成若干个月的模拟归档，展示「已跑/可补/未来」等不同状态
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    // 展示最近 3 个月（当前月 + 前两月），方便预览「切换月份」
    const months: { monthId: string; monthName: string; ifCurrent: string }[] = []
    for (let off = 2; off >= 0; off--) {
      const d = new Date(y, m - 1 - off, 1)
      months.push({
        monthId: `debug-${d.getFullYear()}-${d.getMonth() + 1}`,
        monthName: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`,
        ifCurrent: off === 0 ? '1' : '0',
      })
    }
    monthList.value = months
    monthIdx.value = 2 // 定位到当前月
    monthName.value = months[2].monthName
    termId.value = 'debug'
    // 模拟归档：当月已跑的前几天置灰，未来几天禁用
    const today = now.getDate()
    const ran = new Set<string>()
    // 已经过去的日子里，随机挑一部分作为「已跑」（展示灰色）
    for (let day = 1; day < today; day++) {
      if (day % 2 === 0 || day % 5 === 0) {
        ran.add(`${y}-${pad2(m)}-${pad2(day)}`)
      }
    }
    // 上月随机已跑，用于切换预览
    const pm = months[1]
    const pmm = Number(pm.monthName.match(/(\d{2})\s*月/)?.[1] || 0)
    for (let day = 1; day <= 15; day++) {
      if (day % 3 === 0) ran.add(`${pm.monthName.match(/(\d{4})/)?.[0]}-${pad2(pmm)}-${pad2(day)}`)
    }
    ranDates.value = ran
    buildCells(y, m, ran)
    ready.value = true
    return
  }

  loading.value = true
  error.value = ''
  try {
    const breq = basicReq.value as BasicReq
    const termRes = await TotoroApiWrapper.getSchoolTerm(breq)
    const terms = (((termRes as { data?: { termId: string; termName: string; isCurrent: string }[] }).data || []))
    const current = terms.find((t) => t.isCurrent === '1') || terms[terms.length - 1]
    if (!current) {
      error.value = '未取到学期数据'
      ready.value = true
      return
    }
    termId.value = current.termId

    const monthRes = await TotoroApiWrapper.getSchoolMonthByTerm(current.termId, breq)
    const months = ((monthRes as { monthList?: { monthId: string; monthName: string; ifCurrent: string }[] }).monthList || [])
    // 排序：按年月升序；当前月优先定位
    const sorted = [...months].sort((a, b) => {
      const pa = parseMonthName(a.monthName)
      const pb = parseMonthName(b.monthName)
      if (!pa || !pb) return 0
      return pa.year * 100 + pa.month - (pb.year * 100 + pb.month)
    })
    monthList.value = sorted
    if (!sorted.length) {
      error.value = '未取到月份数据'
      ready.value = true
      return
    }
    const curIdx = sorted.findIndex((m) => m.ifCurrent === '1')
    monthIdx.value = curIdx >= 0 ? curIdx : sorted.length - 1
    ready.value = true
    await loadMonth()
  } catch (e) {
    error.value = `加载归档失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<style scoped>
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.week-head {
  text-align: center;
  font-size: 0.72rem;
  color: var(--v-theme-medium-emphasis);
  padding: 2px 0;
}
.day-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 58px;
  border-radius: 10px;
  border: 1px solid rgba(var(--v-theme-primary), 0.12);
  background: rgba(var(--v-theme-surface), 0.6);
  cursor: pointer;
  transition: all 0.15s ease;
  padding: 0;
}
.day-cell:hover:not(:disabled) {
  border-color: rgba(var(--v-theme-primary), 0.4);
  background: rgba(var(--v-theme-primary), 0.06);
}
.day-cell:disabled {
  cursor: default;
  opacity: 1;
}
.day-num {
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1;
}
.day-flag {
  font-size: 0.62rem;
  line-height: 1;
  margin-top: 4px;
}
.day-blank {
  border: none;
  background: transparent;
  cursor: default;
}
.day-cell.future {
  opacity: 0.35;
  border-color: transparent;
  background: transparent;
}
.day-cell.ran {
  border-color: rgba(var(--v-theme-secondary), 0.2);
  background: rgba(var(--v-theme-secondary), 0.08);
}
.day-flag.flag-ran {
  color: var(--v-theme-secondary);
}
.day-flag.flag-ok {
  color: var(--v-theme-success);
}
.day-cell.selected {
  border-color: var(--v-theme-primary);
  background: rgba(var(--v-theme-primary), 0.14);
  color: var(--v-theme-primary);
}
.day-flag.flag-selected {
  color: var(--v-theme-primary);
}
</style>
