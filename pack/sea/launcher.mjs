import { isSea, getAsset } from 'node:sea'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { exec } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'

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

/* ===== 终端横幅：FIGlet slant 字体 + 科技风配色 ===== */
const esc = (code) => `\u001b[${code}m`
const CLR = {
  reset: esc(0),
  bold: esc(1),
  italic: esc(3),
  cyan: esc(36),
  green: esc(32),
  yellow: esc(33),
  magenta: esc(35),
  blue: esc(34),
  white: esc(37),
  dim: esc(2),
}

/* ===== 终端横幅：FIGlet slant 字体艺术字 + 科技风配色 ===== */
// FIGlet slant 渲染的 "TOTORO HEAVEN"（npx figlet -f slant 生成）
const TITLE_LINES = [
  '  __________  __________  ____  ____     __  ___________ _    _________   __',
  ' /_  __/ __ \\/_  __/ __ \\/ __ \\/ __ \\   / / / / ____/   | |  / / ____/ | / /',
  '  / / / / / / / / / / / / /_/ / / / /  / /_/ / __/ / /| | | / / __/ /  |/ /',
  ' / / / /_/ / / / / /_/ / _, _/ /_/ /  / __  / /___/ ___ | |/ / /___/ /|  /',
  '/_/  \\____/ /_/  \\____/_/ |_|\\____/  /_/ /_/_____/_/  |_|___/_____/_/ |_/',
]

// 文本显示宽度：全角（CJK）字符计 2 列，其它（含 ANSI 码剔除后）计 1 列
const displayWidth = (s) => {
  let w = 0
  for (const ch of s) {
    w += (ch.codePointAt(0) > 0x1fff) ? 2 : 1
  }
  return w
}

// 把字符串填充/居中到指定显示宽度：不足则两侧对称补空格，超宽原样返回
const padTo = (s, width) => {
  const w = displayWidth(s)
  if (w >= width) return s
  const left = Math.floor((width - w) / 2)
  return ' '.repeat(left) + s + ' '.repeat(width - w - left)
}

// 把若干“样式文本 + 纯文本”对拼成整块居中横幅：取所有行纯文本的最大显示宽，整块左右留白对称
function centerBlock(items) {
  const max = Math.max(...items.map((p) => displayWidth(p.plain)))
  const pad = Math.max(0, Math.floor((terminalCols() - max) / 2))
  return items.map((p) => ' '.repeat(pad) + p.styled).join('\n')
}

function terminalCols() {
  try {
    const c = process.stdout.columns
    return (typeof c === 'number' && c > 30) ? c : 96
  } catch {
    return 96
  }
}

function buildBanner() {
  const it = CLR.bold + CLR.italic
  const plainLines = []
  const styledLines = []
  const push = (styled, plain) => { styledLines.push(styled); plainLines.push(plain) }

  const slashTop = '  ' + '\\/\\/'.repeat(20)
  const slashBot = '  ' + '/\\/\\'.repeat(20)
  push(CLR.cyan + slashTop + CLR.reset, slashTop)
  for (const line of TITLE_LINES) {
    push(it + CLR.cyan + line + CLR.reset, line)
  }
  const boxW = 74
  const boxTop = '┌' + '─'.repeat(boxW - 2) + '┐'
  const boxBot = '└' + '─'.repeat(boxW - 2) + '┘'

  // 盒子内两行：标题行（含版本）+ 副标题行，分别按盒子内宽居中
  const innerW = boxW - 2
  const title = `  Totoro Heaven · 龙猫天堂  v${APP_VERSION}`
  const subtitle = `阳光跑助手 · 本地 Web 服务`
  const boxTitle = '│' + padTo(title, innerW) + '│'
  const boxSub = '│' + padTo(subtitle, innerW) + '│'
  push(CLR.dim + boxTop + CLR.reset, boxTop)
  push(CLR.dim + boxTitle + CLR.reset, boxTitle)
  push(CLR.bold + CLR.magenta + boxSub + CLR.reset, boxSub)
  push(CLR.dim + boxBot + CLR.reset, boxBot)
  push(CLR.cyan + slashBot + CLR.reset, slashBot)
  push('', '')
  const line = `  ▶ 服务已启动，浏览器将自动打开  http://localhost:${PORT}/`
  push(CLR.green + '  ▶ ' + CLR.reset + '服务已启动，浏览器将自动打开  ' + CLR.cyan + `http://localhost:${PORT}/` + CLR.reset, line)
  return centerBlock(styledLines.map((s, i) => ({ styled: s, plain: plainLines[i] })))
}

const banner = () => buildBanner()

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
  // ② 横幅要显示**实际**端口，所以放到定端口之后再打印
  console.log(banner())
  await extractAssets()
  const entry = path.join(RUNTIME_DIR, 'server', 'index.mjs')
  console.log(`Server assets ready at ${RUNTIME_DIR}`)
  openBrowserWhenReady()
  await import(pathToFileURL(entry).href)
}

main().catch((e) => {
  console.error('启动失败:', e)
  exec('pause')
  process.exit(1)
})