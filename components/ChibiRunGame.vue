/**
 * 《龙猫天堂》—— 像素跑酷游戏（2026-10-30，1.3.4 新增）
 *
 * ## 主题
 * 「天堂」：云海之上、浮岛与霞光，龙猫踩着云朵向右奔跑，收集橡果、跳过树桩。
 * 全部图形**用 canvas 画**（不引图片/字体/引擎）—— 打包成单文件 EXE 后离线也不会缺资源
 * （与「鸣谢」页彩带同一取舍）。
 *
 * ## 两个按键 + 方向键
 *   ↑ / A = 跳；↓ / B = 蹲；→ = 加速（也可按 B）；← = 减速
 *   ⚠️ A 与 B **既参与操作、又参与作弊码**（`↑↑↓↓←→←→BA`）—— 这是需求本身的要求。
 *
 * ## 迷你优先
 * 单文件、无依赖、无外部资源；逻辑在 `utils/game/chibiRun.ts`（纯函数 + 单测），
 * 本组件只管"画出来 + 收键盘"。
 */
<script setup lang="ts">
import {
  CheatDetector,
  GAME,
  buildWorld,
  createPlayer,
  hits,
  mulberry32,
  stepPlayer,
  tryJump,
  type Entity,
  type GameAction,
  WARMUP_MS,
  type PlayerState,
} from '~/utils/game/chibiRun'

