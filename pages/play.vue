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

    <div class="play-stage">
      <ChibiRunGame @unlock="onUnlock" />
    </div>

    <transition name="fade">
      <div v-if="unlocked" class="play-secret">✨ 你发现了秘密 ✨</div>
    </transition>
  </div>
</template>

<style scoped>
.play-page {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100vh;
  display: block;
  overflow: hidden;
  background: #f7f7f7;
}
.play-head {
  position: absolute;
  top: 10px;
  left: 0;
  right: 0;
  z-index: 5;
  pointer-events: none;
  text-align: center;
}
.play-title {
  display: inline-block;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.18em;
  margin: 0;
  padding: 2px 14px;
  border-radius: 999px;
  background: rgba(18, 16, 28, 0.82);
  color: #ffe9f3;
}
/**
 * 舞台：画布上下若够不到屏幕边（4:1 的等比画面放不出满高），
 * 用伪元素把上下补成**同一颜色**（与原版画布底色一致 = 视觉上一整块全屏）。
 * 颜色取固定值：夜间模式切换时原版会给画布整体反色，这里不跟 —— 留白本身就是浅色界面。
 */
.play-stage {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  justify-content: center;
  align-items: center;
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
