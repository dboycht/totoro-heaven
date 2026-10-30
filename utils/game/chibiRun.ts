/**
 * 《龙猫天堂》游戏核心（纯逻辑层）
 *
 * ## ⚠️ 2026-10-30 重写：物理参数**照抄 Chrome 小恐龙（T-Rex Runner）**
 *
 * 用户原话：「相关的速度你直接搜寻 Chrome 小恐龙那个对着搓吧」。
 * 上一版是我自己调的参数，实测**跳跃/下落极快、障碍躲不开**，用户评价"一无是处"——
 * 所以这一版**不再自创**，逐个参数对齐官方实现。
 *
 * 来源：Chromium `components/neterror/resources/t-rex-runner/runner.js`
 * （经 npm 包 `t-rex-runner@1.0.6` 的 `src/runner.js` 取得，与 Chromium 原版同源）。
 * 许可：Chromium / BSD-style（仅移植**数值与公式**，不复制其代码）。
 *
 * | 参数 | 原版值 | 说明 |
 * | --- | --- | --- |
 * | `GRAVITY` | 0.6 | 每帧加到垂直速度上 |
 * | `INIITAL_JUMP_VELOCITY` | -10 | 起跳垂直速度（负 = 向上） |
 * | `DROP_VELOCITY` | -5 | 松开跳跃键后的下落速度上限（**"下落不会太快"的关键**） |
 * | `MIN_JUMP_HEIGHT` | 30 | 低于此高度不许加速下落 |
 * | `SPEED` | 6 | 起始水平速度 |
 * | `MAX_SPEED` | 13 | 最高水平速度 |
 * | `ACCELERATION` | 0.001 | 每帧加速 |
 * | `DEFAULT_WIDTH` | 600 | 画布宽（逻辑像素） |
 * | `FPS` | 60 | 帧率 |
 * | 恐龙尺寸 | 44×47（蹲 25） | |
 * | 起跑 x | 50 | |
 *
 * 原版**只响应"跳"**；本需求要方向键 + A/B 输入作弊码，所以保留「蹲」与「加速」，
 * **不按键时的手感与原版完全一致**。
 */

/** 世界常量：**全部对齐 Chrome 小恐龙** */
export const GAME = {
  /** 逻辑画布尺寸（原版 600×150；高度略微加大用于 HUD） */
  width: 600,
  height: 170,
  /** 地面线在画布上的 y（原版恐龙站在地面线上） */
  groundY: 150,

  /** 重力（原版 `GRAVITY`） */
  gravity: 0.6,
  /** 起跳垂直速度（原版 `INIITAL_JUMP_VELOCITY`，负 = 向上） */
  initialJumpVelocity: -10,
  /** 松开跳跃键后的下落速度上限（原版 `DROP_VELOCITY`）——**下落快慢由它决定** */
  dropVelocity: -5,
  /** 低于这个高度不许加速下落（原版 `MIN_JUMP_HEIGHT`） */
  minJumpHeight: 30,
  /** 主动加速下落系数（原版 `SPEED_DROP_COEFFICIENT`，按下 ↓ 时用） */
  speedDropCoefficient: 3,

  /** 起始水平速度（原版 `SPEED`） */
  speed: 6,
  /** 最高水平速度（原版 `MAX_SPEED`） */
  maxSpeed: 13,
  /**
   * 每帧加速度。原版是 `ACCELERATION: 0.001`（越跑越快），
   * 这里放缓到 0.0004 —— 本作是"打开就能玩两下"的小游戏，没必要那么早变难。
   */
  acceleration: 0.0004,
  /** 目标帧率（原版 `FPS`） */
  fps: 60,

  /** 角色尺寸（原版 Trex：44×47，蹲下 25） */
  playerW: 44,
  playerH: 47,
  playerDuckH: 25,
  /** 起跑横坐标（原版 `START_X_POS`） */
  startX: 50,

  /** 障碍高度范围（对齐原版仙人掌的量级 25~50） */
  obstacleMinH: 25,
  obstacleMaxH: 40,
  /** 障碍宽度 */
  obstacleW: 17,
} as const

/** 作弊码序列（Konami Code）：上上下下左右左右 BA */
export const KONAMI_SEQUENCE = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right', 'b', 'a'] as const

export type GameAction = 'up' | 'down' | 'left' | 'right' | 'a' | 'b'

/**
 * 作弊码识别器（纯状态机）。
 *
 * 判据：完整喂入 `KONAMI_SEQUENCE` ⇒ `unlocked === true` 且只触发一次；
 *       中途按键不匹配 ⇒ 回退到"以它结尾的最长前缀"（真人手快会多按，不能清零）。
 */
