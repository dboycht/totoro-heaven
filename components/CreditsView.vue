<template>
  <!--
    鸣谢界面（2026-09-23 新增，用户要求"先生成界面，后面再接进软件"）

    自成一体的组件：只靠 props 驱动，不读全局 store、不碰路由，放在任何子页里都能用。
    目录里刻意没有任何导航入口 —— 接进软件时按报告里写的三处改动即可。

    零依赖：彩带用 <canvas> + requestAnimationFrame 自己算；不引 npm 包、不引 CDN、
    不加载外部图片或字体（打包成单文件 EXE 离线运行时，任何外部资源都会失效）。
  -->
  <div class="credits-view">
    <!--
      彩带层：pointer-events:none 是硬要求 —— 它铺满视口，但绝不劫持鼠标；
      aria-hidden 让它对读屏软件完全不存在。z-index 取 1000：
      高于页面内容，低于 Vuetify 的弹窗/提示层（>=2000），所以不会盖住对话框。
    -->
    <canvas
      ref="canvasEl"
      class="credits-confetti"
      :class="{ 'credits-confetti--hidden': !confettiAlive }"
      data-testid="credits-confetti"
      aria-hidden="true"
    />

    <!-- 用普通 div 而不是 v-container：外层 layout 已经包了一个 v-container，
         再嵌一个会双重内边距，这里只要"居中 + 一个最小高度"就够 -->
    <div class="credits-stage">
      <div class="credits-stack">
        <div class="credits-headline text-center">
          <v-icon color="primary" size="34" class="mb-1">mdi-heart-multiple-outline</v-icon>
          <div class="text-h6 font-weight-bold">鸣谢</div>
          <div class="text-body-2 text-medium-emphasis">
            感谢每一位参与测试、提出问题与帮忙查错的同学
          </div>
        </div>

        <v-card
          class="credits-card mx-auto"
          max-width="640"
          rounded="xl"
          elevation="8"
        >
          <div class="credits-card__glow" aria-hidden="true" />

          <v-card-text class="credits-card__body">
            <!--
              正中间：名称（大字号）。key 绑到当前序号的文字上，
              切换时让它重新挂载以触发一次轻度过渡（尊重 reduced-motion，见样式段）。
            -->
            <div
              :key="`name-${activeIndex}`"
              class="credits-name credits-swap text-h3 font-weight-bold text-center"
              data-testid="credits-name"
            >
              {{ active.name }}
            </div>

            <!-- 名称下方：介绍（一行） -->
            <div
              :key="`intro-${activeIndex}`"
              class="credits-intro credits-swap text-body-1 text-medium-emphasis text-center mt-3"
              data-testid="credits-intro"
            >
              {{ active.intro }}
            </div>

            <div
              v-if="active.note"
              :key="`note-${activeIndex}`"
              class="credits-swap text-caption text-medium-emphasis text-center mt-2"
            >
              {{ active.note }}
            </div>
          </v-card-text>

          <!-- 多条时的切换控件：圆点 + 上一条/下一条，可鼠标点、可键盘 Tab 到 -->
          <v-card-actions v-if="total > 1" class="credits-card__actions">
            <v-btn
              icon="mdi-chevron-left"
              variant="text"
              size="small"
              title="上一条"
              data-testid="credits-prev"
              @click="goto(activeIndex - 1)"
            />
            <div class="credits-dots">
              <button
                v-for="(c, i) in listSafe"
                :key="`dot-${i}`"
                type="button"
                class="credits-dot"
                :class="{ 'credits-dot--on': i === activeIndex }"
                :aria-label="`第 ${i + 1} 条：${c.name}`"
                :title="c.name"
                @click="goto(i)"
              />
            </div>
            <v-btn
              icon="mdi-chevron-right"
              variant="text"
              size="small"
              title="下一条"
              data-testid="credits-next"
              @click="goto(activeIndex + 1)"
            />
          </v-card-actions>
        </v-card>

        <!-- 常驻的小控件：重播彩带 + 自动轮播开关。刻意做小、不挡内容、可关闭 -->
        <div class="credits-toolbar d-flex flex-wrap align-center justify-center ga-2">
          <v-btn
            size="small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-party-popper"
            data-testid="credits-replay"
            @click="replay"
          >
            再来一次
          </v-btn>
          <v-btn
            v-if="total > 1"
            size="small"
            variant="text"
            :prepend-icon="autoPlay ? 'mdi-pause' : 'mdi-play'"
            data-testid="credits-autoplay"
            @click="toggleAutoPlay"
          >
            {{ autoPlay ? '暂停轮播' : '自动轮播' }}
          </v-btn>
        </div>

        <div class="text-caption text-medium-emphasis text-center credits-foot">
          本页是界面预览。真正接进软件时才会出现在导航里。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

