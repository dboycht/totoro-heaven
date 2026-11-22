/**
 * Mac 版启动器（2026-11-22）—— Windows SEA EXE（`pack/sea/launcher.mjs`）的 Mac 对应体验：
 * 双击 `totoro-heaven-mac.command`（或 `npm run mac`）⇒ 起 `.output` 里的本地服务 + 自动开浏览器。
 *
 * ## 与 Windows launcher 的同源语义（逐条对齐）
 *   ① **端口段探测** 3000~3020（`pickPort`）：已被**本工具**占用（页面特征 `龙猫天堂`/`Totoro Heaven`）
 *      ⇒ 打开浏览器指向它并退出（不重复起服务）；被**别的程序**占 ⇒ 顺延下一可用端口；
 *   ② **启动锁单实例**（E90 同源）：`startup.lock`（含持锁 PID）—— 对方活着 ⇒ 优雅等待，
 *      等待中认出对方服务已就绪 ⇒ 转去打开浏览器并退出；持锁进程已死 ⇒ 清陈旧锁照常启动；
 *      锁在**服务已监听之后**才放（刚等来锁的实例先做 1.2s 缓冲复查，避免清掉对方正在服务的现场）；
 *   ③ **只绑本机 loopback**：`NITRO_HOST`/`HOST` 缺省 `127.0.0.1`（用户显式设置时不覆盖）——
 *      这个工具读写本人校园跑凭据，绝不能被局域网访问；
 *   ④ **端口强制覆盖**（2026-09-20 审计）：`NITRO_PORT`/`PORT` 无条件写入，不给外部残留变量留后门；
 *   ⑤ **退场前等子进程收尾**（E111）：`open` 命令 await 完成再 `exit(0)`（3s 兜底）——
 *      浏览器是 `open` 拉起的独立进程，不受本进程生死影响；父进程先退不会把"最后一步"杀掉；
 *   ⑥ 终端横幅复用 `pack/sea/banner.mjs`（**单一来源**）：启动即伪装口径（disguised），
 *      游戏里输作弊码后才打完整横幅（full，§71）。
 *
 * ## 与 Windows launcher 的差异（有意为之）
 *   · 不做 SEA：直接 in-process `import` 仓库里 `nuxt build` 的产物 `.output/server/index.mjs`
 *     （与 EXE 的 in-process import 同机制）；产物缺失时**自动 `npm run build`**（进度可见）；
 *   · 版本号运行时读 `package.json`（EXE 是构建期 esbuild 注入 `__APP_VERSION__`）；
 *   · 开浏览器用 macOS `open`（Windows 是 `start`）；失败提示用「回车关闭」替代 `pause`；
 *   · `TOTORO_NO_BROWSER=1` 不开浏览器（探针/自动化验证用）。
 *
 * ⚠️ 「一键获取 token」扫描器只支持 Windows（Win32 调试 API 读微信进程内存）——这与启动器无关，
 *    是应用内 UI/端点的事（见 `composables/useClientPlatform.ts` 与 `tokenScanScript.ts` 硬闸）。
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { exec, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { buildBanner } from '../sea/banner.mjs'

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..')
const APP_VERSION = String(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '')
const ENTRY = path.join(REPO_ROOT, '.output', 'server', 'index.mjs')
const RUNTIME_DIR = path.join(os.tmpdir(), 'totoro-heaven-runtime')
const LOCK_FILE = path.join(RUNTIME_DIR, 'startup.lock')
const NO_BROWSER = process.env.TOTORO_NO_BROWSER === '1'

const PREFERRED_PORT = (() => {
  const n = Number(process.env.TOTORO_PORT)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000
})()
let PORT = PREFERRED_PORT
const banner = (variant) => buildBanner({ variant, version: APP_VERSION, port: PORT })

/* ===== 端口探测（与 launcher.mjs 逐字同语义）===== */

