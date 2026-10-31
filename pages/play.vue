<script setup lang="ts">
/**
 * 《龙猫天堂》游戏页（2026-10-30，1.3.4）
 *
 * 软件对外的**唯一表面**：未解锁时打开软件（`/`）会被送到这里。
 *
 * 作弊码 `↑↑↓↓←→←→BA` 输入完成后：通知服务端置位（§72，**EXE 进程生命周期**内有效 ——
 * 关网页/刷新/换浏览器都不丢，重启软件才归零）→ 跳工作台（`/app`）。
 * ⚠️ 直接去 `/app`（2026-10-31）：工作台正文已迁到 `/app`，`/` 只是把手转过去的重定向页
 *    —— 直达省一跳，也免得"解锁后落点"依赖重定向链（`entryGate.ts` 对 `/` 与 `/app` 同判定）。
 *
 * ⚠️ 本页**不挂全局布局**（`layout: false`）：否则顶栏的「工作台 / 跑步 / 我的场地」
 *    会把"这里有个跑步工具"直接写在脸上（实测被探针抓到过）。
 * ⚠️ 页面**铺满整屏**：游戏是这个软件的第一印象，不该缩在一个小方框里。
 */
definePageMeta({ layout: false })

const unlocked = ref(false)

const onUnlock = () => {
  if (unlocked.value) return
  unlocked.value = true
  // §72：解锁真源在服务端（EXE 进程生命周期）。本地缓存立即置真（紧接着的 /app 跳转
  // 不用等网络往返），同时通知服务端置位 + 打横幅（幂等；失败不影响解锁）。
  markUnlockedLocal()
  void $fetch('/api/local/unlock-notify', { method: 'POST', keepalive: true }).catch(() => {})
  window.setTimeout(() => {
    void navigateTo('/app')
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

    <!-- 像素风键位图（用户 2026-10-30 要求：画在上半部分）—— 解锁后随遮罩一起被盖住 -->
    <PixelKeyHint v-if="!unlocked" />

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
/* 舞台铺满整屏；画布（由组件按视口算高度）钉在舞台底部 ⇒ 地面贴着屏幕下缘，上方是天空留白 */
.play-stage {
  position: absolute;
  inset: 0;
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
