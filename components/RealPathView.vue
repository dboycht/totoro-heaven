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
import { useRealPathExport } from '~/composables/useRealPathExport'
import { defaultRealPathName, nearestLineByGeometry, setSelection, toggleSelection, withRandomSuffix } from '~/utils/mp/realPath'
import { LOCAL_FREE_LINE_ID, TRACK_NAME_MAX } from '~/utils/mp/trackLibrary'

const showSnackbar = useNotice()
const rp = useRealPathExport()
const lib = useTrackLibrary()
/**
 * 当前生效的任务（真实优先、演示兜底）—— 与「跑道编辑」**同一套取法**（那里也是这两行），
 * 不新造 `useActiveTask`：多一处"任务来源"就多一处会漂移的口径。
 */
const { task: realTask, autoRestoreFromCache } = useMpReal()
const { task: demoTask } = useMpDemo()
const activeTask = computed(() => realTask.value ?? demoTask.value)
onMounted(() => {
  lib.load()
  /**
   * ⚠️ **先把本机缓存里的任务恢复回来**（与「跑道编辑」完全同一手法）。
   * 不恢复的话：用户从「我的场地」直接进本页 ⇒ `activeTask` 是 null ⇒ 「存到哪个地点」只能列出
   * 本机键一条 ⇒ 他实测看到的就是"没有识别到任务记录的线路"（2026-11-03 反馈）。
   * 这只是读本机缓存（不发请求），真正的"读任务"仍在工作台。
   */
  autoRestoreFromCache()
  // 月份列表是"可选的便利"：读不到不影响"直接读最近成绩"这条路
  if (rp.hasToken.value && !rp.months.value.length) void rp.loadMonths()
})

/** 任务里下发的线路（用于"存到哪个地点"的下拉；没有任务就只有本机键） */
const taskLines = computed(() =>
  (activeTask.value?.runPointList ?? []).map((l) => ({ value: String(l.pointId), title: String(l.pointName || l.pointId) })),
)
/**
 * 带几何的候选线路（来自当前任务的官方线路）—— 自动匹配用的就是它们的 `pointList`。
 * ⚠️ 必须定义在 `localLineLabel` / `locationItems` **之前**：那两个 computed 会在 setup 期
 * 被 `watch(..., { immediate: true })` 立刻求值，引用后面的 `const` 会踩 TDZ 直接报错。
 */
const taskLinesWithGeometry = computed(() =>
  (activeTask.value?.runPointList ?? []).map((l) => ({
    pointId: String(l.pointId ?? ''),
    pointName: String(l.pointName ?? l.pointId ?? ''),
    pointList: (l.pointList ?? []).map((p) => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) })),
  })),
)
/**
 * 本机键那条的说明文字**按实际情况变**（别一律写"本任务未下发线路"）：
 *   · 读过任务且有线路 ⇒ "不属于任何官方线路"（用户自己描的）；
 *   · 任务确实没下发线路 ⇒ "本任务未下发线路"（客观事实）；
 *   · 还没读任务 ⇒ "还没读取任务"（不冒充前两种情况）。
 */
const localLineLabel = computed(() => {
  if (!activeTask.value) return '本机跑道（还没读取任务）'
  return taskLinesWithGeometry.value.length ? '本机跑道（不属于任何官方线路）' : '本机跑道（本任务未下发线路）'
})
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
  /** ⚠️ 本机键放**最后**：有官方线路时，用户要选的多半是线路（自动匹配也会指向线路） */
  for (const l of taskLines.value) push(l.value, l.title)
  for (const e of lib.entries.value) push(String(e.lineId), `${String(e.lineName || e.lineId)}（本机已有）`)
  push(LOCAL_FREE_LINE_ID, localLineLabel.value)
  return out
})
/**
 * 🆕 2026-11-03（用户实测反馈"没有正常识别到任务记录的线路"）：
 * **按轨迹位置自动匹配官方线路**。
 *
 * 为什么必须这么做：归档记录里**只有 `paperId`（任务 id），没有线路 id**（字段表见
 * `_mp-analyze/深挖/D-配置与归档数据模型.md` §4.1）⇒ 服务端没说那次跑的是哪条线。
 * 而任务里的线路彼此相隔很远（东操场/西操场/图书馆…）⇒ 用"轨迹点到各线路折线的最小距离"判断，
 * 既准又不需要额外接口。匹配不上（>150 m）就**不硬塞**，让用户自己选。
 */
