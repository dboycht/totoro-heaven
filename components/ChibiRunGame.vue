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
 * ## 我们只做三件事
 *   ① 准备原版需要的 DOM（精灵图 + 容器）；
 *   ② **覆盖原版 CSS 的 600px 宽度上限**，让它铺满页面（原版面向 Chrome 内嵌页面，故意写死 600）；
 *   ③ 监听作弊码 `↑↑↓↓←→←→BA`（原版自己处理方向键/空格，我们只搭顺风车）。
 */
const emit = defineEmits<{
  /** 作弊码输入完成 */
  (e: 'unlock'): void
}>()

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
 *    这里让容器**铺满**、画布**等比放大**，否则就是"小恐龙缩在左上角一小块"（实测踩到）。
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
  /**
   * ⚠️ 缩放策略：原版画布的逻辑尺寸是 **600×150**（`Runner.config.WIDTH/HEIGHT`），
   *    画面靠 CSS 放大。**不能只拉宽** —— 那样会横向拉伸、精灵变形（实测踩到：恐龙被压扁）。
   *    正确做法：容器固定 `width:100%; max-width:1200px`，画布 `width:100%; height:auto`
   *    ⇒ 浏览器按比例等比放大（宽高比锁死在 4:1）。
   */
  style.textContent = `
    .game-host.interstitial-wrapper {
      max-width: none !important;
      width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .game-host .runner-container {
      max-width: none !important;
      width: 100% !important;
      height: auto !important;
      overflow: hidden;
    }
    .game-host canvas.runner-canvas,
    .game-host .runner-canvas {
      max-width: none !important;
      width: 100% !important;
      height: auto !important;
      aspect-ratio: 600 / 150;
      display: block;
      image-rendering: auto;
    }
    #offline-resources { display: none !important; }
  `
  document.head.appendChild(style)
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

onMounted(async () => {
  try {
    ensureStyle()
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
    new (RunnerCtor as unknown as new (el: Element) => unknown)(host)

    const onKey = (e: KeyboardEvent) => feedKey(e)
    window.addEventListener('keydown', onKey, true)
    cleanup = () => window.removeEventListener('keydown', onKey, true)
  } catch (err) {
    console.error('[play] 小恐龙资源加载失败：', err)
  }
})

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
.trex-host-wrap {
  width: 100%;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  box-sizing: border-box;
}
.trex-host {
  width: 100%;
}
</style>
