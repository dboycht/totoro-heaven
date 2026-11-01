<script setup lang="ts">
/**
 * Minecraft 风格成就 toast（左下角，2026-11-01，1.3.5）
 *
 * 显示时机由父组件控制（首次通关置 true，数秒后收起；同一页面生命周期只弹一次，
 * 防止「再来一局」又通关时重复打扰）。文案收口在 `utils/game/achievements.ts`
 * 的 `ACHIEVEMENT_WIN`（成就名 = 用户指定「结束了？」，单测盯着）。
 */
import { ACHIEVEMENT_WIN } from '~/utils/game/achievements'

defineProps<{ show: boolean }>()
</script>

<template>
  <transition name="ach-slide">
    <div v-if="show" class="ach-toast" role="status">
      <div class="ach-icon">🏆</div>
      <div class="ach-text">
        <div class="ach-header">{{ ACHIEVEMENT_WIN.header }}</div>
        <div class="ach-title">{{ ACHIEVEMENT_WIN.title }}</div>
        <div class="ach-caption">{{ ACHIEVEMENT_WIN.caption }}</div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
/* 左下角滑入：Minecraft 成就 toast 的位置与配色（深灰底 + 黄字标题） */
.ach-toast {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 280px;
  max-width: calc(100vw - 32px);
  background: rgba(28, 28, 30, 0.95);
  border: 2px solid #3c3c3e;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  padding: 12px 18px 12px 14px;
}
.ach-icon {
  font-size: 30px;
  line-height: 1;
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.5));
}
.ach-header {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  color: #ffd54a;
}
.ach-title {
  font-size: 18px;
  font-weight: 800;
  color: #ffffff;
  margin: 2px 0 3px;
}
.ach-caption {
  font-size: 12px;
  color: #b9b9b9;
  line-height: 1.5;
}
/* 从左缘滑入 / 滑回左缘 */
.ach-slide-enter-active {
  transition: transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.25s ease;
}
.ach-slide-leave-active {
  transition: transform 0.3s ease-in, opacity 0.3s ease-in;
}
.ach-slide-enter-from,
.ach-slide-leave-to {
  transform: translateX(calc(-100% - 24px));
  opacity: 0;
}
</style>
