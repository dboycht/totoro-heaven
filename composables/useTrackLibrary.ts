/**
 * 本地路线库（Nuxt 薄壳）：只管状态与 localStorage；类型/归一化/摘要在纯模块 `utils/mp/trackLibrary.ts`。
 *
 * 用法：
 *   const lib = useTrackLibrary()
 *   lib.load()                       // 读本机（含旧格式迁移）
 *   lib.upsert({lineId, lineName, outer, inner})   // 新建/覆盖（保留原创建日期）
 *   lib.rename(lineId, '西操场外道')  // 改本机显示名（空串 = 恢复厂商原名）
 *   lib.get(lineId)                  // 取一条
 *   lib.entries.value                // 列表（最新在前）
 */
import type { LatLng } from '~/utils/mp/routeSimilarity'
// 🆕 2026-09-22「非官方路径绘制」：本机条目可以存"圈型闭合曲线 / 直线型折返"（可选字段）
import { parseFreePathShape, type FreePathShape } from '~/utils/mp/pathShape'
import {
  FREE_ROUTE_CHOICE_KEY,
  isValidTrackEntry,
  parseFreeRouteChoices,
  prependHistory,
  saveSummaryText,
  TRACK_LIBRARY_KEY,
  TRACK_LIBRARY_KEY_LEGACY,
  normalizeLibrary,
  sanitizeLineName,
  withFreeRouteChoice,
  type TrackRouteEntry,
  type TrackStart,
} from '~/utils/mp/trackLibrary'

