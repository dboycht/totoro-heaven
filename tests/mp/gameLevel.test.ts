/**
 * 《龙猫天堂》游戏关卡可玩性单测（2026-10-30，1.3.4）
 *
 * ## 为什么必须有这一份
 * 实测教训：第一版关卡**跳不过去**（障碍太高、间距太近），而画面上完全看不出来"设计错了"——
 * 只表现为"玩家一直撞死"。手感问题必须转成机械判据，否则每次改参数都要靠人试。
 *
 * 本文件钉住的四条（改动任何物理/关卡参数都会经过这里）：
 *   ① **跳得够高**：障碍最大高度 < 跳跃最高点（留出余量）；
 *   ② **来得及反应**：相邻障碍间距 > 一次跳跃的飞行距离；
 *   ③ **关卡确定**：同 seed 生成同一条关卡（可复现）；
 *   ④ **预热足够**：给玩家的静止期是"毫秒"口径且不少于 4 秒（帧率会变，帧数不可靠）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIRST_OBSTACLE_X,
  GAME,
  WARMUP_MS,
  buildWorld,
  createPlayer,
  hits,
  jumpApex,
  stepPlayer,
  tryJump,
} from '../../utils/game/chibiRun.ts'

test('关卡可玩 A：**跳得比障碍高**（否则是必死跳）', () => {
  const apex = jumpApex()
  assert.ok(
    GAME.obstacleMaxH < apex * 0.85,
    `障碍最高 ${GAME.obstacleMaxH} 必须显著低于跳跃最高点 ${apex.toFixed(1)}（留 15% 余量）`,
  )
})

test('关卡可玩 A2：**滞空期间能跨过障碍**（真正的判据，2026-10-30 靠它才修好）', () => {
  /**
   * 这是最容易漏、也最致命的一条：跳得再高，如果"高于障碍的那段时间里水平走得不够远"，
   * 角色就会**卡在障碍上**（实测：滞空期只走 78 px，而需要 角色宽34 + 障碍宽26 = 60 px + 起跳提前量）。
   * 判据：`安全跨度 = (高度>障碍的帧数) × 水平速度` 必须 > `角色宽 + 障碍宽` 并留余量。
   */
  const p = createPlayer()
  tryJump(p)
  let safeFrames = 0
  for (let f = 0; f < 400; f++) {
    stepPlayer(p, { jumpHeld: false, jumpPressed: false, downHeld: false, boostHeld: false })
    if (p.onGround) break
    if (p.y > GAME.obstacleMaxH) safeFrames++
  }
  const span = safeFrames * GAME.baseSpeed
  const need = GAME.playerW + 26 // 角色宽 + 障碍宽（26 = buildWorld 里的障碍宽）
  assert.ok(
    span > need * 1.15,
    `安全跨度 ${span.toFixed(0)}px 必须显著大于"角色宽+障碍宽" ${need}px（实测踩过：只够 78px 时会卡在障碍上）`,
  )
})

test('关卡可玩 B：相邻障碍间距 > 一次跳跃的飞行距离（落地后还来得及跳下一次）', () => {
  const world = buildWorld(20261030, 20000)
  const obstacles = world.entities.filter((e) => e.kind === 'obstacle')
  assert.ok(obstacles.length > 5, '这个 seed 应该生成若干个障碍')
  // 一次跳跃的滞空帧数 ≈ 2v/g
  const airFrames = (2 * Math.abs(GAME.jumpVelocity)) / GAME.gravity
  const flightDistance = airFrames * GAME.baseSpeed
  let minGap = Infinity
  for (let i = 1; i < obstacles.length; i++) {
    const gap = obstacles[i]!.x - obstacles[i - 1]!.x
    minGap = Math.min(minGap, gap)
  }
  assert.ok(
    minGap > flightDistance,
    `最小间距 ${minGap.toFixed(0)} 必须大于一次跳跃飞行距离 ${flightDistance.toFixed(0)}`,
  )
})

test('关卡可玩 C：第一个障碍离出生点足够远（给玩家看清画面的时间）', () => {
  assert.ok(FIRST_OBSTACLE_X >= 800, `第一个障碍应在 ${FIRST_OBSTACLE_X}，不应贴脸`)
  const world = buildWorld(1, 5000)
  const first = world.entities.filter((e) => e.kind === 'obstacle')[0]!
  assert.equal(first.x, FIRST_OBSTACLE_X)
})

test('关卡可玩 D：同一 seed 生成同一条关卡（可复现）', () => {
  const a = buildWorld(12345, 8000)
  const b = buildWorld(12345, 8000)
  assert.deepEqual(a.entities, b.entities, '同 seed 必须完全一致')
  const c = buildWorld(999, 8000)
  assert.notDeepEqual(a.entities, c.entities, '不同 seed 应不同（否则关卡没有变化）')
})

test('预热 E：给玩家的静止期用毫秒口径且不短于 4 秒', () => {
  assert.ok(WARMUP_MS >= 4000, `预热 ${WARMUP_MS} ms 太短（帧数口径在 60fps 下会缩水）`)
})

test('物理 F：跳跃一次能真正离地，且最终会落回地面（不会卡在空中）', () => {
  const p = createPlayer()
  assert.equal(tryJump(p), true, '在地面上应能起跳')
  let maxY = 0
  let landed = false
  for (let i = 0; i < 400; i++) {
    stepPlayer(p, { jumpHeld: false, jumpPressed: false, downHeld: false, boostHeld: false })
    maxY = Math.max(maxY, p.y)
    if (p.onGround && i > 5) {
      landed = true
      break
    }
  }
  assert.ok(maxY > GAME.obstacleMaxH, `跳跃最高点 ${maxY.toFixed(1)} 必须高于障碍 ${GAME.obstacleMaxH}`)
  assert.equal(landed, true, '必须落回地面（否则角色会飞出去再也不下来）')
  assert.equal(p.y, 0, '落地后 y 必须恰好为 0（不能陷进地面）')
})

test('物理 G：蹲下能降低高度、从而钻过矮处的判定（碰撞盒确实变矮）', () => {
  /** 一个悬空的横杆：站着会撞、蹲下不撞 */
  const bar = { x: 10, y: 26, w: 40, h: 12, kind: 'obstacle' as const }
  const stand = createPlayer()
  stand.x = 20
  assert.equal(hits(stand, bar), true, '站着应撞到横杆')
  const duck = createPlayer()
  duck.x = 20
  duck.ducking = true
  assert.equal(hits(duck, bar), false, '蹲下应能钻过横杆（碰撞盒变矮）')
})
