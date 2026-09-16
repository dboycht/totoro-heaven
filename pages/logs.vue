<template>
  <div>
    <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-text-box-search-outline</v-icon>日志（本机可查）
      </div>
      <div class="text-body-2">
        上面是<b>本机事件日志</b>（每一步做了什么：读取/门禁/取 token/跑步/提交/判定，存本机 localStorage）；
        下面是<b>服务端文件日志</b>（每次上游请求的脱敏摘要 + 错误，写在临时目录，按天切分）。
        <br />🔒 <b>token / 学号 / 姓名一律脱敏</b>，绝不写入日志；导出/复制出去的也是脱敏后的内容。
      </div>
    </v-alert>

    <!-- ① 本机事件日志 -->
    <v-card class="mb-4">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon color="primary" class="mr-1">mdi-history</v-icon>
        本机事件日志
        <v-chip size="small" variant="tonal" class="ml-2">共 {{ logs.entries.value.length }} 条</v-chip>
        <v-chip size="small" color="info" variant="tonal">信息 {{ counts.info }}</v-chip>
        <v-chip size="small" color="warning" variant="tonal">警告 {{ counts.warn }}</v-chip>
        <v-chip size="small" color="error" variant="tonal">错误 {{ counts.error }}</v-chip>
        <v-spacer />
        <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyEvents">复制全部</v-btn>
        <v-btn size="small" variant="text" color="warning" prepend-icon="mdi-delete-outline" @click="clearEvents">
          清空
        </v-btn>
      </v-card-title>
      <v-card-text>
        <div class="d-flex flex-wrap ga-2 mb-3">
          <v-select
            v-model="levelFilter"
            :items="levelOptions"
            label="等级"
            density="compact"
            hide-details
            style="max-width: 150px"
          />
          <v-select
            v-model="catFilter"
            :items="catOptions"
            label="类别"
            density="compact"
            hide-details
            style="max-width: 190px"
          />
          <v-text-field v-model="keyword" label="搜索内容" density="compact" hide-details clearable style="max-width: 240px" />
          <v-switch v-model="newestFirst" label="最新在前" density="compact" hide-details color="primary" />
        </div>

        <div v-if="!filtered.length" class="text-body-2 text-medium-emphasis">
          （暂无符合条件的日志 —— 去做点操作，这里就会记下来）
        </div>

        <v-expansion-panels v-else variant="accordion" density="compact">
          <v-expansion-panel v-for="e in filtered" :key="e.t + e.msg">
            <v-expansion-panel-title class="py-1">
              <span class="text-caption text-medium-emphasis mr-2">{{ formatTime(e.t) }}</span>
              <v-chip :color="levelColor(e.level)" size="x-small" variant="flat" class="mr-2">{{ e.level }}</v-chip>
              <v-chip size="x-small" variant="tonal" class="mr-2">{{ e.cat }}</v-chip>
              <span class="text-body-2">{{ e.msg }}</span>
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <pre class="text-caption log-pre">{{ JSON.stringify(e.data ?? {}, null, 2) }}</pre>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>
    </v-card>

    <!-- ② 服务端文件日志 -->
    <v-card>
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon color="secondary" class="mr-1">mdi-file-document-outline</v-icon>
        服务端文件日志
        <v-chip v-if="serverInfo" size="small" variant="tonal">{{ serverFiles.length }} 个文件 / {{ formatBytes(serverInfo.totalBytes) }}</v-chip>
        <v-spacer />
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loadingServer" @click="loadServerLog">刷新</v-btn>
        <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copyServerLog">复制</v-btn>
        <v-btn size="small" variant="tonal" prepend-icon="mdi-folder-open-outline" @click="openLogFolder">
          打开日志文件夹
        </v-btn>
        <v-btn size="small" variant="text" color="warning" prepend-icon="mdi-delete-sweep-outline" @click="askClear('today')">
          清空今日
        </v-btn>
        <v-btn size="small" variant="text" color="error" prepend-icon="mdi-delete-forever-outline" @click="askClear('all')">
          清空全部
        </v-btn>
      </v-card-title>
      <v-card-subtitle v-if="serverDir" class="text-caption">
        目录：<code>{{ serverDir }}</code>（按天切分，<b>自动保留 7 天 / 上限 20MB</b>；也可手动清理）
        <span v-if="serverFiles.length"> · 现有 {{ serverFiles.length }} 个文件：{{ serverFiles.map((f) => `${f.name}(${formatBytes(f.bytes)})`).join('、') }}</span>
      </v-card-subtitle>
      <v-card-text>
        <div v-if="serverErr" class="text-body-2 text-error mb-2">{{ serverErr }}</div>
        <pre class="text-caption log-pre">{{ serverLines.join('\n') }}</pre>
      </v-card-text>
    </v-card>

    <!-- 清空服务端日志 确认框 -->
    <v-dialog v-model="confirmClearOpen" max-width="520">
      <v-card>
        <v-card-title class="d-flex align-center">
          <v-icon :color="clearMode === 'all' ? 'error' : 'warning'" class="mr-2">mdi-delete-sweep-outline</v-icon>
          {{ clearMode === 'all' ? '清空全部服务端日志？' : '清空今日服务端日志？' }}
        </v-card-title>
        <v-card-text>
          <v-alert :type="clearMode === 'all' ? 'error' : 'warning'" variant="tonal" density="compact" class="mb-3">
            将删除 <b>{{ willDelete.length }} 个文件</b>（约 <b>{{ formatBytes(willDeleteBytes) }}</b>），<b>删了不可恢复</b>。
          </v-alert>
          <div class="text-body-2 mb-2">将删除：</div>
          <ul class="text-caption pl-4 mb-2">
            <li v-for="f in willDelete" :key="f.name">{{ f.name }}（{{ formatBytes(f.bytes) }}）</li>
            <li v-if="!willDelete.length" class="text-medium-emphasis">（没有可删的文件）</li>
          </ul>
          <div class="text-caption text-medium-emphasis">
            说明：日志目录 <code>{{ serverDir }}</code> 平时会自动清理（保留 7 天 / 上限 20MB）；
            清空只影响<b>本机日志文件</b>，不影响任何成绩数据。
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmClearOpen = false">取消</v-btn>
          <v-btn :color="clearMode === 'all' ? 'error' : 'warning'" variant="flat" :disabled="!willDelete.length" @click="doClear">
            确认清空
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { useEventLog } from '~/composables/useEventLog'
import type { LogEntry, LogLevel } from '~/utils/mp/logFormat'

