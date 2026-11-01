import { ref } from 'vue'
import { ACHIEVEMENTS_STORAGE_KEY } from '~/utils/game/achievements'

/**
 * 成就解锁状态（本机持久，2026-11-01，1.3.5 第二批）
 *
 * 存储：`localStorage`（`utils/game/achievements.ts` 的 key 常量）——单机软件，成就
 * 只属于本机浏览器，不入库不上传（隐私红线：不存 token/学号，名字是玩家自己输入的）。
 *
 * **单例**：状态在模块级（play.vue 与 AchievementPanel 共享同一份，解锁后面板即时亮起）；
 * `hydrate` 只在首次调用时读一次 localStorage。SPA（`ssr:false`）只在客户端运行，可安全同步读。
 *
 * 解锁语义（2026-11-01 用户指定）：每个成就**只解锁一次（持久）**——
 * `unlock` 已解锁时返回 false，调用方据此决定弹不弹 toast（重玩再达标不打扰）。
 */
const unlockedIds = ref<Set<string>>(new Set())
let hydrated = false

function hydrate(): void {
  if (hydrated) return
  hydrated = true
  try {
    const raw = localStorage.getItem(ACHIEVEMENTS_STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        unlockedIds.value = new Set(parsed.filter((x): x is string => typeof x === 'string'))
      }
    }
  } catch {
    // 坏数据当作没解锁过（下次写回自然修复），不阻塞游戏
  }
}

export function useGameAchievements() {
  hydrate()

  const persist = () => {
    try {
      localStorage.setItem(ACHIEVEMENTS_STORAGE_KEY, JSON.stringify([...unlockedIds.value]))
    } catch {
      // 隐私模式等写不进的情况：本局内状态仍在（内存），下次会话重新解锁
    }
  }

  /** 解锁一个成就；返回 true = 本次是新解锁（调用方弹 toast），false = 早就解锁过 */
  const unlock = (id: string): boolean => {
    if (unlockedIds.value.has(id)) return false
    const next = new Set(unlockedIds.value)
    next.add(id)
    unlockedIds.value = next
    persist()
    return true
  }

  return { unlockedIds, unlock }
}