export class CheatDetector {
  private matched = 0
  private fired = false

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
    // 不匹配：从"已匹配部分 + 当前键"的尾部找最长的、等于序列前缀的片段
    const history: GameAction[] = [...seq.slice(0, this.matched), action]
    for (let len = Math.min(history.length, seq.length - 1); len >= 1; len--) {
      const tail = history.slice(history.length - len)
      if (tail.every((k, i) => k === seq[i])) {
        this.matched = len
        return false
      }
    }
    this.matched = 0
    return false
  }

  get unlocked(): boolean {
    return this.fired
  }

  get progress(): number {
    return this.matched
  }

  reset(): void {
    this.matched = 0
    this.fired = false
  }
}

/** 玩家状态（坐标：x 向右、y 向上，0 = 地面） */
export interface PlayerState {
  x: number
  y: number
  /** 垂直速度（负 = 向上，与原版同号） */
  jumpVelocity: number
  jumping: boolean
  /** 是否已到达最小跳跃高度（原版 `reachedMinHeight`） */
  reachedMinHeight: boolean
  /** 是否处于"主动加速下落"（原版 `speedDrop`） */
  speedDrop: boolean
  ducking: boolean
  /** 当前水平速度（随时间增加） */
  currentSpeed: number
  distanceRan: number
}

export function createPlayer(): PlayerState {
  return {
    x: GAME.startX,
    y: 0,
    jumpVelocity: 0,
    jumping: false,
    reachedMinHeight: false,
    speedDrop: false,
    ducking: false,
    currentSpeed: GAME.speed,
    distanceRan: 0,
  }
}

/** 每帧输入 */
export interface FrameInput {
  /** 跳跃键这一帧刚按下 */
  jumpPressed: boolean
  /** 跳跃键是否按住（松开会触发"下落加速"） */
  jumpHeld: boolean
  /** 蹲下键按住（原版没有，本版为作弊码保留） */
  downHeld: boolean
  /** 加速键按住（原版没有，本版为作弊码保留） */
  boostHeld: boolean
}

/**
 * 起跳（原版 `startJump`）：起跳速度按**当前速度**微调 —— `INIITAL_JUMP_VELOCITY - (speed / 10)`。
 * 这条很关键：跑得越快跳得越低，保证高速时也能刚好跨过障碍。
 */
export function startJump(p: PlayerState): boolean {
  if (p.jumping) return false
  p.jumpVelocity = GAME.initialJumpVelocity - p.currentSpeed / 10
  p.jumping = true
  p.reachedMinHeight = false
  p.speedDrop = false
  return true
}

/** 松开跳跃键（原版 `endJump`）：达到最小高度后，把下落速度限制在 `DROP_VELOCITY` */
export function endJump(p: PlayerState): void {
  if (p.reachedMinHeight && p.jumpVelocity < GAME.dropVelocity) {
    p.jumpVelocity = GAME.dropVelocity
  }
}

/**
 * 推进一帧（**逐行对齐原版 `updateJump`**）：
 * ```
 * y += jumpVelocity * SPEED_DROP_COEFFICIENT    （主动加速下落时）
 * 否则 y += jumpVelocity
 * jumpVelocity += GRAVITY
 * if (y > MIN_JUMP_HEIGHT) reachedMinHeight = true
 * if (y < 0) { jumping = false; speedDrop = false; y = 0; jumpVelocity = 0 }
 * ```
 */