const autoMatch = computed(() => nearestLineByGeometry(rp.selection.value?.points ?? [], taskLinesWithGeometry.value))
/** 用户选的目标地点（默认：本机键；读到轨迹后会**按位置自动匹配**成对的官方线路） */
const targetLineId = ref<string>(LOCAL_FREE_LINE_ID)
/** 读到轨迹后：把下拉自动切到匹配到的线路（用户仍可改）；没匹配上就保持原样并说明 */
watch(autoMatch, (m) => {
  if (!m) return
  if (!locationItems.value.some((i) => i.value === m.pointId)) return
  targetLineId.value = m.pointId
})
watch(
  locationItems,
  (items) => {
    if (items.some((i) => i.value === targetLineId.value)) return
    targetLineId.value = items[0]?.value ?? LOCAL_FREE_LINE_ID
  },
  { immediate: true },
)
const targetLineName = computed(() => locationItems.value.find((i) => i.value === targetLineId.value)?.title ?? targetLineId.value)

/**
 * 预设名（留空 ⇒ 自动命名）。
 *
 * 🆕 2026-11-10 二次改版（用户口径"生成的路径名称后加上一段随机字符防止相同导致异常"）：
 * **自动名末尾带 4 位随机后缀**（如 `… · 真实路径 2026-09-17 · 1910-2b9c`）；
 * 用户一旦手改，就**保持原样**（不再追加后缀 —— 用户明确要的是"只给自动生成的加"）。
 */
const presetName = ref('')
/** 最近一次自动生成的名字 —— 换地点时只覆盖"还是自动名（或为空）"的情况，**绝不覆盖用户手改** */
const lastAutoName = ref('')
const rebuildAutoName = () => {
  const meta = rp.selection.value?.meta
  if (!meta) return
  const rec = rp.selectedRecord.value
  /** 🆕 2026-11-04（用户口径"默认名携带路径名称"）：带上「存到哪个地点」的名字，如「天目湖-东操场 · 真实路径 …」 */
  const base = defaultRealPathName({ ...meta, startTime: rec?.startTime }, targetLineName.value)
  lastAutoName.value = withRandomSuffix(base)
  presetName.value = lastAutoName.value
}
watch(() => rp.selection.value?.meta, rebuildAutoName)
/** 换了「存到哪个地点」⇒ 默认名跟着换地点前缀（手改过就不动） */
watch(targetLineName, () => {
  if (!presetName.value.trim() || presetName.value === lastAutoName.value) rebuildAutoName()
})

/** 轨迹读数（选了才显示） */
const lapInfo = computed(() => {
  const sel = rp.selection.value
  if (!sel) return null
  /**
   * 🆕 2026-11-04（用户口径"直接原样上传，而不是只保留几圈"）：
   * 轨迹**原样整条**保存（不切圈、不降采样）；切圈**只为了报"一圈多长"**（预览按它着色）。
   */
  return {
    sourcePoints: sel.points.length,
    lapLengthM: sel.lapLengthM,
  }
})
/** 自动匹配到的那条线路（界面如实说"按位置匹配的"） */
const autoMatchNote = computed(() => {
  const m = autoMatch.value
  if (!m) return ''
  return `按轨迹位置自动匹配到「${m.pointName}」（最近距离约 ${Math.round(m.distM)} m）—— 可在下面改`
})

// ── 🆕 2026-11-10 批量选择（用户需求①②：勾选多条 → 一次导出 / 一次导入多个包）──
/** 一条归档记录的形状（与 `utils/mp/realPath.ts` 的 `RealPathRecord` 同源，这里只取用到的字段） */
type RealPathRecord = (typeof rp.records.value)[number]
/**
 * **已经读过的月份**（`monthId` → 那个月的成绩）。
 * 用户口径："已经读取过的就没有必要重复读取，每一次点击月份都要重新读取一遍有点浪费"。
 * 点回读过的月份 ⇒ **直接用缓存**，不再打服务端；只有没读过的月份才真发请求。
 */