/** 一条鸣谢（名称 + 一行介绍；`note` 可选，用于补充说明） */
export interface CreditItem {
  /** 用户名称，例如 `@Dusk` */
  name: string
  /** 名称下方那行介绍 */
  intro: string
  /** 可选补充（会显示成一行更小的灰字） */
  note?: string
}

const props = withDefaults(
  defineProps<{
    /** 鸣谢条目；给多条时会显示切换控件，也能自动轮播 */
    items?: CreditItem[]
    /** 进入时是否播放彩带（false = 只静态显示内容） */
    playOnMount?: boolean
    /** 多条时是否自动轮播 */
    autoPlay?: boolean
    /** 自动轮播间隔（毫秒） */
    intervalMs?: number
    /** 单场彩带的粒子数（建议 120~200） */
    particleCount?: number
    /** 是否显示彩带层（false 时彻底不初始化 canvas） */
    showConfetti?: boolean
  }>(),
  {
    items: () => [{ name: '@Dusk', intro: '参与相关内部测试' }],
    playOnMount: true,
    autoPlay: true,
    intervalMs: 4200,
    particleCount: 160,
    showConfetti: true,
  },
)

/* ------------------------------------------------------------------ *
 * 一、内容与轮播
 * ------------------------------------------------------------------ */

/** 过滤掉没名字的空条目，避免渲染出空白卡片 */
const list = computed<CreditItem[]>(() =>
  (Array.isArray(props.items) ? props.items : []).filter((c) => c && String(c.name || '').trim()),
)

/** 兜底：进来一个空数组时也要有东西可显示，不能白屏 */
const listSafe = computed<CreditItem[]>(() =>
  list.value.length ? list.value : [{ name: '@Dusk', intro: '参与相关内部测试' }],
)

const total = computed(() => listSafe.value.length)
const activeIndex = ref(0)
const active = computed<CreditItem>(() => listSafe.value[activeIndex.value] || listSafe.value[0]!)

/** 绕圈切换（负数与越界都能正确回绕） */
function goto(i: number) {
  const n = total.value
  if (n <= 0) return
  activeIndex.value = ((i % n) + n) % n
}

/**
 * 自动轮播用**定时器**（不是过渡钩子），并且**只在多条时才存在**：
 * 单条时一个定时器都不建 —— 免得留下空转的东西。每次切换后重建定时器，
 * 这样用户手动点"下一条"之后，倒计时重新开始，不会刚切完又被自动切走。
 */
const autoPlayOn = ref(props.autoPlay)
const autoPlay = computed(() => autoPlayOn.value && total.value > 1)
let rotateTimer: ReturnType<typeof setTimeout> | null = null

function clearRotateTimer() {
  if (rotateTimer !== null) {
    clearTimeout(rotateTimer)
    rotateTimer = null
  }
}

function scheduleRotate() {
  clearRotateTimer()
  if (!autoPlay.value) return
  const ms = Math.max(1200, Number(props.intervalMs) || 4200)
  rotateTimer = setTimeout(() => {
    rotateTimer = null
    goto(activeIndex.value + 1)
    scheduleRotate()
  }, ms)
}

function toggleAutoPlay() {
  autoPlayOn.value = !autoPlayOn.value
  scheduleRotate()
}

// 手动切换、条目变化、开关变化 —— 都让倒计时重新开始
watch([activeIndex, total, autoPlayOn], () => scheduleRotate())

// 条目数组被换成新内容时，把序号夹回合法范围
watch(total, (n) => {
  if (n > 0 && activeIndex.value >= n) activeIndex.value = 0
})

/* ------------------------------------------------------------------ *
 * 二、彩带（canvas + requestAnimationFrame，零依赖）
 * ------------------------------------------------------------------ */

type ConfettiKind = 'ribbon' | 'chip'

