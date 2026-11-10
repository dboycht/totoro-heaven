<script setup lang="ts">
/**
 * 《龙猫天堂》游戏页（2026-10-30，1.3.4；2026-11-01 第二批接成就/排行榜/记名）
 *
 * 软件对外的**唯一表面**：未解锁时打开软件（`/`）会被送到这里。
 *
 * 本页装配（1.3.5 第二批）：
 *   - 开场公告 `GameGuideModal`（每次进页都弹）；
 *   - 成就触发点五处：作弊码（unlock）→「黑暗中的响指」、67 / 325 / 350 里程碑（achieve）、
 *     通关后输入名字「郑永康」→「kskblzdjd」；解锁状态持久（localStorage），
 *     toast 队列在**全局**（app.vue）——跳转工作台也不丢；
 *   - 通关结算：定格 + 恭喜 + 名字输入（记入本机排行榜，可跳过）+ 再来一局；
 *   - 成就/排行榜面板 `AchievementPanel`（右上角入口；打开暂停、关闭恢复）。
 *
 * ⚠️ 本页**不挂全局布局**（`layout: false`）：否则顶栏的「工作台 / 跑步 / 我的场地」
 *    会把"这里有个跑步工具"直接写在脸上（实测被探针抓到过）。
 * ⚠️ 页面**铺满整屏**：游戏是这个软件的第一印象，不该缩在一个小方框里。
 */
import {
  ACHIEVEMENT_CHEAT,
  ACHIEVEMENT_SECRET_ID,
  ACHIEVEMENTS,
  SECRET_ACHIEVEMENT_NAME,
  THRESHOLD_ACHIEVEMENTS,
  type GameAchievement,
} from '~/utils/game/achievements'

definePageMeta({ layout: false })

const unlocked = ref(false)

// ── 成就与排行榜（模块级单例 composable；面板与 toast 共享同一份状态）──
const { unlock } = useGameAchievements()
const { add: addScoreEntry } = useGameScoreboard()
const { push: pushAchievementToast } = useAchievementToasts()

/** 解锁成就；"新解锁"才入队 toast（重玩再达标只静默记账，不重复打扰） */
const tryUnlock = (ach: GameAchievement) => {
  if (unlock(ach.id)) pushAchievementToast(ach)
}

const onUnlock = () => {
  if (unlocked.value) return
  unlocked.value = true
  // 立刻把游戏停住（跳转前还有 600ms）：否则这半秒里恐龙还在跑、音效还在响，
  // 而且跳到工作台之后原版挂在 document 上的监听/音效上下文会跟着过去（离开页面时的彻底收尾见 ChibiRunGame 的 teardownRunner）
  gameRef.value?.pause()
  // 「黑暗中的响指」：输完作弊码即解锁（toast 挂全局层，下面 600ms 跳工作台不会吞掉它）
  tryUnlock(ACHIEVEMENT_CHEAT)
  // §72：解锁真源在服务端（EXE 进程生命周期）。本地缓存立即置真（紧接着的 /app 跳转
  // 不用等网络往返），同时通知服务端置位 + 打横幅（幂等；失败不影响解锁）。
  markUnlockedLocal()
  void $fetch('/api/local/unlock-notify', { method: 'POST', keepalive: true }).catch(() => {})
  window.setTimeout(() => {
    void navigateTo('/app')
  }, 600)
}

// ── 分数里程碑与通关 ──
const gameRef = ref<{
  restart: () => void
  pause: () => void
  resume: () => void
  dispose: () => void
} | null>(null)
const won = ref(false)
const finalScore = ref(0)

const onAchieve = (id: string) => {
  const ach = THRESHOLD_ACHIEVEMENTS.find((a) => a.id === id)
  if (ach) tryUnlock(ach)
}

const onWin = (score: number) => {
  won.value = true
  finalScore.value = score
  // 「结束了？」是 350 阈值成就，同一帧先 achieve（解锁+toast）后 win（结算遮罩），这里不重复处理
}

// 记名（通关后，可跳过）：名字只存本机 localStorage，不入库不上传；
// 输入「郑永康」解锁隐藏成就「kskblzdjd」（2026-11-01 用户指定，逐字比对）
const playerName = ref('')
const recorded = ref(false)
const onRecord = () => {
  const name = playerName.value.trim()
  if (!name || recorded.value) return
  addScoreEntry({ name, score: finalScore.value, at: new Date().toISOString() })
  recorded.value = true
  if (name === SECRET_ACHIEVEMENT_NAME) {
    const ach = ACHIEVEMENTS.find((a) => a.id === ACHIEVEMENT_SECRET_ID)
    if (ach) tryUnlock(ach)
  }
}

const onRestart = () => {
  won.value = false
  gameRef.value?.restart()
}

