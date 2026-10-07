/**
 * 「成绩记录」的三态与认领逻辑（**纯逻辑层**，可单测）
 *
 * ## 为什么要有它（2026-10-07 用户被绕住的真因）
 * 「成绩记录」页读的是**本机记录**（`localStorage.mp_demo_records`），而它由
 * `composables/demo/runner.ts` 在**每次「结算」**时写入一条 —— **不看有没有真实提交**。
 * 于是：
 *   · 那个绿色「有效」其实是**本地自检预判**（`check.pass ? 1 : 0`），**不是服务端判定**；
 *   · 记录里的 `scoreId` 是 `demoScantronId()` 生成的**演示风格假号**（`sunrunId` + 日期 + 两位序号），
 *     与真实场次号（如 `sunrunId202610072508`）**对不上** ⇒ 无法用它核对判定；
 *   · 结果就是用户看到"两条都有效"，而其中一条**根本没提交**。
 *
 * ## 口径（本轮修法）
 * 1. 结算时给记录一个 **`localId`**（本机自增/随机 id）+ **`submitState`**（`demo` / `local`）+
 *    **`settledAtMs`**（与 `run.value.settledAtMs` 同一个值）；
 * 2. 真实提交成功时按 **`settledAtMs`** 认领那条记录 ⇒ 写回**真实场次号**、`submitState='submitted'`、
 *    轨迹是否交上（`detailOk`）；读回判定后再把**服务端判定**写进去；
 * 3. 界面据此分三个 badge：`已真实提交` / `仅本地结算` / `演示`，且**只有"已真实提交"才把判定当权威**；
 *    旧数据（没有 `submitState`）如实显示 `未记录（旧数据）` —— 不凭空猜。
 */

export type RecordSubmitState = 'local' | 'submitted' | 'demo'
/** 旧数据（本次改动之前写的记录）没有 `submitState` ⇒ 如实标"未记录"，不猜 */
export type RecordSubmitStateOrUnknown = RecordSubmitState | 'unknown'

/** 只依赖这三个字段（避免把 `MpRunRecord` 整个类型拖进纯逻辑层） */
export interface RecordLike {
  localId?: string
  submitState?: string
  settledAtMs?: number
  scoreId?: string
  detailOk?: boolean
  scorePassType?: number | string
  scorePassRemark?: string
  [key: string]: unknown
}

/** 本机记录 id（**只管唯一，不承载语义**；同一毫秒内也保证不撞） */
export function newLocalRecordId(now: number = Date.now(), rand: number = Math.random()): string {
  const tail = Math.floor(Math.abs(rand) * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `local-${Math.floor(now).toString(36)}-${tail}`
}

/** 记录的三态；缺字段 = `unknown`（旧数据） */
export function recordSubmitState(r: RecordLike | null | undefined): RecordSubmitStateOrUnknown {
  const s = String(r?.submitState ?? '')
  return s === 'local' || s === 'submitted' || s === 'demo' ? s : 'unknown'
}

/** 三态的界面文案（用户可见 ⇒ 不得含 markdown 标记） */
export function recordSubmitStateLabel(r: RecordLike | null | undefined): string {
  switch (recordSubmitState(r)) {
    case 'submitted':
      return '已真实提交'
    case 'local':
      return '仅本地结算'
    case 'demo':
      return '演示'
    default:
      return '未记录（旧数据）'
  }
}

/** 「判定」这一列是不是**服务端**给的（只有"已真实提交"才是） */
export function recordVerdictIsAuthoritative(r: RecordLike | null | undefined): boolean {
  return recordSubmitState(r) === 'submitted'
}

/** 判定列的前缀：非权威时明确写"本地预判"，别让用户以为是服务端判的 */
export function recordVerdictPrefix(r: RecordLike | null | undefined): string {
  return recordVerdictIsAuthoritative(r) ? '' : '本地预判：'
}

/** 轨迹那一列的前缀/说明（`detailOk` 只有"已真实提交"的记录才有意义） */
export function recordDetailNote(r: RecordLike | null | undefined): string {
  const st = recordSubmitState(r)
  if (st === 'submitted') return r?.detailOk === true ? '轨迹已交' : r?.detailOk === false ? '轨迹未交' : '轨迹未记录'
  if (st === 'demo') return '演示数据不提交'
  if (st === 'local') return '未提交（无云端轨迹）'
  return '未记录（旧数据）'
}

/**
 * 真实提交成功时**认领**那笔本机记录（按 `settledAtMs` 精确匹配 —— 毫秒时间戳天然唯一）。
 * @returns 新数组（**不改入参**，与其它纯函数一致）；没认领到就原样返回。
 */
export function claimRecordForRealSubmit<T extends RecordLike>(
  records: T[],
  info: { settledAtMs?: number; scantronId: string; detailOk?: boolean },
): { records: T[]; claimed: boolean } {
  const key = typeof info.settledAtMs === 'number' && Number.isFinite(info.settledAtMs) ? info.settledAtMs : NaN
  if (!Number.isFinite(key) || !info.scantronId) return { records, claimed: false }
  let claimed = false
  const next = records.map((r) => {
    if (claimed || r.settledAtMs !== key) return r
    claimed = true
    return {
      ...r,
      submitState: 'submitted',
      scoreId: info.scantronId,
      // ⚠️ 本地预判值先留着，等读回服务端判定后再覆盖（别把本地预判冒充服务端结论）
      ...(typeof info.detailOk === 'boolean' ? { detailOk: info.detailOk } : {}),
    }
  })
  return { records: next, claimed }
}

/** 轨迹明细最终结果（补交成功/失败后也要能更新） */
export function setRecordDetailOk<T extends RecordLike>(records: T[], scantronId: string, detailOk: boolean): T[] {
  let done = false
  return records.map((r) => {
    if (done || String(r.scoreId ?? '') !== String(scantronId)) return r
    done = true
    return { ...r, detailOk }
  })
}

/**
 * 读回**服务端判定**后写进对应的那条记录（按场次号匹配）。
 * 只有 `submitState === 'submitted'` 的记录会带上完整判定 —— 本地/演示记录不该被冒充。
 */
export function applyServerVerdict<T extends RecordLike>(
  records: T[],
  scantronId: string,
  verdict: { scorePassType?: number | string; scorePassRemark?: string },
): T[] {
  let done = false
  return records.map((r) => {
    if (done || String(r.scoreId ?? '') !== String(scantronId)) return r
    done = true
    return {
      ...r,
      submitState: 'submitted',
      ...(verdict.scorePassType !== undefined ? { scorePassType: verdict.scorePassType } : {}),
      ...(verdict.scorePassRemark !== undefined ? { scorePassRemark: verdict.scorePassRemark } : {}),
    }
  })
}
