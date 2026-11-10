/**
 * **「真实路径【测试】」的取数与导出**（2026-11-03，1.3.6 需求③）
 *
 * 用户口径："登录账号后，可以使用相关内部功能来导出**某一天真实跑的路径信息**，并可以选择
 * 「导出到本地存为路径预设」或者「导出分享给好友」两种选择，用户在跑步界面可以选择这些路径并进行跑步，
 * 目前先做到直接原版数据提交"；分享形态 = **压缩包**。
 *
 * ## 分层（别把这三件事混在一起）
 *   · **纯算法**：`utils/mp/realPath.ts`（解析/切一圈/分享包/读 zip，全有单测）；
 *   · **本文件**：只做"发请求 + 状态机 + 落库/下载"的编排；
 *   · **页面**：`components/RealPathView.vue` 只渲染状态与触发动作。
 *
 * ## 🆕 2026-11-04 口径：**轨迹原样整条**
 * 用户口径："相关的真实路径导出以及引用指的是将原版的路径直接导出然后直接原样上传，而不是只保留几圈"。
 * ⇒ 存预设 / 分享包 / 导入 / 跑步页引用一律用**读回来的原始点列**（不切圈、不降采样）；
 *   切圈（`extractOneLap`）只为了**报一圈长度**（预览按圈着色用，存进 `meta.lapLengthM`）。
 *
 * ## 三条纪律
 *   ① **只读**：本功能对服务端只发只读请求（`getTermList` / `getSchoolMonthByTerm` /
 *      `getSunrunArch` / `getSunrunArchDetail`），**没有任何写请求**；
 *      （注意：本行原来写成 `get*`/`select*` 那种通配写法，其中的 `*` + `/` 会把块注释提前关掉 ——
 *       踩过一次，注释里别再出现星号加斜杠的连续字符。）
 *   ② **只碰本人数据**：查询用的 `snCode` 来自当前登录会话（`useMpReal().profile`），
 *      **不接受调用方指定别人的学号**（隐私红线，见 AGENTS 与项目纪律）；
 *   ③ **提交口径不变**：导出的路径只是**本机几何**，跑步页提交仍走原版报文（本功能一行都没碰 `submitPayload`）。
 */
import { MpApiWrapper } from '~/src/wrappers/MpApiWrapper'
import { logInfo, logWarn } from '~/composables/useEventLog'
import {
  REAL_PATH_BUNDLE_FILE,
  buildRealPathPresetDraft,
  buildShareBundle,
  bundleJsonOf,
  defaultRealPathName,
  extractOneLap,
  groupRecordsByDay,
  parseArchDetailPoints,
  parseArchRecords,
  pathLengthM,
  pickBundleItem,
  pickMonthId,
  readAllShareItemsFromZip,
  readShareBundleFromZip,
  sanitizeZipEntryName,
  summarizeBatch,
  withRandomSuffix,
  type BatchOutcome,
  type BatchSummary,
  type RealPathBundle,
  type RealPathBundleItem,
  type RealPathDay,
  type RealPathMeta,
  type RealPathPoint,
  type RealPathRecord,
} from '~/utils/mp/realPath'

/** 一个"可选的月份"（来自 `getSchoolMonthByTerm`） */
export interface RealPathMonth {
  monthId: string
  monthName: string
  isCurrent: boolean
}

/** 归档里一条被选中的成绩 + 它的轨迹（读到轨迹之后才有 `points`） */
export interface RealPathSelection {
  record: RealPathRecord
  /** **原样整条轨迹**（🆕 2026-11-04：不切圈、不降采样，存预设/分享都用它） */
  points: RealPathPoint[]
  /**
   * **一圈长度**（米；从整条里识别出闭环才量得出 ⇒ `null` = 没识别到）。
   * 切圈**只为了报这一个数**（预览按它把整条按圈着色）；轨迹本身一个点都不删。
   */
  lapLengthM: number | null
  /** 导出用的元信息（含 `lapLengthM`） */
  meta: RealPathMeta
}

