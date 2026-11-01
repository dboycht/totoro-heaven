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

// ── 通关结算（1.3.5，2026-11-01）──
const gameRef = ref<{ restart: () => void } | null>(null)
const won = ref(false)
const finalScore = ref(0)
const achievementShow = ref(false)
let achievementFired = false
let achievementTimer: ReturnType<typeof setTimeout> | undefined

const onWin = (score: number) => {
  won.value = true
  finalScore.value = score
  // 首次通关弹成就「结束了？」（同一页面生命周期只弹一次；6 秒后自动收起）
  if (achievementFired) return
  achievementFired = true
  achievementShow.value = true
  achievementTimer = setTimeout(() => {
    achievementShow.value = false
  }, 6000)
}

const onRestart = () => {
  won.value = false
  gameRef.value?.restart()
}

// 通关遮罩显示时按空格 / ↑ 再来一局（与原版 game over 后按键复活的手感一致）
const onWinKey = (e: KeyboardEvent) => {
  if (!won.value) return
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault()
    onRestart()
  }
}
onMounted(() => window.addEventListener('keydown', onWinKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWinKey)
  if (achievementTimer) clearTimeout(achievementTimer)
})

useHead({ title: '龙猫天堂' })
</script>

<template>
  <div class="play-page">
    <header class="play-head">
      <h1 class="play-title">龙猫天堂</h1>
    </header>

    <div class="play-stage">
      <ChibiRunGame ref="gameRef" @unlock="onUnlock" @win="onWin" />
    </div>

    <!-- 像素风键位图（用户 2026-10-30 要求：画在上半部分）—— 解锁后随遮罩一起被盖住 -->
    <PixelKeyHint v-if="!unlocked" />

    <transition name="fade">
      <div v-if="unlocked" class="play-secret">✨ 你发现了秘密 ✨</div>
    </transition>

    <!-- 通关结算遮罩（1.3.5）：定格成绩 + 恭喜 + 再来一局（按钮或空格/↑） -->
    <transition name="fade">
      <div v-if="won" class="play-win">
        <div class="play-win-card">
          <div class="play-win-title">🎉 恭喜你已经通关</div>
          <div class="play-win-score">最终得分 {{ finalScore }}</div>
          <button type="button" class="play-win-btn" @click="onRestart">再来一局</button>
        </div>
      </div>
    </transition>

    <!-- 开场公告（1.3.5）：每次进入游戏页都弹，见 GameGuideModal -->
    <GameGuideModal />

    <!-- 首通成就 toast（左下角，Minecraft 风）：见 AchievementToast -->
    <AchievementToast :show="achievementShow" />
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
/* 通关结算遮罩（1.3.5）：要接按钮点击，不能像 play-secret 那样禁用指针 */
.play-win {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(18, 14, 30, 0.66);
}
.play-win-card {
  text-align: center;
  background: #16141f;
  border: 3px solid #3a3650;
  border-radius: 10px;
  box-shadow: 0 8px 0 rgba(0, 0, 0, 0.35);
  padding: 26px 40px;
}
.play-win-title {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #ffe9f3;
}
.play-win-score {
  margin-top: 10px;
  font-size: 15px;
  color: #ffd54a;
  letter-spacing: 0.1em;
}
.play-win-btn {
  appearance: none;
  border: 0;
  cursor: pointer;
  font: inherit;
  margin-top: 18px;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.2em;
  text-indent: 0.2em;
  color: #221c08;
  background: #ffd54a;
  padding: 9px 30px;
  border-radius: 8px;
  box-shadow: 0 4px 0 #b8961f;
}
.play-win-btn:active {
  transform: translateY(3px);
  box-shadow: 0 1px 0 #b8961f;
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
