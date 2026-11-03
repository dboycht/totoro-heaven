<script setup lang="ts">
/**
 * **「真实路径」【测试】**（2026-11-03，1.3.6 需求③；放「我的场地」分组下）
 *
 * 用户口径："登录账号后，可以使用相关内部功能来导出**某一天真实跑的路径信息**，并可以选择
 * 「导出到本地存为路径预设」或者「导出分享给好友」两种选择，用户在跑步界面可以选择这些路径并进行跑步，
 * 目前先做到直接原版数据提交，后面再慢慢补齐（相关功能标注为「测试」）"。
 *
 * ## 这一页做什么
 *   ① 选月份 → 读**本人**成绩归档（只读）→ 按天分组；
 *   ② 点一天 → 点那天的某一条 → 「读取这条的轨迹」（只读，`getSunrunArchDetail`）；
 *   ③ 二选一的出口：**存为本机路径预设**（之后在跑步页可选）或**导出压缩包**分享给好友；
 *   ④ 也能**导入**好友发来的压缩包（读 zip → 写本机路线库）。
 *
 * ## 三条如实标注（别删）
 *   · 这是**【测试】**功能：导出的路径会被**当作本机几何**去生成轨迹，提交仍走**原版报文**；
 *   · **只读服务端**：本页没有任何写请求（不做申诉、不改成绩）；
 *   · **只碰本人数据**：查询用的学号来自当前登录会话，页面不提供"查别人"的入口。
 */
import { REAL_PATH_MAX_POINTS, useRealPathExport } from '~/composables/useRealPathExport'
import { defaultRealPathName } from '~/utils/mp/realPath'
import { LOCAL_FREE_LINE_ID } from '~/utils/mp/trackLibrary'

const showSnackbar = useNotice()
const rp = useRealPathExport()
const lib = useTrackLibrary()
/**
 * 当前生效的任务（真实优先、演示兜底）—— 与「跑道编辑」**同一套取法**（那里也是这两行），
 * 不新造 `useActiveTask`：多一处"任务来源"就多一处会漂移的口径。
 */
const { task: realTask } = useMpReal()
const { task: demoTask } = useMpDemo()
const activeTask = computed(() => realTask.value ?? demoTask.value)
onMounted(() => {
  lib.load()
  // 月份列表是"可选的便利"：读不到不影响"直接读最近成绩"这条路
  if (rp.hasToken.value && !rp.months.value.length) void rp.loadMonths()
})

/** 任务里下发的线路（用于"存到哪个地点"的下拉；没有任务就只有本机键） */
const taskLines = computed(() =>
  (activeTask.value?.runPointList ?? []).map((l) => ({ value: String(l.pointId), title: String(l.pointName || l.pointId) })),
)
/** 「存到哪个地点」的选项 = 任务线路 + 本机键 + 库里已有的地点（去重） */
const locationItems = computed(() => {
  const out: { value: string; title: string }[] = []
  const seen = new Set<string>()
  const push = (value: string, title: string) => {
    const v = String(value ?? '').trim()
    if (!v || seen.has(v)) return
    seen.add(v)
    out.push({ value: v, title })
  }
  push(LOCAL_FREE_LINE_ID, '本机跑道（本任务未下发线路）')
  for (const l of taskLines.value) push(l.value, l.title)
  for (const e of lib.entries.value) push(String(e.lineId), `${String(e.lineName || e.lineId)}（本机已有）`)
  return out
})
/** 用户选的目标地点（默认：任务只有一条线路时就用它，否则本机键） */
const targetLineId = ref<string>(LOCAL_FREE_LINE_ID)
watch(
  locationItems,
  (items) => {
    if (items.some((i) => i.value === targetLineId.value)) return
    targetLineId.value = items[0]?.value ?? LOCAL_FREE_LINE_ID
  },
  { immediate: true },
)
const targetLineName = computed(() => locationItems.value.find((i) => i.value === targetLineId.value)?.title ?? targetLineId.value)

/** 预设名（留空 ⇒ 自动命名；这里给个"来自真实路径"的默认值，用户可改） */
const presetName = ref('')
watch(
  () => rp.selection.value?.meta,
  (meta) => {
    if (!meta) return
    const rec = rp.selectedRecord.value
    presetName.value = defaultRealPathName({ ...meta, startTime: rec?.startTime })
  },
)

