<script setup lang="ts">
/**
 * 《龙猫天堂》游戏页（2026-10-30，1.3.4 新增）
 *
 * 这是软件对外的**唯一表面**：未解锁时打开软件（`/`）会被送到这里。
 *
 * 作弊码 `↑↑↓↓←→←→BA` 输入完成后：
 *   ① 写会话级解锁标记（`sessionStorage`，关浏览器即忘）；
 *   ② 跳转工具页（`/`）。
 * 此后中间件对所有页面放行 —— 与正常软件完全一样。
 *
 * ⚠️ 本页在**未解锁语境**下不得出现"工具/软件/跑步/校园"字样（那是线索）。
 */
import { unlock } from '~/utils/game/entryGate'

const unlocked = ref(false)

/** 作弊码命中：先给一个"发现秘密"的反馈，再跳转 */
const onUnlock = () => {
  if (unlocked.value) return
  unlocked.value = true
  unlock()
  window.setTimeout(() => {
    void navigateTo('/')
  }, 700)
}

/**
 * ⚠️ 游戏页**必须不挂全局布局**：`layouts/default.vue` 的顶栏写着「工作台 / 跑步 / 我的场地 / 数据」，
 * 挂在游戏页上方等于把"这里有个跑步工具"直接写在脸上（实测 2026-10-30 被探针抓到）。
 * 判据：**伪装面只能渲染伪装面自己的东西**。
 */
definePageMeta({ layout: false })

useHead({ title: '龙猫天堂' })
</script>

<template>
  <div class="play-page">
    <header class="play-head">
      <h1 class="play-title">龙猫天堂</h1>
      <p class="play-sub">踩着一朵云，一路向上。</p>
    </header>

    <ChibiRunGame @unlock="onUnlock" />

    <transition name="fade">
      <div v-if="unlocked" class="play-secret">✨ 你发现了秘密 ✨</div>
    </transition>
  </div>
</template>

<style scoped>
.play-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 18px 12px 40px;
}
.play-head {
  text-align: center;
}
.play-title {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 0.14em;
  margin: 0;
  background: linear-gradient(90deg, #ffd6e8, #cbb6ff, #a9e5ff);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.play-sub {
  margin: 6px 0 0;
  font-size: 13px;
  opacity: 0.7;
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
