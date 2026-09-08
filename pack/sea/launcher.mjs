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

/* ===== 终端横幅：点阵式 ASCII 大字（/ \\ - _ 绘制）+ 科技风配色 ===== */
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

// 每个字符 3 行、固定 5 宽的衬线字模（/ \ - _ 组合，保证行宽统一）
// 每个字符 3 行、固定 5 宽的块状字模（/ \ = - _ 组合，全部严格 5 字符）
// ASCII 大字标题（3 行、逐字符 5 宽程序拼接，保证行宽一致）
// 字符集：T O R H E A V N M G —— 用 | - _ / 绘制
const FONT = {
  T: ['=====', '  |  ', '  |  '],
  O: [' _ _ ', '|___|', ' _ _ '],
  R: ['|--/_', '|--|_', '|___/'],
  H: ['| | |', '|-|-|', '| | |'],
  E: ['=====', '|=== ', '|=== '],
  A: [' /\\  ', '/||\\ ', '|  | '],
  V: ['\\ | /', ' \\|/ ', '  |  '],
  N: ['|\\ | ', '| \\| ', '|  | '],
  M: ['|\\ /|', '| V |', '|   |'],
  G: ['=====', '| __ ', '|__|_'],
}
const SPACE = ['  ', '  ', '  '] // 语义间隔字宽不足时手动扩

function renderTitle(text = '') {
  const lines = ['', '', '']
  for (const ch of text) {
    const glyph = FONT[ch] || SPACE
    for (let r = 0; r < 3; r++) {
      lines[r] += String(glyph[r] || '').padEnd(3, ' ') + ' '
    }
  }
  return lines
}

const TITLE_LINES = renderTitle('TOTORO HEAVEN')

function buildBanner() {
  const it = CLR.bold + CLR.italic
  const body = []
  // 顶部斜线装饰
  body.push(CLR.cyan + '  ' + '\\/\\/'.repeat(20) + CLR.reset)
  for (const line of TITLE_LINES) {
    body.push(it + CLR.cyan + line + CLR.reset)
  }
  body.push(
    CLR.dim + '┌──────────────────────────────────────────────────────────────────────────┐' + CLR.reset,
    CLR.dim + '│' + CLR.reset + CLR.bold + CLR.magenta + '  Totoro Heaven · 龙猫天堂  v' + APP_VERSION + CLR.reset + '       ' + CLR.dim + '阳光跑助手 · 本地 Web 服务' + CLR.reset + CLR.dim + '  │' + CLR.reset,
    CLR.dim + '└──────────────────────────────────────────────────────────────────────────┘' + CLR.reset,
  )
  body.push(CLR.cyan + '  ' + '/\\/\\'.repeat(20) + CLR.reset)
  body.push('')
  body.push(CLR.green + '  ▶ ' + CLR.reset + '服务已启动，浏览器将自动打开  ' + CLR.cyan + `http://localhost:${PORT}/` + CLR.reset)
  return body.join('\n')
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