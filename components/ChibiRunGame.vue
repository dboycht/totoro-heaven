<script setup lang="ts">
/**
 * 《龙猫天堂》跑酷 —— **直接使用 Chrome 离线小恐龙原版**
 *
 * ## 为什么是"直接抄"
 * 2026-10-30 用户指令原话：「你要不直接抄人家代码吧，你真写不好」。
 * 此前自写版本有基础缺陷（角色跳飞、画面模糊、下落过快、障碍躲不开），
 * 因此改为**原样嵌入 Chromium 的 `t-rex-runner`**：
 *   · `public/trex/runner.js`      —— 原版逻辑（唯一改动：`module.exports` → `window.Runner`）
 *   · `public/trex/resources.html` —— 原版精灵图与音效（**全部内嵌 base64，完全离线**）
 *   · `public/trex/style.css`      —— 原版样式
 *
 * ## 我们只动"外围"（2026-10-30 逐个实测定位，原版逻辑一行未改）
 *
 * ① **准备原版需要的 DOM**（精灵图 + 容器）。
 *
 * ② **高分屏上把 `devicePixelRatio` 抬到 2**：原版用 `IS_HIDPI` 选 1x / 2x 精灵图
 *    （`resources.html` 里两张都有），而普通屏可能正好是 1 ⇒ 一直用 1x 精灵再被 CSS 放大，
 *    **边缘发虚**。原版在脚本加载时就吃死了这个值，必须提前改。
 *
 * ③ **画面铺满整屏**：原版按 600×150 的"状态栏尺寸"素描（恐龙 44×47）。我们**不改这个逻辑尺寸**，
 *    而是调大内层容器与画布的 **CSS 宽高**，让原版的等比缩放机制把整幅画面放大 `s = 宽 / 600` 倍。
 *    原版每帧按"画布宽高"做碰撞与绘制 ⇒ 碰撞盒、速度（`WIDTH ≥ 600` 时恒为标准 6）、障碍间距**全部等比**。
 *    恐龙起始 `xPos`、分拣器 `calcXPos` 按画布像素坐标同步。
 *
 * ④ **接管两处"按初始尺寸写死"的地方**：
 *    - `clearCanvas` 只按 600×150 清屏 ⇒ 放大后右侧/下侧残留旧帧；换成清整块画布。
 *    - 待机画面的"双恐龙"：原版 init 先在 `xPos = 0` 画一只；只在**初始化那一次**把恐龙挪到 50·s 并重绘。
 *      ⚠️ 重绘**绝不能**用 `horizon.update(0, 0, true)` —— 那等于"以速度 0 重新摆一遍分拣器/地平线/云"，
 *      会把它们的旧像素画在初始位置，叠在正常帧下面 ⇒ 看起来**障碍永远停在屏幕右边、云不动**（曾整轮踩坑）。
 *      正确做法是清整块画布后只重画恐龙。
 *
 * ⑤ **监听作弊码** `↑↑↓↓←→←→BA`（原版自己处理按键，我们只搭顺风车），
 *    并把方向键 / 空格**在游戏页里拦掉默认滚动**，否则按方向键输作弊码时页面会滚走、恐龙被按得看不见。
 */
const emit = defineEmits<{
  /** 作弊码输入完成 */
  (e: 'unlock'): void
}>()

/** 原版实例里我们真正用到的部分（原版没有 .d.ts，只能按源码用法最小声明） */
interface TrexRunner {
  dimensions: { WIDTH: number; HEIGHT: number }
  canvas?: HTMLCanvasElement
  canvasCtx?: CanvasRenderingContext2D
  distanceMeter?: { calcXPos: (width: number) => void }
  tRex?: { xPos: number; yPos: number; jumping?: boolean; update?: (deltaTime: number, status?: string) => void }
  /** 原版清屏（只按初始逻辑尺寸）—— 我们要换成清整块画布 */
  clearCanvas?: () => void
}

const hostEl = ref<HTMLElement | null>(null)
let cleanup: (() => void) | null = null

const KONAMI = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right', 'b', 'a'] as const
type Key = (typeof KONAMI)[number]
const KEYMAP: Record<string, Key> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyA: 'a',
  KeyB: 'b',
}
let matched = 0
let fired = false

function feedKey(e: KeyboardEvent): void {
  if (fired) return
  const k = KEYMAP[e.code]
  if (!k) return
  if (k === KONAMI[matched]) {
    matched++
    if (matched === KONAMI.length) {
      fired = true
      emit('unlock')
    }
    return
  }
  const history: Key[] = [...KONAMI.slice(0, matched), k]
  for (let len = Math.min(history.length, KONAMI.length - 1); len >= 1; len--) {
    const tail = history.slice(history.length - len)
    if (tail.every((x, i) => x === KONAMI[i])) {
      matched = len
      return
    }
  }
  matched = 0
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) {
      resolve()
      return
    }
    const s = document.createElement('script')
    s.setAttribute('data-src', src)
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`加载失败：${src}`))
    document.head.appendChild(s)
  })
}