/** 当前选中那天的记录（点"某一天"之后列出来） */
const dayRecords = computed(() => {
  const d = rp.days.value.find((x) => x.date === rp.selectedDate.value)
  return d?.records ?? []
})
/** 轨迹读数（选了才显示） */
const lapInfo = computed(() => {
  const sel = rp.selection.value
  if (!sel) return null
  return {
    sourcePoints: sel.points.length,
    lapPoints: sel.lapPoints.length,
    /** 切出一圈之后点数变少 ⇒ 说明真的切过（如实告诉用户"存的是哪一段"） */
    sliced: sel.points.length !== sel.lapPoints.length,
  }
})

const doLoadMonths = async () => {
  const list = await rp.loadMonths()
  if (list.length) showSnackbar(`读到 ${list.length} 个月份`, 'info')
  else if (rp.error.value) showSnackbar(rp.error.value, 'warning')
}
const doLoadRecords = async (monthId?: string) => {
  const list = await rp.loadRecords(monthId)
  if (list.length) showSnackbar(rp.notice.value || `读到 ${list.length} 条成绩`, 'info')
  else showSnackbar(rp.error.value || rp.notice.value || '没有读到成绩', 'warning')
}
const doLoadDetail = async (scoreId: string) => {
  const pts = await rp.loadDetail(scoreId)
  if (pts.length) showSnackbar(`读到 ${pts.length} 个轨迹点`, 'info')
  else showSnackbar(rp.error.value || '没读到轨迹', 'warning')
}
const doSave = () => {
  const out = rp.saveAsPreset(targetLineId.value, targetLineName.value, presetName.value)
  showSnackbar(out.message, out.ok ? 'success' : 'error')
}
const doShare = async () => {
  const out = await rp.downloadShareZip(presetName.value)
  showSnackbar(out.message, out.ok ? 'info' : 'error')
}

/** 导入：文件选择 + 存到当前选中的地点 */
const fileInput = ref<HTMLInputElement | null>(null)
const doImport = async (ev: Event) => {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const out = await rp.importShareZip(file, { lineId: targetLineId.value, lineName: targetLineName.value })
  showSnackbar(out.message, out.ok ? 'success' : 'error')
  /** 清空选择，便于同一个文件再导一次（例如换个地点） */
  input.value = ''
}

/** 那天的记录标签（时间 + 里程 + 判定） */
const recordLabel = (r: { startTime: string; km: number | null; passType: number | null; usedTime: string }) => {
  const t = r.startTime || '时间未知'
  const km = r.km === null ? '里程未知' : `${r.km.toFixed(2)} km`
  const pass = r.passType === null ? '判定未记录' : r.passType === 0 ? '无效' : r.passType === 1 ? '有效' : `判定 ${r.passType}`
  return `${t} · ${km} · ${r.usedTime || '用时未知'} · ${pass}`
}
</script>

