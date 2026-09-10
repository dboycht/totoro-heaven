/**
 * 小程序模块自测运行器（零依赖）
 *
 * 背景：
 *   - 工程内相对导入是无扩展名的 Vite 风格（如 `from './routeSimilarity'`），
 *     Node ESM 解析不了 `.ts`；而 Node 24 自带 TS 类型剥离，只差一个扩展名。
 *   - 本脚本把 `src/mp` 与 `utils/mp` 的 .ts 拷到临时目录，给相对导入补上 `.ts`，
 *     再用 `node --test` 跑 `tests/mp/*.test.ts`。
 *
 * 用法：node scripts/run-mp-tests.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = path.join(root, '.mp-test-build')

/** 给所有相对导入补 .ts（仅当没有扩展名时） */
function rewriteImports(code) {
  return code.replace(
    /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
    (full, pre, spec, post) => {
      if (/\.(ts|js|json|mjs|cjs)$/.test(spec)) return full
      return `${pre}${spec}.ts${post}`
    },
  )
}

function copyTree(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0
  let n = 0
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      n += copyTree(src, dest)
    } else if (entry.name.endsWith('.ts')) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, rewriteImports(fs.readFileSync(src, 'utf8')), 'utf8')
      n++
    }
  }
  return n
}

fs.rmSync(tmp, { recursive: true, force: true })
const copied =
  copyTree(path.join(root, 'utils', 'mp'), path.join(tmp, 'utils', 'mp')) +
  copyTree(path.join(root, 'src', 'mp'), path.join(tmp, 'src', 'mp')) +
  copyTree(path.join(root, 'tests', 'mp'), path.join(tmp, 'tests', 'mp'))

console.log(`[mp-test] 已准备 ${copied} 个文件 -> ${path.relative(root, tmp)}`)

const res = spawnSync(
  process.execPath,
  ['--test', 'tests/mp/*.test.ts'],
  { stdio: 'inherit', cwd: tmp },
)

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(res.status ?? 1)
