/**
 * **「真实路径【测试】」的取数与导出**（2026-11-03，1.3.6 需求③）
 *
 * 用户口径："登录账号后，可以使用相关内部功能来导出**某一天真实跑的路径信息**，并可以选择
 * 「导出到本地存为路径预设」或者「导出分享给好友」两种选择，用户在跑步界面可以选择这些路径并进行跑步，
 * 目前先做到直接原版数据提交"；分享形态 = **压缩包**。
 *
 * ## 分层（别把这三件事混在一起）
 *   · **纯算法**：`utils/mp/realPath.ts`（解析/切一圈/降采样/分享包/读 zip，全有单测）；
 *   · **本文件**：只做"发请求 + 状态机 + 落库/下载"的编排；
 *   · **页面**：`components/RealPathView.vue` 只渲染状态与触发动作。
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
  defaultRealPathName,
  downsamplePath,
  extractOneLap,
  groupRecordsByDay,
  parseArchDetailPoints,
  parseArchRecords,
  pickBundleItem,
  readShareBundleFromZip,
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
  points: RealPathPoint[]
  /** `extractOneLap()` 的结果（**可能是整条** —— 切不出闭环时它原样返回） */
  lap: RealPathPoint[]
  /** 切成"一圈"并降采样之后的点（存预设/分享都用它） */
  lapPoints: RealPathPoint[]
  /** 导出用的元信息 */
  meta: RealPathMeta
}

/**
 * 一条真实路径**最多存多少个点**（存进 `localStorage` 的路线库）。
 * 判据来自真机数据：1 Hz 采样的 400 m 一圈约 100~200 点 ⇒ 600 点足够两圈，
 * 而路线库整体有 5 MB 量级上限（`utils/mp/trackLibrary.ts` 的说明）。
 */
export const REAL_PATH_MAX_POINTS = 600

export function useRealPathExport() {
  const lib = useTrackLibrary()
  /** 登录态（token / baseUrl）—— `useMpSession()` 是**唯一**的会话来源（别自己读 localStorage） */
  const { session, token: sessionToken } = useMpSession()
  /** 真实链路的档案（含 `snCode` 与学校码）—— 只读本人 |
   *  ⚠️ 用 `useMpReal()` 而不是直接读 localStorage：档案的"是否读过"由它统一维护 */
  const real = useMpReal()

  const months = useState<RealPathMonth[]>('mpRealPathMonths', () => [])
  const records = useState<RealPathRecord[]>('mpRealPathRecords', () => [])
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
  /** 选中那条的"每圈点数"等读数（界面用） */
  const selection = computed<RealPathSelection | null>(() => {
    const record = selectedRecord.value
    if (!record || !points.value) return null
    const lap = extractOneLap(points.value, { tolM: 25, minM: 200 })
    const lapPoints = downsamplePath(lap, REAL_PATH_MAX_POINTS)
    const meta: RealPathMeta = {
      date: record.date,
      scoreId: record.scoreId,
      km: record.km,
      usedTime: record.usedTime,
      fitDegree: record.fitDegree,
      sourcePoints: points.value.length,
      exportedAt: new Date().toISOString(),
    }
    return { record, points: points.value, lap, lapPoints, meta }
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
      /** 月份：调用方给了就用它；否则用"当前月份"（`ifCurrent === '1'`） */
      let useMonth = String(monthId ?? '').trim()
      if (!useMonth) {
        if (!months.value.length) await loadMonths()
        const cur = months.value.find((m) => m.isCurrent) ?? months.value[0]
        useMonth = String(cur?.monthId ?? '')
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
      records.value = list
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
        points: sel.lapPoints,
        lineId,
        lineName,
        presetName,
      })
      const saved = lib.upsert(draft)
      if (!saved.ok) return { ok: false, message: saved.message }
      const name = saved.entry.customName || ''
      logInfo('realpath', '真实路径已存为预设', { scoreId: sel.record.scoreId, lineId, points: sel.lapPoints.length })
      return {
        ok: true,
        message:
          `已存入本机路线库：预设「${name}」（${sel.lapPoints.length} 点，取自 ${sel.meta.date || '日期未知'} 那场）` +
          (saved.persisted ? '' : ' —— 但本机存储写入失败，刷新后可能丢失'),
      }
    } catch (err) {
      return { ok: false, message: `保存失败：${err instanceof Error ? err.message : '未知错误'}` }
    } finally {
      busy.value = ''
    }
  }

  /** 构造分享包（**纯本地**，不联网） */
  const buildBundle = (presetName: string): RealPathBundle | null => {
    const sel = currentSelection()
    if (!sel) return null
    const item: RealPathBundleItem = {
      name: String(presetName || defaultRealPathName({ ...sel.meta, startTime: sel.record.startTime })),
      lineId: '',
      lineName: '',
      points: sel.lapPoints,
      meta: sel.meta,
    }
    return buildShareBundle([item], new Date().toISOString())
  }

  /**
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
        points: downsamplePath(item.points, REAL_PATH_MAX_POINTS),
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

  return {
    // 状态
    months,
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
    // 动作
    loadMonths,
    loadRecords,
    pickDate,
    pickRecord,
    loadDetail,
    saveAsPreset,
    downloadShareZip,
    importShareZip,
  }
}
