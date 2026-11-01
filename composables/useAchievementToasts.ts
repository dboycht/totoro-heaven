import { ref } from 'vue'
import type { GameAchievement } from '~/utils/game/achievements'

/**
 * 成就 toast 队列（模块级**单例**，2026-11-01，1.3.5 第二批）
 *
 * 为什么全局单例：作弊码成就（「黑暗中的响指」）在**游戏页**解锁，但作弊码 600ms 后就跳
 * 工作台 —— toast 若只挂在游戏页会被页面卸载吞掉。所以 `<AchievementToast />` 挂在
 * `app.vue`（全局层，任何页面都显示），队列状态放模块级。
 *
 * 一次一局可能连触发多枚（67 / 325 / 350 同帧跨过）：按 push 顺序**逐条展示**——
 * 每条显示 4 秒 → 收起 0.35 秒（leave 动画）→ 下一条，避免叠罗汉。
 */
const TOAST_MS = 4000
/** 收起动画（AchievementToast 的 leave 0.3s）+ 少量缓冲 */
const GAP_MS = 350

const queue = ref<GameAchievement[]>([])
const current = ref<GameAchievement | null>(null)
const visible = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

const next = (): void => {
  clearTimeout(timer)
  const head = queue.value[0]
  if (!head) {
    visible.value = false
    current.value = null
    return
  }
  if (visible.value) {
    // 先收起当前这条，动画走完再取下一条（否则 transition 不触发、看起来"瞬间换字"）
    visible.value = false
    timer = setTimeout(next, GAP_MS)
    return
  }
  queue.value = queue.value.slice(1)
  current.value = head
  visible.value = true
  timer = setTimeout(next, TOAST_MS)
}

export function useAchievementToasts() {
  /** 入队一枚成就（内部保证一次只显示一条） */
  const push = (ach: GameAchievement): void => {
    queue.value = [...queue.value, ach]
    if (!visible.value) next()
  }

  return { current, visible, push }
}