export function stepPlayer(p: PlayerState, input: FrameInput): void {
  // 起跳沿（原版在按键回调里触发；这里在帧内判定）
  if (input.jumpPressed && !p.jumping) startJump(p)

  // 松开跳跃键 ⇒ 触发减速下落（原版在 keyup 里调 endJump）
  if (!input.jumpHeld && p.jumping) endJump(p)

  // 主动加速下落（原版：按下 ↓ 且已在最小高度之上）
  if (input.downHeld && p.reachedMinHeight && !p.speedDrop) p.speedDrop = true

  // 垂直推进（顺序与原版一致）
  // ⚠️ y 是"离地高度（向上为正）"，而 jumpVelocity 负值表示向上 ⇒ 用减法
  p.y -= p.speedDrop ? p.jumpVelocity * GAME.speedDropCoefficient : p.jumpVelocity
  p.jumpVelocity += GAME.gravity
  /**
   * ⚠️ **每帧都要夹下落速度**（2026-10-30 实测：只在"松开那一帧"夹是错的）。
   * 原版 `endJump` 确实只在 keyup 调一次，但之后 `updateJump` 里重力持续累加 ——
   * 只夹一次的话，松手后速度会从 -5 一路涨回 -11，落地前又变成"砸下来"（用户反馈的"下落极快"）。
   * 这里改成：**只要松了键且已过最小高度，每帧都把下落速度限制在 `dropVelocity`**。
   * 效果：下落恒定在 5 px/帧，落地柔和、可预测（这正是原版手感的关键）。
   */
  if (!input.jumpHeld && p.reachedMinHeight && !p.speedDrop && p.jumpVelocity > GAME.dropVelocity) {
    p.jumpVelocity = GAME.dropVelocity
  }
  if (p.y > GAME.minJumpHeight) p.reachedMinHeight = true
  if (p.y < 0) {
    p.jumping = false
    p.speedDrop = false
    p.y = 0
    p.jumpVelocity = 0
  }

  // 蹲下：只改姿态
  p.ducking = input.downHeld && p.y === 0

  // 水平：随时间加速（原版 `if (currentSpeed < MAX_SPEED) currentSpeed += ACCELERATION`）
  if (p.currentSpeed < GAME.maxSpeed) p.currentSpeed = Math.min(GAME.maxSpeed, p.currentSpeed + GAME.acceleration)
  const speed = input.boostHeld && !p.jumping ? Math.min(GAME.maxSpeed, p.currentSpeed * 1.4) : p.currentSpeed
  p.x += speed
  p.distanceRan += speed
}

/** 实体（障碍 / 橡果） */
export interface Entity {
  x: number
  /** 离地高度（0 = 地面） */
  y: number
  w: number
  h: number
  kind: 'obstacle' | 'acorn'
  taken?: boolean
}

/**
 * 碰撞判定（**对齐原版 `checkForCollision` 的思路**）：
 * 用**收缩后的碰撞盒**（原版每个精灵都有 `collisionBoxes`，比绘制尺寸小几个像素），
 * 避免"看着没碰到却判死"——这是这类游戏最常见的挫败来源。
 */
export function hits(p: PlayerState, e: Entity): boolean {
  const ph = p.ducking ? GAME.playerDuckH : GAME.playerH
  /**
   * 收缩量：**按盒子尺寸取 10%，但不超过 3px，且收缩后至少留 2px**。
   * 为什么不是固定 4px（原版每个精灵是各自的 collisionBoxes）：
   * 障碍只有 17~20 宽时固定收 4px 会把盒子缩到 9px，"看着撞上了却不判死"。
   */
  const shrink = (size: number) => Math.min(3, Math.max(0, Math.min(3, size * 0.1)))
  const pPadX = shrink(GAME.playerW)
  const pPadY = shrink(ph)
  const el2 = shrink(e.w)
  const ePadY = shrink(e.h)
  const pl = p.x + pPadX
  const pr = p.x + GAME.playerW - pPadX
  const pb = p.y + pPadY
  const pt = p.y + ph - pPadY
  const el = e.x + el2
  const er = e.x + e.w - el2
  const eb = e.y + ePadY
  const et = e.y + e.h - ePadY
  return pr > el && pl < er && pt > eb && pb < et
}

/** 世界计划 */
export interface WorldPlan {
  entities: Entity[]
  lengthX: number
}

/**
 * 关卡生成（**对齐原版 `Obstacle` 的间隔规则**）。
 *
 * 原版：`CLEAR_TIME` 3000ms 内不生成障碍（起跑后约 1.5 屏）；之后间隔
 * `maxGap = width * MAX_GAP_COEFFICIENT`（600 × 1.5 = 900）。
 * 这里按等价口径：第一个障碍在 x≈1100，之后每 420~700 px 一个。
 */
export function buildWorld(seed: number, lengthX: number): WorldPlan {
  const rand = mulberry32(seed)
  const entities: Entity[] = []
  let x = 1100
  while (x < lengthX) {
    const h = GAME.obstacleMinH + Math.floor(rand() * (GAME.obstacleMaxH - GAME.obstacleMinH + 1))
    entities.push({ x, y: 0, w: GAME.obstacleW, h, kind: 'obstacle' })
    if (rand() > 0.4) {
      entities.push({ x: x + 40, y: h + 30 + rand() * 40, w: 16, h: 16, kind: 'acorn' })
    }
    x += 420 + Math.floor(rand() * 280)
  }
  return { entities, lengthX }
}

/** 确定性伪随机（同 seed 同关卡） */
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

/** 跳跃最高点（供测试/调参参考）：v²/(2g) */
export function jumpApex(): number {
  const v = Math.abs(GAME.initialJumpVelocity)
  return (v * v) / (2 * GAME.gravity)
}
