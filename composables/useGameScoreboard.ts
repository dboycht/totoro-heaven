import { ref } from 'vue'
import { SCOREBOARD_STORAGE_KEY, type ScoreEntry } from '~/utils/game/achievements'

/**
 * 通关排行榜（本机持久，2026-11-01，1.3.5 第二批）
 *
 * 存储：`localStorage`（key 见 `utils/game/achievements.ts`）——玩家通关后自己输入名字，
 * 只存本机浏览器，不入库不上传。按分数降序、同分先到在前，最多留 50 条。
 * **单例**：状态在模块级（play.vue 与 AchievementPanel 共享同一份，记录后榜单即时更新）。
 * SPA（`ssr:false`）只在客户端运行，可安全同步读。
 */
const entries = ref<ScoreEntry[]>([])
let hydrated = false

function hydrate(): void {
  if (hydrated) return
  hydrated = true
  try {
    const raw = localStorage.getItem(SCOREBOARD_STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        entries.value = parsed.filter(
          (x): x is ScoreEntry =>
            !!x && typeof x === 'object' && typeof (x as ScoreEntry).name === 'string' &&
            typeof (x as ScoreEntry).score === 'number' && typeof (x as ScoreEntry).at === 'string',
        )
      }
    }
  } catch {
    // 坏数据当作空榜（下次写回自然修复），不阻塞游戏
  }
}

export function useGameScoreboard() {
  hydrate()

  const persist = () => {
    try {
      localStorage.setItem(SCOREBOARD_STORAGE_KEY, JSON.stringify(entries.value))
    } catch {
      // 写不进（隐私模式等）：本局内存里仍有，下次会话丢弃
    }
  }

  /** 记入一条通关成绩（分数降序、同分先到在前，截前 50） */
  const add = (entry: ScoreEntry): void => {
    entries.value = [...entries.value, entry]
      .sort((a, b) => (b.score - a.score) || (a.at < b.at ? -1 : 1))
      .slice(0, 50)
    persist()
  }

  return { entries, add }
}
