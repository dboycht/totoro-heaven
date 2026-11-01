/**
 * 游戏引导：通关目标 + 成就 + 开场公告（2026-11-01，1.3.5）
 *
 * ## 为什么收口成一个纯模块
 *   - 分数换算与通关阈值有单测（`tests/mp/gameGuide.test.ts`）盯着，数字不许被随手改；
 *   - 弹窗与成就的**用户可见文案**只有这一份来源，页面组件只渲染不自带文案
 *     （与 `src/mp/releaseArt.ts` 收口版本文案是同一个思路）。
 *
 * ## 分数口径
 * 与 `public/trex/runner.js` 一致：`score = Math.round(distance * 0.025)`。
 * `0.025` 是 Chromium 原版 `DistanceMeter` 的 `COEFFICIENT`（只读对照，不许改 ——
 * 改了换算就和原版 HUD 显示对不上）。
 *
 * ## 交互口径（2026-11-01 用户指令）
 *   1. 打开游戏直接弹公告（每次进入游戏页都弹，点「我已知晓」关闭本次）；
 *   2. 游戏最高分 300 分，达到即通关：画面定格、显示「恭喜你已经通关」；
 *   3. 首次通关时左下角弹 Minecraft 风格成就「结束了？」，引导玩家去探索。
 */

/** 通关分数（2026-11-01 用户指定：最高 300 分） */
export const WIN_SCORE = 300

/** Chromium 原版 `DistanceMeter.config.COEFFICIENT`（`public/trex/runner.js`，只读对照） */
export const SCORE_COEFFICIENT = 0.025

/** 逻辑距离 → 原版 HUD 分数（与 `runner.js` 的 `getActualDistance` 同口径） */
export function scoreFromDistance(distance: number): number {
  return Math.round(distance * SCORE_COEFFICIENT)
}

/** 是否达到通关分数（达到即过；判定放在同一帧 ⇒ HUD 分数定格在 300，不会涨过头） */
export function isWinScore(score: number): boolean {
  return score >= WIN_SCORE
}

/** 开场公告弹窗的文案（正文是 2026-11-01 用户指定原话，逐字不得改动） */
export const GUIDE_MODAL = {
  title: '公告',
  /** 正文前段（与 linkText、bodyAfter 在页面上拼成一句，与用户原话逐字一致） */
  bodyBefore: '如果你知道本项目实际上是什么的话，请前往',
  /** 可点击链接的字样 */
  linkText: 'GitHub讨论区',
  /** 正文后段 */
  bodyAfter: '进行研究，这并不只是一款小游戏',
  /** 确认按钮 */
  button: '我已知晓',
  /** 讨论区地址（GitHub Discussions；仓库若未开启讨论区需先在仓库设置里开启） */
  discussionsUrl: 'https://github.com/dboycht/totoro-heaven/discussions',
} as const

/** 成就条目（首批 demo：一个成就，首次通关弹出） */
export interface GameAchievement {
  /** 稳定 id（可测试、可扩展） */
  id: string
  /** toast 顶部小字（Minecraft 风格的黄字标题） */
  header: string
  /** 成就名（2026-11-01 用户指定；Minecraft 同名成就的彩蛋式引用） */
  title: string
  /** 引导语（一句；指回讨论区，与开场公告呼应） */
  caption: string
}

/** 首次通关成就（左下角弹出） */
export const ACHIEVEMENT_WIN: GameAchievement = {
  id: 'the-end-question',
  header: '成就已达成！',
  title: '结束了？',
  caption: '真正的探索从这里开始：GitHub 讨论区见。',
}
