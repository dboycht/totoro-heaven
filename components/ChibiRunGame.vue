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
 * ## 我们只动"外围"，绝不动原版逻辑（2026-10-30 实测逐个定位后敲定）
 *
 * ① **准备原版需要的 DOM**（精灵图 + 容器）。
 *
 * ② **高分屏上把 `devicePixelRatio` 抬到 2**：原版用 `IS_HIDPI` 选 1x / 2x 精灵图
 *    （`resources.html` 里两张都有），而普通笔记本屏 `devicePixelRatio` 可能正好是 1
 *    ⇒ 一直用 1x 精灵再被 CSS 放大，**边缘发虚**。原版在脚本加载时就吃死了这个值，必须提前改。
 *    ⚠️ 副作用：原版 `updateCanvasScaling` 会因 `dpr ≠ backingStore` 把**画布缓冲**放大 ×2，
 *    同时把 `canvas.style.width/height` 写成逻辑尺寸 —— 正好是我们要的效果。
 *
 * ③ **画面铺满整屏**：原版按 600×150 的"状态栏尺寸"素描（恐龙 44×47），但我们不改这个逻辑尺寸，
 *    而是**调大内层容器与画布的 CSS 宽高**，让原版的等比缩放机制把整幅画面放大 `s = 宽 / 600` 倍。
 *    原版每帧按"画布宽高"做碰撞与绘制，所以**碰撞盒、速度（`WIDTH ≥ 600` 时恒为标准 6）、障碍间距全部等比**，
 *    手感与原版一致、只是看得更清楚。恐龙起始位置 `xPos`、分拣器 `calcXPos` 按画布像素坐标同步。
 *    同时接管 `clearCanvas`：原版只按初始 600×150 清屏，改大后会残留旧帧（实测：恐龙身后一串虚影）。
 *
 * ④ **不补遮罩、不留边缝**：画布按 4:1 等比铺满视口后居中，上下余量本就是底色（`#f7f7f7`）
 *    ⇒ 整块就是"全屏游戏"，没有第二种颜色打架（上一版留了黑边，用户看到的就是"不是全屏"）。
 *
 * ⑤ **监听作弊码** `↑↑↓↓←→←→BA`（原版自己处理按键，我们只搭顺风车）；
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
  tRex?: { xPos: number; update?: (deltaTime: number, status?: string) => void }
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
 *    这里让外容器铺满，内层容器交给 `applyGameScale` 按倍率给尺寸。
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
    /* 原版写死的 600px 上限 / 44px 起始宽全部放开，尺寸由 applyGameScale 决定 */
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
      /* 开始后原版会塞 -webkit-animation: intro（把 inner 从 44px 撑到全宽）；
         我们不用它 —— 尺寸保持恒定，免得一上来闪一下 */
      animation: none !important;
      -webkit-animation: none !important;
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
 * 尺寸算法：**画布按 4:1 等比铺满整个视口**（取宽、高两个方向里能放下的那个），
 * 再把画布居中 —— 这样没有上下黑边/白边（4:1 的画面在 16:9 屏幕上必然留白，
 * 与其补色不如把留白也算进画面，地平线随之下移到画面下方 1/4 处）。
 *
 * @param host 外容器（原版 `outerContainerEl`，里面由原版建了 `.runner-container` 与画布）
 * @param runner 原版实例（用于按画布像素坐标重新居中分拣器 / 恐龙，并接管清屏范围）
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

  // 初始化时原版先在 xPos = 0 画了一只恐龙，再靠 intro 动画挪到 50 ⇒ 改坐标前画面上会
  
  // 同时出现两只（实测截到）。这里清一次屏并按原版方式重画待机画面。
  const redrawIdle = () => {
    const r = runner as TrexRunner & { horizon?: { update: (...a: unknown[]) => void } }
    clearAll()
    r.horizon?.update(0, 0, true)
    // 原版 init 里就是 `update(0, Trex.status.WAITING)` 画出待机恐龙；不传状态时它不会重画
    r.tRex?.update?.(0, 'WAITING')
  }

  const layout = () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 画布 4:1 等比铺满视口
    const w = Math.min(vw, Math.round(vh * (BASE_W / BASE_H)))
    const h = Math.round(w * (BASE_H / BASE_W))
    const s = w / BASE_W
    const letterbox = Math.max(0, Math.round((vh - h) / 2))

    const key = `${w}x${h}@${letterbox}`
    if (key === appliedKey) return
    appliedKey = key

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
    if (runner.tRex) runner.tRex.xPos = Math.round(BASE_PAD * s)
    redrawIdle()
    return letterbox
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

    // ③ 画面放大 / 留白 / 居中（见文件头 ③④）
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