/** 该端口上是否已经跑着本工具（用页面特征判断，避免把别人的服务当自己的） */
async function looksLikeOurApp(port) {
  try {
    const ctrl = new AbortController()
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

/* ===== 退场前的"最后一步"必须等子进程跑完（E111 语义，见 launcher.mjs 同名助手）===== */

const openBrowserThenExit = async (url) => {
  if (!NO_BROWSER) {
    await Promise.race([
      new Promise((resolve) => exec(`open ${url}`, () => resolve())),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
  }
  process.exit(0)
}

/** 失败路径：让用户来得及看错误再关窗。双击 .command 时 stdin 是 TTY ⇒ 等回车；
 *  脚本/自动化（无 TTY）⇒ 直接退出，不挂。60s 兜底防挂。 */
const pauseThenExit = async (code = 1) => {
  console.error('\n（按回车关闭…）')
  await Promise.race([
    new Promise((resolve) => {
      if (process.stdin.isTTY) process.stdin.once('data', () => resolve())
      else resolve()
    }),
    new Promise((resolve) => setTimeout(resolve, 60000)),
  ])
  process.exit(code)
}

async function pickPort() {
  for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + 20; p++) {
    if (await looksLikeOurApp(p)) {
      console.log(`  ℹ 检测到本工具已在 http://localhost:${p}/ 运行，直接打开浏览器（不再重复启动服务）。`)
      console.log('  ℹ 原因：同一时间只应运行一个本程序实例（多个实例会互相抢端口与锁）。')
      await openBrowserThenExit(`http://localhost:${p}/`)
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
      `    TOTORO_PORT=4000 npm run mac\n`,
  )
  await pauseThenExit()
}

/* ===== 启动锁（与 launcher.mjs 同语义：PID 锁 + 陈旧锁自清 + 等待中转开浏览器）===== */

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireStartupLock() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    // 等待期间对方可能已把服务起起来 ⇒ 直接打开浏览器退出，绝不往下走
    if (attempt > 0 && attempt % 2 === 0 && (await looksLikeOurApp(PREFERRED_PORT))) {
      console.log(`  ℹ 本工具已在 http://localhost:${PREFERRED_PORT}/ 运行，直接打开浏览器。`)
      await openBrowserThenExit(`http://localhost:${PREFERRED_PORT}/`)
    }
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return attempt // 0 = 没等过锁（用作"要不要缓冲复查"的依据）
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let holder = 0
      try {
        holder = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
      } catch {
        /* 锁刚被释放 ⇒ 下轮重试创建 */
      }
      if (!holder || !pidAlive(holder)) {
        fs.rmSync(LOCK_FILE, { force: true })
        continue
      }
      if (attempt === 0) {
        console.log('  ℹ 检测到另一个实例正在启动（构建/起服务中），等待它完成…')
      }
      if (attempt >= 60) {
        console.error('启动失败：另一个实例长时间未完成启动。请关闭所有本程序窗口后重试；')
        console.error(`若反复出现，删除这个临时目录后再试：  ${RUNTIME_DIR}`)
        await pauseThenExit()
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

function releaseStartupLock() {
  try {
    const holder = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
    if (holder === process.pid) fs.rmSync(LOCK_FILE, { force: true })
  } catch {
    /* 没有锁可放 —— 尽力而为 */
  }
}

/* ===== 构建 + 起服务 ===== */

/** 产物缺失 ⇒ 自动 `npm run build`（进度可见）；失败 ⇒ 提示 + 等回车再退 */
function ensureBuilt() {
  if (fs.existsSync(ENTRY)) return true
  console.log('  ℹ 首次启动：还没有构建产物（.output），先跑 `npm run build`（约 1 分钟，只需一次）…')
  const r = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', cwd: REPO_ROOT })
  if (r.status !== 0) {
    console.error('启动失败：`npm run build` 失败（上方是它的输出）。若是缺依赖，先跑 `npm install` 再试。')
    return false
  }
  if (!fs.existsSync(ENTRY)) {
    console.error(`启动失败：构建完成但找不到产物：${ENTRY}`)
    return false
  }
  return true
}

/** 服务就绪后开浏览器（父进程常驻 ⇒ exec 竞态不存在；仍 await 以防万一） */
function openBrowserWhenReady() {
  if (NO_BROWSER) return
  const probe = setInterval(() => {
    fetch(`http://127.0.0.1:${PORT}/`)
      .then((r) => {
        if (r.ok) {
          clearInterval(probe)
          exec(`open http://localhost:${PORT}/`)
        }
      })
      .catch(() => {
        /* server not ready yet */
      })
  }, 500)
}

async function main() {
  // ① 先定端口（可能顺延；若已有本工具在跑就直接打开浏览器并退出）
  PORT = await pickPort()
  // ② 端口与地址强制覆盖（与 launcher.mjs 同判据：只绑 loopback、不给残留环境变量留后门）
  process.env.NITRO_PORT = String(PORT)
  process.env.PORT = String(PORT)
  process.env.NITRO_HOST = process.env.NITRO_HOST || '127.0.0.1'
  process.env.HOST = process.env.HOST || '127.0.0.1'
  // ③ 横幅（启动即伪装口径，§71）
  console.log(banner('disguised'))
  // ④ 产物检查（缺失自动构建）
  if (!ensureBuilt()) await pauseThenExit()
  // ⑤ 启动锁（单实例；等来的锁做缓冲复查，见 acquireStartupLock）
  const waitedAttempts = await acquireStartupLock()
  if (waitedAttempts > 0) {
    // 刚等来的锁：对方刚放锁、可能还在 import→listen 的路上 ⇒ 1.2s 缓冲复查（E90 同源）
    await new Promise((r) => setTimeout(r, 1200))
    if (await looksLikeOurApp(PORT)) {
      releaseStartupLock()
      console.log(`  ℹ 本工具已在 http://localhost:${PORT}/ 运行（另一个实例先启动完了），直接打开浏览器。`)
      await openBrowserThenExit(`http://localhost:${PORT}/`)
    }
  }
  // ⑥ 服务就绪后开浏览器
  openBrowserWhenReady()
  // ⑦ 解锁通知钩子（§71）：浏览器端输作弊码后由本地服务调用（同 launcher.mjs）
  let unlockAnnounced = false
  globalThis.__TOTORO_ON_UNLOCK__ = () => {
    if (unlockAnnounced) return
    unlockAnnounced = true
    console.log(banner('full'))
  }
  // ⑧ in-process 起服务（与 EXE 同机制；import 返回即已监听）
  await import(pathToFileURL(ENTRY).href)
  // ⑨ 服务已监听 ⇒ 放锁（之后的第二个实例会被 pickPort 的"已在运行"路径接走）
  releaseStartupLock()
}

process.on('SIGINT', () => {
  releaseStartupLock()
  process.exit(0)
})
process.on('SIGTERM', () => {
  releaseStartupLock()
  process.exit(0)
})

main().catch(async (e) => {
  releaseStartupLock()
  console.error('启动失败:', e)
  await pauseThenExit()
})
