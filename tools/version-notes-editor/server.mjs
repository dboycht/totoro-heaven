#!/usr/bin/env node
/**
 * **「版本更新」文案编辑器**（独立小软件，2026-11-28）
 *
 * ## 用户口径
 * > "给我一个编辑软件……这个编辑器跟我们的主程序是独立的。"
 *
 * 所以它**不依赖主程序**：零依赖、纯 Node 内置模块、单独进程、单独端口（默认从 4321 起自动找空位），
 * 只用浏览器当界面。主程序不认识它；它只认仓库里的一个目录：`public/version-notes/`。
 *
 * ## 它做什么
 *   · 打开时读到本机 `package.json` 的版本号，默认就编这一版；
 *   · 左边写、右边**按弹窗真实样式**实时预览（预览解析器就是 `notes-parse.mjs`，
 *     与主程序 `utils/mp/versionNotes.ts` 同规则，有跨端一致性测试钉住）；
 *   · 保存 = 写 `public/version-notes/<版本>.md`（LF、无 BOM），随下次发布进 canonical。
 *
 * ## 端口与安全
 * 只 bind `127.0.0.1`（本机）；版本号必须形如 `1.2.3`（拒绝一切路径穿越）；
 * 只能写 `public/version-notes/` 这一个目录。
 *
 * 用法：
 *   node tools/version-notes-editor/server.mjs                # 默认从 4321 起找一个空端口，自动开浏览器
 *   node tools/version-notes-editor/server.mjs --port 4311
 *   node tools/version-notes-editor/server.mjs --no-open      # 不自动开浏览器
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const NOTES_DIR = join(ROOT, 'public', 'version-notes')
const HOST = '127.0.0.1'

/** 默认端口基址：被占用就顺序往上试（实测 4310 被 QQ 占着，写死会在用户机器上直接开不起来） */
const PORT_BASE = 4321
const PORT_TRIES = 20
const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const EXPLICIT_PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 0
const PORT = EXPLICIT_PORT || PORT_BASE
const NO_OPEN = argv.includes('--no-open')

/** 版本号白名单：只允许 `1.2.3` 形式（这也是防路径穿越的唯一一条判据） */
const VERSION_RE = /^\d+\.\d+\.\d+$/

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const packageVersion = () => {
  try {
    return String(readJson(join(ROOT, 'package.json')).version ?? '')
  } catch {
    return ''
  }
}

function notePath(version) {
  if (!VERSION_RE.test(String(version ?? ''))) throw new Error(`版本号不合法：${version}`)
  return join(NOTES_DIR, `${version}.md`)
}

function readNote(version) {
  try {
    return readFileSync(notePath(version), 'utf8')
  } catch {
    return ''
  }
}

function listVersions() {
  try {
    return readdirSync(NOTES_DIR)
      .filter((f) => f.endsWith('.md') && VERSION_RE.test(f.slice(0, -3)))
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .reverse()
  } catch {
    return []
  }
}

/** 归一化（与主程序 / 编辑器预览同一套）：CRLF → LF、去行尾空白与首尾空行、去 BOM */
function normalize(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendFile(res, file, type) {
  try {
    const body = readFileSync(file)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') return sendFile(res, join(HERE, 'index.html'), 'text/html; charset=utf-8')
    if (req.method === 'GET' && url.pathname === '/notes-parse.mjs')
      return sendFile(res, join(HERE, 'notes-parse.mjs'), 'text/javascript; charset=utf-8')

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const version = String(url.searchParams.get('version') || packageVersion())
      if (!VERSION_RE.test(version)) return sendJson(res, 400, { ok: false, error: `版本号不合法：${version}` })
      const text = readNote(version)
      return sendJson(res, 200, {
        ok: true,
        version,
        packageVersion: packageVersion(),
        versions: listVersions(),
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        file: relative(ROOT, notePath(version)),
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      }
      const version = String(payload?.version ?? '')
      if (!VERSION_RE.test(version)) return sendJson(res, 400, { ok: false, error: `版本号不合法：${version}` })
      const text = normalize(payload?.text)
      mkdirSync(NOTES_DIR, { recursive: true })
      const file = notePath(version)
      writeFileSync(file, text ? `${text}\n` : '', 'utf8')
      const bytes = Buffer.byteLength(text ? `${text}\n` : '', 'utf8')
      console.log(`[notes-editor] 已保存 ${relative(ROOT, file)}（${bytes} B，${text.split('\n').filter(Boolean).length} 行）`)
      return sendJson(res, 200, { ok: true, version, bytes, file: relative(ROOT, file), versions: listVersions() })
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
  }
})

/**
 * 起监听：显式 `--port` 只试那一个（占用了就报错，别偷偷换）；
 * 没给 `--port` 就从 `PORT_BASE` 往上连试 `PORT_TRIES` 个 —— 用户机器上什么软件占哪个端口都可能。
 */
function startListening(attempt = 0) {
  const port = PORT + attempt
  const onError = (err) => {
    server.off('listening', onListening)
    if (err?.code === 'EADDRINUSE' && !EXPLICIT_PORT && attempt + 1 < PORT_TRIES) {
      startListening(attempt + 1)
      return
    }
    if (err?.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 被占用${EXPLICIT_PORT ? '' : `（试到 ${PORT + PORT_TRIES - 1} 都不行）`}：换一个端口再开，例如 --port ${port + 1}`)
    } else {
      console.error('编辑器启动失败：', err?.message ?? err)
    }
    process.exit(1)
  }
  const onListening = () => {
    server.off('error', onError)
    banner(port)
  }
  server.once('error', onError)
  server.once('listening', onListening)
  server.listen(port, HOST)
}

function banner(port) {
  const url = `http://${HOST}:${port}/`
  console.log('')
  console.log('  📝 版本更新文案编辑器')
  console.log(`     地址：${url}`)
  console.log(`     当前版本（package.json）：${packageVersion() || '(读不到)'}`)
  console.log(`     保存目录：${relative(ROOT, NOTES_DIR)}/<?版本>.md`)
  console.log('     关闭：本终端按 Ctrl+C')
  console.log('')
  if (!NO_OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
    } catch {
      console.log('  （自动打开浏览器失败，请手动打开上面的地址）')
    }
  }
  if (!existsSync(NOTES_DIR)) console.log(`  提示：${relative(ROOT, NOTES_DIR)}/ 还没有，第一次保存时会自动建。`)
}

startListening()