interface ConfettiParticle {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  color: string
  rot: number
  spin: number
  grav: number
  drag: number
  wob: number
  wobPhase: number
  /** 纸带翻面速度：宽度按 cos 缩放，做出"纸带在翻"的观感 */
  flipPhase: number
  flipSpeed: number
  kind: ConfettiKind
  /** 形状：0 圆 / 1 方 / 2 小三角，只在 chip 上用 */
  shape: number
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
const confettiAlive = ref(false)

const ctxRef = shallowRef<CanvasRenderingContext2D | null>(null)
const particles: ConfettiParticle[] = []
let width = 0
let height = 0
let dpr = 1
let rafId: number | null = null
let lastTs = 0
let waveTimers: Array<ReturnType<typeof setTimeout>> = []
/** 已经排好的波次（还没到时间的）；用它判断"这一场是不是彻底结束了" */
let pendingWaves = 0

/** 暂停/后台时不要把物理算飞（帧间隔封顶 32ms） */
const MAX_DT = 0.032
const GRAVITY = 620

const PALETTE = [
  '#4CAF50',
  '#26A69A',
  '#FFB74D',
  '#FFA726',
  '#EF5350',
  '#42A5F5',
  '#AB47BC',
  '#F06292',
  '#FFEE58',
  '#66BB6A',
]

/**
 * 播彩带的时间线：第 0 / 300 / 660 / 1050 毫秒各爆一次（共 4 波），
 * 每波粒子数依次递减（约 34% / 27% / 21% / 18%），
 * 所以总数 ≈ particleCount，**不会因为多波而翻倍**。
 *
 * 起点在屏幕下缘偏中间的区域，初速度**向上**且带随机横向扩散 ⇒
 * 视觉上就是"从底部中间向四周爆开、先上冲再飘落"。
 */
const WAVE_AT_MS = [0, 300, 660, 1050]
const WAVE_SHARE = [0.34, 0.27, 0.21, 0.18]

/** 只在窗口尺寸真的变了时才改画布尺寸（改 canvas 尺寸会清空画布，不能每帧做） */
function resizeCanvas() {
  const el = canvasEl.value
  if (!el) return
  const w = Math.max(1, el.clientWidth || window.innerWidth)
  const h = Math.max(1, el.clientHeight || window.innerHeight)
  const nextDpr = Math.min(2, window.devicePixelRatio || 1) // 上限 2：够清晰，又不浪费填充率
  if (w === width && h === height && nextDpr === dpr) return
  width = w
  height = h
  dpr = nextDpr
  el.width = Math.round(w * dpr)
  el.height = Math.round(h * dpr)
  const ctx = ctxRef.value
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function spawnWave(count: number) {
  const ctx = ctxRef.value
  if (!ctx || count <= 0) return

  // 起点：贴近下缘（再往上 8%），横向集中在中间 40% 宽度内
  const originX = width * (0.3 + Math.random() * 0.4)
  const originY = height * 0.92
  const spread = Math.min(width * 0.42, 420)

  for (let i = 0; i < count; i++) {
    // 抛射角：-150° ~ -30°（canvas 的 y 轴朝下，所以负角度 = 朝上）
    const angle = (-150 + Math.random() * 120) * (Math.PI / 180)
    // 速度：380~840 px/s。实测最高飘到约 500px 高（下缘出发大致够到卡片下沿），
    // 刻意**够不到卡片正中的文字** —— 免得纸带糊在名称上挡住阅读。
    const speed = 380 + Math.random() * 460
    // 离中心的横向偏移：越靠边，横向初速越大 ⇒ 向四周散开
    const offX = (Math.random() - 0.5) * spread * 0.5
    const ribbon = Math.random() < 0.55

    particles.push({
      x: originX + offX,
      y: originY + (Math.random() - 0.5) * height * 0.06,
      vx: Math.cos(angle) * speed * (0.55 + Math.abs(offX) / spread),
      vy: Math.sin(angle) * speed,
      w: ribbon ? 5 + Math.random() * 4 : 3 + Math.random() * 4,
      h: ribbon ? 12 + Math.random() * 14 : 3 + Math.random() * 4,
      color: PALETTE[(Math.random() * PALETTE.length) | 0]!,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 9,
      grav: GRAVITY * (0.8 + Math.random() * 0.5),
      drag: 0.28 + Math.random() * 0.34,
      wob: 10 + Math.random() * 26,
      wobPhase: Math.random() * Math.PI * 2,
      flipPhase: Math.random() * Math.PI * 2,
      flipSpeed: 4 + Math.random() * 7,
      kind: ribbon ? 'ribbon' : 'chip',
      shape: (Math.random() * 3) | 0,
    })
  }
}

function step(dt: number) {
  const ctx = ctxRef.value
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)

  const killY = height + 90
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!
    p.wobPhase += dt * 3.2
    p.flipPhase += dt * p.flipSpeed

    // 空气阻力（指数衰减，帧率无关）+ 重力
    const damp = Math.exp(-p.drag * dt)
    p.vx = p.vx * damp + Math.cos(p.wobPhase) * p.wob * dt
    p.vy = p.vy * damp + p.grav * dt

    p.x += p.vx * dt
    p.y += p.vy * dt
    p.rot += p.spin * dt

    // 落出下缘 / 飞出左右缘太远 ⇒ 这条结束
    if (p.y > killY || p.x < -140 || p.x > width + 140) {
      particles.splice(i, 1)
      continue
    }

    // 纸带"翻面"：横向宽度按 cos 缩放；最窄处几乎成一条线
    const flip = Math.abs(Math.cos(p.flipPhase))
    const w = p.kind === 'ribbon' ? p.w * (0.22 + 0.78 * flip) : p.w
    const alpha = 0.68 + 0.32 * flip

    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(p.rot)
    ctx.globalAlpha = alpha
    ctx.fillStyle = p.color
    if (p.kind === 'ribbon') {
      ctx.fillRect(-w / 2, -p.h / 2, w, p.h)
    } else if (p.shape === 0) {
      ctx.beginPath()
      ctx.arc(0, 0, p.w * 0.6, 0, Math.PI * 2)
      ctx.fill()
    } else if (p.shape === 1) {
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
    } else {
      ctx.beginPath()
      ctx.moveTo(0, -p.h * 0.7)
      ctx.lineTo(p.w * 0.6, p.h * 0.6)
      ctx.lineTo(-p.w * 0.6, p.h * 0.6)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

/**
 * 唯一的 rAF 循环。跑空就自动停：
 * 粒子清空、且没有待爆的波次 ⇒ 取消 rAF 并清屏，不留常驻空转。
 */
function frame(ts: number) {
  const dt = lastTs ? Math.min(MAX_DT, (ts - lastTs) / 1000) : 0
  lastTs = ts

  step(dt)

  if (particles.length === 0 && pendingWaves === 0) {
    stopLoop()
    const ctx = ctxRef.value
    if (ctx) ctx.clearRect(0, 0, width, height)
    confettiAlive.value = false
    return
  }
  rafId = requestAnimationFrame(frame)
}

function startLoop() {
  if (rafId !== null) return
  lastTs = 0
  confettiAlive.value = true
  rafId = requestAnimationFrame(frame)
}

function stopLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function clearTimers() {
  for (const t of waveTimers) clearTimeout(t)
  waveTimers = []
  pendingWaves = 0
}

function clearParticles() {
  particles.length = 0
  const ctx = ctxRef.value
  if (ctx) ctx.clearRect(0, 0, width, height)
  confettiAlive.value = false
}

/** 真正播一场：排好波次、启动循环 */
function playConfetti() {
  if (!props.showConfetti) return
  if (prefersReducedMotion.value) return // 尊重系统设置：不播动画，只静态显示内容
  if (!canvasEl.value) return

  clearTimers()
  resizeCanvas()

  const totalParticles = Math.max(0, Math.min(400, Math.round(Number(props.particleCount) || 160)))
  let allocated = 0
  WAVE_AT_MS.forEach((delay, i) => {
    const isLast = i === WAVE_AT_MS.length - 1
    const count = isLast
      ? Math.max(0, totalParticles - allocated)
      : Math.round(totalParticles * (WAVE_SHARE[i] ?? 0))
    allocated += count
    pendingWaves++
    waveTimers.push(
      setTimeout(() => {
        pendingWaves--
        spawnWave(count)
        startLoop()
      }, delay),
    )
  })
}

/** "再来一次"：先清空当前场次再重排，不会叠着上一场 */
function replay() {
  clearTimers()
  clearParticles()
  playConfetti()
}

/* ------------------------------------------------------------------ *
 * 三、无障碍：prefers-reduced-motion / 页面隐藏 / 尺寸变化
 * ------------------------------------------------------------------ */

/**
 * 零依赖读 `prefers-reduced-motion`：优先用 matchMedia，
 * 老环境没有 matchMedia 就当作"不减弱"，绝不能因为读不到而崩。
 */
const motionQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
const prefersReducedMotion = ref(motionQuery ? motionQuery.matches : false)

function onMotionChange(e: MediaQueryListEvent | MediaQueryList) {
  prefersReducedMotion.value = !!e.matches
  if (prefersReducedMotion.value) {
    // 用户中途改成"减弱动效" ⇒ 立刻刹车并清干净
    clearTimers()
    clearParticles()
    stopLoop()
  }
}

/** 标签页切到后台就停（省电，也避免回来时一帧补算一大堆） */
function onVisibilityChange() {
  if (document.hidden) {
    clearTimers()
    stopLoop()
  }
}

function onResize() {
  resizeCanvas()
}

onMounted(() => {
  const el = canvasEl.value
  if (el) {
    ctxRef.value = el.getContext('2d')
    resizeCanvas()
  }

  motionQuery?.addEventListener('change', onMotionChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('resize', onResize)

  // 只在"该播"的时候排波次；prefersReducedMotion 为真时 playConfetti 自己会退回
  if (props.playOnMount) playConfetti()

  scheduleRotate()
})

onBeforeUnmount(() => {
  // 卸载必须清干净：rAF、所有定时器、所有监听
  stopLoop()
  clearTimers()
  clearParticles()
  clearRotateTimer()
  motionQuery?.removeEventListener('change', onMotionChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('resize', onResize)
  ctxRef.value = null
})

// 外部把 showConfetti 关掉时，立刻收干净
watch(
  () => props.showConfetti,
  (on) => {
    if (!on) {
      clearTimers()
      clearParticles()
      stopLoop()
    }
  },
)
</script>

<style scoped>
.credits-view {
  position: relative;
}

/* 彩带层：铺满视口、不吃鼠标事件、不参与读屏 */
.credits-confetti {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1000;
  opacity: 1;
  transition: opacity 0.4s ease;
}

.credits-confetti--hidden {
  opacity: 0;
}

.credits-stage {
  position: relative;
  z-index: 1;
  min-height: min(72vh, 620px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.credits-stack {
  width: 100%;
  max-width: 720px;
}

.credits-headline {
  margin-bottom: 18px;
}

.credits-card {
  position: relative;
  overflow: hidden;
  /* 主题色只影响这一层柔和底色，深浅色下都能看 */
  background-image: linear-gradient(
    145deg,
    rgba(var(--v-theme-primary), 0.16),
    rgba(var(--v-theme-surface), 0) 58%
  );
}

/* 卡片右上角一团很淡的主题色，避免整页太平 */
.credits-card__glow {
  position: absolute;
  top: -70px;
  right: -50px;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(var(--v-theme-primary), 0.22), transparent 70%);
  pointer-events: none;
}

.credits-card__body {
  position: relative;
  padding-top: 34px;
  padding-bottom: 26px;
}

.credits-name {
  line-height: 1.2;
  word-break: break-word;
}

.credits-intro {
  line-height: 1.6;
}

.credits-card__actions {
  position: relative;
  justify-content: center;
  gap: 6px;
  padding-bottom: 14px;
}

.credits-dots {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px;
}

.credits-dot {
  width: 9px;
  height: 9px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  background: rgba(var(--v-theme-on-surface), 0.28);
  transition: background-color 0.2s ease, transform 0.2s ease;
}

.credits-dot:hover {
  background: rgba(var(--v-theme-on-surface), 0.5);
}

.credits-dot--on {
  background: rgb(var(--v-theme-primary));
  transform: scale(1.25);
}

.credits-toolbar {
  margin-top: 18px;
}

.credits-foot {
  margin-top: 10px;
}

/* 切换条目时的轻度过渡 */
.credits-swap {
  animation: credits-fade-in 0.32s ease both;
}

@keyframes credits-fade-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 键盘焦点要看得见（不劫持键盘，但 Tab 过来得有提示） */
.credits-view :deep(.v-btn:focus-visible),
.credits-dot:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

/**
 * 系统设置「减弱动效」时：内容照常显示，一切动画关掉。
 * canvas 也不显示（脚本侧同样不会画，这里再兜一层）。
 */
@media (prefers-reduced-motion: reduce) {
  .credits-confetti {
    display: none;
  }

  .credits-swap {
    animation: none;
  }

  .credits-dot {
    transition: none;
  }
}
</style>
