/**
 * 本地路线库（Nuxt 薄壳）：只管状态与 localStorage；类型/归一化/摘要在纯模块 `utils/mp/trackLibrary.ts`。
 *
 * 用法：
 *   const lib = useTrackLibrary()
 *   lib.load()                       // 读本机（含旧格式迁移）
 *   lib.upsert({lineId, lineName, outer, inner, presetName})   // 新建一条预设（名称留空 = 自动命名）
 *   lib.upsert({id, lineId, lineName, outer, inner})           // 更新指定的那条预设（保留原创建日期）
 *   lib.rename(id, '西操场外道')      // 改预设名（**全库不可重名**；空串会被自动命名兜住）
 *   lib.remove(id)                   // 删一条预设
 *   lib.get(id)                      // 取一条（先按预设 id，再按 lineId 退回该地点最新那条）
 *   lib.entries.value                // 列表（最新在前）
 *
 * 🆕 2026-11-03（1.3.6）：**一个地点可以有多条预设**（用户要求）。
 *   主键从 `lineId` 换成 `id`，`lineId` 降级为"地点键"；旧数据 `id = lineId` ⇒ 零迁移。
 */
import type { LatLng } from '~/utils/mp/routeSimilarity'
// 🆕 2026-09-22「非官方路径绘制」：本机条目可以存"圈型闭合曲线 / 直线型折返"（可选字段）
import { parseFreePathShape, type FreePathShape, type TrackEntry } from '~/utils/mp/pathShape'
import {
  FREE_ROUTE_CHOICE_KEY,
  PRESET_CHOICE_KEY,
  isValidTrackEntry,
  autoPresetName,
  conflictOwnerText,
  entryIdOf,
  findEntryByRef,
  findNameConflict,
  newTrackPresetId,
  parseRefChoiceMap,
  prependHistory,
  presetsOfLine,
  resolvePresetForLine,
  sanitizeLineName,
  saveSummaryText,
  TRACK_LIBRARY_KEY,
  TRACK_LIBRARY_KEY_LEGACY,
  normalizeLibrary,
  normalizeTrackEntry,
  withRefChoice,
  type PresetResolution,
  type TrackRenameResult,
  type TrackRouteEntry,
  type TrackSaveResult,
  type TrackStart,
} from '~/utils/mp/trackLibrary'
// 🆕 2026-11-03（需求③）：真实路径元信息的类型（结构定义在纯模块里）
import type { RealPathMeta } from '~/utils/mp/realPath'

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
  /**
   * 🆕 2026-11-03（1.3.6）：**「这个地点用哪条预设」的选择**（`{[lineId]: 预设 id}`）。
   *
   * 与上面那份**同一个形状、同一套纯函数**（`parseRefChoiceMap` / `withRefChoice`），
   * 只是键从 taskId 换成 lineId —— 两级下拉（线路 → 预设）的第二级必须被记住，
   * 否则用户每次进页都被打回默认那条，会以为"我选的没生效"。
   * 🔴 它同样**只决定本机几何**：提交报文一个字都不变。
   */
  const presetChoices = useState<Record<string, string>>('mpPresetChoices', () => ({}))

  /** 从本机读回"按任务记住的本机路径选择"（坏数据安全降级成空表） */
  const loadFreeRouteChoices = (): Record<string, string> => {
    if (!import.meta.client) return freeRouteChoices.value
    let parsed: Record<string, string> = {}
    try {
      parsed = parseRefChoiceMap(JSON.parse(localStorage.getItem(FREE_ROUTE_CHOICE_KEY) || 'null'))
    } catch {
      /* 坏数据（JSON 解析失败）⇒ 当作还没选过；不打扰用户 */
      parsed = {}
    }
    freeRouteChoices.value = parsed
    return parsed
  }

  /** 🆕 2026-11-03：从本机读回"每个地点选的哪条预设"（坏数据同样安全降级） */
  const loadPresetChoices = (): Record<string, string> => {
    if (!import.meta.client) return presetChoices.value
    let parsed: Record<string, string> = {}
    try {
      parsed = parseRefChoiceMap(JSON.parse(localStorage.getItem(PRESET_CHOICE_KEY) || 'null'))
    } catch {
      /* 坏数据 ⇒ 当作还没选过 */
      parsed = {}
    }
    presetChoices.value = parsed
    return parsed
  }

  /** 取某个任务记住的那条本机路径（没记过 ⇒ 空串） */
  const freeRouteChoiceFor = (taskId: string | null | undefined): string =>
    String(freeRouteChoices.value[String(taskId ?? '').trim()] ?? '')

  /** 🆕 2026-11-03：取某个地点记住的那条预设（没记过 ⇒ 空串 ⇒ 由判据落回默认那条） */
  const presetChoiceFor = (lineId: string | null | undefined): string =>
    String(presetChoices.value[String(lineId ?? '').trim()] ?? '')

  /**
   * 记住"这个任务用哪条本机路径"（`lineId` 传空串 = 清掉该任务的选择）。
   * 尽力落盘：写失败只影响"下次记不记得"，本次运行照旧。
   */
  const setFreeRouteChoice = (taskId: string | null | undefined, lineId: string | null | undefined): void => {
    const next = withRefChoice(freeRouteChoices.value, taskId, lineId)
    freeRouteChoices.value = next
    if (!import.meta.client) return
    try {
      localStorage.setItem(FREE_ROUTE_CHOICE_KEY, JSON.stringify(next))
    } catch {
      /* 配额/隐私模式：内存里已生效，只是"下次开程序"记不住 —— 尽力而为，可静默 */
    }
  }

  /**
   * 🆕 2026-11-03：记住"这个地点用哪条预设"（`presetId` 传空串 = 清掉该地点的选择）。
   * 与 `setFreeRouteChoice` **同一口径**（尽力落盘、失败只影响记忆）。
   */
  const setPresetChoice = (lineId: string | null | undefined, presetId: string | null | undefined): void => {
    const next = withRefChoice(presetChoices.value, lineId, presetId)
    presetChoices.value = next
    if (!import.meta.client) return
    try {
      localStorage.setItem(PRESET_CHOICE_KEY, JSON.stringify(next))
    } catch {
      /* 同上：尽力而为，可静默 */
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
    // 🆕 2026-11-03：还有"每个地点选的哪条预设"（两级下拉的第二级）
    loadPresetChoices()
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
   * **删除一条预设**（🆕 2026-11-03：按**预设 id** 删；传 `lineId` 时退回删该地点**最新保存**的那条
   * —— 与 `findEntryByRef` 同口径，保证旧调用方与旧数据仍然可用）。
   *
   * ⚠️ 返回值从"是否落盘"扩成 `{removed, persisted}`：一个地点可以有多条预设之后，
   *    "没删到东西却报删除成功"变成真实可能（传了个别的地点/已删除的 id）⇒ 必须能区分。
   *
   * ⚠️ 2026-09-20 审计修复（保留）：`persist()` 的返回值原先在 `remove` / `rename` 里被丢掉
   * ⇒ 配额满/隐私模式下"内存删了、磁盘还在"，界面照样提示"已删除"，**刷新后被删的路线又回来了**。
   */
  const remove = (ref: string): { removed: boolean; persisted: boolean } => {
    const target = findEntryByRef(entries.value, ref)
    if (!target) return { removed: false, persisted: true }
    const id = entryIdOf(target)
    entries.value = entries.value.filter((e) => entryIdOf(e) !== id)
    return { removed: true, persisted: persist() }
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
    /**
     * 🆕 2026-11-03（1.3.6）：**要更新的那条预设的 id**。
     *   · 传了且库里有 ⇒ **更新那一条**（保留原创建日期/创建版本）；
     *   · 传了但库里没有 ⇒ 用这个 id **新建**（导入/恢复场景要用固定 id）；
     *   · **不传** ⇒ **新建一条预设**（id 由 `newTrackPresetId()` 生成）。
     * ⚠️ 这是与旧版最大的语义差别：旧版按 `lineId` 覆盖 ⇒ 一个地点只能有一条。
     */
    id?: string
    /** 地点键（厂商线路 `pointId`，或本机键 `local:free`） */
    lineId: string
    lineName: string
    outer: LatLng[]
    inner: LatLng[]
    laneNo?: number
    laneCount?: number
    note?: string
    start?: TrackStart | null
    /** 🆕 1.3.3（2026-10-30）：进场点。`null` = 明确清掉；`undefined` = 保持原样 */
    entry?: TrackEntry | null
    freeShape?: FreePathShape | null
    /**
     * 🆕 2026-11-03（1.3.6 需求③「真实路径」）：**这条预设来自哪一场真实跑**。
     * `undefined` = 沿用旧值；`null` = 明确清掉；对象 = 写进去（由 `buildRealPathPresetDraft()` 生成）。
     * 🔴 里面不含学号/姓名/token（白名单字段见 `utils/mp/realPath.ts`）。
     */
    realPath?: RealPathMeta | null
    /**
     * 🆕 2026-11-03（1.3.6）：**预设名称**（用户原话"保存预设的时候可以输入相关名字进行存储，便于用户区分"）。
     *   · 归一化后非空 ⇒ 用它（**全库不可重名**，撞了直接拒绝，见返回值）；
     *   · 空/没传 ⇒ **自动命名**（`autoPresetName()`：优先取线路名，撞了就叫「东操场 · 预设 2」）。
     */
    presetName?: string
  }): TrackSaveResult => {
    /**
     * ⚠️ 2026-09-19 审计 S1 的**纵深防御**：即使界面判据被绕过（历史上就是 `ringCheck` 为 null
     * 让保存按钮没禁用），这里也**拒绝把不完整的圈写进库** —— 库里一旦有它，跑步页就会
     * 把它当"描过跑道"，而生成器会回落到官方模板（本版禁止）。
     * 🆕 2026-09-22：放行条件换成 `isValidTrackEntry`（双圈够点 **或** 带一个可用的非官方形状）。
     */
    const freeShape = input.freeShape === undefined ? undefined : (parseFreePathShape(input.freeShape) ?? null)
    if (!isValidTrackEntry({ outer: input.outer, inner: input.inner, freeShape })) {
      return { ok: false, reason: 'invalid-geometry', message: '内外圈点数不足（各需至少 3 点），或路径形状不可用' }
    }
    /** 更新的目标：只有**显式传了 id** 才去找旧条目（不传 = 新建，绝不"顺手覆盖同地点的另一条"） */
    const wantedId = String(input.id ?? '').trim()
    const old = wantedId ? findEntryByRef(entries.value, wantedId) : undefined
    const presetId = wantedId || newTrackPresetId()
    /**
     * 预设名称：显式填了就用它；没填 ⇒ 沿用这条自己的旧名字（有的话）⇒ 再退回**自动命名**。
     * ⚠️ 名称**永远不为空**（用户明确要求"预设名称不可以相同"，空名字等于没有区分度）。
     */
    const typedName = sanitizeLineName(input.presetName)
    const name = typedName || sanitizeLineName(old?.customName) || autoPresetName(entries.value, input.lineName || old?.lineName, input.lineId, old ? entryIdOf(old) : presetId)
    /** 🔴 "名称不可以相同"：**全库**查重（排除自己），撞了就拒绝保存并把占用者告诉调用方 */
    const conflict = findNameConflict(entries.value, name, old ? entryIdOf(old) : presetId)
    if (conflict) {
      return {
        ok: false,
        reason: 'duplicate-name',
        message: `已有一个预设叫「${conflictOwnerText(conflict, input.lineId)}」，预设名称不能相同 —— 换个名字再存`,
      }
    }
    const nowIso = new Date().toISOString()
    const version = String(appVersion.value ?? '未知')
    // `undefined` = 沿用旧值；`null` = 清掉（见上面注释）
    const start = input.start === undefined ? old?.start : (input.start ?? undefined)
    // 🆕 1.3.3（2026-10-30）进场点：与 start 完全同一口径（`undefined` 沿用 / `null` 清掉）
    const keptEntry = input.entry === undefined ? old?.entry : (input.entry ? normalizeTrackEntry(input.entry) : undefined)
    // 🆕 非官方形状：同一个"undefined 沿用 / null 清掉"的口径
    const keptFreeShape = freeShape === undefined ? old?.freeShape : (freeShape ?? undefined)
    /**
     * 🆕 2026-11-03（需求③）：真实路径的来源元信息 —— 与 `freeShape` 同一口径
     * （`undefined` 沿用 / `null` 清掉）。**这里必须透传**，否则"导出成预设"那一步存进去的
     * `realPath` 会在下一次保存几何时被悄悄丢掉（那就再也说不清"这条是哪天导出的"）。
     */
    const keptRealPath = input.realPath === undefined ? old?.realPath : (input.realPath ?? undefined)
    const laneNo = input.laneNo ?? old?.laneNo
    const laneCount = input.laneCount ?? old?.laneCount
    const entry: TrackRouteEntry = {
      // 🆕 2026-11-03（1.3.6）：预设主键（新建时是新生成的；更新时就是原来那条）
      id: presetId,
      lineId: input.lineId,
      lineName: input.lineName,
      // ⚠️ 重新保存几何时**不能把名字冲掉**（用户命名后回去微调一圈，名字得留着）；这里始终是**有值**的
      customName: name,
      outer: input.outer,
      inner: input.inner,
      createdAt: old?.createdAt || nowIso,
      // 创建版本：老条目继续沿用（不因一次重新保存而"变成"新版本创建）
      appVersion: old?.createdAt ? old.appVersion : version,
      laneCount,
      laneNo,
      note: input.note ?? old?.note,
      ...(start ? { start } : {}),
      ...(keptEntry ? { entry: keptEntry } : {}),
      ...(keptFreeShape ? { freeShape: keptFreeShape } : {}),
      ...(keptRealPath ? { realPath: keptRealPath } : {}),
      updatedAt: nowIso,
      updatedAppVersion: version,
      editCount: (old?.editCount ?? 0) + 1,
      history: prependHistory(old?.history, {
        at: nowIso,
        appVersion: version,
        summary: saveSummaryText({ outer: input.outer, inner: input.inner, laneNo, laneCount, start, freeShape: keptFreeShape ?? null }),
      }),
    }
    // 只替换**这一条预设**（同一个地点的其它预设原样保留 —— 这正是本轮要修的"一地只能一条"）
    entries.value = [entry, ...entries.value.filter((e) => entryIdOf(e) !== presetId)]
    /**
     * 🆕 2026-09-22（issue #12）：**把"是否真的落盘"传回调用方**（与 `remove` / `rename` 同一纪律）。
     * 原先这里把 `persist()` 的返回值丢掉 ⇒ 配额满 / 隐私模式下"内存里存了、磁盘上没有"，
     * 界面照样提示"已存入本机路线库"，而**刷新后跑道就没了**——自由路线任务正是靠这条记录
     * 才有一条几何可用（跑步页读的就是它），所以落盘失败必须如实说，不能只报成功。
     */
    return { ok: true, entry, persisted: persist() }
  }

  /**
   * **改预设名**（2026-09-18，1.1.9 需求②；🆕 2026-11-03 起按**预设 id** 定位）：
   * 只改这条预设的名字，不动几何、不动厂商线路名、不动创建日期。
   * · 名字归一化走纯函数 `sanitizeLineName`（折空白/去控制字符/限长），**与界面输入无关地保证干净**；
   * · 传空串/空白 ⇒ **恢复显示厂商原名快照**（旧口径），🆕 但那会让这条预设"没有自己的名字"
   *   ⇒ 现在改成**自动命名兜底**（名称永不为空；想恢复原名就填线路名本身）。
   * · 找不到这条 ⇒ `{ok:false, reason:'not-found'}`，**不静默新建**（否则会凭空多出一条空路线）。
   * · 🆕 "名称不可以相同"：**全库查重**（排除自己），撞了拒绝并说明是谁占了。
   * · 🆕 2026-09-20（1.1.12 需求③）：改名也是一次"编辑" ⇒ 同样写 `updatedAt`/版本/次数与历史，
   *   但**名字没变时不记账**（否则连点两次"保存名字"就把次数刷上去了）。
   */
  const rename = (ref: string, nextName: string): TrackRenameResult => {
    const target = findEntryByRef(entries.value, ref)
    if (!target) return { ok: false, reason: 'not-found', message: '这条预设已经不在本机路线库里了' }
    const id = entryIdOf(target)
    const typed = sanitizeLineName(nextName)
    const clean = typed || autoPresetName(entries.value, target.lineName, target.lineId, id)
    const conflict = findNameConflict(entries.value, clean, id)
    if (conflict) {
      return {
        ok: false,
        reason: 'duplicate-name',
        message: `已有一个预设叫「${conflictOwnerText(conflict, target.lineId)}」，预设名称不能相同 —— 换个名字再存`,
      }
    }
    const changed = sanitizeLineName(target.customName) !== clean
    const updated: TrackRouteEntry = { ...target, customName: clean }
    if (changed) {
      const nowIso = new Date().toISOString()
      const version = String(appVersion.value ?? '未知')
      updated.updatedAt = nowIso
      updated.updatedAppVersion = version
      updated.editCount = (target.editCount ?? 0) + 1
      updated.history = prependHistory(target.history, {
        at: nowIso,
        appVersion: version,
        summary: `重命名为「${clean}」`,
      })
    }
    entries.value = entries.value.map((e) => (entryIdOf(e) === id ? updated : e))
    return { ok: true, entry: updated, persisted: persist() }
  }

  /**
   * 取一条预设（🆕 2026-11-03：**先按预设 id，找不到再按 `lineId` 退回该地点最新保存的那条**）。
   * ⚠️ 退回是为了兼容旧调用方（它们传的是 `lineId`，如「跑道编辑」里选的线路）；
   *    要精确取某一条请传预设 id（列表里就是 `e.id`）。
   */
  const get = (ref: string | undefined | null) => (ref ? findEntryByRef(entries.value, ref) : undefined)

  /** 🆕 2026-11-03：某个地点下的全部预设（最新保存的在前） */
  const presetsOf = (lineId: string | undefined | null) => presetsOfLine(entries.value, lineId)

  /**
   * 🆕 2026-11-03：**"这个地点这次用哪条预设"的唯一判据**（跑步引擎与跑步页共用）。
   * 判据本体在算法层 `resolvePresetForLine()`（纯函数、有单测）；这里只是把"记住的选择"喂进去。
   */
  const presetResolutionFor = (lineId: string | undefined | null): PresetResolution =>
    resolvePresetForLine(entries.value, lineId ?? '', presetChoiceFor(lineId))

  /** 上面那个判据的"只要哪一条"版本（跑步引擎用它取几何） */
  const geometryEntryFor = (lineId: string | undefined | null) => presetResolutionFor(lineId).entry

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
    // 🆕 2026-11-03（1.3.6）：一个地点多条预设 —— 选择（按地点记）与"这次用哪条"的判据
    presetChoices,
    loadPresetChoices,
    presetChoiceFor,
    setPresetChoice,
    presetsOf,
    presetResolutionFor,
    geometryEntryFor,
  }
}
