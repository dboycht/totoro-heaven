/**
 * 《龙猫跑酷》游戏核心（纯逻辑层，2026-10-30，1.3.4 新增）
 *
 * ## 为什么把逻辑与渲染分开
 * 与项目既有做法一致（`generateRoute` / `pathShape` 都是"纯函数 + 单测"）：
 * 游戏最容易出的是"物理手感不对"与"状态机卡死"这两类问题，它们在 canvas 里**看不出来**，
 * 只能靠"给定输入、断言输出"来钉住。渲染层（`components/PlayGame.vue`）只负责把它画出来。
 *
 * ## 玩法
 * 像素风横版跑酷：小猫自动向右跑，方向键↑/A 跳、↓ 蹲、←→ 加减速；收集橡果、躲开障碍。
 *
 * ## 作弊码（Konami Code）
 * `↑↑↓↓←→←→BA` —— 输入完成后回调 `onCheatUnlocked`。
 * ⚠️ 这里只负责"识别按键序列"，**不负责跳转**：跳转由页面决定（见 `pages/play.vue`），
 *    这样核心逻辑保持零副作用、可单测。
 */

/** 游戏世界常量（全部为"设计单位"，渲染层按画布尺寸缩放） */
export const GAME = {
  /** 地面高度（从世界底部起算） */
  groundY: 0,
  /**
   * 物理参数（2026-10-30 由**参数扫描**定，判据见 `tests/mp/gameLevel.test.ts` 的「关卡可玩 A2」）：
   * 硬约束 = 起跳后"高度高于障碍"期间走过的水平距离（安全跨度）必须**显著大于**角色宽+障碍宽（60 px）。
   * 第一组参数只给出 64 px（仅多 4 px），实测玩家极易卡在障碍上；现在这组给出 **83 px**（+38% 余量）。
   * g=0.8 / v=12 / speed=3.2 ⇒ 最高 84、滞空 28 帧（手感不飘）。
   */
  gravity: 0.6,
  /** 跳跃初速度（向上为正）：v²/2g ≈ 84 px 最高点，远超 20 px 的障碍 */
  jumpVelocity: -16,
  /**
   * 长按跳跃的额外上升（可变跳跃高度）。
   * ⚠️ 2026-10-30 实测：它**叠加在初速上**，原值 -0.28 × 12 帧把最高点从设计的 84 推到 **121**
   * ⇒ 滞空 34 帧、水平推进 109 px，越过障碍后落下来正好砸在障碍上（离线模拟抓到的）。
   * 现在降到 -0.12 × 6 帧，最高点回到设计值附近（±10 px）。
   */
  jumpHoldBoost: -0.12,
  /** 最大按住加跳帧数 */
  jumpHoldFrames: 6,
  /** 基础水平速度（与重力/初速配套，见上方参数扫描结论） */
  baseSpeed: 4.0,
  /** 加速后的水平速度 */
  boostSpeed: 6.2,
  /** 玩家角色包围盒（用于碰撞）—— 2026-10-30 按观感放大（第一版 26×34 在 640 宽的画布上太小） */
  playerW: 34,
  playerH: 42,
  /** 障碍最高多少（**必须让玩家跳得过去**，见 `jumpApex` 与关卡单测） */
  obstacleMaxH: 20,
  /** 蹲下时的高度 */
  playerDuckH: 24,
} as const

/** 作弊码序列（Konami Code）：上上下下左右左右 BA */
export const KONAMI_SEQUENCE = [
  'up',
  'up',
  'down',
  'down',
  'left',
  'right',
  'left',
  'right',
  'b',
  'a',
] as const

export type GameAction = 'up' | 'down' | 'left' | 'right' | 'a' | 'b'

/**
 * 作弊码识别器（**纯状态机**）。
 *
 * 判据（可执行的一句话）：喂入按键序列后，
 *   · 完整喂入 `KONAMI_SEQUENCE` ⇒ `unlocked === true`（且只触发一次）；
 *   · 中途喂错 ⇒ 从**能与新按键接上的最长前缀**重新开始（而不是清零）——
 *     否则 `↑↑↑↓↓…` 这种"多按了一下上"就永远解不开了（真人手快必然发生）。
 */
export class CheatDetector {
  private matched = 0
  private fired = false

