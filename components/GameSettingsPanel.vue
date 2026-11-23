<script setup lang="ts">
/**
 * 游戏设置面板（2026-11-23，1.3.9 开发轮；用户要求「游戏端界面添加设置按钮，可以选择清除成就数据等」）
 *
 * 入口在游戏页左上角「⚙ 设置」（`pages/play.vue`）；打开时父组件暂停游戏（与成就面板同一套
 * `pause()` / `resume()`，原版 `stop()` / `play()`，关闭原地续跑）。
 *
 * 只清**本机游戏数据**（两枚 localStorage 键：成就解锁集合 / 排行榜），
 * **不动**软件解锁状态（服务端 `unlock`）、登录态、token、成绩记录与任何服务端数据。
 * 每类清除都要二次确认（不可撤销），避免误点。
 */
import { ACHIEVEMENTS } from '~/utils/game/achievements'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { unlockedIds, reset: resetAchievements } = useGameAchievements()
const { entries, reset: resetScoreboard } = useGameScoreboard()

type Target = 'ach' | 'board' | 'all'

const LABELS: Record<Target, string> = {
  ach: '成就数据',
  board: '排行榜数据',
  all: '全部游戏数据',
}

const pending = ref<Target | null>(null)
const done = ref('')
const pendingLabel = computed(() => (pending.value ? LABELS[pending.value] : ''))

const ask = (target: Target) => {
  pending.value = target
  done.value = ''
}
const cancel = () => {
  pending.value = null
}
const confirm = () => {
  const target = pending.value
  if (!target) return
  if (target === 'ach' || target === 'all') resetAchievements()
  if (target === 'board' || target === 'all') resetScoreboard()
  done.value = `已清除${LABELS[target]}`
  pending.value = null
}

// 每次重新打开都回到干净状态（不残留上一次的确认条 / 已清除提示）
watch(
  () => props.open,
  (open) => {
    if (open) {
      pending.value = null
      done.value = ''
    }
  },
)
</script>

<template>
  <transition name="settings-fade">
    <div v-if="open" class="settings-mask" @click.self="emit('close')">
      <div class="settings-card" role="dialog" aria-modal="true" aria-label="游戏设置">
        <div class="settings-head">
          <span class="settings-title">⚙ 设置</span>
          <button type="button" class="settings-close" aria-label="关闭设置" @click="emit('close')">✕</button>
        </div>

        <div class="settings-row">
          <div class="settings-info">
            <div class="settings-name">成就数据</div>
            <div class="settings-desc">已解锁 {{ unlockedIds.size }} / {{ ACHIEVEMENTS.length }} 枚，只存本机。</div>
          </div>
          <button type="button" class="settings-btn" @click="ask('ach')">清除成就数据</button>
        </div>

        <div class="settings-row">
          <div class="settings-info">
            <div class="settings-name">排行榜数据</div>
            <div class="settings-desc">本机记录 {{ entries.length }} 条，只存本机。</div>
          </div>
          <button type="button" class="settings-btn" @click="ask('board')">清除排行榜数据</button>
        </div>

        <div class="settings-row">
          <div class="settings-info">
            <div class="settings-name">全部游戏数据</div>
            <div class="settings-desc">成就与排行榜一起清除。</div>
          </div>
          <button type="button" class="settings-btn" @click="ask('all')">清除全部游戏数据</button>
        </div>

        <div v-if="pending" class="settings-confirm">
          <div class="settings-confirm-text">确定清除{{ pendingLabel }}？此操作不可撤销。</div>
          <div class="settings-confirm-actions">
            <button type="button" class="settings-cancel" @click="cancel">取消</button>
            <button type="button" class="settings-ok" @click="confirm">确认清除</button>
          </div>
        </div>

        <div v-if="done" class="settings-done">{{ done }}</div>

        <div class="settings-note">只清除本机游戏数据，不影响软件解锁与登录状态。</div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
/* 遮罩：与成就面板同级（z 45），高于通关结算遮罩 30、低于 toast 50 */
.settings-mask {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(12, 10, 20, 0.6);
}
.settings-card {
  width: min(430px, calc(100vw - 40px));
  max-height: min(80vh, 560px);
  overflow: auto;
  background: #16141f;
  border: 3px solid #3a3650;
  border-radius: 10px;
  box-shadow: 0 8px 0 rgba(0, 0, 0, 0.35);
  padding: 14px 18px 16px;
}
.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.settings-title {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.3em;
  color: #ffd54a;
}
.settings-close {
  appearance: none;
  border: 0;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 15px;
  color: #b9b3c8;
  padding: 2px 4px;
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-top: 2px solid #262233;
}
.settings-info {
  min-width: 0;
}
.settings-name {
  font-size: 14px;
  font-weight: 800;
  color: #f3eef8;
}
.settings-desc {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: #9d97ad;
}
.settings-btn {
  appearance: none;
  flex: 0 0 auto;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 800;
  color: #ffe9f3;
  background: #5b2233;
  border: 2px solid #8c3a4d;
  border-radius: 7px;
  padding: 7px 12px;
}
.settings-btn:active {
  transform: translateY(2px);
}
.settings-confirm {
  margin-top: 4px;
  padding: 10px 12px;
  background: #241820;
  border: 2px solid #8c3a4d;
  border-radius: 8px;
}
.settings-confirm-text {
  font-size: 12px;
  line-height: 1.6;
  color: #ffd9df;
}
.settings-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.settings-cancel,
.settings-ok {
  appearance: none;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 800;
  border-radius: 6px;
  padding: 5px 12px;
}
.settings-cancel {
  color: #d8d3e4;
  background: transparent;
  border: 2px solid #4a4460;
}
.settings-ok {
  color: #2a0b12;
  background: #ff7a8a;
  border: 2px solid #ff7a8a;
}
.settings-done {
  margin-top: 10px;
  font-size: 12px;
  font-weight: 800;
  color: #8be08b;
}
.settings-note {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 2px solid #262233;
  font-size: 11px;
  line-height: 1.5;
  color: #7d7890;
}
.settings-fade-enter-active,
.settings-fade-leave-active {
  transition: opacity 0.2s ease;
}
.settings-fade-enter-from,
.settings-fade-leave-to {
  opacity: 0;
}
</style>
