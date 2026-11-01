/**
 * 游戏引导：通关目标 + 成就系统 + 开场公告（2026-11-01，1.3.5 第二批）
 *
 * ## 为什么收口成一个纯模块
 *   - 分数换算、通关阈值、成就阈值有单测（`tests/mp/gameGuide.test.ts`）盯着，数字不许被随手改；
 *   - 弹窗与成就的**用户可见文案**只有这一份来源，页面组件只渲染不自带文案
 *     （与 `src/mp/releaseArt.ts` 收口版本文案是同一个思路）。
 *
 * ## 分数口径
 * 与 `public/trex/runner.js` 一致：`score = Math.round(distance * 0.025)`。
 * `0.025` 是 Chromium 原版 `DistanceMeter` 的 `COEFFICIENT`（只读对照，不许改 ——
 * 改了换算就和原版 HUD 显示对不上）。
 *
 * ## 交互口径（2026-11-01 用户指令，第二批）
 *   1. 开场公告改两行（游玩后可离开 / 不知道的话去 GitHub 讨论区）；每次进游戏页都弹；
 *   2. 成绩上限 300 → **350**，达到 350 即通关；
 *   3. 成就四枚：67 分「Six Seven！」、325 分「已完成今日325大学习」、350 通关「结束了？」、
 *      通关后输入名字「郑永康」→ 隐藏成就「kskblzdjd」；
 *   4. 成就显示栏 + 排行榜（本机 localStorage，不上传）。
 */

/** 通关分数（2026-11-01 用户指定：上限 350，达到即通关） */
export const WIN_SCORE = 350

/** Chromium 原版 `DistanceMeter.config.COEFFICIENT`（`public/trex/runner.js`，只读对照） */
export const SCORE_COEFFICIENT = 0.025

/** 逻辑距离 → 原版 HUD 分数（与 `runner.js` 的 `getActualDistance` 同口径） */
export function scoreFromDistance(distance: number): number {
  return Math.round(distance * SCORE_COEFFICIENT)
}

/** 是否达到通关分数（达到即过；判定放在同一帧 ⇒ HUD 分数定格，不会涨过头） */
export function isWinScore(score: number): boolean {
  return score >= WIN_SCORE
}

/** 开场公告弹窗的文案（2026-11-01 用户指定两行，逐字不得改动） */
export const GUIDE_MODAL = {
  title: '公告',
  /** 第一行：认为这是小游戏的人，玩完可以走 */
  line1: '如果你认为本项目是一款小游戏的话，那么你可以在游玩后离开',
  /** 第二行拆三段（linkText 渲染成可点击链接，指向讨论区） */
  line2Before: '如果你并不知道本项目是什么的话，欢迎前往',
  linkText: 'GitHub讨论区',
  line2After: '了解更多详情',
  /** 确认按钮 */
  button: '我已知晓',
  /** 讨论区地址（GitHub Discussions；仓库若未开启讨论区需先在仓库设置里开启） */
  discussionsUrl: 'https://github.com/dboycht/totoro-heaven/discussions',
} as const

/** toast 顶部小字（Minecraft 风格的黄字标题，全成就统一） */
export const ACHIEVEMENT_HEADER = '成就已达成！'

/** 成就条目（阈值类：分数达到即解锁；特殊类：threshold 缺省，如作弊码/通关后输入名字） */
export interface GameAchievement {
  /** 稳定 id（localStorage、图片文件名与 e2e 用） */
  id: string
  /** 成就名（用户指定文案的逐字钉死） */
  title: string
  /** 解锁后面板里显示的达成条件（隐藏式成就未解锁时什么都不显示） */
  hint: string
  /** 分数阈值（缺省 = 非分数触发） */
  threshold?: number
  /** toast 引导语（可选；显示在成就名下方） */
  caption?: string
  /**
   * 图标路径（`public/` 下相对路径；**1:1 正方形**，建议 128×128 PNG 透明底）。
   * 2026-11-01 用户自制 logo，做好后按成就 id 命名放入 `public/game/achievements/`，
   * 把路径填到这里；缺省时组件回退显示 🏆。
   */
  icon?: string
}

