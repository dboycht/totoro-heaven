import { isSea, getAsset } from 'node:sea'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { exec } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'
import { buildBanner } from './banner.mjs'

const RUNTIME_DIR = path.join(os.tmpdir(), 'totoro-heaven-runtime')
/**
 * 期望端口（可用环境变量覆盖）。**实际端口在运行时才定**：
 * 若它被占用，会自动顺延到下一个可用端口（见 `pickPort`），
 * 并把最终端口写进 `process.env` / 用于打印与打开浏览器。
 */
const PREFERRED_PORT = (() => {
  const n = Number(process.env.TOTORO_PORT)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000
})()
let PORT = PREFERRED_PORT
const ASSET_KEY = 'app.tar.gz'

/* ===== 端口处理（2026-09-18：修"端口被占就崩"）=====
 * 实测问题：3000 被别的实例/dev 服务占用时，Nitro 直接抛
 * `Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`，
 * 用户只看到一大段栈、程序退出 —— 既没说是端口冲突、也没告诉怎么办。
 * 处理策略（三步，全部是"用户看得懂的行为"）：
 *   ① 该端口上已经跑着**本工具**（探测到页面特征）⇒ 直接打开浏览器、本进程退出（不重复起服务）；
 *   ② 该端口被**别的程序**占用 ⇒ 从 preferred+1 起找一个可用端口，用那个端口启动；
 *   ③ 连续若干端口都被占 ⇒ 打印一句人话再退出。
 */
const numOrNull = (line) => {
  const v = Number(String(line).trim())
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : null
}

/** 该端口上是否已经跑着本工具（用页面特征判断，避免把别人的服务当自己的） */
async function looksLikeOurApp(port) {
  try {
    const ctrl = new AbortController()
    // ⚠️ 2026-09-21（审计）：原先 1200ms —— 冷启动时页面可能还没吐出来，会被判"不是本程序"，
    // 进而在"3000 被自家占用"时顺延出第二个实例（共享同一解包目录 ⇒ 互相踩）。放宽到 3 秒。
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const html = await res.text()
    return html.includes('龙猫天堂') || html.includes('Totoro Heaven')
  } catch {
    return false
  }
}

/** 探测"端口是否空闲"（能绑上就是空闲；绑完立刻释放） */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

async function pickPort() {
  /**
   * ⚠️ **2026-09-21 结构性修复（审计 B3）**：**探测整个候选端口段**，而不是只看首选端口。
   *
   * 原先只探 3000：若 3000 被别的程序占用、本程序已顺延到 3001，用户再双击一次时 3000 上不是我们的服务
   * ⇒ 起**第二个实例**；而第二个实例启动时会清空并重解包**共享目录**（`%TEMP%\totoro-heaven-runtime`）
   * ⇒ 正在服务的第一个实例开始偶发 500/`ERR_MODULE_NOT_FOUND`。
   * 判据：**"本工具是否已在运行"必须在整个候选端口段上判断**（空闲端口探测失败是瞬时的，代价可忽略）。
   */
  for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + 20; p++) {
    if (await looksLikeOurApp(p)) {
      console.log(`  ℹ 检测到本工具已在 http://localhost:${p}/ 运行，直接打开浏览器（不再重复启动服务）。`)
      console.log('  ℹ 原因：同一时间只应运行一个本程序实例（多个实例会共用同一个临时解包目录，可能互相影响）。')
      exec(`start http://localhost:${p}/`)
      process.exit(0)
    }
  }
  for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + 20; p++) {
    if (await isPortFree(p)) {
      if (p !== PREFERRED_PORT) {
        console.log(`  ℹ 端口 ${PREFERRED_PORT} 已被其它程序占用，本次改用 ${p}。`)
      }
      return p
    }
  }
  console.error(
    `\n启动失败：端口 ${PREFERRED_PORT}~${PREFERRED_PORT + 20} 都被占用了。\n` +
      `请关掉占用这些端口的程序后重试，或用环境变量指定别的端口，例如：\n` +
      `    set TOTORO_PORT=4000 && totoro-heaven.exe\n`,
  )
  exec('pause')
  process.exit(1)
}

/**
 * 🔒 只绑本机 loopback：这个工具会读写**你本人的校园跑凭据**，绝不能被局域网访问。
 * Nitro 的 node-server 预设默认可能绑 0.0.0.0 → 这里显式收紧（用户显式设置 HOST 时不覆盖）。
 * ⚠️ 端口相关环境变量**在 pickPort() 之后**再写（见 main），否则会用到还没确定的 PORT。
 */