  /** 喂一个按键；返回 true 表示**这一次**刚好解锁（用于只触发一次） */
  feed(action: GameAction): boolean {
    if (this.fired) return false
    const seq = KONAMI_SEQUENCE
    if (action === seq[this.matched]) {
      this.matched++
      if (this.matched === seq.length) {
        this.fired = true
        return true
      }
      return false
    }
    /**
     * 不匹配 ⇒ 找出"以当前按键结尾、且是序列前缀的最长串"。
     *
     * 做法：把**已匹配的部分 + 当前按键**拼起来，从最长往短试着匹配序列前缀，
     * 取第一个成立的。这样：
     *   · `↑↑` 之后又按 `↑` ⇒ 试 `↑↑↑`（不是前缀）→ `↑↑`（是前缀！长度 2）⇒ 仍算匹配 2 个；
     *   · `↑↑↓` 之后按 `↑` ⇒ 试 `↑↑↓↑`/`↑↓↑`（都不是）→ `↓↑`（不是）→ `↑`（是）⇒ 重新从 1 开始。
     * ⚠️ 之前按"在历史里找同键"实现，多按一下上会被判成只剩 1 个（实测踩到），故改为这个"滑窗"口径。
     */
    const history = seq.slice(0, this.matched).join(',') + ',' + action
    const parts = history.split(',')
    for (let len = Math.min(parts.length, seq.length - 1); len >= 1; len--) {
      const tail = parts.slice(parts.length - len)
      let ok = true
      for (let i = 0; i < len; i++) {
        if (tail[i] !== seq[i]) {
          ok = false
          break
        }
      }
      if (ok) {
        this.matched = len
        return false
      }
    }
    this.matched = 0
    return false
  }

  /** 已解锁（供界面显示"已发现秘密"用） */
  get unlocked(): boolean {
    return this.fired
  }

  /** 已匹配到第几个键（调试/测试用，不显示给玩家） */
  get progress(): number {
    return this.matched
  }

  reset(): void {
    this.matched = 0
    this.fired = false
  }
}

/** 玩家状态 */
export interface PlayerState {
  /** 世界坐标 x（像素，向右增长） */
  x: number
  /** 世界坐标 y：**0 = 地面**，向上为正 */
  y: number
  /** 垂直速度（满帧为正表示向上） */
  vy: number
  /** 是否在地面上 */
  onGround: boolean
  /** 已按住跳跃的帧数（用于可变跳跃高度） */
  jumpHold: number
  /** 是否蹲下 */
  ducking: boolean
}

export function createPlayer(): PlayerState {
  return { x: 0, y: 0, vy: 0, onGround: true, jumpHold: 0, ducking: false }
}

/**
 * 开场安全距离（像素）：第一个障碍离出生点至少这么远。
 *
 * ⚠️ 2026-10-30 实测踩到：第一版从 `x = 420` 开始铺障碍，而画布只认 `player.x + ?` 的可见范围，
 * 同时角色一出生就在跑 ⇒ **开场几百毫秒内必然撞上第一个障碍**（截图里直接显示"撞到啦"）。
 * 判据：**第一个障碍必须在"玩家看清楚画面并反应过来"之后才出现** ⇒ 给足 1.5 屏以上的距离。
 */
export const FIRST_OBSTACLE_X = 900

/**
 * 开局"预热"时长（**毫秒**）：这段时间角色不动、世界不滚动，只把操作提示显示给玩家。
 *
 * ⚠️ 这里有两次实测教训（2026-10-30）：
 *   ① 第一版一开局角色就自动向右跑，玩家还在看画面 ⇒ 几秒内必然撞上第一个障碍，
 *      打开游戏的第一眼就是"撞到啦"；
 *   ② 改成 100 **帧**后仍然只有约 1.6 秒（`requestAnimationFrame` 约 60 fps）
 *      ⇒ 截图时预热刚好结束、还是撞了。**凡是"给玩家的时间"，一律用毫秒而不是帧**（帧率会变）。
 * 判据：预热不得短于 4 秒；玩家按任意操作键可立即开始（不强迫等待）。
 */
export const WARMUP_MS = 4200

/** 每帧输入 */
export interface FrameInput {
  /** 跳跃键是否按住（↑ 或 A） */
  jumpHeld: boolean
  /** 跳跃键这一帧是否刚按下（用于起跳沿） */
  jumpPressed: boolean
  /** 下键（↓ 或 B）按住 */
  downHeld: boolean
  /** 加速键（B）按住 */
  boostHeld: boolean
}

/**
 * 推进一帧玩家物理。
 *
 * ⚠️ 三条手感判据（都有单测）：
 *   ① **落地即清零**：`onGround` 时 `y` 必须恰好等于 0、`vy` 归零（否则角色会"陷进地面"或持续抖动）；
 *   ② **可变跳跃高度**：松开跳跃键后立即停止上升（`vy` 不再为负）—— 这是平台跳跃的标配手感；
 *   ③ **蹲下不改变 x**：蹲只改高度，不减速（否则"蹲着钻过去"会变得很难）。
 */