/**
 * 离开本页（作弊码跳工作台 / 切到别的页面）时先让游戏组件收尾：
 * 停主循环、摘掉 document 监听、**关掉音效上下文**。
 * 组件卸载时的 `onBeforeUnmount` 也会做同一件事，这里提前一拍（页面摘除是有顺序的）。
 */
onBeforeUnmount(() => {
  gameRef.value?.dispose()
})

// ── 成就/排行榜面板：打开暂停（原版 stop 定格）、关闭恢复（play 原地续跑）；通关定格时不恢复 ──
const panelOpen = ref(false)
const onPanelToggle = () => {
  panelOpen.value = !panelOpen.value
  if (panelOpen.value) gameRef.value?.pause()
  else gameRef.value?.resume()
}

// 通关遮罩显示时按空格 / ↑ 再来一局（与原版 game over 后按键复活的手感一致）
// ⚠️ 焦点在名字输入框里时放行 —— 空格要能打进名字，不能顺手把局重开了
const onWinKey = (e: KeyboardEvent) => {
  if (!won.value) return
  if (e.target instanceof HTMLInputElement) return
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault()
    onRestart()
  }
}
onMounted(() => window.addEventListener('keydown', onWinKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onWinKey))

useHead({ title: '龙猫天堂' })
</script>

<template>
  <div class="play-page">
    <header class="play-head">
      <h1 class="play-title">龙猫天堂</h1>
    </header>

    <!-- 成就/排行榜入口（右上角；打开时游戏暂停，关闭恢复） -->
    <button type="button" class="play-meta-btn" @click="onPanelToggle">🏆 成就 · 排行榜</button>

    <div class="play-stage">
      <ChibiRunGame ref="gameRef" @unlock="onUnlock" @achieve="onAchieve" @win="onWin" />
    </div>

    <!-- 像素风键位图（用户 2026-10-30 要求：画在上半部分）—— 解锁后随遮罩一起被盖住 -->
    <PixelKeyHint v-if="!unlocked" />

    <transition name="fade">
      <div v-if="unlocked" class="play-secret">✨ 你发现了秘密 ✨</div>
    </transition>

    <!-- 通关结算遮罩（1.3.5 第二批）：定格成绩 + 恭喜 + 记名（隐藏成就触发点）+ 再来一局 -->
    <transition name="fade">
      <div v-if="won" class="play-win">
        <div class="play-win-card">
          <div class="play-win-title">🎉 恭喜你已经通关</div>
          <div class="play-win-score">最终得分 {{ finalScore }}</div>
          <div class="play-win-record">
            <input
              v-model="playerName"
              class="play-win-input"
              :disabled="recorded"
              maxlength="16"
              placeholder="输入你的名字，记入排行榜"
              @keydown.enter="onRecord"
            />
            <button type="button" class="play-win-btn" :disabled="recorded || !playerName.trim()" @click="onRecord">
              {{ recorded ? '已记录 ✓' : '记入排行榜' }}
            </button>
          </div>
          <button type="button" class="play-win-btn play-win-restart" @click="onRestart">再来一局</button>
        </div>
      </div>
    </transition>

    <!-- 开场公告（每次进入游戏页都弹，见 GameGuideModal） -->
    <GameGuideModal />

    <!-- 成就/排行榜面板（隐藏式成就：未解锁只显示灰色问号块） -->
    <AchievementPanel :open="panelOpen" @close="onPanelToggle" />
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
/* 成就/排行榜入口（右上角，像素风小按钮）
   ⚠️ z-index 必须高于通关结算遮罩（.play-win = 30）：通关结算界面里也要能打开
   面板看排行榜/成就（e2e 实测：低于 30 时遮罩吃掉点击，面板打不开） */
.play-meta-btn {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 35;
  appearance: none;
  border: 2px solid #4a4460;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 800;
  color: #ffe9f3;
  background: rgba(18, 16, 28, 0.82);
  border-radius: 999px;
  padding: 4px 14px;
}
.play-meta-btn:active {
  transform: translateY(1px);
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
/* 记名行（通关后可跳过）：输入框是本批新增的唯一文本输入面 —— 键盘放行判据见 ChibiRunGame 的 isTypingTarget */
.play-win-record {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 18px;
}
.play-win-input {
  font: inherit;
  font-size: 14px;
  width: 200px;
  color: #f3eef8;
  background: #211e2f;
  border: 2px solid #4a4460;
  border-radius: 8px;
  padding: 8px 12px;
  outline: none;
}
.play-win-input:focus {
  border-color: #ffd54a;
}
.play-win-input:disabled {
  opacity: 0.6;
}
.play-win-input::placeholder {
  color: #7d7890;
  font-size: 12px;
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
