<script setup lang="ts">
/**
 * 成就显示栏 + 排行榜面板（2026-11-01，1.3.5 第二批）
 *
 * 游戏页右上角入口按钮（`pages/play.vue`）打开；打开时父组件会**暂停游戏**
 * （原版 `stop()` / 关闭时 `play()`，原地恢复不重置），关闭按钮或点遮罩即收起。
 *
 * 两个标签页：
 *   - 成就：**全部为隐藏式成就**（2026-11-01 用户指定）——未解锁 = 灰色匿名块（只有问号，
 *     不剧透名字与条件），解锁后亮出图标（用户自制 logo，缺省 🏆）+ 名字 + 条件 + 引导语；
 *   - 排行榜：本机通关记录（名字 + 分数 + 日期），前 10 条，空榜给引导文案。
 * 数据来自 `useGameAchievements` / `useGameScoreboard`（模块级单例，与 play.vue 共享）。
 */
import { ACHIEVEMENTS } from '~/utils/game/achievements'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { unlockedIds } = useGameAchievements()
const { entries } = useGameScoreboard()
const tab = ref<'ach' | 'board'>('ach')

/** ISO 时间 → MM/DD（面板窄栏只放得下月/日） */
const fmtDate = (iso: string): string => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[1]}/${m[2]}` : ''
}
</script>

<template>
  <transition name="panel-fade">
    <div v-if="open" class="panel-mask" @click.self="emit('close')">
      <div class="panel-card" role="dialog" aria-modal="true" aria-label="成就与排行榜">
        <div class="panel-tabs">
          <button type="button" class="panel-tab" :class="{ on: tab === 'ach' }" @click="tab = 'ach'">🏆 成就</button>
          <button type="button" class="panel-tab" :class="{ on: tab === 'board' }" @click="tab = 'board'">🏅 排行榜</button>
          <button type="button" class="panel-close" aria-label="关闭" @click="emit('close')">✕</button>
        </div>

        <div v-if="tab === 'ach'" class="panel-list">
          <!-- 隐藏式成就（2026-11-01 用户指定）：未解锁 = 灰色匿名块（只显示问号，不剧透名字与条件）；
               解锁后亮出图标（用户自制 logo，缺省 🏆）+ 名字 + 条件 + 引导语 -->
          <div
            v-for="a in ACHIEVEMENTS"
            :key="a.id"
            class="panel-ach"
            :class="unlockedIds.has(a.id) ? 'got' : 'masked'"
          >
            <template v-if="unlockedIds.has(a.id)">
              <img v-if="a.icon" class="panel-ach-img" :src="a.icon" alt="" />
              <div v-else class="panel-ach-icon">🏆</div>
              <div class="panel-ach-text">
                <div class="panel-ach-title">{{ a.title }}</div>
                <div class="panel-ach-hint">{{ a.hint }}</div>
                <div v-if="a.caption" class="panel-ach-caption">{{ a.caption }}</div>
              </div>
            </template>
            <template v-else>
              <div class="panel-ach-icon panel-ach-q">?</div>
              <div class="panel-ach-text">
                <div class="panel-ach-title panel-ach-unknown">???</div>
              </div>
            </template>
          </div>
        </div>

        <div v-else class="panel-list">
          <div v-if="entries.length === 0" class="panel-empty">还没有记录——通关（350 分）并留下名字吧。</div>
          <div v-for="(e, i) in entries.slice(0, 10)" :key="e.at" class="panel-row">
            <span class="panel-rank">{{ i + 1 }}</span>
            <span class="panel-name">{{ e.name }}</span>
            <span class="panel-score">{{ e.score }}</span>
            <span class="panel-date">{{ fmtDate(e.at) }}</span>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
/* 遮罩盖住游戏（z 高于入口按钮 10 与通关遮罩 30，低于 toast 50） */
.panel-mask {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(12, 10, 20, 0.6);
}
.panel-card {
  width: min(460px, calc(100vw - 40px));
  max-height: min(70vh, 520px);
  display: flex;
  flex-direction: column;
  background: #16141f;
  border: 3px solid #3a3650;
  border-radius: 10px;
  box-shadow: 0 8px 0 rgba(0, 0, 0, 0.35);
  padding: 14px 16px 16px;
}
.panel-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.panel-tab {
  appearance: none;
  border: 2px solid #4a4460;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 800;
  color: #b9b3c8;
  background: transparent;
  border-radius: 6px;
  padding: 6px 14px;
}
.panel-tab.on {
  color: #221c08;
  background: #ffd54a;
  border-color: #ffd54a;
}
.panel-close {
  appearance: none;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 15px;
  color: #b9b3c8;
  background: transparent;
  margin-left: auto;
  padding: 4px 8px;
}
.panel-close:hover {
  color: #ffffff;
}
.panel-list {
  overflow-y: auto;
  min-height: 120px;
}
/* 成就行：解锁亮（金边）/ 未解锁灰色匿名块 */
.panel-ach {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 8px;
  border-radius: 8px;
  border: 2px solid transparent;
}
.panel-ach + .panel-ach {
  margin-top: 6px;
}
.panel-ach.got {
  background: rgba(255, 213, 74, 0.08);
  border-color: #4a4460;
}
.panel-ach.masked {
  background: #201d2c;
  border-color: #2e2b3d;
}
/* 用户自制 logo（1:1 PNG）：pixelated 保证像素图放大不糊 */
.panel-ach-img {
  width: 32px;
  height: 32px;
  image-rendering: pixelated;
  object-fit: contain;
}
.panel-ach-icon {
  font-size: 22px;
  line-height: 1.4;
}
.panel-ach-q {
  width: 32px;
  text-align: center;
  font-weight: 800;
  color: #55506a;
}
.panel-ach-title {
  font-size: 15px;
  font-weight: 800;
  color: #ffe9f3;
}
.panel-ach-unknown {
  color: #55506a;
  letter-spacing: 0.3em;
}
.panel-ach-hint {
  font-size: 12px;
  color: #9a95ab;
  margin-top: 2px;
}
.panel-ach-caption {
  font-size: 12px;
  color: #ffd54a;
  margin-top: 3px;
}
/* 排行榜行 */
.panel-empty {
  text-align: center;
  color: #9a95ab;
  font-size: 13px;
  padding: 34px 0;
}
.panel-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: 6px;
  font-size: 14px;
  color: #f3eef8;
}
.panel-row:nth-child(odd) {
  background: rgba(255, 255, 255, 0.04);
}
.panel-rank {
  width: 26px;
  font-weight: 800;
  color: #ffd54a;
}
.panel-name {
  flex: 1;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-score {
  font-weight: 800;
  color: #7ad7ff;
}
.panel-date {
  font-size: 12px;
  color: #9a95ab;
}
.panel-fade-enter-active,
.panel-fade-leave-active {
  transition: opacity 0.2s ease;
}
.panel-fade-enter-from,
.panel-fade-leave-to {
  opacity: 0;
}
</style>