export function useTrackLibrary() {
  const { appVersion } = useUpdateCheck()
  const entries = useState<TrackRouteEntry[]>('mpTrackLibrary', () => [])
  /**
   * 🆕 2026-09-25（诊断包实测修复）：**本机路线库装载过没有**。
   *
   * 起因：`entries` 的初值是 `[]`，而**只有**跑步页 / 跑道编辑页 / 非官方路径页会调 `load()`
   * ⇒ 在工作台读数据那一刻，`entries` 代表的是"**还没读**"，而不是"**确实没有**"。
   * 门禁的 `localGeometryReady` 必须能区分这两者，否则严格模式下会误报
   * "这台电脑还没有可用的本机路径几何"（用户明明画过；实测证据见 `DEVELOPMENT.md` §39.3 第 2 条）。
   *
   * 与 `entries` 同生命周期（`useState` 内存态，刷新即归零）。
   */
  const loaded = useState<boolean>('mpTrackLibraryLoaded', () => false)
  /**
   * 🆕 2026-09-22（用户批准）：**「本机路径」下拉的选择**，按任务各记各的（`{[taskId]: lineId}`）。
   *
   * ⚠️ 刻意**不写进 `mp_real_task_v1`**（那份缓存的契约是 `{at, task, lineId, token}` 四项，见 `realCache.ts`），
   *    也**不进任何提交报文** —— 它只决定"本机用哪条几何生成轨迹"。
   * 读写在下面（`loadFreeRouteChoices` / `freeRouteChoiceFor` / `setFreeRouteChoice`），键名与纯解析函数在算法层。
   */
  const freeRouteChoices = useState<Record<string, string>>('mpFreeRouteChoices', () => ({}))

  /** 从本机读回"按任务记住的本机路径选择"（坏数据安全降级成空表） */
  const loadFreeRouteChoices = (): Record<string, string> => {
    if (!import.meta.client) return freeRouteChoices.value
    let parsed: Record<string, string> = {}
    try {
      parsed = parseFreeRouteChoices(JSON.parse(localStorage.getItem(FREE_ROUTE_CHOICE_KEY) || 'null'))
    } catch {
      /* 坏数据（JSON 解析失败）⇒ 当作还没选过；不打扰用户 */
      parsed = {}
    }
    freeRouteChoices.value = parsed
    return parsed
  }

  /** 取某个任务记住的那条本机路径（没记过 ⇒ 空串） */
  const freeRouteChoiceFor = (taskId: string | null | undefined): string =>
    String(freeRouteChoices.value[String(taskId ?? '').trim()] ?? '')

  /**
   * 记住"这个任务用哪条本机路径"（`lineId` 传空串 = 清掉该任务的选择）。
   * 尽力落盘：写失败只影响"下次记不记得"，本次运行照旧。
   */
  const setFreeRouteChoice = (taskId: string | null | undefined, lineId: string | null | undefined): void => {
    const next = withFreeRouteChoice(freeRouteChoices.value, taskId, lineId)
    freeRouteChoices.value = next
    if (!import.meta.client) return
    try {
      localStorage.setItem(FREE_ROUTE_CHOICE_KEY, JSON.stringify(next))
    } catch {
      /* 配额/隐私模式：内存里已生效，只是"下次开程序"记不住 —— 尽力而为，可静默 */
    }
  }

  /** 从本机读取（含旧格式迁移：旧键里有、而新键里没有的，补进来） */
  const load = () => {
    if (!import.meta.client) return entries.value
    let merged: TrackRouteEntry[] = []
    try {
      merged = normalizeLibrary(JSON.parse(localStorage.getItem(TRACK_LIBRARY_KEY) || 'null'), String(appVersion.value ?? '未知'))
    } catch {
      merged = []
    }
    let migrated = false
    try {
      const legacyRaw = localStorage.getItem(TRACK_LIBRARY_KEY_LEGACY)
      if (legacyRaw) {
        for (const e of normalizeLibrary(JSON.parse(legacyRaw), '旧版')) {
          if (!merged.some((m) => String(m.lineId) === String(e.lineId))) merged.push(e)
        }
        // ⚠️ 迁完**立刻删掉旧键**：否则每次 load() 都会把用户已删除的条目再补回来 ——
        //    用户实测"删除不掉"就是这个原因（删了之后一进页面又出现）。
        localStorage.removeItem(TRACK_LIBRARY_KEY_LEGACY)
        migrated = true
      }
    } catch {
      /* 旧数据坏了就忽略（顺手把坏键也清掉，避免每次都解析失败） */
      try {
        localStorage.removeItem(TRACK_LIBRARY_KEY_LEGACY)
      } catch {
        /* 忽略 */
      }
    }
    entries.value = merged
    /** 🆕 2026-09-25：标记"读过本机库了" ⇒ 门禁从此可以把"没有几何"当作**确定结论**（`undefined` 才是未知） */
    loaded.value = true
    if (migrated) persist()
    // 🆕 2026-09-22：顺带把「本机路径」的选择也读回来（同一个"本机数据"入口，省得各处再记一次）
    loadFreeRouteChoices()
    return merged
  }

  /**
   * 写盘。⚠️ 2026-09-19 审计 M4：原来**没有 try/catch** —— 配额满/隐私模式下
   * `setItem` 会抛，而此时**内存里已经改过了**（`entries.value = ...`）⇒ 内存与磁盘不一致、
   * 而且异常会冒到调用方、连"保存成功"的提示都不会显示。现在吞掉异常并返回是否落盘成功，
   * 调用方可据此提示"只存在内存里，刷新会丢"。
   */
  const persist = (): boolean => {
    if (!import.meta.client) return false
    try {
      localStorage.setItem(TRACK_LIBRARY_KEY, JSON.stringify(entries.value))
      return true
    } catch {
      return false
    }
  }

  /**
   * ⚠️ 2026-09-20 审计修复：`persist()` 的返回值原本只有 `upsert` 间接用了，
   * `remove` / `rename` **直接丢掉** ⇒ 配额满/隐私模式下"内存删了、磁盘还在"，
   * 界面照样提示"已删除"，**刷新后被删的路线又回来了**（用户历史反馈的"删不掉"就是这一类）。
   * 判据：内存与磁盘的**每个写操作**都要把"是否真的落盘"传回调用方。
   */
  const remove = (lineId: string): boolean => {
    entries.value = entries.value.filter((e) => String(e.lineId) !== String(lineId))
    return persist()
  }

  /**
   * 新建或覆盖（覆盖时**保留原创建日期**，只更新几何与"本次保存"留痕）。
   *
   * 🆕 2026-09-20（1.1.12 需求②③）：
   *   · `start` 是**起跑点设置**：`undefined` = 保持原样（老调用方不用改），
   *     `null` = **明确清掉**（用户在编辑器里设回"未设置"时必须能落盘，否则清了又回来）；
   *   · 每次保存都写 `updatedAt` / `updatedAppVersion` / `editCount` 并**压一条编辑历史**；
   *   · ⚠️ `appVersion` 的语义**从此固定为"创建时版本"**：原先每次保存都会把它刷成当前版本，
   *     与字段注释（"创建时的软件版本"）自相矛盾 —— 现在"最近保存版本"由 `updatedAppVersion` 承担。
   *
   * 返回值：`undefined` = 被拒（内外圈不合法）；否则 `{ entry, persisted }`
   * （`persisted === false` = 只写进了内存、**没落盘**，调用方必须如实提示）。
   *
   * 🆕 2026-09-22「非官方路径绘制」：多一个可选的 `freeShape`（圈型闭合曲线 / 直线型折返）。
   *   · `undefined` = 保持原样（老调用方不用改）；
   *   · `null` = **明确清掉**（用户改回"内外圈"模式时要把形状删掉）；
   *   · 合法形状 = 存进去（`outer`/`inner` 允许是占位几何 —— 跑图以 `freeShape` 为准）。
   *   入参一律过 `parseFreePathShape` 归一化（不认识的形状当"没有"处理，绝不写坏数据进库）。
   */
  const upsert = (input: {
    lineId: string
    lineName: string
    outer: LatLng[]
    inner: LatLng[]
    laneNo?: number
    laneCount?: number
    note?: string
    start?: TrackStart | null
    freeShape?: FreePathShape | null
  }) => {
    /**
     * ⚠️ 2026-09-19 审计 S1 的**纵深防御**：即使界面判据被绕过（历史上就是 `ringCheck` 为 null
     * 让保存按钮没禁用），这里也**拒绝把不完整的圈写进库** —— 库里一旦有它，跑步页就会
     * 把它当"描过跑道"，而生成器会回落到官方模板（本版禁止）。
     * 🆕 2026-09-22：放行条件换成 `isValidTrackEntry`（双圈够点 **或** 带一个可用的非官方形状）。
     */
    const freeShape = input.freeShape === undefined ? undefined : (parseFreePathShape(input.freeShape) ?? null)
    if (!isValidTrackEntry({ outer: input.outer, inner: input.inner, freeShape })) return undefined
    const old = entries.value.find((e) => String(e.lineId) === String(input.lineId))
    const nowIso = new Date().toISOString()
    const version = String(appVersion.value ?? '未知')
    // `undefined` = 沿用旧值；`null` = 清掉（见上面注释）
    const start = input.start === undefined ? old?.start : (input.start ?? undefined)
    // 🆕 非官方形状：同一个"undefined 沿用 / null 清掉"的口径
    const keptFreeShape = freeShape === undefined ? old?.freeShape : (freeShape ?? undefined)
    const laneNo = input.laneNo ?? old?.laneNo
    const laneCount = input.laneCount ?? old?.laneCount
    const entry: TrackRouteEntry = {
      lineId: input.lineId,
      lineName: input.lineName,
      // ⚠️ 重新保存几何时**不能把用户起的名字冲掉**（用户重命名后回去微调一圈，名字得留着）
      customName: old?.customName,
      outer: input.outer,
      inner: input.inner,
      createdAt: old?.createdAt || nowIso,
      // 创建版本：老条目继续沿用（不因一次重新保存而"变成"新版本创建）
      appVersion: old?.createdAt ? old.appVersion : version,
      laneCount,
      laneNo,
      note: input.note ?? old?.note,
      ...(start ? { start } : {}),
      ...(keptFreeShape ? { freeShape: keptFreeShape } : {}),
      updatedAt: nowIso,
      updatedAppVersion: version,
      editCount: (old?.editCount ?? 0) + 1,
      history: prependHistory(old?.history, {
        at: nowIso,
        appVersion: version,
        summary: saveSummaryText({ outer: input.outer, inner: input.inner, laneNo, laneCount, start, freeShape: keptFreeShape ?? null }),
      }),
    }
    entries.value = [entry, ...entries.value.filter((e) => String(e.lineId) !== String(input.lineId))]
    /**
     * 🆕 2026-09-22（issue #12）：**把"是否真的落盘"传回调用方**（与 `remove` / `rename` 同一纪律）。
     * 原先这里把 `persist()` 的返回值丢掉 ⇒ 配额满 / 隐私模式下"内存里存了、磁盘上没有"，
     * 界面照样提示"已存入本机路线库"，而**刷新后跑道就没了**——自由路线任务正是靠这条记录
     * 才有一条几何可用（跑步页读的就是它），所以落盘失败必须如实说，不能只报成功。
     */
    return { entry, persisted: persist() }
  }

  /**
   * **重命名**（2026-09-18，1.1.9 需求②）：只改本机显示名，不动几何、不动厂商线路名、不动创建日期。
   * · 名字归一化走纯函数 `sanitizeLineName`（折空白/去控制字符/限长），**与界面输入无关地保证干净**；
   * · 传空串/空白 ⇒ 清掉自定义名，显示回厂商原名快照；
   * · 找不到这条 ⇒ 返回 `undefined`，**不静默新建**（否则会凭空多出一条空路线）。
   * · 🆕 2026-09-20（1.1.12 需求③）：改名也是一次"编辑" ⇒ 同样写 `updatedAt`/版本/次数与历史，
   *   但**名字没变时不记账**（否则连点两次"保存名字"就把次数刷上去了）。
   * · 🆕 2026-09-20 审计修复：返回值带上"**是否真的落盘**"（`persisted`），界面据此如实提示。
   */
  const rename = (lineId: string, nextName: string): { entry: TrackRouteEntry; persisted: boolean } | undefined => {
    const target = entries.value.find((e) => String(e.lineId) === String(lineId))
    if (!target) return undefined
    const clean = sanitizeLineName(nextName)
    const changed = (sanitizeLineName(target.customName) || '') !== clean
    const updated: TrackRouteEntry = { ...target, customName: clean ? clean : undefined }
    if (changed) {
      const nowIso = new Date().toISOString()
      const version = String(appVersion.value ?? '未知')
      updated.updatedAt = nowIso
      updated.updatedAppVersion = version
      updated.editCount = (target.editCount ?? 0) + 1
      updated.history = prependHistory(target.history, {
        at: nowIso,
        appVersion: version,
        summary: clean ? `重命名为「${clean}」` : '恢复显示官方线路名',
      })
    }
    entries.value = entries.value.map((e) => (String(e.lineId) === String(lineId) ? updated : e))
    return { entry: updated, persisted: persist() }
  }

  const get = (lineId: string | undefined | null) =>
    lineId ? entries.value.find((e) => String(e.lineId) === String(lineId)) : undefined

  return {
    entries,
    // 🆕 2026-09-25：装载标记（门禁据此把"没有几何"与"还没装载"分开）
    loaded,
    load,
    persist,
    upsert,
    remove,
    rename,
    get,
    appVersion,
    // 🆕 2026-09-22：「本机路径」下拉的选择（按任务记；与提交报文无关）
    freeRouteChoices,
    loadFreeRouteChoices,
    freeRouteChoiceFor,
    setFreeRouteChoice,
  }
}