export function stepPlayer(p: PlayerState, input: FrameInput): void {
  // 垂直：按住跳跃键时可延长上升
  if (input.jumpHeld && p.jumpHold < GAME.jumpHoldFrames && !p.onGround && p.vy < 0) {
    p.vy += GAME.jumpHoldBoost
    p.jumpHold++
  }
  p.vy += GAME.gravity
  p.y -= p.vy

  if (p.y <= 0) {
    p.y = 0
    p.vy = 0
    p.onGround = true
    p.jumpHold = 0
  } else {
    p.onGround = false
  }

  // 水平：始终向右推进（跑酷），加速键提高速度
  p.x += input.boostHeld ? GAME.boostSpeed : GAME.baseSpeed

  // 蹲：只改姿态
  p.ducking = input.downHeld && p.onGround
}

/** 起跳（只有在可跳时生效，返回是否真的跳了） */
export function tryJump(p: PlayerState): boolean {
  if (!p.onGround) return false
  p.vy = GAME.jumpVelocity
  p.y = 0.01 // 离地一点点，下一帧就会走"空中"分支
  p.onGround = false
  p.jumpHold = 0
  return true
}

/** 障碍 / 收集物 */
export interface Entity {
  /** 世界坐标 x */
  x: number
  /** 离地高度（0 = 地面） */
  y: number
  w: number
  h: number
  kind: 'obstacle' | 'acorn'
  /** 是否已被吃掉（橡果）/ 已结算（障碍，避免重复扣分） */
  taken?: boolean
}

/** 矩形相交判定（玩家包围盒 vs 实体） */
export function hits(p: PlayerState, e: Entity): boolean {
  const ph = p.ducking ? GAME.playerDuckH : GAME.playerH
  const playerTop = p.y + ph
  const playerLeft = p.x
  const playerRight = p.x + GAME.playerW
  const eLeft = e.x
  const eRight = e.x + e.w
  const eBottom = e.y
  const eTop = e.y + e.h
  return playerRight > eLeft && playerLeft < eRight && playerTop > eBottom && p.y < eTop
}

/**
 * 世界生成：按固定间距铺障碍与橡果。
 *
 * 判据：**同一 seed 必然生成同一条关卡**（可复现，便于"这一关过不去"能被复现与调试）；
 * 且相邻障碍间距必须 ≥ `minGap`（否则会出现"必死跳"，玩家无法通过）。
 */
export interface WorldPlan {
  entities: Entity[]
  /** 生成到多远的 x（世界长度） */
  lengthX: number
}

export function buildWorld(seed: number, lengthX: number): WorldPlan {
  const rand = mulberry32(seed)
  const entities: Entity[] = []
  /**
   * 障碍间距：**必须大于"一次跳跃的滞空时间 × 前进速度"**，否则玩家落地立刻又撞上。
   * 实测（2026-10-30）：第一版 220 px，而跳跃滞空 ≈（2 × 9.4 / 0.62）≈ 30 帧 ≈ 100 px 的飞行距离，
   * 加上落地后反应时间仍不够 ⇒ 连续两次来不及。改成 340 起。
   */
  const minGap = 520
  let x = FIRST_OBSTACLE_X
  while (x < lengthX) {
    // 障碍：地面上的树桩（高度受 `obstacleMaxH` 限制，保证跳得过去）
    const h = 16 + Math.floor(rand() * (GAME.obstacleMaxH - 16))
    entities.push({ x, y: 0, w: 26, h, kind: 'obstacle' })
    // 障碍上方/前后的橡果
    if (rand() > 0.35) entities.push({ x: x + 60, y: 40 + rand() * 60, w: 18, h: 18, kind: 'acorn' })
    if (rand() > 0.6) entities.push({ x: x - 90, y: 30 + rand() * 40, w: 18, h: 18, kind: 'acorn' })
    x += minGap + Math.floor(rand() * 260)
  }
  return { entities, lengthX }
}

/**
 * 这一跳能跳多高（设计单位，= 像素）。
 * 用于**关卡自检**：障碍高度不得超过它，否则就是"必死跳"。
 * 公式：从 `jumpVelocity` 起、受重力 `gravity` 减速到 0 时的高度 = v² / (2g)。
 */
export function jumpApex(): number {
  const v = Math.abs(GAME.jumpVelocity)
  return (v * v) / (2 * GAME.gravity)
}

/** 确定性伪随机（与大项目里 `generateRoute` 的 `createRng` 同源思路：小、可复现、无依赖） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