const logs = useEventLog()
const showSnackbar = inject<(msg: string, color?: string) => void>('showSnackbar', () => {})

const levelFilter = ref<'all' | LogLevel>('all')
const catFilter = ref('all')
const keyword = ref('')
const newestFirst = ref(true)

const levelOptions = [
  { title: '全部', value: 'all' },
  { title: '信息', value: 'info' },
  { title: '警告', value: 'warn' },
  { title: '错误', value: 'error' },
]

const catOptions = computed(() => {
  const cats = [...new Set(logs.entries.value.map((e) => e.cat))].sort()
  return [{ title: '全部', value: 'all' }, ...cats.map((c) => ({ title: c, value: c }))]
})

const counts = computed(() => logs.counts.value)

const filtered = computed<LogEntry[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = logs.entries.value.filter((e) => {
    if (levelFilter.value !== 'all' && e.level !== levelFilter.value) return false
    if (catFilter.value !== 'all' && e.cat !== catFilter.value) return false
    if (kw) {
      const hay = `${e.msg} ${JSON.stringify(e.data ?? {})}`.toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })
  return newestFirst.value ? [...list].reverse() : list
})

const levelColor = (l: LogLevel) => (l === 'error' ? 'error' : l === 'warn' ? 'warning' : 'info')
const formatTime = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const formatBytes = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`)

const copyText = async (text: string, okMsg: string) => {
  try {
    await navigator.clipboard.writeText(text)
    showSnackbar(okMsg, 'success')
  } catch {
    // 剪贴板不可用时退化为选中提示
    showSnackbar('浏览器拒绝了剪贴板访问，请手动选中复制', 'warning')
  }
}
const copyEvents = () => copyText(logs.asText(filtered.value), `已复制 ${filtered.value.length} 条事件日志`)
const clearEvents = () => {
  logs.clear()
  showSnackbar('已清空本机事件日志', 'info')
}

// ---- 服务端文件日志 ----
const serverLines = ref<string[]>([])
const serverDir = ref('')
const serverInfo = ref<{ files: { name: string; bytes: number; mtime: string }[]; totalBytes: number } | null>(null)
const serverFiles = computed(() => serverInfo.value?.files ?? [])
const serverErr = ref('')
const loadingServer = ref(false)

const loadServerLog = async () => {
  loadingServer.value = true
  serverErr.value = ''
  try {
    const res = await $fetch<{
      ok: boolean
      dir: string
      lines: string[]
      info: { files: { name: string; bytes: number; mtime: string }[]; totalBytes: number }
    }>('/api/local/logs/tail?lines=200')
    serverLines.value = res.lines
    serverDir.value = res.dir
    serverInfo.value = res.info
  } catch (err) {
    serverErr.value = `读取服务端日志失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    loadingServer.value = false
  }
}
const copyServerLog = () => copyText(serverLines.value.join('\n'), '已复制服务端日志')
const openLogFolder = async () => {
  try {
    const res = await $fetch<{ ok: boolean; dir: string; message?: string }>('/api/local/logs/open', { method: 'POST' })
    showSnackbar(res.ok ? `已打开日志目录：${res.dir}` : `打开失败：${res.message ?? ''}`, res.ok ? 'success' : 'warning')
  } catch (err) {
    showSnackbar(`打开失败：${err instanceof Error ? err.message : String(err)}`, 'warning')
  }
}

