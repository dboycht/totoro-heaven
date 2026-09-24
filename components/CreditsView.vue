<template>
  <!--
    鸣谢界面（2026-09-23 新增；同日按用户要求改版为"电影片尾"式）

    自成一体的组件：只靠 props 驱动，不读全局 store、不碰路由，放在任何子页里都能用。
    目录里刻意没有任何导航入口 —— 接进软件时按报告里写的那几处改动即可。

    零依赖：彩带与滚动都用 <canvas> / requestAnimationFrame 自己算。
    不引 npm 包、不引 CDN、不加载外部图片或字体（打包成单文件 EXE 离线运行时外部资源都会失效）。

    两种布局（`fits` 决定，见脚本 reflow()）：
      · 放得下 ⇒ 全部条目一次性居中列在视口里，不滚动；
      · 放不下 ⇒ 电影片尾式缓慢向上滚动，到末尾停顿约 2 秒后从头循环。
  -->
  <div class="credits-view" :style="{ '--credits-stage-h': `${stageHeight}px` }">
    <!--
      彩带层：铺满整个视口（position:fixed; inset:0）。
      pointer-events:none 是硬要求 —— 它铺满视口，但绝不劫持鼠标；
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

    <div class="credits-stage">
      <!-- 顶部标题：不参与滚动，任何模式下都固定可见 -->
      <header class="credits-headline text-center">
        <v-icon color="primary" size="34" class="mb-1">mdi-heart-multiple-outline</v-icon>
        <div class="text-h6 font-weight-bold">鸣谢</div>
        <div class="text-body-2 text-medium-emphasis">
          感谢每一位参与测试、提出问题与帮忙查错的同学
        </div>
      </header>

      <!--
        条目区（片尾窗口）：overflow:hidden 的裁剪框。
        滚动模式靠 translateY 移动内部内容 —— 刻意不用原生滚动条，
        这样用户的滚轮/键盘仍然作用于整个页面，不会被"抢走"。
        （reduced-motion 下退化成原生可滚动容器，保证内容仍能看全。）
      -->
      <div
        ref="clipEl"
        class="credits-window"
        :class="{ 'credits-window--scrollable': manualScroll }"
        data-testid="credits-window"
      >
        <div
          ref="contentEl"
          class="credits-content"
          :class="{ 'credits-content--fit': fits, 'credits-content--roll': !fits }"
          :style="{ transform: `translateY(${-shift.toFixed(2)}px)` }"
          data-testid="credits-content"
        >
          <div
            v-for="(c, i) in listSafe"
            :key="`credit-${i}-${c.name}`"
            class="credits-entry"
            :class="{
              'credits-entry--focus': fits && total > 1 && i === activeIndex,
              'credits-entry--dim': fits && total > 1 && i !== activeIndex,
            }"
            :data-credit-index="i"
          >
            <div
              class="credits-name font-weight-bold"
              :class="nameSizeClass"
              :data-testid="i === 0 ? 'credits-name' : `credits-name-${i}`"
            >
              {{ c.name }}
            </div>
            <div
              class="credits-intro text-medium-emphasis"
              :class="introSizeClass"
              :data-testid="i === 0 ? 'credits-intro' : `credits-intro-${i}`"
            >
              {{ c.intro }}
            </div>
            <div v-if="c.note" class="credits-note text-medium-emphasis">
              {{ c.note }}
            </div>
          </div>
        </div>
      </div>

      <!-- 底部控件：固定不滚动。刻意做小、不挡内容 -->
      <footer class="credits-footer">
        <div class="credits-toolbar d-flex flex-wrap align-center justify-center ga-2">
          <v-btn
            v-if="!fits"
            size="small"
            variant="tonal"
            :prepend-icon="scrolling ? 'mdi-pause' : 'mdi-play'"
            data-testid="credits-scroll-toggle"
            @click="toggleScroll"
          >
            {{ scrolling ? '暂停滚动' : '继续滚动' }}
          </v-btn>
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
          <!-- 条目放得下时才有得切；滚动模式下整列都在动，不需要切换控件 -->
          <template v-if="fits && total > 1">
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
          </template>
        </div>
        <div class="text-caption text-medium-emphasis text-center credits-foot">
          <template v-if="!fits">片尾缓慢滚动中，可随时暂停；你的滚轮与键盘仍然归你自己用。</template>
          <template v-else>本页是界面预览。真正接进软件时才会出现在导航里。</template>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

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
    /** 鸣谢条目；条目多到放不下时自动变成片尾滚动 */
    items?: CreditItem[]
    /** 进入时是否播放彩带（false = 只静态显示内容） */
    playOnMount?: boolean
    /** 条目放得下且不止一条时，是否按固定间隔轮播（滚动模式与此无关） */
    autoPlay?: boolean
    /** 轮播间隔（毫秒） */
    intervalMs?: number
    /** 彩带粒子数；不传（或 0）则按视口面积自动算（200~320，上限 400） */
    particleCount?: number
    /** 是否显示彩带层（false 时彻底不初始化 canvas） */
    showConfetti?: boolean
    /** 片尾滚动速度（像素/秒）—— 电影片尾那种"慢慢走" */
    scrollSpeed?: number
    /** 滚到末尾后停顿多久再从头开始（毫秒） */
    endHoldMs?: number
  }>(),
  {
    items: () => [{ name: '@Dusk', intro: '参与相关内部测试' }],
    playOnMount: true,
    autoPlay: true,
    intervalMs: 4200,
    particleCount: 0,
    showConfetti: true,
    scrollSpeed: 30,
    endHoldMs: 2000,
  },
)

