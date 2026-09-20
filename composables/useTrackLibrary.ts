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
import {
  hasValidRings,
  prependHistory,
  saveSummaryText,
  TRACK_LIBRARY_KEY,
  TRACK_LIBRARY_KEY_LEGACY,
  normalizeLibrary,
  sanitizeLineName,
  type TrackRouteEntry,
  type TrackStart,
} from '~/utils/mp/trackLibrary'

export function useTrackLibrary() {
  const { appVersion } = useUpdateCheck()
  const entries = useState<TrackRouteEntry[]>('mpTrackLibrary', () => [])

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
    if (migrated) persist()
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
  }) => {
    /**
     * ⚠️ 2026-09-19 审计 S1 的**纵深防御**：即使界面判据被绕过（历史上就是 `ringCheck` 为 null
     * 让保存按钮没禁用），这里也**拒绝把不完整的圈写进库** —— 库里一旦有它，跑步页就会
     * 把它当"描过跑道"，而生成器会回落到官方模板（本版禁止）。
     */
    if (!hasValidRings({ outer: input.outer, inner: input.inner })) return undefined
    const old = entries.value.find((e) => String(e.lineId) === String(input.lineId))
    const nowIso = new Date().toISOString()
    const version = String(appVersion.value ?? '未知')
    // `undefined` = 沿用旧值；`null` = 清掉（见上面注释）
    const start = input.start === undefined ? old?.start : (input.start ?? undefined)
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
      updatedAt: nowIso,
      updatedAppVersion: version,
      editCount: (old?.editCount ?? 0) + 1,
      history: prependHistory(old?.history, {
        at: nowIso,
        appVersion: version,
        summary: saveSummaryText({ outer: input.outer, inner: input.inner, laneNo, laneCount, start }),
      }),
    }
    entries.value = [entry, ...entries.value.filter((e) => String(e.lineId) !== String(input.lineId))]
    persist()
    return entry
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

  return { entries, load, persist, upsert, remove, rename, get, appVersion }
}