const monthCache = ref<Map<string, RealPathRecord[]>>(new Map())
/** 当前生效月份的显示名（列表标题用；读不出就叫"当前月份"） */
const activeMonthName = computed(() => {
  const id = String(rp.activeMonthId.value ?? '')
  return rp.months.value.find((m) => m.monthId === id)?.monthName || (id ? id : '当前月份')
})
/** 当前月份的列表（"全选""反选"只作用于它 —— 用户口径："这个选择只针对你选择的月份下面的"） */
const monthRecords = computed(() => rp.records.value)
/** 跨月累计已选（跨月保持；汇总块显示它） */
const pickedRecords = computed(() => rp.pickedRecords.value)
const pickedCount = computed(() => pickedRecords.value.length)
const pickedIds = computed(() => new Set(pickedRecords.value.map((r) => String(r.scoreId))))
/** 勾选摘要（最多列 4 条，多余的用"…"） */
const pickedDatesText = computed(() => {
  const shown = pickedRecords.value.slice(0, 4).map((r) => `${r.date || '日期未知'}${r.startTime ? ` ${r.startTime.slice(0, 5)}` : ''}`)
  return shown.join('、') + (pickedCount.value > shown.length ? `…（共 ${pickedCount.value} 条）` : '')
})
const isPicked = (scoreId: string) => pickedIds.value.has(String(scoreId))
const togglePick = (scoreId: string) => {
  const rec = [...monthRecords.value, ...pickedRecords.value].find((r) => String(r.scoreId) === String(scoreId))
  if (rec) rp.togglePickRecord(rec)
}
/** 当前月是否已全部选中（「全选」要显示成"已全选"） */
const monthAllPicked = computed(
  () => monthRecords.value.length > 0 && monthRecords.value.every((r) => pickedIds.value.has(String(r.scoreId))),
)
/** 当前月有多少条已选 */
const monthPickedCount = computed(() => monthRecords.value.filter((r) => pickedIds.value.has(String(r.scoreId))).length)
/** 「全选」：把**当前月份**的记录全加入已选（增量，不洗掉别的月份） */
const pickAll = () => rp.pickManyRecords(monthRecords.value)
/** 「反选」：把**当前月份**里已选的拿掉（其余月份的已选一律不动） */
const invertPicks = () => rp.unpickManyRecords(monthRecords.value.filter((r) => pickedIds.value.has(String(r.scoreId))))
/** 「清空已选」：清掉**全部**跨月已选 */
const clearPicks = () => rp.clearPickedRecords()
/** 从汇总块里逐条取消 */
const unpickOne = (scoreId: string) => {
  const rec = pickedRecords.value.find((r) => String(r.scoreId) === String(scoreId))
  if (rec) rp.togglePickRecord(rec)
}
/** 已选里有多少条不在当前月份（如实提示，免得用户以为丢了） */
const pickedOffMonthCount = computed(() => pickedRecords.value.filter((r) => !monthRecords.value.some((m) => String(m.scoreId) === String(r.scoreId))).length)

/** 批量动作的逐条结果（`null` = 还没跑过；界面据此决定显不显示"失败原因"那一栏） */
const batchSummary = ref<BatchSummaryLike | null>(null)
type BatchSummaryLike = { total: number; okCount: number; failCount: number; text: string; ok: { name: string; message: string }[]; failed: { name: string; message: string }[] }

/** 批量导出的进度文案与百分比（`null` = 没有批量在跑） */
const batchProgressText = computed(() => {
  const p = rp.batchProgress.value
  if (!p) return ''
  return `正在逐条读取轨迹 ${p.done}/${p.total} …（每条都要单独问一次服务端，请稍候）`
})
const batchProgressPercent = computed(() => {
  const p = rp.batchProgress.value
  if (!p || !p.total) return 0
  return Math.round((p.done / p.total) * 100)
})

const doBatchSave = async () => {
  const out = await rp.saveBatchAsPresets(
    pickedRecords.value.map((r) => ({ scoreId: r.scoreId })),
    targetLineId.value,
    targetLineName.value,
  )
  batchSummary.value = out.summary
  showSnackbar(out.message, out.summary.failCount ? (out.summary.okCount ? 'warning' : 'error') : 'success')
}
const doBatchShare = async () => {
  /** 🔴 地点一起导出去（否则对方导入时无从归位） */
  const out = await rp.downloadBatchZip(pickedRecords.value.map((r) => ({ scoreId: r.scoreId })), {
    lineId: targetLineId.value,
    lineName: targetLineName.value,
  })
  batchSummary.value = out.summary
  showSnackbar(out.message, out.summary.failCount ? (out.summary.okCount ? 'warning' : 'error') : 'info')
}

const doLoadMonths = async () => {
  const list = await rp.loadMonths()
  if (list.length) showSnackbar(`读到 ${list.length} 个月份`, 'info')
  else if (rp.error.value) showSnackbar(rp.error.value, 'warning')
}
/**
 * 读某个月的归档。
 *
 * 🔴 2026-11-10 二次验收修正（Bug 2 的另一半）：
 *   · **已读过的月份直接用缓存**（用户口径："已经读取过的就没有必要重复读取"）——
 *     缓存键是 `monthId`，只在"重新读"这个显式动作下才失效；
 *   · 读到的新月份**并入**列表（`scoreId` 去重），而不是把上一个月的记录顶掉 ——
 *     否则"跨月勾选"会立刻变成"勾选指向不存在的记录"。
 *
 * @param monthId  指定月份；不传 = 用当前月份
 * @param force    忽略缓存、强制重读（「重新读一遍」按钮用）
 */
