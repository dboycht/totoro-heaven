<script setup lang="ts">
/**
 * 《龙猫天堂》游戏页（2026-10-30，1.3.4）
 *
 * 软件对外的**唯一表面**：未解锁时打开软件（`/`）会被送到这里。
 *
 * 作弊码 `↑↑↓↓←→←→BA` 输入完成后：写会话级解锁标记 → 跳转工具页（`/`）。
 *
 * ⚠️ 本页**不挂全局布局**（`layout: false`）：否则顶栏的「工作台 / 跑步 / 我的场地」
 *    会把"这里有个跑步工具"直接写在脸上（实测被探针抓到过）。
 * ⚠️ 页面**铺满整屏**：游戏是这个软件的第一印象，不该缩在一个小方框里。
 */
import { unlock } from '~/utils/game/entryGate'

definePageMeta({ layout: false })

const unlocked = ref(false)

const onUnlock = () => {
  if (unlocked.value) return
  unlocked.value = true
  unlock()
  window.setTimeout(() => {
    void navigateTo('/')
  }, 600)
}

useHead({ title: '龙猫天堂' })
</script>

<template>
  <div class="play-page">
    <header class="play-head">
      <h1 class="play-title">龙猫天堂</h1>
    </header>

    <ChibiRunGame @unlock="onUnlock" />

    <transition name="fade">
      <div v-if="unlocked" class="play-secret">✨ 你发现了秘密 ✨</div>
    </transition>
  </div>
</template>

<style scoped>
.play-page {
  min-height: 100vh;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 0 10px;
  box-sizing: border-box;
  background: #12101c;
}
.play-head {
  flex: 0 0 auto;
}
.play-title {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.18em;
  margin: 0;
  background: linear-gradient(90deg, #ffd6e8, #cbb6ff, #a9e5ff);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.play-secret {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  font-weight: 800;
  color: #ffe9f3;
  background: rgba(24, 12, 36, 0.72);
  letter-spacing: 0.1em;
  pointer-events: none;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