<template>
  <v-container fluid>
    <!-- 顶部：这是什么 + 【测试】标注 + 三条如实说明 -->
    <v-alert type="info" variant="tonal" density="comfortable" class="mb-3">
      <div class="d-flex align-center flex-wrap ga-2">
        <v-icon>mdi-map-marker-path</v-icon>
        <span class="font-weight-bold">真实路径</span>
        <v-chip size="small" color="warning" variant="flat">测试</v-chip>
      </div>
      <div class="text-body-2 mt-1">
        把你在小程序/本工具里<b>真实跑过</b>的那一天的轨迹取回来，存成本机路径预设（之后在「跑步」页可选），
        或者打成一个压缩包分享给好友。
        <br />本页<b>只读</b>服务端（不申诉、不改成绩）；查询的学号来自<b>当前登录会话</b>，只能读你自己的记录。
        <br />⚠️ 存成预设后，跑步页会把它<b>当作本机几何</b>去生成轨迹，<b>提交仍走原版报文</b>（本功能不影响提交口径）。
      </div>
    </v-alert>

    <v-alert v-if="!rp.hasToken.value" type="warning" variant="tonal" density="compact" class="mb-3">
      还没有登录态：请先回「工作台」点「一键获取 token」，再回本页。
    </v-alert>

    <v-row dense>
      <!-- 左：1 选月份 → 2 读归档 → 3 选天与成绩 -->
      <v-col cols="12" md="7">
        <v-card>
          <v-card-title class="text-subtitle-1 d-flex flex-wrap align-center ga-2">
            <v-icon color="primary">mdi-account-search-outline</v-icon>
            第 1~2 步：选月份 → 读我的成绩归档
            <v-spacer />
            <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" :loading="rp.busy.value === 'months'" :disabled="!rp.hasToken.value" @click="doLoadMonths">
              读月份
            </v-btn>
          </v-card-title>
          <v-card-text>
            <div class="d-flex flex-wrap align-center ga-2 mb-3">
              <v-chip size="small" variant="tonal">登录学号：{{ rp.snCode.value || '未读到' }}</v-chip>
              <v-btn
                size="small"
                color="primary"
                variant="flat"
                prepend-icon="mdi-database-search"
                :loading="rp.busy.value === 'records'"
                :disabled="!rp.hasToken.value"
                @click="doLoadRecords()"
              >
                读取最近成绩
              </v-btn>
              <span class="text-caption text-medium-emphasis">（不选月份＝用当前月份）</span>
            </div>
            <div v-if="rp.months.value.length" class="d-flex flex-wrap ga-1 mb-3">
              <v-btn
                v-for="m in rp.months.value"
                :key="m.monthId"
                size="x-small"
                variant="tonal"
                :color="m.isCurrent ? 'primary' : undefined"
                @click="doLoadRecords(m.monthId)"
              >
                {{ m.monthName }}{{ m.isCurrent ? '（当前）' : '' }}
              </v-btn>
            </div>

            <v-alert v-if="rp.error.value" type="error" variant="tonal" density="compact" class="mb-2">{{ rp.error.value }}</v-alert>
            <v-alert v-else-if="rp.notice.value" type="success" variant="tonal" density="compact" class="mb-2">{{ rp.notice.value }}</v-alert>

            <div class="text-subtitle-2 mb-1">按天（{{ rp.days.value.length }} 天）</div>
            <div v-if="!rp.days.value.length" class="text-caption text-medium-emphasis mb-2">
              还没有数据：先点上面的「读取最近成绩」。
            </div>
            <div v-else class="d-flex flex-wrap ga-1 mb-3">
              <v-btn
                v-for="d in rp.days.value"
                :key="`day-${d.date || 'unknown'}`"
                size="small"
                variant="tonal"
                :color="rp.selectedDate.value === d.date ? 'primary' : undefined"
                @click="rp.pickDate(d.date)"
              >
                {{ d.date || '日期未知' }}（{{ d.records.length }}）
              </v-btn>
            </div>

            <template v-if="rp.selectedDate.value !== '' || dayRecords.length">
              <div class="text-subtitle-2 mb-1">这一天跑了几次 —— 点一条读它的轨迹</div>
              <v-list density="compact" class="pa-0">
                <v-list-item
                  v-for="r in dayRecords"
                  :key="r.scoreId"
                  :active="rp.selectedScoreId.value === r.scoreId"
                  @click="rp.pickRecord(r.scoreId)"
                >
                  <v-list-item-title class="text-body-2">{{ recordLabel(r) }}</v-list-item-title>
                  <v-list-item-subtitle class="text-caption">场次号：{{ r.scoreId }}</v-list-item-subtitle>
                  <template #append>
                    <v-btn size="x-small" variant="text" color="primary" :loading="rp.busy.value === 'detail'" @click.stop="doLoadDetail(r.scoreId)">
                      读取轨迹
                    </v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </template>
          </v-card-text>
        </v-card>

        <v-card class="mt-3">
          <v-card-title class="text-subtitle-1 d-flex flex-wrap align-center ga-2">
            <v-icon color="secondary">mdi-vector-polyline</v-icon>
            第 3 步：这条轨迹长什么样
          </v-card-title>
          <v-card-text>
            <div v-if="!lapInfo" class="text-caption text-medium-emphasis">
              还没读到轨迹：在上面点「读取轨迹」。读不到时会如实说明（云端 `pointList` 为空的那类记录是取不回来的）。
            </div>
            <template v-else>
              <div class="text-body-2">
                原始 <b>{{ lapInfo.sourcePoints }}</b> 点 →
                存成预设时用 <b>{{ lapInfo.lapPoints }}</b> 点
                <span v-if="lapInfo.sliced" class="text-medium-emphasis">（已从整场里<b>切出一圈</b>并降采样，最多 {{ REAL_PATH_MAX_POINTS }} 点）</span>
              </div>
              <div class="text-caption text-medium-emphasis mt-1">
                为什么要切一圈：整场 3 km 是 5~8 圈，直接当"一圈"存会让跑图与圈数全乱；切不出来（不是闭环）时会<b>原样保留</b>。
              </div>
            </template>
          </v-card-text>
        </v-card>
      </v-col>

      <!-- 右：出口（存预设 / 导出压缩包）+ 导入 -->
      <v-col cols="12" md="5">
        <v-card variant="outlined" color="warning">
          <v-card-title class="text-subtitle-1 d-flex align-center flex-wrap ga-2">
            <v-chip size="small" color="warning" variant="flat">测试</v-chip>
            第 4 步：导出
          </v-card-title>
          <v-card-text>
            <v-select v-model="targetLineId" :items="locationItems" item-title="title" item-value="value" label="存到哪个地点" density="compact" class="mb-2" />
            <v-text-field v-model="presetName" label="预设名称（留空 = 自动命名）" density="compact" :counter="24" maxlength="24" hide-details="auto" class="mb-3" />
            <v-btn block size="small" color="primary" class="mb-2" prepend-icon="mdi-content-save-outline" :disabled="!lapInfo" :loading="rp.busy.value === 'save'" @click="doSave">
              导出到本地：存为路径预设
            </v-btn>
            <div class="text-caption text-medium-emphasis mb-3">
              存进本机路线库（与「跑道编辑」共用同一个库）⇒ 回「跑步」页就能在「预设 / 本机路径」里选到它。
            </div>
            <v-btn block size="small" color="secondary" variant="tonal" prepend-icon="mdi-folder-zip-outline" :disabled="!lapInfo" :loading="rp.busy.value === 'share'" @click="doShare">
              导出分享给好友：生成压缩包
            </v-btn>
            <div class="text-caption text-medium-emphasis mt-1">
              压缩包里只有一个 JSON（<code>totoro-real-path.json</code>）：路径点 + 日期/场次号/里程/用时/拟合度。
              <b>不含</b> token、学号、姓名。好友用下面的「导入」读回去即成为他自己的本机预设。
            </div>
            <v-divider class="my-3" />
            <div class="text-subtitle-2 mb-1">导入好友分享的压缩包</div>
            <input ref="fileInput" type="file" accept=".zip,application/zip" class="d-none" @change="doImport" />
            <v-btn block size="small" variant="tonal" prepend-icon="mdi-file-upload-outline" @click="fileInput?.click()">
              选择一个压缩包并导入
            </v-btn>
            <div class="text-caption text-medium-emphasis mt-1">
              导入的路径会存到上面选的地点（同样可以在跑步页选用）；存进去的条目会标明"来源：真实路径"。
            </div>
          </v-card-text>
        </v-card>

        <v-card class="mt-3" variant="tonal">
          <v-card-title class="text-subtitle-2">本机已有的真实路径预设</v-card-title>
          <v-card-text>
            <div v-if="!lib.entries.value.filter((e) => e.realPath).length" class="text-caption text-medium-emphasis">
              还没有导出的真实路径。导出之后这里会列出来（含导出日期）。
            </div>
            <v-list v-else density="compact" class="pa-0">
              <v-list-item v-for="e in lib.entries.value.filter((x) => x.realPath)" :key="`real-${e.id}`" class="px-0">
                <v-list-item-title class="text-body-2">{{ e.customName || e.lineName }}</v-list-item-title>
                <v-list-item-subtitle class="text-caption">
                  来自 {{ e.realPath?.date || '日期未知' }} 那场 · 地点：{{ e.lineName || e.lineId }}
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