/* ------------------------------------------------------------------ *
 * 一、内容
 * ------------------------------------------------------------------ */

/** 过滤掉没名字的空条目，避免渲染出空白块 */
const list = computed<CreditItem[]>(() =>
  (Array.isArray(props.items) ? props.items : []).filter((c) => c && String(c.name || '').trim()),
)

/** 兜底：进来一个空数组时也要有东西可显示，不能白屏 */
const listSafe = computed<CreditItem[]>(() =>
  list.value.length ? list.value : [{ name: '@Dusk', intro: '参与相关内部测试' }],
)

const total = computed(() => listSafe.value.length)
const activeIndex = ref(0)

/** 绕圈切换（负数与越界都能正确回绕） */
function goto(i: number) {
  const n = total.value
  if (n <= 0) return
  activeIndex.value = ((i % n) + n) % n
}

/* ------------------------------------------------------------------ *
 * 二、片尾式布局：放得下就全显示，放不下就缓慢向上滚
 * ------------------------------------------------------------------ */

const clipEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)

/**
 * 整个"片尾舞台"的高度：钉在一屏内，把剩下的空间留给条目窗口。
 * 预留量 = 顶栏 64 + 外层内边距 + 标题块 + 底部控件；再兜一个 360px 的最小值，
 * 免得小窗口里被压成一条缝。
 */
const STAGE_RESERVED = 130
const stageHeight = ref(
  typeof window === 'undefined' ? 700 : Math.max(360, Math.round(window.innerHeight - STAGE_RESERVED)),
)

function updateStageHeight() {
  stageHeight.value = Math.max(360, Math.round(window.innerHeight - STAGE_RESERVED))
}

/** 放得下 ⇒ 静态全显示；放不下 ⇒ 片尾滚动 */
const fits = ref(true)
/** 滚动模式下是否让容器变成原生可滚动（只在 reduced-motion 下为真） */
const manualScroll = ref(false)
/** 已滚动的像素（内容上移量） */
const shift = ref(0)
/** 滚动总距离 */
const maxShift = ref(0)
const scrolling = ref(false)

const START_HOLD_MS = 1600
const MEASURE_TOLERANCE = 2

let scrollRaf: number | null = null
let holdTimer: ReturnType<typeof setTimeout> | null = null
let lastScrollTs = 0
let resizeObserver: ResizeObserver | null = null

function clearHoldTimer() {
  if (holdTimer !== null) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
}

function stopScrollLoop() {
  if (scrollRaf !== null) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = null
  }
}

function stopScrolling() {
  scrolling.value = false
  clearHoldTimer()
  stopScrollLoop()
}

/**
 * 匀速推进 + 到末尾/开头各自停顿（电影片尾的节奏）。
 * 位移按时间算（帧率无关），所以真实速度就是 scrollSpeed 像素/秒。
 */