process.env.NITRO_HOST = process.env.NITRO_HOST || '127.0.0.1'
process.env.HOST = process.env.HOST || '127.0.0.1'
// NITRO_PORT / PORT 在 pickPort() 确定后写入（见 main）

// 打包脚本会把这行占位符替换为实际版本号
const APP_VERSION = '__APP_VERSION__'

/* ===== 终端横幅：实现在 ./banner.mjs（esbuild 打包时内联；单测与最小化 demo 共用同一份）=====
 * 两个变体：disguised（启动默认，小游戏口径）/ full（作弊码解锁后，与原版逐字一致，见 E88 同期的 §71）。 */
const banner = (variant) => buildBanner({ variant, version: APP_VERSION, port: PORT })

async function extractAssets() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  /**
   * ⚠️ 先清掉上一次解出来的 `server/` 与 `public/` 再解包：
   * 否则新版本与旧版本的残留会**混在同一个目录**里（实测：升到 1.1.9 后 temp 里仍留着 1.1.6 的贺图等文件），
   * 既占磁盘、也可能让"看到的页面"和"当前版本"不一致。`tar.x` 只覆盖同名文件、不会删除已消失的文件。
   */
  for (const sub of ['server', 'public']) {
    try {
      fs.rmSync(path.join(RUNTIME_DIR, sub), { recursive: true, force: true })
    } catch {
      /* 尽力而为：删不掉（例如被占用）也不影响本次启动，继续解包覆盖即可 */
    }
  }
  const buf = Buffer.from(getAsset(ASSET_KEY))
  const archive = path.join(RUNTIME_DIR, ASSET_KEY)
  fs.writeFileSync(archive, buf)
  await tar.x({ file: archive, cwd: RUNTIME_DIR })
  fs.rmSync(archive, { force: true })
}

function openBrowserWhenReady() {
  const probe = setInterval(() => {
    fetch(`http://127.0.0.1:${PORT}/`)
      .then((r) => {
        if (r.ok) {
          clearInterval(probe)
          exec(`start http://localhost:${PORT}/`)
        }
      })
      .catch(() => {
        /* server not ready yet */
      })
  }, 500)
}

async function main() {
  if (!isSea()) {
    console.error('此 EXE 须以打包后的 SEA 单文件运行（直接双击即可）。')
    process.exit(1)
  }
  // ① 先定端口（可能顺延；若已有本工具在跑就直接打开浏览器并退出）
  PORT = await pickPort()
  /**
   * ⚠️ 2026-09-20 审计修复（端口必须**强制覆盖**）：原先写 `process.env.NITRO_PORT || String(PORT)`，
   * 只要父进程/shell 里残留 `NITRO_PORT`（或 Windows 用户环境变量里设过，含无效空串），
   * 服务就会绑那个**旧端口**，而横幅与自动打开的浏览器用的是本次 `pickPort()` 选出的端口
   * ⇒ 用户看到"白页 / 打不开"，甚至点开的是**别的程序**。
   * 期望端口的唯一入口是 `TOTORO_PORT`（`pickPort` 已经消费它），这里不再给外部变量留后门。
   */
  process.env.NITRO_PORT = String(PORT)
  process.env.PORT = String(PORT)
  // ② 横幅要显示**实际**端口，所以放到定端口之后再打印；启动即**伪装口径**（§71）
  console.log(banner('disguised'))
  await extractAssets()
  const entry = path.join(RUNTIME_DIR, 'server', 'index.mjs')
  console.log(`Server assets ready at ${RUNTIME_DIR}`)
  openBrowserWhenReady()
  // ③ 解锁通知钩子（§71，2026-10-31 用户要求）：浏览器端在游戏里输入作弊码后，
  //    本地服务（与 launcher **同进程**，见下面这行的 in-process import）调用这个钩子，
  //    终端此时才打印与原版逐字一致的完整横幅（「阳光跑助手 · 本地 Web 服务」）。
  //    幂等：作弊码可反复输、页面可刷新，只打一次；dev（npm run dev）不经过 launcher ⇒ 钩子不存在、自然空转。
  let unlockAnnounced = false
  globalThis.__TOTORO_ON_UNLOCK__ = () => {
    if (unlockAnnounced) return
    unlockAnnounced = true
    console.log(banner('full'))
  }
  await import(pathToFileURL(entry).href)
}

main().catch((e) => {
  console.error('启动失败:', e)
  exec('pause')
  process.exit(1)
})