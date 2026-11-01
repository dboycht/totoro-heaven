<script setup lang="ts">
/**
 * 开场公告弹窗（2026-11-01，1.3.5）
 *
 * 用户口径：「打开游戏直接弹窗」—— 每次进入游戏页都弹，点「我已知晓」关闭这一次
 * （不做永久记忆，引导强度优先；玩家若形成印象，正是本弹窗的目的）。
 *
 * 文案收口在 `utils/game/achievements.ts` 的 `GUIDE_MODAL`（逐字 = 用户指定原话，
 * 有单测盯着），本组件只渲染；「GitHub讨论区」五个字是可点击链接（新标签打开讨论区）。
 */
import { GUIDE_MODAL } from '~/utils/game/achievements'

const emit = defineEmits<{ (e: 'ack'): void }>()
const known = ref(false)

const onAck = () => {
  known.value = true
  emit('ack')
}
</script>

<template>
  <transition name="guide-fade">
    <div v-if="!known" class="guide-mask">
      <div class="guide-card" role="dialog" aria-modal="true" :aria-label="GUIDE_MODAL.title">
        <div class="guide-title">{{ GUIDE_MODAL.title }}</div>
        <p class="guide-body">
          {{ GUIDE_MODAL.bodyBefore }}<a
            class="guide-link"
            :href="GUIDE_MODAL.discussionsUrl"
            target="_blank"
            rel="noopener noreferrer"
          >{{ GUIDE_MODAL.linkText }}</a>{{ GUIDE_MODAL.bodyAfter }}
        </p>
        <button type="button" class="guide-btn" @click="onAck">{{ GUIDE_MODAL.button }}</button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
/* 遮罩：压在游戏画布与键位图之上（游戏页元素 z-index 最高 5） */
.guide-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(12, 10, 20, 0.55);
}
/* 像素游戏公告卡：深底、硬边框、阶梯式硬阴影 */
.guide-card {
  width: min(500px, calc(100vw - 44px));
  background: #16141f;
  border: 3px solid #3a3650;
  border-radius: 10px;
  box-shadow: 0 8px 0 rgba(0, 0, 0, 0.35);
  padding: 20px 26px 22px;
  text-align: center;
}
.guide-title {
  display: inline-block;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.5em;
  text-indent: 0.5em;
  color: #ffd54a;
  padding: 3px 12px;
  border: 2px solid #4a4460;
  border-radius: 6px;
  margin-bottom: 14px;
}
.guide-body {
  margin: 0 0 18px;
  font-size: 15px;
  line-height: 1.9;
  color: #f3eef8;
}
.guide-link {
  color: #7ad7ff;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.guide-link:hover {
  color: #a8e7ff;
}
/* 硬阴影大按钮：按下有位移，游戏手感的「确认」 */
.guide-btn {
  appearance: none;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.2em;
  text-indent: 0.2em;
  color: #221c08;
  background: #ffd54a;
  padding: 10px 34px;
  border-radius: 8px;
  box-shadow: 0 4px 0 #b8961f;
}
.guide-btn:active {
  transform: translateY(3px);
  box-shadow: 0 1px 0 #b8961f;
}
.guide-fade-enter-active,
.guide-fade-leave-active {
  transition: opacity 0.22s ease;
}
.guide-fade-enter-from,
.guide-fade-leave-to {
  opacity: 0;
}
</style>