const doLoadRecords = async (monthId?: string, force = false) => {
  const key = String(monthId ?? '').trim()
  /**
   * 「读取最近成绩」（不点名月份）是**重来一次**的语义：先清空列表与缓存，只留"最近这个月"。
   * 点具体月份才是**累积**（用户要在跨月之间勾选）。
   */
  if (!key) {
    rp.records.value = []
    monthCache.value = new Map()
  }
  if (key && !force && monthCache.value.has(key)) {
    const cached = monthCache.value.get(key)!
    /**
     * 🔴 缓存命中 = "把列表切到这个月"，与联网读到之后**做同样的事**（只是不发请求）：
     *   · `records` 的语义是"当前月份" ⇒ 这里**赋值**（不是并入）；
     *   · `activeMonthId` 必须跟着走，否则高亮会停在别的月份上
     *     （实测：点回读过的月份时高亮串到了另一个月，看着像"点错了"）；
     *   · 清掉"选中看轨迹"的那一条 —— 它属于上一个月，留着会让第 3 步显示别的月的轨迹。
     */
    rp.records.value = cached
    rp.activeMonthId.value = key
    rp.selectedScoreId.value = ''
    rp.points.value = null
    showSnackbar(`「${monthNameOf(key)}」已读过（${cached.length} 条），直接用本机缓存 —— 要重读请点「重新读取」`, 'info', { timeout: 4000 })
    return
  }
  const list = await rp.loadRecords(monthId)
  if (rp.error.value) {
    showSnackbar(rp.error.value, 'warning')
    return
  }
  /** 成功读到（哪怕 0 条）就把这个月记进缓存：0 条也是有效答案，不必反复问 */
  const usedKey = String(rp.activeMonthId.value || key).trim()
  if (usedKey) monthCache.value = new Map(monthCache.value).set(usedKey, list)
  if (list.length) showSnackbar(rp.notice.value || `读到 ${list.length} 条成绩`, 'info')
  else showSnackbar(rp.notice.value || '这个月没有查到成绩记录', 'warning')
}
/** 月份显示名（缓存命中时提示用；找不到就回退成 id） */
const monthNameOf = (monthId: string) => rp.months.value.find((m) => m.monthId === monthId)?.monthName || monthId
/** 「重新读取」：清掉本机缓存并强制重读列表里已有的那些月份（同一批请求，不改变选择） */
const doReloadRecords = async () => {
  const ids = [...monthCache.value.keys()]
  monthCache.value = new Map()
  if (!ids.length) {
    await doLoadRecords(rp.activeMonthId.value || undefined, true)
    return
  }
  for (const id of ids) await doLoadRecords(id, true)
  showSnackbar(`已重新读取 ${ids.length} 个月的归档`, 'info')
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
  /** 🔴 地点必须一起导出去（否则对方导入时无从归位） */
  const out = await rp.downloadShareZip(presetName.value, targetLineId.value, targetLineName.value)
  showSnackbar(out.message, out.ok ? 'info' : 'error')
}

/** 导入：文件选择 + 存到当前选中的地点 */
const fileInput = ref<HTMLInputElement | null>(null)
const doImport = async (ev: Event) => {
  const input = ev.target as HTMLInputElement
  /**
   * 🆕 2026-11-10（用户需求②）：**支持一次选多个压缩包**。
   * 逐条结果由组合层汇总（`importManyShareZips`），失败原因写在 `batchSummary` 里逐条列出 ——
   * 这里不再只弹一个"成功/失败"就完事（那样多个文件时说不清是哪个出的问题）。
   */
  const files = [...(input.files ?? [])]
  if (!files.length) return
  /**
   * 🔴 2026-11-10（用户反馈「导入东操场的路径没有被录入到东操场」）：
   * 把**可选地点表**传给组合层，让它先按「包里的地点 → 轨迹位置」自动归类；
   * 认不出的那些回到 pending，这里再弹「选择存档地点」让用户定。
   */
  const out = await rp.importManyShareZips(files, {
    lineId: targetLineId.value,
    lineName: targetLineName.value,
    places: placeOptions.value,
  })
  batchSummary.value = out.summary
  if (out.pending.length) {
    pendingImports.value = out.pending
    pendingPlaceId.value = placeOptions.value[0]?.value ?? LOCAL_FREE_LINE_ID
    pendingOpen.value = true
  }
  showSnackbar(out.message, out.summary.failCount ? (out.summary.okCount ? 'warning' : 'error') : 'success')
  /** 清空选择，便于同一批文件再导一次（例如换个地点） */
  input.value = ''
}

