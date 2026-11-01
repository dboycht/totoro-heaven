/**
 * 游戏引导单测（2026-11-01，1.3.5 第二批）
 *
 * 钉住四件事：
 *   ① 通关阈值 350 与分数换算口径（0.025 = Chromium 原版 `DistanceMeter.config.COEFFICIENT`）；
 *   ② 开场公告两行正文与用户原话逐字一致（2026-11-01 第二批改口，不许被随手改写）；
 *   ③ 五枚成就：阈值、名字逐字、id 唯一、隐藏成就触发常量（「郑永康」）；
 *   ④ 隐藏式成就的"全量可解"不变量：每枚都有 title 与 hint（解锁后面板能亮出内容）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACHIEVEMENT_CHEAT,
  ACHIEVEMENT_SECRET_ID,
  ACHIEVEMENTS,
  ACHIEVEMENT_WIN,
  GUIDE_MODAL,
  SCORE_COEFFICIENT,
  SECRET_ACHIEVEMENT_NAME,
  THRESHOLD_ACHIEVEMENTS,
  WIN_SCORE,
  isWinScore,
  scoreFromDistance,
} from '../../utils/game/achievements'

test('通关阈值：最高分 350（2026-11-01 第二批用户指定，原 300）', () => {
  assert.equal(WIN_SCORE, 350)
})

test('分数系数：与 Chromium 原版 DistanceMeter 的 COEFFICIENT 一致', () => {
  assert.equal(SCORE_COEFFICIENT, 0.025)
})

test('分数换算：与原版 getActualDistance 同口径（Math.round）', () => {
  assert.equal(scoreFromDistance(0), 0)
  assert.equal(scoreFromDistance(40), 1)
  assert.equal(scoreFromDistance(14000), 350)
  // 349.985 → round = 350：离 350 差不到一个逻辑像素也算 350（与原版一致）
  assert.equal(scoreFromDistance(13999.4), 350)
  // 349 分区间：13960 * 0.025 = 349
  assert.equal(scoreFromDistance(13960), 349)
})

test('通关判定：达到即过，未达到不算', () => {
  assert.equal(isWinScore(349), false)
  assert.equal(isWinScore(350), true)
  assert.equal(isWinScore(351), true)
})

test('开场公告第一行：与用户原话逐字一致', () => {
  assert.equal(GUIDE_MODAL.line1, '如果你认为本项目是一款小游戏的话，那么你可以在游玩后离开')
})

test('开场公告第二行：与用户原话逐字一致（拼合后）', () => {
  const full = GUIDE_MODAL.line2Before + GUIDE_MODAL.linkText + GUIDE_MODAL.line2After
  assert.equal(full, '如果你并不知道本项目是什么的话，欢迎前往GitHub讨论区了解更多详情')
  assert.equal(GUIDE_MODAL.title, '公告')
  assert.equal(GUIDE_MODAL.button, '我已知晓')
})

test('开场公告：链接指向本仓库的 GitHub 讨论区', () => {
  assert.equal(GUIDE_MODAL.discussionsUrl, 'https://github.com/dboycht/totoro-heaven/discussions')
  assert.ok(GUIDE_MODAL.discussionsUrl.startsWith('https://'), '必须是 https')
})

test('成就总数：五枚（第二批新增「黑暗中的响指」）', () => {
  assert.equal(ACHIEVEMENTS.length, 5)
})

test('成就 id 唯一（localStorage 键与图片文件名都靠它）', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('阈值成就：67 / 325 / 350 三枚，名字逐字', () => {
  assert.equal(THRESHOLD_ACHIEVEMENTS.length, 3)
  const byId = new Map(THRESHOLD_ACHIEVEMENTS.map((a) => [a.id, a]))
  assert.equal(byId.get('six-seven')?.threshold, 67)
  assert.equal(byId.get('six-seven')?.title, 'Six Seven！')
  assert.equal(byId.get('study-325')?.threshold, 325)
  assert.equal(byId.get('study-325')?.title, '已完成今日325大学习')
  assert.equal(byId.get('the-end-question')?.threshold, 350)
  assert.equal(byId.get('the-end-question')?.title, '结束了？')
})

test('通关成就引用：ACHIEVEMENT_WIN 就是「结束了？」', () => {
  assert.equal(ACHIEVEMENT_WIN.id, 'the-end-question')
  assert.equal(ACHIEVEMENT_WIN.title, '结束了？')
})

test('作弊码成就：「黑暗中的响指」，无分数阈值（由 unlock 事件触发）', () => {
  assert.equal(ACHIEVEMENT_CHEAT.id, 'snap-in-dark')
  assert.equal(ACHIEVEMENT_CHEAT.title, '黑暗中的响指')
  assert.equal(ACHIEVEMENT_CHEAT.threshold, undefined)
})

test('隐藏名成就：通关后输入「郑永康」（逐字）解锁「kskblzdjd」', () => {
  assert.equal(SECRET_ACHIEVEMENT_NAME, '郑永康')
  assert.equal(ACHIEVEMENT_SECRET_ID, 'kskblzdjd')
  const secret = ACHIEVEMENTS.find((a) => a.id === ACHIEVEMENT_SECRET_ID)
  assert.equal(secret?.title, 'kskblzdjd')
  assert.equal(secret?.threshold, undefined)
})

test('隐藏式成就不变量：每枚都有 title 与 hint（解锁后面板必须能亮出内容）', () => {
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.title.length > 0, `${a.id} 缺 title`)
    assert.ok(a.hint.length > 0, `${a.id} 缺 hint`)
  }
})

test('成就图标：路径必须是 /game/achievements/<id>.png（id 与文件名一致，换 logo 同名覆盖即可）', () => {
  // ⚠️ 文件**存在性**不在单测查：test:mp 在 .mp-test-build 沙箱跑、public/ 不随拷（E64 隔离机制），
  //    真实加载由 e2e verify_game_guide.mjs 的 naturalWidth 断言兜住。
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.icon, `${a.id} 缺 icon 字段`)
    assert.equal(a.icon, `/game/achievements/${a.id}.png`, `${a.id} 的 icon 必须按 id 命名：${a.icon}`)
  }
})
