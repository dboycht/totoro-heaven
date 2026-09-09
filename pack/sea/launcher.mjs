import { isSea, getAsset } from 'node:sea'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { exec } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'

const RUNTIME_DIR = path.join(os.tmpdir(), 'totoro-heaven-runtime')
const PORT = Number(process.env.TOTORO_PORT || 3000)
const ASSET_KEY = 'app.tar.gz'

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

const banner = buildBanner()

async function extractAssets() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true })
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
  console.log(banner)
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