async function ensureResources(): Promise<void> {
  if (document.getElementById('offline-resources')) return
  const res = await fetch('/trex/resources.html')
  const html = await res.text()
  const holder = document.createElement('div')
  holder.innerHTML = html
  while (holder.firstChild) document.body.appendChild(holder.firstChild)
}

/**
 * 原版样式的**覆盖层**（在 style.css 之后加载，靠 !important 生效）。
 *
 * ⚠️ 原版把尺寸写死成 600px 宽、150px 高（`.interstitial-wrapper{max-width:600px}`、
 *    `.runner-container{max-width:600px;width:44px}`）—— 那是给 Chrome 错误页内嵌用的。
 *    这里只**放开上限**，实际尺寸交给 `applyGameScale`。
 */
function ensureStyle(): void {
  if (!document.querySelector('link[data-trex-style]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/trex/style.css'
    link.setAttribute('data-trex-style', '1')
    document.head.appendChild(link)
  }
  if (document.getElementById('trex-override')) return
  const style = document.createElement('style')
  style.id = 'trex-override'
  style.textContent = `
    /* ⚠️ 不要在这里写 width / height —— JS 用 setProperty(...,'important') 设尺寸，
       与内联 !important 同优先级时会按"后者胜"互相压住（实测踩到：布局函数算了尺寸却被 CSS 压回 100%）。 */
    .game-host.interstitial-wrapper {
      max-width: none !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: visible !important;
    }
    .game-host .runner-container {
      max-width: none !important;
      overflow: visible !important;
      /* ⚠️ 这里绝不能禁掉 intro 动画（曾经写过 animation:none，结果整局跑不动）：
         原版靠它的 webkitAnimationEnd 事件进入 startGame；playIntro 会停下主循环，事件不来 ⇒
         主循环永不恢复、update 的 deltaTime 恒为 0 ⇒ 分拣器/云/障碍全不动、撞不死、跑不完。
         实测症状：分数一直涨，但仙人掌钉在屏幕右边。
         开场那一下的宽度动画由 applyGameScale 在运行时单独关掉（只关动画副作用，不动事件链路）。*/
    }
    .game-host canvas.runner-canvas {
      position: absolute;
      top: 0;
      left: 0;
      max-width: none !important;
      display: block;
    }
    #offline-resources { display: none !important; }
  `
  document.head.appendChild(style)
}

/** 原版 `Runner.defaultDimensions = { WIDTH: 600, HEIGHT: 150 }`；恐龙起始 `x = 50`（`Trex.config.START_X_POS`） */
const BASE_W = 600
const BASE_H = 150
const BASE_PAD = 50

/**
 * 按原版自己的等比缩放机制把画面铺满视口（见文件头 ③④）。
 *
 * 尺寸算法：**画布按 4:1 等比铺满整个视口**（取宽、高两个方向里能放下的那个），居中显示
 * （4:1 的画面在 16:9 屏幕上必然上下留白，留白就是原版底色，不另补色）。
 *
 * @param host 外容器（原版 `outerContainerEl`，里面由原版建了 `.runner-container` 与画布）
 * @param runner 原版实例（用于按画布像素坐标同步分拣器 / 恐龙，并接管清屏范围）
 * @returns 解除监听的函数
 */
function applyGameScale(host: HTMLElement, runner: TrexRunner): () => void {
  let raf = 0
  let appliedKey = ''

  /** 清整块画布：原版只按初始逻辑尺寸（600×150）清屏，改大之后右侧/下侧会残留旧帧 */
  const clearAll = () => {
    const c = runner.canvas
    const ctx = runner.canvasCtx
    if (!c || !ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
  }
  const nativeClear = runner.clearCanvas?.bind(runner)
  if (nativeClear) {
    runner.clearCanvas = () => {
      nativeClear()
      clearAll()
    }
  }

  /**
   * 初始化那一次：把恐龙从 `xPos = 0` 挪到 `50·s` 并重画。
   * ⚠️ 只清屏 + 只重画恐龙；**不要**调 `horizon.update(0, 0, true)`（见文件头 ④）。
   */
  const placeTrex = (targetX: number) => {
    const trex = runner.tRex
    if (!trex) return
    trex.xPos = targetX
    clearAll()
    trex.update?.(0, 'WAITING')
  }

  const layout = () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 画布 4:1 等比铺满视口
    const w = Math.min(vw, Math.round(vh * (BASE_W / BASE_H)))
    const h = Math.round(w * (BASE_H / BASE_W))
    const s = w / BASE_W

    const key = `${w}x${h}`
    if (key === appliedKey) return
    appliedKey = key

    // 开场动画会把内层容器从 44px 撑到全宽（原版只为 600px 场景准备），与我们要的恒定尺寸打架 ⇒
    // 只抹掉动画带来的宽度变化，但不要禁掉整条动画链路（见 ensureStyle 里的警告）。
    const animTarget = host.querySelector<HTMLElement>('.runner-container')
    animTarget?.style.setProperty('animation-duration', '0.001s', 'important')

    host.style.setProperty('width', `${w}px`, 'important')
    host.style.setProperty('height', `${h}px`, 'important')
    host.style.setProperty('position', 'relative', 'important')

    const container = host.querySelector<HTMLElement>('.runner-container')
    if (container) {
      container.style.setProperty('width', `${w}px`, 'important')
      container.style.setProperty('height', `${h}px`, 'important')
    }
    const canvas = host.querySelector<HTMLCanvasElement>('canvas.runner-canvas')
    if (canvas) {
      // 原版只把缓冲按 dpr 放大，CSS 尺寸仍写着逻辑像素 ⇒ 换成与容器一致的尺寸
      canvas.style.setProperty('width', `${w}px`, 'important')
      canvas.style.setProperty('height', `${h}px`, 'important')
    }

    // 原版按画布逻辑尺寸算距离表 / 用户 x 坐标：缩放后按画布像素坐标同步（否则贴左缘、分拣器挤在 60px 处）
    if (runner.dimensions) runner.dimensions.WIDTH = w
    runner.distanceMeter?.calcXPos(w)
    placeTrex(Math.round(BASE_PAD * s))
  }

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      layout()
    })
  }

  layout()
  window.addEventListener('resize', schedule)
  return () => {
    window.removeEventListener('resize', schedule)
    if (raf) cancelAnimationFrame(raf)
    if (nativeClear) runner.clearCanvas = nativeClear
  }
}

