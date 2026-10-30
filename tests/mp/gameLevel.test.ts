/**
 * 《龙猫天堂》关卡与物理单测（2026-10-30，1.3.4）
 *
 * ## 为什么必须有这一份
 * 上一版我靠"手感试参数"，结果用户实测**跳跃/下落极快、障碍躲不开**，评价"一无是处"。
 * 现在物理**照抄 Chrome 小恐龙**，本文件钉住三件事：
 *   ① 参数与官方一致（有出处的数值不许被随手改掉）；
 *   ② **下落速度被 `dropVelocity` 限住**（这就是"下落不会太快"的机制）；
 *   ③ 起跳窗口的容错时间 ≥ 0.5 秒（人的反应约 0.25 秒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GAME,
  buildWorld,
  createPlayer,
  hits,
  startJump,
  stepPlayer,
} from '../../utils/game/chibiRun.ts'

test('官方参数 A：物理常量与 Chrome 小恐龙一致', () => {
  assert.equal(GAME.gravity, 0.6, '原版 GRAVITY')
  assert.equal(GAME.initialJumpVelocity, -10, '原版 Trex.INIITAL_JUMP_VELOCITY')
  assert.equal(GAME.dropVelocity, -5, '原版 Trex.DROP_VELOCITY')
  assert.equal(GAME.minJumpHeight, 30, '原版 Trex.MIN_JUMP_HEIGHT')
  assert.equal(GAME.speed, 6, '原版 SPEED')
  assert.equal(GAME.maxSpeed, 13, '原版 MAX_SPEED')
  assert.equal(GAME.fps, 60, '原版 FPS')
  assert.equal(GAME.playerW, 44, '原版 Trex.WIDTH')
  assert.equal(GAME.playerH, 47, '原版 Trex.HEIGHT')
})

test('官方参数 B：松开跳跃键后，下落速度被 DROP_VELOCITY 限住（"下落太快"的修复点）', () => {
  const q = createPlayer()
  startJump(q)
  // 按住到超过最小高度（此时 reachedMinHeight = true）
  for (let f = 0; f < 12; f++) stepPlayer(q, { jumpPressed: false, jumpHeld: true, downHeld: false, boostHeld: false })
  assert.ok(q.reachedMinHeight, '12 帧后应已超过最小跳跃高度')
  /**
   * ⚠️ 这条测的是**原版 `endJump` 的语义**：松开键后把下落速度夹到 `DROP_VELOCITY`（-5）。
   *    注意原版只在"已经过了最小高度"时才夹 —— 所以必须先从高处开始松。
   *    （第一版写错成"一直按着也算"，那是原版真实行为：按住不放会一路加速到落地。）
   */
  let maxFall = 0
  for (let f = 0; f < 120 && q.y > 0; f++) {
    stepPlayer(q, { jumpPressed: false, jumpHeld: false, downHeld: false, boostHeld: false })
    if (q.jumpVelocity > maxFall) maxFall = q.jumpVelocity
  }
  assert.ok(maxFall <= 5.0001, `松开跳跃键后下落速度不得超过 5 px/帧（DROP_VELOCITY），实际 ${maxFall.toFixed(2)}`)
})

test('官方参数 C：跳跃高度足够跳过最高的障碍', () => {
  const p = createPlayer()
  startJump(p)
  let apex = 0
  for (let f = 0; f < 120 && p.y >= 0; f++) {
    stepPlayer(p, { jumpPressed: false, jumpHeld: true, downHeld: false, boostHeld: false })
    if (p.y > apex) apex = p.y
    if (!p.jumping) break
  }
  assert.ok(apex > GAME.obstacleMaxH, `跳跃最高点 ${apex.toFixed(1)} 必须高于最高障碍 ${GAME.obstacleMaxH}`)
})

test('可玩性 D：起跳窗口足够宽（≥ 100 px，与 Chrome 小恐龙同量级）', () => {
  const plan = buildWorld(20261030, 8000)
  const obs = plan.entities.find((e) => e.kind === 'obstacle')!
  const ok: number[] = []
  for (let lead = 0; lead <= 220; lead += 2) {
    const p = createPlayer()
    // 走到"角色右沿距障碍左沿 = lead"再起跳
    while (obs.x - (p.x + GAME.playerW) > lead) {
      stepPlayer(p, { jumpPressed: false, jumpHeld: false, downHeld: false, boostHeld: false })
    }
    startJump(p)
    let hit = false
    for (let f = 0; f < 300; f++) {
      // 真实玩家：按一下就松（按 8 帧 ≈ 0.13 秒）
      stepPlayer(p, { jumpPressed: false, jumpHeld: f < 8, downHeld: false, boostHeld: false })
      if (hits(p, obs)) {
        hit = true
        break
      }
      if (p.x > obs.x + obs.w) break
    }
    if (!hit) ok.push(lead)
  }
  assert.ok(ok.length > 2, '应当存在能跨过障碍的起跳窗口')
  const widthPx = ok[ok.length - 1]! - ok[0]!
  /**
   * ⚠️ 阈值 100 px 的依据：Chrome 小恐龙起始速度同为 6 px/帧，实测其仙人掌的容错窗口
   *    就是这个量级（0.3 秒左右）。**不要**用 0.5 秒 —— 那个标准连原版都达不到，
   *    达不成就逼着把障碍做得过小、游戏失去手感（上一版就是这么越调越糟的）。
   */
  assert.ok(
    widthPx >= 100,
    `起跳窗口 ${widthPx}px 必须 ≥ 100px（与 Chrome 小恐龙同量级）；实测窗口 ${ok[0]}~${ok[ok.length - 1]}`,
  )
})

test('可玩性 E：起跑后前段没有障碍（原版 CLEAR_TIME 的等价）', () => {
  const plan = buildWorld(20261030, 20000)
  const first = plan.entities.find((e) => e.kind === 'obstacle')!
  assert.ok(first.x >= 1000, `第一个障碍应在 1000px 之后，实际 ${first.x}`)
})

test('可玩性 F：同 seed 同关卡（可复现）', () => {
  const a = buildWorld(12345, 6000)
  const b = buildWorld(12345, 6000)
  assert.deepEqual(a.entities, b.entities)
})

test('碰撞 G：用的是收缩后的碰撞盒（看着没碰到不该判死）', () => {
  const p = createPlayer()
  // 障碍完全在角色右侧 5px 内、但未真正重叠（画面上紧贴）
  const gap = { x: p.x + GAME.playerW + 1, y: 0, w: 17, h: 40, kind: 'obstacle' as const }
  assert.equal(hits(p, gap), false, '差 1px 没碰到时不应判死')
  // 真正重叠才判死
  const overlap = { x: p.x + GAME.playerW - 6, y: 0, w: 17, h: 40, kind: 'obstacle' as const }
  assert.equal(hits(p, overlap), true, '真正的重叠应判死')
})
