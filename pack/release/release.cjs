/**
 * GitHub Release 发布脚本（REST API，无需 gh CLI）
 *
 * 为什么用 .cjs：本项目 package.json 是 "type":"module"，.js 会被当 ESM 报 `require is not defined`（见 ERROR.md E8）。
 *
 * 用法（token 由 pack/release/publish.ps1 从 Windows 凭据管理器读出并放进 GH_TOKEN）：
 *   node --use-system-ca pack/release/release.cjs
 *   node --use-system-ca pack/release/release.cjs --tag 1.1.1 --zip dist/totoro-heaven-1.1.1.zip --notes dist/release-notes-1.1.1.md
 *
 * 默认值：tag = package.json 的 version；zip = dist/totoro-heaven-<tag>.zip；
 *         sevenZip = dist/totoro-heaven-<tag>.7z（**存在才上传**，自 1.1.10 起每个 Release 都发 zip + 7z）；
 *         notes = dist/release-notes-<tag>.md（缺省时用一行兜底说明）。
 * ⚠️ `--notes` 就是 Release 的**正文**：本项目的惯例是传 `dist/release-body-<tag>.md`（= 更新日志），
 *    `dist/release-notes-<tag>.md` 只是开发侧留档（含"重要提示"抬头）。
 *
 * ⚠️ 三个必须记住的坑（E8 实测）：
 *   1. 上传附件的 host 是 **uploads.github.com**（用 api.github.com 会 404）；
 *   2. 本机 Node 默认 CA 校验失败，必须 `node --use-system-ca`；
 *   3. 附件名要 encodeURIComponent；body 用 UTF-8（Node 默认即 UTF-8）。
 *
 * 幂等：tag 已存在则复用该 release（并同步 name/body），同名附件先删后传，可安全重跑。
 * 安全：token 只在进程内使用，**绝不打印**。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

const ROOT = path.resolve(__dirname, '..', '..')

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const TAG = argOf('tag', pkg.version)
const REPO = argOf('repo', 'dboycht/totoro-heaven')
const ZIP = path.resolve(ROOT, argOf('zip', path.join('dist', `totoro-heaven-${TAG}.zip`)))
/**
 * 🆕 2026-09-20：**第二个附件（7z）**。自 1.1.10 起每个 Release 都发 zip + 7z，
 * 而本脚本原先只会上传一个 zip ⇒ 7z 得靠另一个一次性脚本补传（容易漏、也没进版本控制）。
 * 现在：默认路径 `dist/totoro-heaven-<tag>.7z`，**存在才上传**（老版本没有 7z 时行为不变）。
 */
const SEVEN = path.resolve(ROOT, argOf('sevenZip', path.join('dist', `totoro-heaven-${TAG}.7z`)))
const NOTES = path.resolve(ROOT, argOf('notes', path.join('dist', `release-notes-${TAG}.md`)))
const TOKEN = process.env.GH_TOKEN || ''

if (!TOKEN) {
  console.error('缺少 GH_TOKEN（由 pack/release/publish.ps1 注入）')
  process.exit(1)
}
if (!fs.existsSync(ZIP)) {
  console.error(`找不到发布附件：${ZIP}`)
  process.exit(1)
}

/** 附件清单（顺序即上传顺序）；7z 不存在时自动跳过 */
const ASSETS = [
  { path: ZIP, contentType: 'application/zip' },
  ...(fs.existsSync(SEVEN) ? [{ path: SEVEN, contentType: 'application/x-7z-compressed' }] : []),
]

const body = fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : `Release ${TAG}`

/** 极简 https 请求封装（Node 内置，无第三方依赖） */
function api(method, host, urlPath, payload, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const data =
      payload === undefined || payload === null
        ? null
        : Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(JSON.stringify(payload), 'utf8')
    const req = https.request(
      {
        method,
        host,
        path: urlPath,
        headers: {
          'User-Agent': 'totoro-heaven-release',
          Authorization: `token ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data ? { 'Content-Type': contentType, 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            /* 非 JSON 响应（如 404 空体） */
          }
          resolve({ status: res.statusCode, json, text })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const apiHost = 'api.github.com'
const uploadHost = 'uploads.github.com'

/** 取或建 release（幂等） */
async function ensureRelease() {
  const existing = await api('GET', apiHost, `/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`)
  if (existing.status === 200 && existing.json && existing.json.id) {
    console.log(`release ${TAG} 已存在（id=${existing.json.id}），同步说明并复用`)
    const patched = await api('PATCH', apiHost, `/repos/${REPO}/releases/${existing.json.id}`, {
      name: TAG,
      body,
      prerelease: false,
      draft: false,
    })
    if (patched.status >= 300) {
      console.error(`更新 release 失败：HTTP ${patched.status} ${patched.text.slice(0, 300)}`)
      process.exit(1)
    }
    return patched.json
  }
  if (existing.status !== 404) {
    console.error(`查询 release 失败：HTTP ${existing.status} ${existing.text.slice(0, 300)}`)
    process.exit(1)
  }
  const created = await api('POST', apiHost, `/repos/${REPO}/releases`, {
    tag_name: TAG,
    name: TAG,
    body,
    draft: false,
    prerelease: false,
  })
  if (created.status >= 300) {
    console.error(`创建 release 失败：HTTP ${created.status} ${created.text.slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`release ${TAG} 创建成功（id=${created.json.id}）`)
  return created.json
}

/** 上传附件（同名先删，保证可重跑）；逐个上传 ASSETS 里的每个文件 */
async function uploadAssets(releaseId) {
  const list = await api('GET', apiHost, `/repos/${REPO}/releases/${releaseId}/assets`)
  const uploaded = []
  for (const spec of ASSETS) {
    const name = path.basename(spec.path)
    if (Array.isArray(list.json)) {
      for (const asset of list.json.filter((a) => a.name === name)) {
        const del = await api('DELETE', apiHost, `/repos/${REPO}/releases/assets/${asset.id}`)
        console.log(`  删除同名旧附件 ${name}（HTTP ${del.status}）`)
      }
    }
    const bytes = fs.readFileSync(spec.path)
    const res = await api(
      'POST',
      uploadHost,
      `/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      bytes,
      spec.contentType,
    )
    if (res.status >= 300) {
      console.error(`上传附件失败：${name} HTTP ${res.status} ${res.text.slice(0, 300)}`)
      process.exit(1)
    }
    console.log(`  附件上传成功：${name}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`)
    uploaded.push(res.json)
  }
  return uploaded
}

async function main() {
  const release = await ensureRelease()
  const assets = await uploadAssets(release.id)

  console.log('\n=== 发布完成 ===')
  console.log(`tag        : ${release.tag_name}`)
  console.log(`name       : ${release.name}`)
  console.log(`release id : ${release.id}`)
  for (const asset of assets) {
    console.log(`asset      : ${asset.name} (${asset.size} bytes)`)
    if (asset.digest) console.log(`  digest   : ${asset.digest}`)
  }
  console.log(`页面       : ${release.html_url}`)
}

// ⚠️ .cjs 是 CommonJS：**不能**用顶层 await，必须包在 async main 里
main().catch((err) => {
  console.error('发布失败：', err)
  process.exit(1)
})