export function useRealPathExport() {
  const lib = useTrackLibrary()
  /** 登录态（token / baseUrl）—— `useMpSession()` 是**唯一**的会话来源（别自己读 localStorage） */
  const { session, token: sessionToken } = useMpSession()
  /** 真实链路的档案（含 `snCode` 与学校码）—— 只读本人 |
   *  ⚠️ 用 `useMpReal()` 而不是直接读 localStorage：档案的"是否读过"由它统一维护 */
  const real = useMpReal()

  const months = useState<RealPathMonth[]>('mpRealPathMonths', () => [])
  /**
   * **最近一次读归档用的月份**（`monthId`；`''` = 还没读过）。
   * 界面的月份高亮只认它 —— 原来是"`ifCurrent` 那条永远高亮"，于是点 10 月或用「读取最近成绩」
   * 读到 9 月的数据时，上面高亮的还是本月（图 1 那个现象）。取值判据见 `pickMonthId()`。
   */
  const activeMonthId = useState<string>('mpRealPathMonthId', () => '')
  /**
   * **批量动作的进度**（`{done,total}`；`null` = 没有批量在跑）。
   * 批量要串行读多条轨迹，几十秒都可能 —— 没有进度用户只会以为卡死了。
   */
  const batchProgress = useState<{ done: number; total: number } | null>('mpRealPathBatchProgress', () => null)
  const records = useState<RealPathRecord[]>('mpRealPathRecords', () => [])
  /**
   * **跨月累计已选**的成绩（用户口径里的"已选汇总"）。
   *
   * 为什么按**整条记录**存而不是只存 id：换月份后 `records` 只剩当月那批，
   * 只存 id 的话汇总块就渲染不出"9 月选了哪几条"（拿不到日期/里程/场次号）。
   * 存整条也只是几十条小对象，换来的是"跨月选择可见、可逐条取消"。
   */
  const pickedRecords = useState<RealPathRecord[]>('mpRealPathPicked', () => [])
  /** 选中的那一天（`''` = 全部/没选） */
  const selectedDate = useState<string>('mpRealPathDate', () => '')
  /** 选中的那条成绩的场次号（`''` = 没选） */
  const selectedScoreId = useState<string>('mpRealPathScoreId', () => '')
  /** 已读到的轨迹（`null` = 还没读） */
  const points = useState<RealPathPoint[] | null>('mpRealPathPoints', () => null)
  /** 正在做什么（界面据此禁用按钮）：'' / 'months' / 'records' / 'detail' / 'save' / 'share' */
  const busy = useState<string>('mpRealPathBusy', () => '')
  /** 上一次操作的错误（空串 = 没错误） */
  const error = useState<string>('mpRealPathError', () => '')
  /** 上一次成功的提示（空串 = 没提示） */
  const notice = useState<string>('mpRealPathNotice', () => '')

  const token = computed(() => String(sessionToken.value ?? session.value?.token ?? ''))
  /** 读这一列请求都要带的基础参数（与 `real/submit.ts` 的读判定同口径） */
  const apiOptions = computed(() => ({ token: token.value, baseUrl: session?.value?.baseUrl }))
  const snCode = computed(() => String(real.profile.value?.snCode ?? ''))
  const hasToken = computed(() => Boolean(token.value))

  const days = computed<RealPathDay[]>(() => groupRecordsByDay(records.value))
  /** 当前选中的那条（没选 ⇒ `undefined`） */
  const selectedRecord = computed(() => records.value.find((r) => r.scoreId === selectedScoreId.value))
  /** 选中那条的读数（🆕 2026-11-04：轨迹**原样整条**，一圈长度只为预览着色报数） */
  const selection = computed<RealPathSelection | null>(() => {
    const record = selectedRecord.value
    if (!record || !points.value) return null
    /**
     * **切圈只为了报"一圈多长"**（预览按它着色；用户口径"仍按一圈长着色"）：
     * `extractOneLap` 认得出闭环 ⇒ 量那一圈的折线长度；认不出 ⇒ `null`（预览整条一色）。
     * ⚠️ 轨迹本身**一个点都不删**（用户 2026-11-04 口径："直接原样上传，而不是只保留几圈"）。
     */
    const lap = extractOneLap(points.value, { tolM: 25, minM: 200 })
    const lapLengthM = lap.length < points.value.length ? pathLengthM(lap) : null
    const meta: RealPathMeta = {
      date: record.date,
      scoreId: record.scoreId,
      km: record.km,
      usedTime: record.usedTime,
      fitDegree: record.fitDegree,
      sourcePoints: points.value.length,
      lapLengthM,
      exportedAt: new Date().toISOString(),
    }
    return { record, points: points.value, lapLengthM, meta }
  })

  /** 清掉"选中的轨迹"（换天/换条时必须清，否则会把上一条的轨迹当成这一条的） */
  const clearDetail = () => {
    points.value = null
  }

  /** 读学期/月份列表（只读） */
  const loadMonths = async (): Promise<RealPathMonth[]> => {
    if (!hasToken.value) {
      error.value = '还没有登录态：请先回「工作台」点「一键获取 token」'
      return []
    }
    busy.value = 'months'
    error.value = ''
    notice.value = ''
    try {
      const res = await MpApiWrapper.getSchoolMonthByTerm(apiOptions.value)
      const list = (res.data as { monthId?: string; monthName?: string; ifCurrent?: string | number }[] | undefined) ?? []
      const out: RealPathMonth[] = []
      for (const m of list) {
        const monthId = String(m?.monthId ?? '').trim()
        if (!monthId) continue
        out.push({ monthId, monthName: String(m?.monthName ?? monthId), isCurrent: String(m?.ifCurrent) === '1' })
      }
      months.value = out
      /**
       * 读回月份表后**先按当前月预置高亮**（`pickMonthId()` 的第二条判据）：
       * 不预置的话，"只点了「读月份」、还没读成绩"时整个月份条一个都不亮，
       * 用户看不出"再点一下就是读这个月"。
       */
      if (!activeMonthId.value) activeMonthId.value = pickMonthId(out)
      logInfo('realpath', '读到月份列表', { count: out.length })
      if (!out.length) error.value = '服务端没给月份列表 —— 可以先点「读取最近成绩」用当前学期/月份试一次'
      return out
    } catch (err) {
      error.value = `读月份失败：${err instanceof Error ? err.message : '未知错误'}`
      logWarn('realpath', '读月份失败', { message: error.value })
      return []
    } finally {
      busy.value = ''
    }
  }

  /**
   * 读成绩归档（**只读**）：先按当前学期 + 指定月份查，
   * 口径与 `composables/real/submit.ts` 的读判定**逐字相同**（`rowNumber: 1000`）。
   */
  const loadRecords = async (monthId?: string): Promise<RealPathRecord[]> => {
    if (!hasToken.value) {
      error.value = '还没有登录态：请先回「工作台」点「一键获取 token」'
      return []
    }
    busy.value = 'records'
    error.value = ''
    notice.value = ''
    clearDetail()
    try {
      const terms = await MpApiWrapper.getTermList(apiOptions.value)
      const termList = (terms.data as { id?: string; isActive?: string | number }[] | undefined) ?? []
      const activeTerm = termList.find((t) => String(t.isActive) === '1') ?? termList[0]
      /** 月份：调用方给了就用它；否则用「当前月份」（判据只在纯函数 `pickMonthId()` 里，别在这里另写一套） */
      if (!months.value.length) await loadMonths()
      const useMonth = pickMonthId(months.value, monthId)
      if (!useMonth) {
        error.value = '没能确定要读哪个月份：请先点右上角「读月份」，再点某个月份读取'
        return []
      }
      const arch = await MpApiWrapper.getSunrunArch(
        {
          projectName: '阳光跑',
          monthId: useMonth,
          termId: String(activeTerm?.id ?? ''),
          paperId: '',
          stuNumber: snCode.value,
          snCode: snCode.value,
          pageNumber: 1,
          rowNumber: 1000,
        },
        apiOptions.value,
      )
      const list = parseArchRecords(arch.data)
      /**
       * 🔄 2026-11-10 三次验收修正（用户口径）：`records` 只放**当前月份**的记录。
       *
       * 上一版为了"跨月勾选不丢"把各月记录并进同一个列表，结果列表变成"全部月份堆在一起"
       * —— 用户明确说："图二应该是一个选项卡下只有一个月相关的，而不是全部的"。
       * 现在分层：
       *   · `records`        = **当前选中月份**的记录（列表只显示它）；
       *   · `pickedRecords`  = **跨月累计已选**（汇总块显示它）—— 换月份不影响它。
       * 于是"跨月勾选不丢"与"列表只显示当月"两件事可以同时成立。
       */
      records.value = list
      /** 界面高亮跟着**真正用过的那一个月**走（图 1：读的是 9 月、高亮却停在"本月"） */
      activeMonthId.value = useMonth
      selectedDate.value = ''
      selectedScoreId.value = ''
      logInfo('realpath', '读到成绩归档', { count: list.length, monthId: useMonth })
      if (!list.length) {
        notice.value = '这个月没有查到成绩记录（也可能该月还没跑）'
      } else {
        notice.value = `读到 ${list.length} 条成绩，按天分成 ${groupRecordsByDay(list).length} 天`
      }
      return list
    } catch (err) {
      error.value = `读成绩归档失败：${err instanceof Error ? err.message : '未知错误'}`
      logWarn('realpath', '读成绩归档失败', { message: error.value })
      return []
    } finally {
      busy.value = ''
    }
  }

  /** 选一天（界面点日期条）—— 顺带把"选中成绩"清掉，避免张冠李戴 */
  const pickDate = (date: string) => {
    selectedDate.value = String(date ?? '')
    selectedScoreId.value = ''
    clearDetail()
  }

  /** 选一条成绩（界面点那一条）—— 同样清掉上一条的轨迹 */
  const pickRecord = (scoreId: string) => {
    selectedScoreId.value = String(scoreId ?? '')
    clearDetail()
  }

  /** 读这条成绩的轨迹（**只读**；`getSunrunArchDetail`） */
  const loadDetail = async (scoreId?: string): Promise<RealPathPoint[]> => {
    const id = String(scoreId ?? selectedScoreId.value ?? '').trim()
    if (!id) {
      error.value = '还没选成绩：先在上面点一条'
      return []
    }
    if (!hasToken.value) {
      error.value = '还没有登录态：请先回「工作台」点「一键获取 token」'
      return []
    }
    busy.value = 'detail'
    error.value = ''
    notice.value = ''
    /**
     * ⚠️ **点"读取轨迹"就等于选中那一条**：界面把按钮放在每行右侧，用户点的是"这一行"的轨迹
     * ⇒ 若这里不把 `selectedScoreId` 设过来，`selection` 恒为空、下面的读数与"导出"按钮全是灰的
     * （浏览器探针实测：点了按钮、轨迹也读到了 241 点，但页面还在说"还没读到轨迹"）。
     */
    selectedScoreId.value = id
    try {
      const res = await MpApiWrapper.getSunrunArchDetail(id, apiOptions.value)
      const pts = parseArchDetailPoints(res.data)
      points.value = pts
      if (!pts.length) {
        error.value = '这条成绩读不到轨迹（云端 pointList 为空）—— 可能当初提交时明细没交上，换一条试试'
        return []
      }
      logInfo('realpath', '读到真实轨迹', { scoreId: id, points: pts.length })
      notice.value = `读到 ${pts.length} 个轨迹点`
      return pts
    } catch (err) {
      error.value = `读轨迹失败：${err instanceof Error ? err.message : '未知错误'}`
      logWarn('realpath', '读轨迹失败', { scoreId: id, message: error.value })
      return []
    } finally {
      busy.value = ''
    }
  }

  /** 本次要保存/分享的那条（没读轨迹 ⇒ `null`） */
  const currentSelection = (): RealPathSelection | null => selection.value

  /**
   * **导出到本地：存为路径预设**（唯一的写动作，且只写本机路线库）。
   *
   * @param lineId   存到哪个地点（厂商线路 `pointId` 或 `local:free`）
   * @param lineName 那个地点的名字快照
   * @param presetName 用户填的名字（留空 ⇒ 组合层自动命名）
   */
  const saveAsPreset = (
    lineId: string,
    lineName: string,
    presetName: string,
  ): { ok: boolean; message: string } => {
    const sel = currentSelection()
    if (!sel) return { ok: false, message: '还没读到这条成绩的轨迹：先点「读取这条的轨迹」' }
    busy.value = 'save'
    try {
      const draft = buildRealPathPresetDraft({
        meta: sel.meta,
        /** 🆕 2026-11-04：**原样整条**（不切圈、不降采样） */
        points: sel.points,
        lineId,
        lineName,
        presetName,
      })
      const saved = lib.upsert(draft)
      if (!saved.ok) return { ok: false, message: saved.message }
      const name = saved.entry.customName || ''
      logInfo('realpath', '真实路径已存为预设', { scoreId: sel.record.scoreId, lineId, points: sel.points.length })
      return {
        ok: true,
        message:
          `已存入本机路线库：预设「${name}」（原样 ${sel.points.length} 点，不切圈不降采样，取自 ${sel.meta.date || '日期未知'} 那场）` +
          (saved.persisted ? '' : ' —— 但本机存储写入失败，刷新后可能丢失'),
      }
    } catch (err) {
      return { ok: false, message: `保存失败：${err instanceof Error ? err.message : '未知错误'}` }
    } finally {
      busy.value = ''
    }
  }

  /** 构造分享包（**纯本地**，不联网；轨迹原样整条） */
  const buildBundle = (presetName: string): RealPathBundle | null => {
    const sel = currentSelection()
    if (!sel) return null
    const item: RealPathBundleItem = {
      name: String(presetName || defaultRealPathName({ ...sel.meta, startTime: sel.record.startTime })),
      lineId: '',
      lineName: '',
      points: sel.points,
      meta: sel.meta,
    }
    return buildShareBundle([item], new Date().toISOString())
  }  /**
   * **导出分享给好友**：把分享包交给本机端点打成 zip，再触发浏览器下载。
   * @returns `{ ok, message }`（成功时 `message` 里有文件名与字节数）
   */
  const downloadShareZip = async (presetName: string): Promise<{ ok: boolean; message: string }> => {
    const bundle = buildBundle(presetName)
    if (!bundle) return { ok: false, message: '还没读到这条成绩的轨迹：先点「读取这条的轨迹」' }
    busy.value = 'share'
    try {
      const fileName = `真实路径-${bundle.items[0]?.meta.date || '未记录'}-${bundle.items[0]?.name || REAL_PATH_BUNDLE_FILE}`
      const res = await fetch('/api/local/real-path/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName, json: JSON.stringify(bundle) }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, message: `打包失败（HTTP ${res.status}）${text ? `：${text.slice(0, 120)}` : ''}` }
      }
      const blob = await res.blob()
      /** 服务端回带最终文件名（URL 编码过的，中文要解） */
      const encoded = res.headers.get('x-totoro-file') || ''
      const name = encoded ? decodeURIComponent(encoded) : `${fileName}.zip`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      /** 交给浏览器下载后立刻释放（否则 blob 会一直占内存到刷新） */
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      logInfo('realpath', '导出分享压缩包', { name, bytes: blob.size, scoreId: bundle.items[0]?.meta.scoreId })
      return { ok: true, message: `已生成压缩包「${name}」（${Math.round(blob.size / 1024)} KB）—— 把它发给好友即可` }
    } catch (err) {
      return { ok: false, message: `导出失败：${err instanceof Error ? err.message : '未知错误'}` }
    } finally {
      busy.value = ''
    }
  }

  /**
   * **导入好友分享的压缩包**（只读文件 + 写本机路线库）。
   * @param file   浏览器 `<input type="file">` 拿到的文件
   * @param index  选包里的第几条（默认 0）
   * @param lineId/lineName 存到哪个地点（与"导出到本地"同一口径）
   */
  const importShareZip = async (
    file: File,
    opts: { index?: number; lineId: string; lineName: string; presetName?: string },
  ): Promise<{ ok: boolean; message: string }> => {
    busy.value = 'share'
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const parsed = await readShareBundleFromZip(bytes)
      if (!parsed.ok) return { ok: false, message: parsed.error }
      const item = pickBundleItem(parsed.items, opts.index ?? 0)
      if (!item) return { ok: false, message: `包里没有第 ${(opts.index ?? 0) + 1} 条路径` }
      const draft = buildRealPathPresetDraft({
        meta: item.meta,
        /** 🆕 2026-11-04：导入同样**原样整条**（不降采样 —— 包里是什么就存什么） */
        points: item.points,
        lineId: opts.lineId,
        lineName: opts.lineName,
        presetName: opts.presetName ?? item.name,
      })
      const saved = lib.upsert(draft)
      if (!saved.ok) return { ok: false, message: saved.message }
      logInfo('realpath', '导入了好友分享的真实路径', { name: item.name, points: item.points.length })
      return { ok: true, message: `已导入「${saved.entry.customName || item.name}」（${item.points.length} 点）` }
    } catch (err) {
      return { ok: false, message: `导入失败：${err instanceof Error ? err.message : '未知错误'}` }
    } finally {
      busy.value = ''
    }
  }

  /**
   * **批量：把选中的若干条成绩逐条读回轨迹，打包成一个分享包下载**（2026-11-10 用户需求①）。
   *
   * 与单条分享的区别：**每条都要单独发一次 `getSunrunArchDetail`**（服务端一次只给一条的 pointList），
   * 所以这里是串行循环 —— 串行而不是并发，是为了让进度可见，也避免同一条链路上并发打服务端。
   *
   * 🆕 包内结构（用户口径："大压缩包的内部就是相关的各个路径"）：
   * **每条路径一个独立的 JSON 文件**，条目名 = 这条的预设名（`.json`）。
   * 于是"第一个包 1 条 + 第二个包 2 条 ⇒ 导入 3 条"的对应关系在包内是自明的。
   *
   * 逐条结果**全部留档**：某一条读不到轨迹不能把整批拖垮（跳过即可），也不能悄悄少装几条。
   */
  const downloadBatchZip = async (
    entries: { scoreId: string; presetName?: string }[],
  ): Promise<{ ok: boolean; message: string; summary: BatchSummary }> => {
    const wanted = (Array.isArray(entries) ? entries : []).filter((e) => String(e?.scoreId ?? '').trim())
    if (!wanted.length) {
      return { ok: false, message: '还没选任何成绩：先在上面勾选要导出的那几条', summary: summarizeBatch([]) }
    }
    if (!hasToken.value) {
      return { ok: false, message: '还没有登录态：请先回「工作台」点「一键获取 token」', summary: summarizeBatch([]) }
    }
    busy.value = 'share'
    batchProgress.value = { done: 0, total: wanted.length }
    try {
      const files: { name: string; json: string }[] = []
      const outcomes: BatchOutcome[] = []
      const usedNames = new Set<string>()
      const exportedAt = new Date().toISOString()
      for (const [i, want] of wanted.entries()) {
        const scoreId = String(want.scoreId).trim()
        /** 跨月已选优先（列表只剩当月，从它查会漏掉别的月份） */
        const record = pickedRecords.value.find((r) => r.scoreId === scoreId) ?? records.value.find((r) => r.scoreId === scoreId)
        const label = record ? `${record.date || '日期未知'} ${record.startTime || ''}`.trim() : scoreId
        try {
          const res = await MpApiWrapper.getSunrunArchDetail(scoreId, apiOptions.value)
          const pts = parseArchDetailPoints(res.data)
          if (!pts.length) {
            /** 读不到就**跳过**（用户口径），但如实记账，最后在汇总里说明 */
            outcomes.push({ name: label, ok: false, message: '这条成绩读不到轨迹（云端 pointList 为空）—— 已跳过' })
            continue
          }
          const lap = extractOneLap(pts, { tolM: 25, minM: 200 })
          const meta: RealPathMeta = {
            date: record?.date ?? '',
            scoreId,
            km: record?.km ?? null,
            usedTime: record?.usedTime ?? '',
            fitDegree: record?.fitDegree ?? null,
            sourcePoints: pts.length,
            lapLengthM: lap.length < pts.length ? pathLengthM(lap) : null,
            exportedAt,
          }
          /** 批量里用户没填名字 ⇒ 默认名 + 随机后缀（避免与别人/别次的同名撞车） */
          const typed = String(want.presetName ?? '').trim()
          const rawName = typed || withRandomSuffix(defaultRealPathName({ ...meta, startTime: record?.startTime }))
          const item: RealPathBundleItem = { name: rawName, lineId: '', lineName: '', points: pts, meta }
          /** 包内条目名去重：同名的加序号（ZIP 不允许重名条目） */
          let entryName = sanitizeZipEntryName(rawName)
          if (usedNames.has(entryName)) {
            const stem = entryName.replace(/\.json$/i, '')
            let n = 2
            while (usedNames.has(`${stem}-${n}.json`)) n++
            entryName = `${stem}-${n}.json`
          }
          usedNames.add(entryName)
          files.push({ name: entryName, json: bundleJsonOf(item, exportedAt) })
          outcomes.push({ name: label, ok: true, message: `已装入（${pts.length} 点）` })
        } catch (err) {
          outcomes.push({ name: label, ok: false, message: `读轨迹失败：${err instanceof Error ? err.message : '未知错误'} —— 已跳过` })
        } finally {
          batchProgress.value = { done: i + 1, total: wanted.length }
        }
      }
      const summary = summarizeBatch(outcomes)
      if (!files.length) {
        logWarn('realpath', '批量导出：一条都没装上', { total: wanted.length })
        return { ok: false, message: `一条都没能导出：${summary.failCount} 条都读不到轨迹（原因见下面逐条说明）`, summary }
      }
      const firstOk = outcomes.find((o) => o.ok)?.name.split(' ')[0] || '未记录'
      const fileName = files.length === 1
        ? `真实路径-${firstOk}-${outcomes.find((o) => o.ok)?.name || ''}`
        : `真实路径-批量${files.length}条-${firstOk}`
      const res = await fetch('/api/local/real-path/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName, files }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, message: `打包失败（HTTP ${res.status}）${text ? `：${text.slice(0, 120)}` : ''}`, summary }
      }
      const blob = await res.blob()
      const encoded = res.headers.get('x-totoro-file') || ''
      const name = encoded ? decodeURIComponent(encoded) : `${fileName}.zip`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      logInfo('realpath', '批量导出分享压缩包', { name, bytes: blob.size, files: files.length, failed: summary.failCount })
      const tail = summary.failCount ? `；另有 ${summary.failCount} 条读不到已跳过（原因见下面逐条说明）` : ''
      return {
        ok: true,
        message: `已生成压缩包「${name}」（${Math.round(blob.size / 1024)} KB，内含 ${files.length} 个路径文件）${tail}`,
        summary,
      }
    } catch (err) {
      return { ok: false, message: `导出失败：${err instanceof Error ? err.message : '未知错误'}`, summary: summarizeBatch([]) }
    } finally {
      busy.value = ''
      batchProgress.value = null
    }
  }

  /**
   * **批量：把选中的多条成绩逐条读回轨迹，并按「存到哪个地点」逐条落库**（2026-11-10 用户需求①）。
   *
   * 逐条独立：某一条存不进去（撞名 / 几何不合法）不影响其它条，而且**每一条的结果都回报**。
   */
  const saveBatchAsPresets = async (
    entries: { scoreId: string; presetName?: string }[],
    lineId: string,
    lineName: string,
  ): Promise<{ ok: boolean; message: string; summary: BatchSummary }> => {
    const wanted = (Array.isArray(entries) ? entries : []).filter((e) => String(e?.scoreId ?? '').trim())
    if (!wanted.length) {
      return { ok: false, message: '还没选任何成绩：先在上面勾选要导出的那几条', summary: summarizeBatch([]) }
    }
    if (!hasToken.value) {
      return { ok: false, message: '还没有登录态：请先回「工作台」点「一键获取 token」', summary: summarizeBatch([]) }
    }
    busy.value = 'save'
    batchProgress.value = { done: 0, total: wanted.length }
    try {
      const outcomes: BatchOutcome[] = []
      for (const [i, want] of wanted.entries()) {
        const scoreId = String(want.scoreId).trim()
        /** 跨月已选优先（列表只剩当月，从它查会漏掉别的月份） */
        const record = pickedRecords.value.find((r) => r.scoreId === scoreId) ?? records.value.find((r) => r.scoreId === scoreId)
        const label = record ? `${record.date || '日期未知'} ${record.startTime || ''}`.trim() : scoreId
        try {
          const res = await MpApiWrapper.getSunrunArchDetail(scoreId, apiOptions.value)
          const pts = parseArchDetailPoints(res.data)
          if (!pts.length) {
            outcomes.push({ name: label, ok: false, message: '这条成绩读不到轨迹（云端 pointList 为空）' })
            continue
          }
          const lap = extractOneLap(pts, { tolM: 25, minM: 200 })
          const meta: RealPathMeta = {
            date: record?.date ?? '',
            scoreId,
            km: record?.km ?? null,
            usedTime: record?.usedTime ?? '',
            fitDegree: record?.fitDegree ?? null,
            sourcePoints: pts.length,
            lapLengthM: lap.length < pts.length ? pathLengthM(lap) : null,
            exportedAt: new Date().toISOString(),
          }
          const draft = buildRealPathPresetDraft({
            meta,
            points: pts,
            lineId,
            lineName,
            presetName: want.presetName ?? '',
          })
          const saved = lib.upsert(draft)
          if (!saved.ok) {
            outcomes.push({ name: label, ok: false, message: saved.message })
            continue
          }
          outcomes.push({ name: label, ok: true, message: `已存为「${saved.entry.customName || label}」（${pts.length} 点）` })
        } catch (err) {
          outcomes.push({ name: label, ok: false, message: `保存失败：${err instanceof Error ? err.message : '未知错误'}` })
        } finally {
          batchProgress.value = { done: i + 1, total: wanted.length }
        }
      }
      const summary = summarizeBatch(outcomes)
      logInfo('realpath', '批量存为预设', { total: wanted.length, ok: summary.okCount, failed: summary.failCount })
      const tail = summary.failCount ? '（失败原因见下面逐条说明）' : ''
      return { ok: summary.okCount > 0, message: `批量存预设：${summary.text}${tail}`, summary }
    } finally {
      busy.value = ''
      batchProgress.value = null
    }
  }

  /**
   * **批量：一次选多个压缩包导入**（2026-11-10 用户需求②）。
   *
   * 按用户口径**遍历每个包里的每一条路径**："第一个压缩包 1 个路径，第二个压缩包 2 个路径，
   * 那么导入的就是 3 个路径" —— 所以是两层循环（包 × 包内条目），逐条落库、逐条记结果。
   *
   * 🔴 任何一条失败都要留住原因（文件读不了 / 不是路径包 / 包内坐标全坏 / 撞名 / 存不进本机库），
   *    最后用 `summarizeBatch()` 汇总。`opts.index` 只用于"只想要包里第 N 条"的老口径，
   *    批量导入默认**全收**（不传 index）。
   */
  const importManyShareZips = async (
    files: File[],
    opts: { index?: number; lineId: string; lineName: string; presetName?: string },
  ): Promise<{ ok: boolean; message: string; summary: BatchSummary }> => {
    const list = (Array.isArray(files) ? files : []).filter(Boolean)
    if (!list.length) {
      return { ok: false, message: '还没选文件：先点「选择一个或多个压缩包」', summary: summarizeBatch([]) }
    }
    busy.value = 'share'
    batchProgress.value = { done: 0, total: list.length }
    try {
      const outcomes: BatchOutcome[] = []
      for (const [i, file] of list.entries()) {
        const fileName = String(file.name || `第 ${i + 1} 个文件`)
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const parsed = await readAllShareItemsFromZip(bytes)
          if (!parsed.ok) {
            outcomes.push({ name: fileName, ok: false, message: parsed.error })
            continue
          }
          /** 老口径（只取第 N 条）仍然保留；批量默认全收 */
          const picked = opts.index === undefined
            ? parsed.items
            : parsed.items.filter((_, idx) => idx === Math.trunc(Number(opts.index)))
          if (!picked.length) {
            outcomes.push({ name: fileName, ok: false, message: `包里没有第 ${(opts.index ?? 0) + 1} 条路径（共 ${parsed.items.length} 条）` })
            continue
          }
          /** 同包内被跳过的坏条目也要回报（"包里 3 条只进来 2 条"必须看得见） */
          for (const s of parsed.skipped) {
            outcomes.push({ name: `${fileName} · ${s.entryName}`, ok: false, message: s.reason })
          }
          for (const { entryName, item } of picked) {
            const label = picked.length > 1 || parsed.skipped.length ? `${fileName} · ${entryName}` : fileName
            try {
              const draft = buildRealPathPresetDraft({
                meta: item.meta,
                points: item.points,
                lineId: opts.lineId,
                lineName: opts.lineName,
                presetName: opts.presetName ?? item.name,
              })
              const saved = lib.upsert(draft)
              if (!saved.ok) {
                outcomes.push({ name: label, ok: false, message: saved.message })
                continue
              }
              outcomes.push({ name: label, ok: true, message: `已导入「${saved.entry.customName || item.name}」（${item.points.length} 点）` })
            } catch (err) {
              outcomes.push({ name: label, ok: false, message: `导入失败：${err instanceof Error ? err.message : '未知错误'}` })
            }
          }
        } catch (err) {
          outcomes.push({ name: fileName, ok: false, message: `读文件失败：${err instanceof Error ? err.message : '未知错误'}` })
        } finally {
          batchProgress.value = { done: i + 1, total: list.length }
        }
      }
      const summary = summarizeBatch(outcomes)
      logInfo('realpath', '批量导入压缩包', { files: list.length, ok: summary.okCount, failed: summary.failCount })
      return { ok: summary.okCount > 0, message: `批量导入：${summary.text}`, summary }
    } finally {
      busy.value = ''
      batchProgress.value = null
    }
  }

  /** 加/remove 一条到已选（跨月累计；同一条再点一次就取消） */
  const togglePickRecord = (record: RealPathRecord) => {
    const id = String(record?.scoreId ?? '')
    if (!id) return
    pickedRecords.value = pickedRecords.value.some((r) => String(r.scoreId) === id)
      ? pickedRecords.value.filter((r) => String(r.scoreId) !== id)
      : [...pickedRecords.value, record]
  }
  /** 批量加入（「全选」：只作用于传进来的这批 —— 界面传**当前月份**的列表） */
  const pickManyRecords = (list: RealPathRecord[]) => {
    const have = new Set(pickedRecords.value.map((r) => String(r.scoreId)))
    const add = (Array.isArray(list) ? list : []).filter((r) => r && !have.has(String(r.scoreId)))
    if (add.length) pickedRecords.value = [...pickedRecords.value, ...add]
  }
  /** 批量移除（「反选」= 把传进来的这批里"已在已选"的拿掉） */
  const unpickManyRecords = (list: RealPathRecord[]) => {
    const drop = new Set((Array.isArray(list) ? list : []).map((r) => String(r?.scoreId ?? '')))
    pickedRecords.value = pickedRecords.value.filter((r) => !drop.has(String(r.scoreId)))
  }
  /**
   * 清空已选。
   * ⚠️ 只清"已选"、**不清"已读月份缓存"** —— 用户点了清空勾选不代表要重新联网读一遍。
   */
  const clearPickedRecords = () => {
    pickedRecords.value = []
  }

  return {
    // 状态
    months,
    activeMonthId,
    records,
    days,
    selectedDate,
    selectedScoreId,
    points,
    busy,
    error,
    notice,
    hasToken,
    snCode,
    selectedRecord,
    selection,
    /** 🆕 跨月累计已选（"已选汇总"块用） */
    pickedRecords,
    batchProgress,
    // 🆕 已选集合的增删（跨月累计；判据走纯函数 `toggleSelection`/`setSelection`）
    togglePickRecord,
    pickManyRecords,
    unpickManyRecords,
    clearPickedRecords,
    // 动作
    loadMonths,
    loadRecords,
    pickDate,
    pickRecord,
    loadDetail,
    saveAsPreset,
    downloadShareZip,
    importShareZip,
    // 🆕 2026-11-10：批量（勾选多条 → 一次导出 / 一次导入多个包）
    downloadBatchZip,
    saveBatchAsPresets,
    importManyShareZips,
  }
}