/** ── 导入时「认不出地点」的待定项 + 选择存档地点的弹窗（2026-11-10）── */
const pendingOpen = ref(false)
const pendingImports = ref<{ file: string; entryName: string; item: { name: string; points: unknown[] }; reason: string }[]>([])
/** 用户在弹窗里选的地点 */
const pendingPlaceId = ref<string>(LOCAL_FREE_LINE_ID)
/**
 * **可选地点表**（含官方线路点列）—— 自动归类与弹窗下拉共用这一份。
 * ⚠️ 与 locationItems 的区别：那个是给下拉用的（只有 value/title），
 * 这里额外带上 pointList，几何匹配要用。
 */
const placeOptions = computed(() => {
  const out: { value: string; title: string; pointList?: { latitude: number; longitude: number }[] }[] = []
  const seen = new Set<string>()
  const push = (value: string, title: string, pointList?: { latitude: number; longitude: number }[]) => {
    const v = String(value ?? '').trim()
    if (!v || seen.has(v)) return
    seen.add(v)
    out.push({ value: v, title, pointList })
  }
  /** 官方线路优先（几何匹配只能靠它们） */
  for (const l of taskLinesWithGeometry.value) push(l.pointId, l.pointName, l.pointList)
  for (const i of locationItems.value) push(i.value, i.title)
  return out
})
const pendingPlaceName = computed(
  () => placeOptions.value.find((o) => o.value === pendingPlaceId.value)?.title ?? pendingPlaceId.value,
)
/** 弹窗里确认：把待定的那几条存到选中的地点 */
const doSavePending = () => {
  const out = rp.savePendingImports(pendingImports.value as never, pendingPlaceId.value, pendingPlaceName.value)
  pendingOpen.value = false
  const prev = batchSummary.value
  /** 与上一次的批量结果合并（用户要同时看到「自动归类的」与「手动选的」两批结果） */
  const mergedText = `${prev?.text ?? ''}；其中 ${out.summary.okCount} 条按你选的地点存好了`
  batchSummary.value = prev
    ? {
        ...prev,
        okCount: prev.okCount + out.summary.okCount,
        failCount: prev.failCount + out.summary.failCount,
        total: prev.total + out.summary.total,
        ok: [...prev.ok, ...out.summary.ok],
        failed: [...prev.failed, ...out.summary.failed],
        text: mergedText,
      }
    : out.summary
  showSnackbar(out.message, out.ok ? 'success' : 'error')
  pendingImports.value = []
}
/** 弹窗里取消：这几条不导入了（如实告诉用户没导入） */
const cancelPending = () => {
  pendingOpen.value = false
  showSnackbar(`已放弃 ${pendingImports.value.length} 条认不出地点的路径（没有导入）`, 'warning')
  pendingImports.value = []
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
              <!-- 🆕 换月份不再重新请求已读过的月份；要拿最新数据就点这里 -->
              <v-btn
                size="small"
                variant="tonal"
                prepend-icon="mdi-refresh"
                :loading="rp.busy.value === 'records'"
                :disabled="!rp.hasToken.value || !monthCache.size"
                @click="doReloadRecords"
              >
                重新读取
              </v-btn>
              <span class="text-caption text-medium-emphasis">（不选月份＝用当前月份；点过的月份走本机缓存）</span>
            </div>
            <div v-if="rp.months.value.length" class="d-flex flex-wrap ga-1 mb-3">
              <!-- 高亮 = 最近一次真正读过的那个月（activeMonthId），不是"永远是本月"：否则读 9 月、界面却亮着本月 -->
              <v-btn
                v-for="m in rp.months.value"
                :key="m.monthId"
                size="x-small"
                variant="tonal"
                :color="m.monthId === rp.activeMonthId.value ? 'primary' : undefined"
                :prepend-icon="monthCache.has(m.monthId) ? 'mdi-check' : undefined"
                @click="doLoadRecords(m.monthId)"
              >
                {{ m.monthName }}{{ m.isCurrent ? '（当前）' : '' }}
              </v-btn>
            </div>

            <v-alert v-if="rp.error.value" type="error" variant="tonal" density="compact" class="mb-2">{{ rp.error.value }}</v-alert>
            <v-alert v-else-if="rp.notice.value" type="success" variant="tonal" density="compact" class="mb-2">{{ rp.notice.value }}</v-alert>

            <div v-if="!monthRecords.length" class="text-caption text-medium-emphasis mb-2">
              这个月还没有数据：先点上面的「读取最近成绩」，或点另一个月份。
            </div>
            <template v-else>
              <!-- 🔴 2026-11-10 三次改版（用户口径）：列表只显示当前月份的记录；
                   「全选 / 反选」只作用于这个月的列表 -->
              <div class="d-flex flex-wrap align-center ga-2 mb-2">
                <div class="text-subtitle-2">
                  {{ activeMonthName }} 的成绩（{{ monthRecords.length }} 条，已选 {{ monthPickedCount }}）
                </div>
                <v-spacer />
                <v-btn size="x-small" variant="tonal" @click="pickAll">全选</v-btn>
                <v-btn size="x-small" variant="tonal" :disabled="!monthPickedCount" @click="invertPicks">反选</v-btn>
              </div>
              <v-list density="compact" class="pa-0">
                <v-list-item
                  v-for="r in monthRecords"
                  :key="r.scoreId"
                  :active="rp.selectedScoreId.value === r.scoreId"
                  @click="rp.pickRecord(r.scoreId)"
                >
                  <template #prepend>
                    <v-checkbox-btn
                      :model-value="isPicked(r.scoreId)"
                      density="compact"
                      class="mr-1"
                      :aria-label="`勾选 ${r.scoreId}`"
                      @click.stop="togglePick(r.scoreId)"
                    />
                  </template>
                  <v-list-item-title class="text-body-2">
                    <span class="text-medium-emphasis">{{ r.date || '日期未知' }}</span> · {{ recordLabel(r) }}
                  </v-list-item-title>
                  <v-list-item-subtitle class="text-caption">场次号：{{ r.scoreId }}</v-list-item-subtitle>
                  <template #append>
                    <!-- 单条/批量互斥（用户口径）：勾了任何一条 ⇒ 单条读取变灰；清空勾选后恢复 -->
                    <v-btn
                      size="x-small"
                      variant="text"
                      color="primary"
                      :disabled="pickedCount > 0"
                      :loading="rp.busy.value === 'detail'"
                      @click.stop="doLoadDetail(r.scoreId)"
                    >
                      读取轨迹
                    </v-btn>
                  </template>
                </v-list-item>
              </v-list>
              <div class="text-caption text-medium-emphasis mt-1">
                {{ monthAllPicked ? '这个月已全选。' : '勾选框只影响"已选汇总"；不勾选时点一条读它的轨迹（单条导出）。' }}
                换月份<b>不会</b>丢掉已选的。
              </div>
            </template>

            <!-- 🆕 2026-11-10（用户口径）：已选汇总（常驻）—— 跨月累计选中的都列在这儿，可逐条取消 -->
            <v-divider class="my-3" />
            <div class="d-flex flex-wrap align-center ga-2 mb-2">
              <div class="text-subtitle-2">已选汇总（{{ pickedCount }} 条）</div>
              <v-spacer />
              <v-btn size="x-small" variant="tonal" :disabled="!pickedCount" @click="clearPicks">清空已选</v-btn>
            </div>
            <div v-if="!pickedCount" class="text-caption text-medium-emphasis">
              还没选任何成绩：在上面勾选，或点「全选」（只选当前月份）；选中后这里会列出全部。
            </div>
            <template v-else>
              <div v-if="pickedOffMonthCount" class="text-caption text-primary mb-1">
                其中 {{ pickedOffMonthCount }} 条不在当前月份 —— 导出时会一起带上。
              </div>
              <v-list density="compact" class="pa-0 selected-summary">
                <v-list-item v-for="r in pickedRecords" :key="`pick-${r.scoreId}`" class="px-0">
                  <v-list-item-title class="text-body-2">
                    <span class="text-medium-emphasis">{{ r.date || '日期未知' }}</span> ·
                    {{ r.startTime || '时间未知' }} · {{ r.km === null ? '里程未知' : `${r.km.toFixed(2)} km` }}
                    · {{ r.usedTime || '用时未知' }}
                  </v-list-item-title>
                  <template #append>
                    <v-btn size="x-small" variant="text" color="error" @click="unpickOne(r.scoreId)">取消</v-btn>
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
                原样保存 <b>{{ lapInfo.sourcePoints }}</b> 点（<b>不切圈、不降采样</b>）
                <template v-if="lapInfo.lapLengthM">
                  · 识别到一圈约 <b>{{ Math.round(lapInfo.lapLengthM) }} m</b>（跑步页预览按它把整条按圈着色）
                </template>
                <template v-else> · <span class="text-warning">没识别到闭环</span>，预览按整条一色显示</template>
              </div>
              <div v-if="autoMatchNote" class="text-caption text-success mt-1">{{ autoMatchNote }}</div>
              <div v-else-if="taskLinesWithGeometry.length" class="text-caption text-medium-emphasis mt-1">
                没能在你当前任务的线路里按位置认出这条轨迹（最近也超过 150 m）—— 请在右边的「存到哪个地点」里自己挑一条。
              </div>
              <div v-else class="text-caption text-warning mt-1">
                当前还没有读到任务（线路列表为空）⇒ 只能先存到「本机跑道」。回「工作台」读一次任务再回本页，就会自动按位置匹配线路。
              </div>
              <div class="text-caption text-medium-emphasis mt-1">
                一圈长度只是<b>报数</b>（供预览按圈着色），轨迹本身一个点都不删 —— 5~8 圈整场原样保存。
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
            <!-- 长度上限 = 纯函数里的 TRACK_NAME_MAX（预设名在这里就截断，不留给路线库静默删尾巴） -->
            <v-text-field v-model="presetName" label="预设名称（留空 = 自动命名）" density="compact" :counter="TRACK_NAME_MAX" :maxlength="TRACK_NAME_MAX" hide-details="auto" class="mb-1" />
            <div class="text-caption text-medium-emphasis mb-3">
              留空时自动命名会在末尾加一段<b>随机后缀</b>（如 <code>-2b9c</code>），避免两次导出撞名；你手打的名字保持原样。
            </div>
            <!-- 🔴 单条 / 批量互斥（用户口径）：勾了任何一条 ⇒ 下面这两个单条按钮变灰 -->
            <v-alert v-if="pickedCount" type="warning" variant="tonal" density="compact" class="mb-2">
              已选 {{ pickedCount }} 条 ⇒ <b>单条导出已锁定</b>。要单条导出请先「清空勾选」。
            </v-alert>
            <v-btn block size="small" color="primary" class="mb-2" prepend-icon="mdi-content-save-outline" :disabled="!lapInfo || pickedCount > 0" :loading="rp.busy.value === 'save'" @click="doSave">
              导出到本地：存为路径预设
            </v-btn>
            <div class="text-caption text-medium-emphasis mb-3">
              存进本机路线库（与「跑道编辑」共用同一个库）⇒ 回「跑步」页就能在「预设 / 本机路径」里选到它。
            </div>
            <v-btn block size="small" color="secondary" variant="tonal" prepend-icon="mdi-folder-zip-outline" :disabled="!lapInfo || pickedCount > 0" :loading="rp.busy.value === 'share'" @click="doShare">
              导出分享给好友：生成压缩包
            </v-btn>
            <div class="text-caption text-medium-emphasis mt-1">
              单条压缩包里只有<b>一个</b> JSON（<code>totoro-real-path.json</code>）：路径点 + 日期/场次号/里程/用时/拟合度。
              <b>不含</b> token、学号、姓名。好友用下面的「导入」读回去即成为他自己的本机预设。
            </div>
            <v-divider class="my-3" />
            <!-- 🆕 2026-11-10（用户需求①）：批量 —— 勾选多条 → 一次导出 -->
            <div class="text-subtitle-2 mb-1">批量操作（勾选多条后可用）</div>
            <v-alert v-if="pickedCount" type="info" variant="tonal" density="compact" class="mb-2">
              已选 <b>{{ pickedCount }}</b> 条：{{ pickedDatesText }}
            </v-alert>
            <div v-else class="text-caption text-medium-emphasis mb-2">
              在左边列表里勾选复选框（可先点「全选」）—— 勾选是<b>跨年月</b>的。
            </div>
            <div v-if="batchProgressText" class="mb-2">
              <v-progress-linear :model-value="batchProgressPercent" color="primary" height="6" rounded class="mb-1" />
              <div class="text-caption text-medium-emphasis">{{ batchProgressText }}</div>
            </div>
            <v-btn
              block
              size="small"
              color="primary"
              variant="tonal"
              class="mb-2"
              prepend-icon="mdi-content-save-multiple-outline"
              :disabled="!pickedCount"
              :loading="rp.busy.value === 'save'"
              @click="doBatchSave"
            >
              批量存为路径预设（{{ pickedCount }} 条）
            </v-btn>
            <v-btn
              block
              size="small"
              color="secondary"
              variant="tonal"
              class="mb-2"
              prepend-icon="mdi-folder-zip-outline"
              :disabled="!pickedCount"
              :loading="rp.busy.value === 'share'"
              @click="doBatchShare"
            >
              批量导出压缩包（{{ pickedCount }} 条）
            </v-btn>
            <div class="text-caption text-medium-emphasis mb-3">
              每条都要<b>单独读一次轨迹</b>，所以条数多时会慢一些（上面有进度条）。
              导出的包里<b>每条路径一个独立的 JSON 文件</b>；读不到的<b>跳过</b>，最后在下面逐条列出结果。
            </div>
            <v-divider class="my-3" />
            <div class="text-subtitle-2 mb-1">导入好友分享的压缩包</div>
            <input ref="fileInput" type="file" accept=".zip,application/zip" multiple class="d-none" @change="doImport" />
            <v-btn block size="small" variant="tonal" prepend-icon="mdi-file-upload-outline" @click="fileInput?.click()">
              选择一个或多个压缩包并导入
            </v-btn>
            <div class="text-caption text-medium-emphasis mt-1">
              导入的路径会存到上面选的地点（同样可以在跑步页选用）；存进去的条目会标明"来源：真实路径"。
              <b>可以一次选多个包</b>；一个包里有多少条路径就收多少条（导出的批量包内是每条一个 JSON）。
              失败的会在下面逐条说明原因。
            </div>

            <!-- 🆕 2026-11-10（用户口径）：认不出地点的那几条弹这个选择框；选完才落库 -->
            <v-dialog v-model="pendingOpen" max-width="560" persistent>
              <v-card>
                <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
                  <v-icon color="warning">mdi-map-marker-question-outline</v-icon>
                  选择存档地点（{{ pendingImports.length }} 条认不出来）
                </v-card-title>
                <v-card-text>
                  <div class="text-caption text-medium-emphasis mb-2">
                    下面这些路径<b>包里没写地点、按轨迹位置也匹配不上</b>任何线路。
                    请选一个地点把它们存进去（存进去后仍可在「跑道编辑」里重命名/删除）。
                  </div>
                  <v-list density="compact" class="pa-0 mb-3 pending-list">
                    <v-list-item v-for="(p, i) in pendingImports" :key="i" class="px-0">
                      <!-- 显示路径名（包里 item.name），不是包内 JSON 文件名 —— 后者对用户没意义 -->
                      <v-list-item-title class="text-body-2">{{ p.item.name || p.entryName }}</v-list-item-title>
                      <v-list-item-subtitle class="text-caption">{{ p.reason }}（来自 {{ p.file }}）</v-list-item-subtitle>
                    </v-list-item>
                  </v-list>
                  <v-select
                    v-model="pendingPlaceId"
                    :items="placeOptions"
                    item-title="title"
                    item-value="value"
                    label="存到哪个地点"
                    density="compact"
                    hide-details
                  />
                </v-card-text>
                <v-card-actions>
                  <v-btn variant="text" @click="cancelPending">不导入这些</v-btn>
                  <v-spacer />
                  <v-btn color="primary" variant="flat" @click="doSavePending">存到「{{ pendingPlaceName }}」</v-btn>
                </v-card-actions>
              </v-card>
            </v-dialog>

            <!-- 🆕 2026-11-10（用户需求②）：批量结果 —— 成功的点一下数，失败的必须逐条列出来 -->
            <template v-if="batchSummary && batchSummary.total">
              <v-divider class="my-3" />
              <div class="text-subtitle-2 mb-1">上一次批量的结果</div>
              <v-alert :type="batchSummary.failCount ? (batchSummary.okCount ? 'warning' : 'error') : 'success'" variant="tonal" density="compact" class="mb-2">
                {{ batchSummary.text }}
              </v-alert>
              <div v-if="batchSummary.failed.length" class="mb-1">
                <div class="text-caption font-weight-bold text-error mb-1">失败的 {{ batchSummary.failed.length }} 条（逐条原因）：</div>
                <v-list density="compact" class="pa-0">
                  <v-list-item v-for="(f, i) in batchSummary.failed" :key="`bf-${i}`" class="px-0">
                    <v-list-item-title class="text-body-2">{{ f.name }}</v-list-item-title>
                    <v-list-item-subtitle class="text-caption">{{ f.message }}</v-list-item-subtitle>
                  </v-list-item>
                </v-list>
              </div>
              <v-expansion-panels v-if="batchSummary.ok.length" variant="accordion">
                <v-expansion-panel :title="`成功的 ${batchSummary.ok.length} 条（展开看明细）`">
                  <v-expansion-panel-text>
                    <div v-for="(o, i) in batchSummary.ok" :key="`bo-${i}`" class="text-caption mb-1">
                      <b>{{ o.name }}</b> —— {{ o.message }}
                    </div>
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
            </template>
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