// ---- 手动清理服务端日志 ----
const confirmClearOpen = ref(false)
const clearMode = ref<'today' | 'all'>('today')
const todayName = computed(() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `app-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`
})
/** 按模式算出"将被删除"的文件（用于确认框展示） */
const willDelete = computed(() =>
  clearMode.value === 'all' ? serverFiles.value : serverFiles.value.filter((f) => f.name === todayName.value),
)
const willDeleteBytes = computed(() => willDelete.value.reduce((s, f) => s + f.bytes, 0))

const askClear = (mode: 'today' | 'all') => {
  clearMode.value = mode
  confirmClearOpen.value = true
}

const doClear = async () => {
  const mode = clearMode.value
  confirmClearOpen.value = false
  try {
    const res = await $fetch<{ ok: boolean; deleted: string[]; freedBytes: number; dir: string }>('/api/local/logs/clear', {
      method: 'POST',
      body: { mode },
    })
    logs.log('warn', 'ui', mode === 'all' ? '已清空全部服务端日志' : '已清空今日服务端日志', {
      deleted: res.deleted,
      freedBytes: res.freedBytes,
    })
    showSnackbar(
      res.deleted.length ? `已删除 ${res.deleted.length} 个日志文件，释放 ${formatBytes(res.freedBytes)}` : '没有可删的日志文件',
      res.deleted.length ? 'success' : 'info',
    )
    await loadServerLog()
  } catch (err) {
    showSnackbar(`清空失败：${err instanceof Error ? err.message : String(err)}`, 'warning')
  }
}

onMounted(() => {
  logs.log('info', 'ui', '打开日志页')
  void loadServerLog()
})
</script>

<style scoped>
.log-pre {
  max-height: 460px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  padding: 8px;
}
</style>
