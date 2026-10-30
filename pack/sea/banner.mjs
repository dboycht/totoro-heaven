/**
 * 终端横幅的**单一来源**（2026-10-31 从 launcher.mjs 拆出）：
 *
 * ## 两个变体（2026-10-31 用户要求："初始时不显示『阳光跑助手』字样，替换为小游戏之类；
 * 输入作弊码后，终端内输出和原版一致的字样"）
 *   · `disguised`（默认/伪装）：盒子副标题写**小游戏**口径 —— 对外表面只有"这是个像素小游戏"；
 *   · `full`（解锁后）：与 1.3.3 及之前的原版横幅**逐字一致**（「阳光跑助手 · 本地 Web 服务」）。
 *
 * ## 为什么能拆成独立模块
 * 打包脚本（`build-sea.ps1` 第 1 步）用 esbuild `--bundle` 把 launcher 连同本文件内联成单个 CJS，
 * 所以 SEA 入口可以正常 `import './banner.mjs'`；同时它也是纯 ESM、无依赖，
 * 单测（`tests/mp/launcherBanner.test.ts`）与最小化 demo 都直接 import 这一份 —— 横幅只有一个真源。
 *
 * ⚠️ `TITLE_LINES` 保持**纯 ASCII**（FIGlet slant 产物）；中文只允许出现在盒子两行与提示行
 * （`displayWidth` 会按全角 2 列对齐）。历史坑见 `ERROR.md` E0（字形核对与整块居中）。
 */

/* ===== 配色 ===== */
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

// FIGlet slant 渲染的 "TOTORO HEAVEN"（npx figlet -f slant 生成）
// 导出仅供单测（`tests/mp/launcherBanner.test.ts`）断言"艺术字纯 ASCII"，别在别处 import
export const TITLE_LINES = [
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

/** 盒子副标题：两个变体**唯一的差异行**（其余逐字一致） */
const SUBTITLES = {
  disguised: '像素小游戏 · 单机离线版',
  full: '阳光跑助手 · 本地 Web 服务',
}

/**
 * 构建横幅文本。
 * @param {{ variant?: 'disguised' | 'full', version?: string, port?: number }} opts
 *   `variant` 默认 `'disguised'`（启动即伪装）；`version` 打包时由 `__APP_VERSION__` 注入；
 *   `port` 用 `pickPort()` 之后的实际端口。
 */
export function buildBanner(opts = {}) {
  const variant = opts.variant === 'full' ? 'full' : 'disguised'
  const version = String(opts.version ?? '')
  const port = Number(opts.port ?? 3000)

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
  const title = `  Totoro Heaven · 龙猫天堂  v${version}`
  const subtitle = SUBTITLES[variant]
  const boxTitle = '│' + padTo(title, innerW) + '│'
  const boxSub = '│' + padTo(subtitle, innerW) + '│'
  push(CLR.dim + boxTop + CLR.reset, boxTop)
  push(CLR.dim + boxTitle + CLR.reset, boxTitle)
  push(CLR.bold + CLR.magenta + boxSub + CLR.reset, boxSub)
  push(CLR.dim + boxBot + CLR.reset, boxBot)
  push(CLR.cyan + slashBot + CLR.reset, slashBot)
  push('', '')
  const line = `  ▶ 服务已启动，浏览器将自动打开  http://localhost:${port}/`
  push(CLR.green + '  ▶ ' + CLR.reset + '服务已启动，浏览器将自动打开  ' + CLR.cyan + `http://localhost:${port}/` + CLR.reset, line)
  return centerBlock(styledLines.map((s, i) => ({ styled: s, plain: plainLines[i] })))
}
