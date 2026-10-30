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
 * ③ **画面铺满整屏**：原版按 600×150 的"状态栏尺寸"素描（恐龙 44×47；速度在 `WIDTH ≥ 600` 时恒为标准 6）。
 *    我们**不放大素材**：逻辑高固定 150（CSS 高 = 视口高，1:1 最清晰），只把**画布宽**改成视口宽，
 *    并同步 `dimensions.WIDTH`（障碍出生点）、地平线段宽、分拣器 x —— 于是恐龙离左边缘恒为 50px、
 *    地平线铺满整屏、障碍从屏幕最右端生成。
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
    /* 画布满视口，内容由 JS 等比缩放后底部居中绘制（见 applyGameScale） */
    .game-host canvas.runner-canvas {
      position: absolute;
      inset: 0;
      max-width: none !important;
      display: block;
    }
    #offline-resources { display: none !important; }
  `
  document.head.appendChild(style)
}

/**
 * 原版的逻辑尺寸是 600×150（`Runner.defaultDimensions`），恐龙 44×47、起始 `x = 50`。
 *
 * ## 缩放策略（2026-10-30，用户两轮反馈"太窄/偏左/太小"之后定稿）
 * 把**整幅原版画面**等比放大 `Kx` 倍（`Kx = min(视口宽/600, 视口高/150)`），在画布内**底部居中**绘制：
 *   - 画布 = 视口尺寸，缓冲与 CSS 同尺寸 ⇒ 不拉伸、不模糊；
 *   - 绘制用 `ctx.setTransform(Kx, 0, 0, Kx, offX, offY)` ⇒ 素材比例不变、整体清晰；
 *   - 画布 CSS 在**整块视口**上再放一个"逻辑换算"：`translate((1−Kx)/2, (150−视口高/Kx))`，
 *     让原版按 600×150 的逻辑坐标绘制时正好落在上面那块区域里；
 *   - 恐龙按 **CSS 像素**定位（离左边缘恒为 `TREX_LEFT_PX`），不随倍率越推越远；
 *   - 地平线段宽恒为 600 逻辑像素，横向铺满（`drawImage` 在 transform 下自动平铺）。
 *
 * ⚠️ 反面教训（都踩过）：把倍率乘在 50 / 600 上 ⇒ "离左边缘多远/地平线断在哪"全被放大（偏左）；
 *    只拉 CSS 不改缓冲 ⇒ 糊；改画布高度后仍按原逻辑算 y ⇒ 内容缩在顶上一条带里。
 */
const BASE_W = 600
const BASE_H = 150
/** 恐龙离左边缘的距离（CSS 像素，不随倍率变化） */
const TREX_LEFT_PX = 50
/** 分拣器距右边缘的距离（逻辑像素；原版 `DEST_WIDTH × (位数+1)` ≈ 66） */
const METER_RIGHT_PX = 66

/** 原版实例里我们额外要用到的字段 */
interface TrexHorizon {
  obstacles: { xPos: number; width: number }[]
  horizonLine?: { dimensions: { WIDTH: number } }
}

function applyGameScale(host: HTMLElement, runner: TrexRunner): () => void {
  let raf = 0
  let appliedKey = ''

  /** 清整块画布（缓冲像素）：加宽之后右侧会残留旧帧 */
  const clearAll = () => {
    const c = runner.canvas
    const ctx = runner.canvasCtx
    if (!c || !ctx) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.restore()
  }
  const nativeClear = runner.clearCanvas?.bind(runner)
  if (nativeClear) {
    runner.clearCanvas = () => {
      nativeClear()
      clearAll()
    }
  }

  /** 恐龙归位并重画待机画面（⚠️ 不要调 horizon.update(0,0,true)，见文件头 ④） */
  const placeTrex = () => {
    const trex = runner.tRex
    if (!trex) return
    trex.xPos = trexXLogical()
    clearAll()
    trex.update?.(0, 'WAITING')
  }

  /** 绘制倍率（画布逻辑坐标 → CSS 像素）；地平线段宽等也用它换算 */
  let Kx = 1
  /** 恐龙 x（逻辑坐标）：视觉位置恒为 TREX_LEFT_PX 个 CSS 像素 ⇒ 除以倍率换算回逻辑坐标 */
  const trexXLogical = () => Math.round(TREX_LEFT_PX / Kx)

  const layout = () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 等比放大：宽度铺满；若放大后"地面"会顶出屏幕上缘，则改由高度定倍率（画面整体缩小、上下居中）
    const kxByW = vw / BASE_W
    Kx = Math.min(kxByW, vh / BASE_H)
    // 左右居中：多出来的宽度（或高度）平均分到两边
    const drawW = BASE_W * Kx
    const drawH = BASE_H * Kx
    const offX = (vw - drawW) / 2
    const offY = vh - drawH

    const key = `${vw}x${vh}`
    if (key === appliedKey) return
    appliedKey = key

    host.style.setProperty('width', `${vw}px`, 'important')
    host.style.setProperty('height', `${vh}px`, 'important')
    host.style.setProperty('position', 'relative', 'important')

    const container = host.querySelector<HTMLElement>('.runner-container')
    if (container) {
      // 开场动画会把内层容器从 44px 撑到全宽（与恒定尺寸打架）⇒ 压到瞬时；
      // ⚠️ 但**不能**禁掉动画本身：原版靠它的 animationend 才进入 startGame（见 ensureStyle 的警告）。
      container.style.setProperty('animation-duration', '0.001s', 'important')
    }

    const canvas = runner.canvas
    const ctx = runner.canvasCtx
    if (canvas) {
      // 缓冲 = CSS 尺寸（不拉伸）；再按 K 缩放绘制 + 水平居中原点
      canvas.width = vw
      canvas.height = vh
      canvas.style.setProperty('width', `${vw}px`, 'important')
      canvas.style.setProperty('height', `${vh}px`, 'important')
    }
    if (ctx) {
      ctx.setTransform(Kx, 0, 0, Kx, offX, offY)
    }

    // 原版按"画布逻辑尺寸"决定障碍出生点 / 地平线折返 / 地面高度：
    // 逻辑宽恒为 600；逻辑高 = 视口高 / Kx（这样地面正好落在屏幕底部）
    const logicalH = vh / Kx
    if (runner.dimensions) runner.dimensions.WIDTH = BASE_W
    if (runner.dimensions) runner.dimensions.HEIGHT = logicalH
    const horizon = (runner as TrexRunner & { horizon?: TrexHorizon }).horizon
    if (horizon?.horizonLine?.dimensions) horizon.horizonLine.dimensions.WIDTH = BASE_W
    // 分拣器：贴右边缘（逻辑坐标 = 视口宽/K − 66/K）
    const meter = runner.distanceMeter as { calcXPos: (w: number) => void } | undefined
    if (meter) meter.calcXPos(Math.round(BASE_W - METER_RIGHT_PX / Kx))
    if (runner.tRex) runner.tRex.xPos = trexXLogical()
  }

  const schedule = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      layout()
    })
  }

  layout()
  placeTrex()
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