const emit = defineEmits<{
  /** 作弊码输入完成（页面负责跳转到真正的软件） */
  (e: 'unlock'): void
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const score = ref(0)
const bestScore = ref(0)
const running = ref(true)
const message = ref('')

/** 固定画布尺寸（迷你：不跟随窗口变化，避免复杂度） */
const W = 640
const H = 300

let raf = 0
let player: PlayerState = createPlayer()
let entities: Entity[] = []
let cameraX = 0
let frames = 0
let seed = 20261030
/** 是否已开始跑（开局预热期间为 false；按任意操作键或等满预热即 true） */
let started = false
/** 预热结束的时间戳（performance.now() 口径）；到点前角色不动 */
let warmupUntil = 0
const cheat = new CheatDetector()

/** 有没有按着任何操作键（用于提前结束开局预热） */
function anyHeld(): boolean {
  return held.up || held.down || held.left || held.right || held.a || held.b
}

/** 按键状态（按住类操作靠它） */
const held = { up: false, down: false, left: false, right: false, a: false, b: false }
/** 本帧刚按下的键（起跳沿用） */
let pressedJump = false

const rand = mulberry32(seed)

/** 云朵背景（预生成，滚动复用） */
const clouds = Array.from({ length: 14 }, () => ({
  x: rand() * W * 2,
  y: 20 + rand() * 120,
  r: 14 + rand() * 26,
  s: 0.2 + rand() * 0.5,
}))
/** 远景浮岛 */
const islands = Array.from({ length: 5 }, (_, i) => ({
  x: i * 260 + 80,
  y: 60 + rand() * 70,
  w: 60 + rand() * 50,
}))

function reset() {
  player = createPlayer()
  entities = buildWorld(seed, 40000).entities
  cameraX = 0
  frames = 0
  score.value = 0
  message.value = ''
  running.value = true
  started = false
  warmupUntil = performance.now() + WARMUP_MS
}

/** 天堂配色 */
const SKY_TOP = '#2a1a4a'
const SKY_MID = '#7b4a8f'
const SKY_LOW = '#f2a3b3'
const CLOUD = 'rgba(255, 236, 245, 0.86)'
const CLOUD_D = 'rgba(226, 196, 224, 0.9)'
const GROUND = '#6d5a8f'

function draw() {
  const cv = canvasEl.value
  const g = cv?.getContext('2d')
  if (!g) return

  // ── 天空（霞光渐变：上紫下粉，贴合"天堂"） ──
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, SKY_TOP)
  sky.addColorStop(0.55, SKY_MID)
  sky.addColorStop(1, SKY_LOW)
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)

  // ── 太阳/月亮光晕 ──
  const glow = g.createRadialGradient(W * 0.78, 58, 4, W * 0.78, 58, 66)
  glow.addColorStop(0, 'rgba(255, 245, 210, 0.95)')
  glow.addColorStop(1, 'rgba(255, 200, 180, 0)')
  g.fillStyle = glow
  g.beginPath()
  g.arc(W * 0.78, 58, 66, 0, Math.PI * 2)
  g.fill()

  // ── 远景浮岛（缓慢视差） ──
  for (const is of islands) {
    const sx = is.x - cameraX * 0.25
    const wrapped = ((sx % (W + 300)) + W + 300) % (W + 300) - 150
    g.fillStyle = 'rgba(120, 90, 150, 0.55)'
    g.beginPath()
    g.ellipse(wrapped, is.y, is.w / 2, 8, 0, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = 'rgba(150, 120, 175, 0.45)'
    g.beginPath()
    g.moveTo(wrapped - is.w / 3, is.y + 4)
    g.lineTo(wrapped + is.w / 3, is.y + 4)
    g.lineTo(wrapped, is.y + 26)
    g.closePath()
    g.fill()
  }

  // ── 云海（两层视差） ──
  for (const c of clouds) {
    const sx = c.x - cameraX * c.s
    const wrapped = ((sx % (W + 200)) + W + 200) % (W + 200) - 100
    g.fillStyle = CLOUD_D
    g.beginPath()
    g.arc(wrapped, c.y, c.r, 0, Math.PI * 2)
    g.arc(wrapped + c.r * 0.8, c.y + 4, c.r * 0.75, 0, Math.PI * 2)
    g.arc(wrapped - c.r * 0.8, c.y + 6, c.r * 0.7, 0, Math.PI * 2)
    g.fill()
  }

  // ── 云面跑道（龙猫踩在云上） ──
  const groundTop = H - 58
  g.fillStyle = 'rgba(255, 240, 250, 0.96)'
  g.beginPath()
  g.moveTo(0, groundTop)
  for (let x = 0; x <= W; x += 16) {
    const wx = x + cameraX
    g.lineTo(x, groundTop + Math.sin(wx / 42) * 3)
  }
  g.lineTo(W, H)
  g.lineTo(0, H)
  g.closePath()
  g.fill()
  g.fillStyle = GROUND
  g.fillRect(0, groundTop + 12, W, H - groundTop - 12)

  // ── 实体 ──
  const toScreenX = (wx: number) => wx - cameraX
  for (const e of entities) {
    const sx = toScreenX(e.x)
    if (sx < -80 || sx > W + 80) continue
    if (e.kind === 'obstacle') {
      // 树桩（天堂里的一小丛竹/树桩）
      const baseY = groundTop + 4 - e.y
      g.fillStyle = '#5b8f6a'
      g.fillRect(sx, baseY - e.h, e.w, e.h)
      g.fillStyle = '#7fbf8b'
      g.fillRect(sx + 3, baseY - e.h, 5, e.h)
      g.fillStyle = '#3f6b4c'
      g.fillRect(sx, baseY - e.h, e.w, 4)
    } else if (!e.taken) {
      // 橡果
      const cx = sx + e.w / 2
      const cy = groundTop - 6 - e.y
      g.fillStyle = '#c98a4b'
      g.beginPath()
      g.arc(cx, cy + 3, e.w / 2, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#8a5a2b'
      g.fillRect(cx - e.w / 2, cy - 4, e.w, 4)
    }
  }

  // ── 龙猫（灰白像素风，踩在云上向右跑） ──
  const px = player.x - cameraX + 90
  const ph = player.ducking ? GAME.playerDuckH : GAME.playerH
  const py = groundTop + 4 - player.y - ph
  const pwid = GAME.playerW

  // 尾巴（身后一撮，随跑动轻摆）
  g.fillStyle = '#9aa3bb'
  const tailWag = player.onGround ? (Math.floor(frames / 8) % 2 === 0 ? 0 : 2) : 3
  g.fillRect(px - 8, py + ph * 0.55 + tailWag, 9, 7)

  // 身体
  g.fillStyle = '#b9bfd4'
  g.fillRect(px, py + 7, pwid, ph - 7)
  g.fillRect(px + 2, py + 2, pwid - 4, 8) // 头顶圆一点
  // 肚皮
  g.fillStyle = '#eef1fa'
  g.fillRect(px + 5, py + ph * 0.46, pwid - 10, ph * 0.44)
  // 耳朵
  g.fillStyle = '#b9bfd4'
  g.fillRect(px + 3, py - 6, 7, 9)
  g.fillRect(px + pwid - 10, py - 6, 7, 9)
  g.fillStyle = '#d9a8b8'
  g.fillRect(px + 5, py - 4, 3, 5)
  g.fillRect(px + pwid - 8, py - 4, 3, 5)
  // 眼睛（跑动时略眯）
  g.fillStyle = '#2b2b3a'
  const eyeH = player.onGround && Math.floor(frames / 10) % 2 === 0 ? 4 : 6
  g.fillRect(px + 8, py + 12, 5, eyeH)
  g.fillRect(px + pwid - 13, py + 12, 5, eyeH)
  // 鼻子与胡须
  g.fillStyle = '#e88ba0'
  g.fillRect(px + pwid / 2 - 2, py + 21, 5, 4)
  g.fillStyle = 'rgba(255,255,255,0.7)'
  g.fillRect(px + pwid / 2 + 4, py + 20, 9, 1)
  g.fillRect(px + pwid / 2 + 4, py + 24, 9, 1)
  // 腿（跑动两帧交替；空中则收起）
  g.fillStyle = '#98a0bb'
  if (player.onGround) {
    const swing = Math.floor(frames / 6) % 2 === 0
    g.fillRect(px + (swing ? 5 : 14), py + ph, 7, 6)
    g.fillRect(px + (swing ? 16 : 7), py + ph, 7, 6)
  } else {
    g.fillRect(px + 6, py + ph - 2, 7, 5)
    g.fillRect(px + pwid - 13, py + ph - 4, 7, 5)
  }

  // ── 近景云（贴着跑道下沿，制造"踩在云上"，但不盖住角色） ──
  for (const c of clouds.slice(0, 6)) {
    const sx = c.x * 1.6 - cameraX * 0.9
    const wrapped = ((sx % (W + 260)) + W + 260) % (W + 260) - 130
    g.fillStyle = 'rgba(255, 250, 255, 0.8)'
    g.beginPath()
    g.arc(wrapped, groundTop + 16, c.r * 0.7, 0, Math.PI * 2)
    g.arc(wrapped + c.r * 0.6, groundTop + 20, c.r * 0.5, 0, Math.PI * 2)
    g.fill()
  }

  // ── HUD ──
  g.fillStyle = 'rgba(20, 12, 30, 0.5)'
  g.fillRect(8, 8, 168, 24)
  g.fillStyle = '#ffe9f3'
  g.font = 'bold 13px monospace'
  g.fillText(`橡果 ${score.value}   最高 ${bestScore.value}`, 16, 25)

  if (message.value) {
    g.fillStyle = 'rgba(20, 12, 30, 0.62)'
    g.fillRect(0, H / 2 - 34, W, 68)
    g.fillStyle = '#fff3fa'
    g.font = 'bold 20px sans-serif'
    g.textAlign = 'center'
    g.fillText(message.value, W / 2, H / 2 + 7)
    g.textAlign = 'left'
  } else if (!started && performance.now() < warmupUntil) {
    // 开局预热：把"怎么玩"写在画面中央（别指望玩家先看下面那行小字）
    g.fillStyle = 'rgba(20, 12, 30, 0.55)'
    g.fillRect(0, H / 2 - 40, W, 80)
    g.textAlign = 'center'
    g.fillStyle = '#ffe9f3'
    g.font = 'bold 17px sans-serif'
    g.fillText('↑ 或 A 跳起来，躲开树桩', W / 2, H / 2 - 8)
    g.fillStyle = '#d9c7ea'
    g.font = '13px sans-serif'
    g.fillText('按任意键开始', W / 2, H / 2 + 20)
    g.textAlign = 'left'
  }
}

/** 一帧 */
function tick() {
  if (!running.value) {
    draw()
    raf = requestAnimationFrame(tick)
    return
  }
  frames++

  /**
   * 开局预热（见 `WARMUP_MS` 的注释）：这段时间角色**不动**，只显示操作提示，
   * 让玩家先看清"要按什么"。按任意操作键即提前开始（不强迫等满）。
   */
  if (!started && performance.now() < warmupUntil) {
    if (anyHeld()) started = true
    else {
      draw()
      raf = requestAnimationFrame(tick)
      return
    }
  }

  // 输入 → 物理
  stepPlayer(player, {
    jumpHeld: held.up || held.a,
    jumpPressed: pressedJump,
    downHeld: held.down || held.b,
    boostHeld: held.right || held.b,
  })
  if (pressedJump) {
    tryJump(player)
    pressedJump = false
  }
  // ← 减速（把推进量抵回来一点，实现"慢下来"）
  if (held.left) player.x -= GAME.baseSpeed * 0.55

  cameraX = player.x - 90

  // 碰撞
  for (const e of entities) {
    if (e.x + e.w < player.x - 40 || e.x > player.x + 300) continue
    if (e.kind === 'acorn') {
      if (!e.taken && hits(player, e)) {
        e.taken = true
        score.value++
        if (score.value > bestScore.value) bestScore.value = score.value
      }
    } else if (hits(player, e)) {
      running.value = false
      message.value = `撞到啦！橡果 ${score.value} · 按 Enter 重来`
    }
  }

  draw()
  raf = requestAnimationFrame(tick)
}

/** 键盘 → 动作 */
const KEYMAP: Record<string, GameAction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyA: 'a',
  KeyB: 'b',
}