/**
 * 成就列表（2026-11-01 第二批：全部为**隐藏式成就**——未解锁时面板只显示灰色匿名块，
 * 不剧透名字与条件；解锁后亮出名字 + 条件 + 引导语）。显示顺序 = 数组顺序。
 */
export const ACHIEVEMENTS: GameAchievement[] = [
  {
    id: 'six-seven',
    title: 'Six Seven！',
    hint: '单局达到 67 分',
    threshold: 67,
    caption: '6——7——',
    icon: '/game/achievements/six-seven.png',
  },
  {
    id: 'study-325',
    title: '已完成今日325大学习',
    hint: '单局达到 325 分',
    threshold: 325,
    caption: '今天的 325 大学习已经完成。',
    icon: '/game/achievements/study-325.png',
  },
  {
    id: 'the-end-question',
    title: '结束了？',
    hint: '完成通关（350 分）',
    threshold: 350,
    caption: '真正的探索从这里开始：GitHub 讨论区见。',
    icon: '/game/achievements/the-end-question.png',
  },
  {
    id: 'snap-in-dark',
    title: '黑暗中的响指',
    hint: '输入过那段隐藏指令',
    caption: '另一扇门，开了。',
    icon: '/game/achievements/snap-in-dark.png',
  },
  {
    id: 'kskblzdjd',
    title: 'kskblzdjd',
    hint: '？？？',
    caption: '你把名字留对了。',
    icon: '/game/achievements/kskblzdjd.png',
  },
]

/** 有分数阈值的成就（`ChibiRunGame` 的逐帧里程碑检查用；隐藏成就不在其中）。
 *  ⚠️ 不要给它显式标 `GameAchievement[]` —— 显式注解会压掉谓词的类型收窄，
 *  元素上的 `threshold` 又变回"可能缺省"，用它的地方全要判空（实测 vue-tsc 报 TS18048）。 */
export const THRESHOLD_ACHIEVEMENTS = ACHIEVEMENTS.filter(
  (a): a is GameAchievement & { threshold: number } => typeof a.threshold === 'number',
)

/** 通关成就（350 触发的那枚，`play.vue` 的 win 回调用） */
export const ACHIEVEMENT_WIN: GameAchievement = ACHIEVEMENTS.find((a) => a.id === 'the-end-question')!

/** 作弊码成就（游戏页输入 `↑↑↓↓←→←→BA` 解锁真实功能的那一下同时解锁，2026-11-01 用户指定） */
export const ACHIEVEMENT_CHEAT: GameAchievement = ACHIEVEMENTS.find((a) => a.id === 'snap-in-dark')!

/** 通关后输入这个名字 ⇒ 解锁隐藏成就「kskblzdjd」（2026-11-01 用户指定，逐字） */
export const SECRET_ACHIEVEMENT_NAME = '郑永康'

/** 隐藏成就的 id（名字命中的判定在 `play.vue`，解锁状态在 `composables/useGameAchievements.ts`） */
export const ACHIEVEMENT_SECRET_ID = 'kskblzdjd'

/** localStorage 键（成就解锁集合 / 排行榜；只存本机浏览器，不入库不上传） */
export const ACHIEVEMENTS_STORAGE_KEY = 'totoro-game:achievements'
export const SCOREBOARD_STORAGE_KEY = 'totoro-game:scoreboard'

/** 排行榜条目（`composables/useGameScoreboard.ts` 的存储形状） */
export interface ScoreEntry {
  /** 玩家自己输入的名字（只存本机） */
  name: string
  /** 通关分数（= WIN_SCORE） */
  score: number
  /** 记录时间（ISO 字符串） */
  at: string
}
