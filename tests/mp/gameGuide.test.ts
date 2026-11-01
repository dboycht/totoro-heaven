/**
 * 游戏引导单测（2026-11-01，1.3.5）
 *
 * 钉住三件事：
 *   ① 通关阈值 300 与分数换算口径（0.025 = Chromium 原版 `DistanceMeter.config.COEFFICIENT`）；
 *   ② 开场公告正文与用户原话逐字一致（这是 2026-11-01 用户指定的引导文案，不许被随手改写）；
 *   ③ 成就「结束了？」的文案与讨论区链接指向正确。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACHIEVEMENT_WIN,
  GUIDE_MODAL,
  SCORE_COEFFICIENT,
  WIN_SCORE,
  isWinScore,
  scoreFromDistance,
} from '../../utils/game/achievements'

test('通关阈值：最高分 300（2026-11-01 用户指定）', () => {
  assert.equal(WIN_SCORE, 300)
})

test('分数系数：与 Chromium 原版 DistanceMeter 的 COEFFICIENT 一致', () => {
  assert.equal(SCORE_COEFFICIENT, 0.025)
})

test('分数换算：与原版 getActualDistance 同口径（Math.round）', () => {
  assert.equal(scoreFromDistance(0), 0)
  assert.equal(scoreFromDistance(40), 1)
  assert.equal(scoreFromDistance(12000), 300)
  // 299.985 → round = 300：离 300 差不到一个逻辑像素也算 300（与原版一致）
  assert.equal(scoreFromDistance(11999.4), 300)
  // 299 分区间：11960 * 0.025 = 299
  assert.equal(scoreFromDistance(11960), 299)
})

test('通关判定：达到即过，未达到不算', () => {
  assert.equal(isWinScore(299), false)
  assert.equal(isWinScore(300), true)
  assert.equal(isWinScore(301), true)
})

test('开场公告：正文与用户原话逐字一致（拼合后）', () => {
  const full = GUIDE_MODAL.bodyBefore + GUIDE_MODAL.linkText + GUIDE_MODAL.bodyAfter
  assert.equal(full, '如果你知道本项目实际上是什么的话，请前往GitHub讨论区进行研究，这并不只是一款小游戏')
  assert.equal(GUIDE_MODAL.title, '公告')
  assert.equal(GUIDE_MODAL.button, '我已知晓')
})

test('开场公告：链接指向本仓库的 GitHub 讨论区', () => {
  assert.equal(GUIDE_MODAL.discussionsUrl, 'https://github.com/dboycht/totoro-heaven/discussions')
  assert.ok(GUIDE_MODAL.discussionsUrl.startsWith('https://'), '必须是 https')
})

test('成就：首通成就名为「结束了？」，引导语指回讨论区', () => {
  assert.equal(ACHIEVEMENT_WIN.id, 'the-end-question')
  assert.equal(ACHIEVEMENT_WIN.title, '结束了？')
  assert.equal(ACHIEVEMENT_WIN.header, '成就已达成！')
  assert.ok(ACHIEVEMENT_WIN.caption.includes('GitHub'), '引导语必须提到 GitHub 讨论区')
})