function onKeyDown(e: KeyboardEvent) {
  const act = KEYMAP[e.code]
  if (act) {
    e.preventDefault()
    // 作弊码：识别按键序列（A/B 同时是操作键）
    if (!held[act] && cheat.feed(act)) {
      emit('unlock')
      return
    }
  }
  if (act === 'up' || act === 'a') {
    if (!held[act]) pressedJump = true
    held[act] = true
  } else if (act === 'down' || act === 'left' || act === 'right' || act === 'b') {
    held[act] = true
  }
  if (e.code === 'Enter' || e.code === 'Space') {
    e.preventDefault()
    if (!running.value) reset()
  }
}
function onKeyUp(e: KeyboardEvent) {
  const act = KEYMAP[e.code]
  if (!act) return
  e.preventDefault()
  held[act] = false
}

onMounted(() => {
  reset()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  raf = requestAnimationFrame(tick)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})
</script>

<template>
  <!-- 迷你：一个画布 + 一行按键提示，不引任何 UI 框架组件 -->
  <div class="game-wrap">
    <canvas ref="canvasEl" :width="W" :height="H" class="game-canvas" tabindex="0" />
    <div class="game-hint">
      方向键移动　<b>A</b> 跳　<b>B</b> 加速／蹲　Enter 重来
    </div>
  </div>
</template>

<style scoped>
.game-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.game-canvas {
  width: 100%;
  max-width: 640px;
  height: auto;
  border-radius: 10px;
  outline: none;
  image-rendering: pixelated;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
}
.game-hint {
  font-size: 12px;
  letter-spacing: 0.02em;
  opacity: 0.72;
}
</style>
