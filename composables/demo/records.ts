/**
 * 【演示态 + 跑步机】成绩记录：`useDemoRecords()`（`localStorage` 持久化 + 派生统计）
 *
 * 记录状态本身用 `useState('mpDemoRecords', ...)` 声明 —— 与 `demo/state.ts` 是**同一个共享引用**
 * （key 集中在 `state.ts` 里管理，本文件只取 `RECORDS_KEY` 常量，避免键名两处漂移）。
 * 依赖方向：本文件 → `demo/state.ts`（单向，**不反向**）。
 *
 * `stats` / `term` 是**展示用派生值**：真实模式暂未接线（学期要求次数由 `useMpReal.fetchVerdict`
 * 读回记录后仍待接线），所以演示模式给假值、真实模式给 null（界面显示 —）。
 */
import type { Ref } from 'vue'
import type { MpRunRecord } from '~/src/mp/types'
import { DEMO_ARCH_SUMMARY, DEMO_TERM } from '~/src/mp/demo'
import { RECORDS_KEY } from './state'

export function useDemoRecords(demoMode: Ref<boolean>) {
  /** 成绩记录（**默认空**；演示记录由「载入演示数据」写入，真实记录由结算/接口写入） */
  const records = useState<MpRunRecord[]>('mpDemoRecords', () => {
    if (import.meta.client) {
      try {
        const raw = localStorage.getItem(RECORDS_KEY)
        /**
         * ⚠️ 2026-09-20 审计修复：原先只防"JSON 解析失败"，没防"**解析成功但不是数组**"
         * （`{}` / `"abc"` / `123` 都会解析成功）⇒ `records.value` 变成非数组，
         * 记录页的 `.filter/.reduce` 直接抛 TypeError、整页崩。
         * 判据：**落盘数据的结构也要校验**，不只校验能不能解析（同 `normalizeLibrary` 的做法）。
         */
        if (raw) {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) return parsed as MpRunRecord[]
        }
      } catch {
        /* 忽略损坏的本地缓存 */
      }
    }
    return []
  })

  const persistRecords = () => {
    if (import.meta.client) {
      try {
        localStorage.setItem(RECORDS_KEY, JSON.stringify(records.value))
      } catch {
        /* 忽略配额错误 */
      }
    }
  }

  const resetRecords = () => {
    records.value = []
    persistRecords()
  }

  // ---------- 展示用派生值 ----------

  const stats = computed(() => {
    const passed = records.value.filter((r) => Number(r.scorePassType) === 1 || Number(r.scorePassType) === 2).length
    const invalid = records.value.filter((r) => Number(r.scorePassType) === 0).length
    const totalMileage = records.value.reduce((sum, r) => sum + Number(r.mileage || 0), 0)
    // ⚠️ requireNumber 目前来自演示摘要（真实值已由 useMpReal.fetchVerdict 读回记录，但学期要求次数尚未接线）
    const requireNumber = demoMode.value ? DEMO_ARCH_SUMMARY.requireNumber : null
    return {
      requireNumber,
      passed,
      invalid,
      totalMileage: totalMileage.toFixed(2),
    }
  })

  /** 学期信息：演示模式给假值；真实模式暂未接线（界面显示 —） */
  const term = computed(() => (demoMode.value ? DEMO_TERM : null))

  return {
    records,
    persistRecords,
    resetRecords,
    stats,
    term,
  }
}

/** `useDemoRecords()` 的返回类型（供 `demo/runner.ts` 声明形参，避免把整个 records 再摊一遍） */
export type DemoRecordsApi = ReturnType<typeof useDemoRecords>