function scrollFrame(ts: number) {
  const dt = lastScrollTs ? Math.min(0.032, (ts - lastScrollTs) / 1000) : 0
  lastScrollTs = ts

  if (!scrolling.value) {
    scrollRaf = null
    return
  }

  const speed = Math.max(1, Number(props.scrollSpeed) || 30)
  shift.value = Math.min(maxShift.value, shift.value + speed * dt)

  if (shift.value >= maxShift.value) {
    // 末尾停一会儿，再从开头继续（缓慢循环）
    scrolling.value = false
    clearHoldTimer()
    const hold = Math.max(0, Number(props.endHoldMs) || 2000)
    holdTimer = setTimeout(() => {
      holdTimer = null
      shift.value = 0
      nextTick(() => {
        lastScrollTs = 0
        scrolling.value = true
        scrollRaf = requestAnimationFrame(scrollFrame)
      })
    }, hold)
    scrollRaf = null
    return
  }

  scrollRaf = requestAnimationFrame(scrollFrame)
}

function startScrolling() {
  if (fits.value) return
  if (prefersReducedMotion.value) return // 减弱动效 ⇒ 不自动滚，交给用户自己滚
  if (scrolling.value) return
  clearHoldTimer()
  lastScrollTs = 0
  scrolling.value = true
  scrollRaf = requestAnimationFrame(scrollFrame)
}

function toggleScroll() {
  if (scrolling.value) stopScrolling()
  else startScrolling()
}

/** 条目多时把字号收一点（滚动模式下再收一档） */
const nameSizeClass = computed(() => {
  if (!fits.value) return 'credits-name--roll'
  if (total.value > 6) return 'credits-name--many'
  if (total.value > 2) return 'credits-name--mid'
  return 'credits-name--big'
})

const introSizeClass = computed(() => (fits.value && total.value <= 2 ? 'text-body-1' : 'text-body-2'))

/**
 * 量一次尺寸，决定用哪种布局。
 * 判据：可用高度（裁剪框）能不能容下内容整高（多给 2px 容差，避免亚像素抖动来回切）。
 */
function reflow() {
  const clip = clipEl.value
  const content = contentEl.value
  if (!clip || !content) return

  const available = clip.clientHeight
  const needed = content.scrollHeight
  if (available <= 0) return

  const nowFits = needed <= available + MEASURE_TOLERANCE
  fits.value = nowFits
  manualScroll.value = prefersReducedMotion.value && !nowFits
  maxShift.value = Math.max(0, needed - available)

  if (nowFits) {
    stopScrolling()
    shift.value = 0
    return
  }
  if (shift.value > maxShift.value) shift.value = maxShift.value

  // 放不下：先从头展示一会儿，再开始缓慢滚动
  if (scrolling.value || holdTimer !== null) return
  clearHoldTimer()
  holdTimer = setTimeout(() => {
    holdTimer = null
    startScrolling()
  }, START_HOLD_MS)
}

/** 内容变了（条目数、字号、换行）都要重量一次 */
function reflowSoon() {
  nextTick(() => requestAnimationFrame(() => reflow()))
}

/* ------------------------------------------------------------------ *
 * 三、条目放得下时的轮播（与片尾滚动互斥：滚动模式不做轮播）
 * ------------------------------------------------------------------ */

const autoPlayOn = ref(props.autoPlay)
const autoPlay = computed(() => autoPlayOn.value && fits.value && total.value > 1)
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

watch([activeIndex, total, autoPlayOn, fits], () => scheduleRotate())
watch(total, (n) => {
  if (n > 0 && activeIndex.value >= n) activeIndex.value = 0
})
// 条目内容变化 ⇒ 重新量尺寸
watch(listSafe, () => reflowSoon(), { deep: true })

/* ------------------------------------------------------------------ *
 * 四、彩带（canvas + requestAnimationFrame，零依赖）
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
 * 所以总数 ≈ particleCount，不会因为多波而翻倍。
 */
const WAVE_AT_MS = [0, 300, 660, 1050]
const WAVE_SHARE = [0.34, 0.27, 0.21, 0.18]

/** 视口面积基准：1440x1000 时取 240 个粒子，再按面积线性缩放并夹在 200~320 */
const AREA_BASE_PX = 1440 * 1000
const AREA_BASE_COUNT = 240

function autoParticleCount() {
  const px = Math.max(1, window.innerWidth) * Math.max(1, window.innerHeight)
  const n = Math.round(AREA_BASE_COUNT * (px / AREA_BASE_PX))
  return Math.max(200, Math.min(320, n))
}