function waitForWidth(el: HTMLElement, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve) => {
    const started = performance.now()
    const tick = () => {
      const w = el.offsetWidth
      if (w > 0) {
        resolve(w)
        return
      }
      if (performance.now() - started > timeoutMs) {
        resolve(0)
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

/**
 * ⚠️ **不要写成 onMounted(async () => …)**：组件 setup 一旦含顶层 await 就被拆成异步 setup，
 * 生命周期钩子会脱离组件实例（实测控制台警告：onMounted is called when there is no active component instance），
 * 于是卸载时 onBeforeUnmount 不触发、监听器无法解除。这里保持同步钩子 + 内部异步启动。
 */
onMounted(() => {
  void boot()
})

async function boot(): Promise<void> {
  try {
    ensureStyle()
    // ② 高分屏 ⇒ 抬到 2x，让原版选中 2x 精灵图（原版在脚本加载时就读死了这个值，必须提前改）
    if (window.devicePixelRatio > 1 && window.devicePixelRatio < 2) {
      Object.defineProperty(window, 'devicePixelRatio', { get: () => 2, configurable: true })
    }
    await ensureResources()
    await loadScript('/trex/runner.js')

    const host = hostEl.value
    const RunnerCtor = (window as unknown as { Runner?: new (el: Element) => unknown }).Runner
    if (!host || !RunnerCtor) return

    host.classList.add('interstitial-wrapper', 'game-host')
    const w = await waitForWidth(host)
    if (!(w > 0)) {
      console.error('[play] 容器宽度为 0，无法初始化')
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-new
    const runner = new (RunnerCtor as unknown as new (el: Element) => unknown)(host) as TrexRunner

    // ③ 画面放大 / 铺满 / 居中（见文件头 ③④）
    const detachScale = applyGameScale(host, runner)

    // ⑤ 游戏页里拦掉方向键 / 空格的默认滚动 —— 否则按方向键输作弊码时页面滚走、恐龙被按得看不见
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown'])
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.code)) e.preventDefault()
      feedKey(e)
    }
    window.addEventListener('keydown', onKey, true)
    cleanup = () => {
      window.removeEventListener('keydown', onKey, true)
      detachScale()
    }
  } catch (err) {
    console.error('[play] 小恐龙资源加载失败：', err)
  }
}

onBeforeUnmount(() => {
  cleanup?.()
})
</script>

<template>
  <div class="trex-host-wrap">
    <div ref="hostEl" class="trex-host game-host" />
  </div>
</template>

<style scoped>
/* 游戏占满整屏：画布按 4:1 等比放大，四周不留白（"不是全屏"是用户 2026-10-30 的明确抱怨） */
.trex-host-wrap {
  width: 100%;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.trex-host {
  width: 100%;
}
</style>