/** 只在尺寸真的变了时才改画布尺寸（改 canvas 尺寸会清空画布，不能每帧做） */
function resizeCanvas() {
  const el = canvasEl.value
  if (!el) return
  // 铺满整个视口。尺寸取 window.innerWidth/innerHeight（clientWidth 会被滚动条减掉，
  // 那会让画布比可视区窄一条），并在元素上同步 CSS 尺寸，保证两者一致。
  const root = document.documentElement
  const w = Math.max(1, Math.round(window.innerWidth || root.clientWidth || 1))
  const h = Math.max(1, Math.round(window.innerHeight || root.clientHeight || 1))
  const nextDpr = Math.min(2, window.devicePixelRatio || 1) // 上限 2：够清晰，又不浪费填充率
  if (w === width && h === height && nextDpr === dpr) return
  width = w
  height = h
  dpr = nextDpr
  el.width = Math.round(w * dpr)
  el.height = Math.round(h * dpr)
  el.style.width = `${w}px`
  el.style.height = `${h}px`
  const ctx = ctxRef.value
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/**
 * 爆一波：起点铺满**整条下缘**（x 全宽随机），初速向上且足够大。
 * 速度按视口高度缩放 ⇒ 小窗口不冲过头、大屏也能覆盖整个页面高度。
 */
function spawnWave(count: number) {
  const ctx = ctxRef.value
  if (!ctx || count <= 0) return

  const originY = height * 0.995
  const vScale = Math.max(0.55, Math.min(1.9, height / 900))

  for (let i = 0; i < count; i++) {
    // 抛射角：-142° ~ -38°（canvas 的 y 轴朝下，所以负角度 = 朝上）
    const angle = (-142 + Math.random() * 104) * (Math.PI / 180)
    const speed = (330 + Math.random() * 620) * vScale
    const ribbon = Math.random() < 0.55

    particles.push({
      // 起点铺满整条边，不再集中在中间那一段
      x: Math.random() * width,
      y: originY + (Math.random() - 0.5) * height * 0.03,
      vx: Math.cos(angle) * speed * (0.6 + Math.random() * 0.8),
      vy: Math.sin(angle) * speed,
      w: ribbon ? 5 + Math.random() * 4 : 3 + Math.random() * 4,
      h: ribbon ? 12 + Math.random() * 14 : 3 + Math.random() * 4,
      color: PALETTE[(Math.random() * PALETTE.length) | 0]!,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 9,
      grav: GRAVITY * (0.8 + Math.random() * 0.5) * vScale,
      drag: 0.24 + Math.random() * 0.3,
      wob: 12 + Math.random() * 30,
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
    if (p.y > height + 120 || p.x < -150 || p.x > width + 150) {
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
 * 彩带的 rAF 循环。跑空就自动停：
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

  const requested = Number(props.particleCount) > 0 ? Number(props.particleCount) : autoParticleCount()
  const totalParticles = Math.max(0, Math.min(400, Math.round(requested)))
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
 * 五、无障碍：prefers-reduced-motion / 页面隐藏 / 尺寸变化
 * ------------------------------------------------------------------ */

/**
 * 零依赖读 prefers-reduced-motion：优先用 matchMedia，
 * 老环境没有 matchMedia 就当作"不减弱"，绝不能因为读不到而崩。
 */
const motionQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
const prefersReducedMotion = ref(motionQuery ? motionQuery.matches : false)

function onMotionChange(e: MediaQueryListEvent | MediaQueryList) {
  prefersReducedMotion.value = !!e.matches
  reflowSoon()
  if (prefersReducedMotion.value) {
    // 用户中途改成"减弱动效" ⇒ 立刻刹车并清干净
    clearTimers()
    clearParticles()
    stopLoop()
    stopScrolling()
    shift.value = 0
  }
}

/** 标签页切到后台就停（省电，也避免回来时一帧补算一大堆） */
function onVisibilityChange() {
  if (document.hidden) {
    clearTimers()
    stopLoop()
    stopScrolling()
  }
}

function onResize() {
  resizeCanvas()
  const before = stageHeight.value
  updateStageHeight()
  // 舞台高度变了 ⇒ 窗口可用高度也变了，必须重量一次（否则会卡在错误的模式里）
  if (before !== stageHeight.value) reflowSoon()
  else reflow()
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

  // 只监听裁剪框：它的高度就是"可用高度"，容器变化时重新判"放不放得下"
  if (typeof ResizeObserver !== 'undefined' && clipEl.value) {
    resizeObserver = new ResizeObserver(() => reflow())
    resizeObserver.observe(clipEl.value)
  }

  updateStageHeight()
  reflowSoon()
  if (props.playOnMount) playConfetti()
  scheduleRotate()
})

onBeforeUnmount(() => {
  // 卸载必须清干净：两个 rAF、所有定时器、所有监听
  stopLoop()
  stopScrolling()
  clearTimers()
  clearParticles()
  clearRotateTimer()
  resizeObserver?.disconnect()
  resizeObserver = null
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

/* 彩带层：铺满整个视口、不吃鼠标事件、不参与读屏 */
.credits-confetti {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 1000;
  opacity: 1;
  transition: opacity 0.4s ease;
}

.credits-confetti--hidden {
  opacity: 0;
}

/* 竖向三段：固定标题 / 可伸缩的条目窗口 / 固定底部控件 */
.credits-stage {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  /*
    高度钉死在一屏内（而不是 min-height）—— 这是"放不下就滚动"能成立的前提：
    如果这里只给 min-height，条目窗口会被内容撑高，永远"放得下"，
    于是永远不会进入片尾滚动（实测就是这个坑：40 条时窗口高 = 内容高 = 3940px）。
    预留量给的是：顶栏 64 + 外层内边距 + 标题块 + 底部控件。
  */
  height: var(--credits-stage-h, calc(100vh - 130px));
  max-width: 760px;
  margin: 0 auto;
}

.credits-headline {
  flex: 0 0 auto;
  margin-bottom: 14px;
}

/*
  条目窗口：撑满标题与底部控件之间的剩余空间。
  overflow:hidden ⇒ 滚动模式靠 translateY 移动内容，不产生原生滚动条，
  用户的滚轮/键盘因此仍然作用于页面本身（不劫持）。
  mask 让上/下边缘各有一段渐隐（电影片尾那种"淡出画外"），
  免得文字被硬生生切掉半行。渐隐区不影响可读区，中间整段仍是全不透明。
*/
.credits-window {
  position: relative;
  flex: 1 1 auto;
  min-height: 140px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 26px,
    #000 calc(100% - 26px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 26px,
    #000 calc(100% - 26px),
    transparent 100%
  );
}

/* reduced-motion 下退化成原生可滚动：不让自动滚，但用户必须还能自己滚着看全 */
.credits-window--scrollable {
  overflow-y: auto;
}

.credits-content {
  padding: 6px 4px 24px;
  will-change: transform;
}

.credits-content--fit {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  gap: 26px;
  padding-top: 12px;
  padding-bottom: 12px;
}

.credits-content--roll {
  display: block;
}

/* 放得下：居中留白 */
.credits-content--fit .credits-entry {
  text-align: center;
  max-width: 640px;
  transition: opacity 0.3s ease;
}

/* 两条时高亮当前那条、另一条压暗一点：既有名单感，又能看出在轮播 */
.credits-content--fit .credits-entry--dim {
  opacity: 0.42;
}

/* 放不下：按片尾那样一条条排开 */
.credits-content--roll .credits-entry {
  text-align: center;
  max-width: 640px;
  margin: 0 auto 34px;
}

.credits-content--roll .credits-entry:last-child {
  margin-bottom: 8px;
}

.credits-entry {
  /* 条目本身不吃事件，避免盖住底下的可交互元素 */
  pointer-events: none;
}

.credits-name {
  line-height: 1.24;
  word-break: break-word;
}

/* 字号按"条目多少"收放：1~2 条要大气，几十条不能糊满屏 */
.credits-name--big {
  font-size: 48px;
}

.credits-name--mid {
  font-size: 38px;
}

.credits-name--many {
  font-size: 34px;
}

.credits-name--roll {
  font-size: 27px;
}

.credits-intro {
  margin-top: 8px;
  line-height: 1.6;
}

.credits-note {
  margin-top: 4px;
  font-size: 0.78rem;
  line-height: 1.5;
}

.credits-footer {
  flex: 0 0 auto;
  padding-top: 14px;
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

.credits-foot {
  margin-top: 10px;
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

  .credits-content--fit .credits-entry {
    transition: none;
  }

  .credits-dot {
    transition: none;
  }
}
</style>
