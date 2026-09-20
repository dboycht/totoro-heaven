import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  // ⚠️ 2026-09-17 修正（vue-tsc 查出后**再更正**）：原先写在**根级**的 `compatibilityDate` 让 typecheck 失败
  //    （`nuxt 3.9.1` 的 `NuxtConfig` 类型里没有这个键），但它**并不是空操作** ——
  //    移除后 Nitro 立刻警告 `Using 2024-04-03 as fallback`，说明这个值是**被 Nitro 消费**的。
  //    正解：放进 `nitro.compatibilityDate`（既有类型、又真正生效），值保持原样不变。
  devtools: { enabled: false },
  ssr: false,
  modules: [],
  css: [
    'vuetify/styles',
    '@mdi/font/css/materialdesignicons.css',
    '~/assets/css/main.css',
  ],
  // ⚠️ 2026-09-17 修正（vue-tsc 查出）：原先写的是 `watch: { ignored: [...] }` ——
  //    **Nuxt 没有这个选项**（`watch` 的类型是 `(string|RegExp)[]`），即这段配置**从未生效**。
  //    真正让 dev 不监听 13MB 逆向材料目录的是下面 `vite.server.watch.ignored`；
  //    这里改用 Nuxt 的顶层 `ignore`（构建期忽略），两处配合才与注释的意图一致。
  ignore: ['**/_mp-analyze/**', '**/.mp-test-build/**'],
  typescript: {
    tsConfig: {
      compilerOptions: {
        // tests/mp 用**显式 `.ts` 后缀**导入（Node `--test` + 类型剥离需要），
        // 与 `tsconfig.mp.json` 保持一致；否则 `nuxi typecheck` 会对每个测试文件报 TS5097。
        allowImportingTsExtensions: true,
      },
    },
  },
  /**
   * ⚠️ **只影响 `npm run dev`，不影响 build / 打包 EXE**（判据见 `ERROR.md` E59）：
   *   · 生产产物在 `.output/server/index.mjs` 里按 `process.env.NITRO_HOST || process.env.HOST` 绑地址（产物里**没有** devServer）；
   *   · 打包 EXE 由 `pack/sea/launcher.mjs` 显式设 `NITRO_HOST=127.0.0.1`（端口由 `pickPort()` 定）。
   *
   * 🆕 2026-09-20 加 `host`：不写 host 时 Nitro 会绑 `localhost` 解析出的**第一个**地址（本机是 `::1`），于是
   *   ① 一大堆验证脚本默认的 `127.0.0.1` 全连不上；
   *   ② 🔴 **「一键获取 token」直接废掉** —— 扫描器把候选 POST 回 `http://127.0.0.1:<port>/api/local/token-import`
   *      （`server/api/local/token-scan/start.post.ts:16`），只绑 `::1` 时回传连接被拒 ⇒ 扫描器 `exit 1`、
   *      界面报"扫描器未回传结果（退出码 1）"（看起来像被杀软拦截，实为地址族不匹配）。
   *   这正是 `server/utils/tokenScanState.ts:91` 注释里"dev 用 `--host 127.0.0.1`"的前提 ⇒ 现在固化进配置。
   */
  devServer: {
    port: 3000,
    host: '127.0.0.1',
  },
  vite: {
    server: {
      watch: {
        ignored: ['**/_mp-analyze/**', '**/.mp-test-build/**'],
      },
      hmr: {
        port: 3000,
        protocol: 'ws',
        host: 'localhost',
      },
    },
    optimizeDeps: {
      include: ['ky'],
    },
    vue: {
      template: {
        transformAssetUrls: {
          video: ['src', 'poster'],
          source: ['src'],
          img: ['src'],
        },
      },
    },
  },
  build: {
    transpile: ['vuetify'],
  },
  app: {
    head: {
      title: '龙猫天堂 · 阳光跑助手',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: '阳光跑（乐学/龙猫校园）跑步记录辅助工具 · 微信小程序后端线' },
      ],
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/vnd.microsoft.icon', href: '/logo.ico' },
      ],
    },
  },
  runtimeConfig: {
    mp: {
      // 微信小程序后端（「龙猫体育锻炼」，AppID wx8e8598deed63f9b1）
      // 唯一的后端目标：旧 App 后端 `app.xtotoro.com` 已于 1.0.4 停止支持并彻底移除
      baseUrl: 'https://wxxcx.xtotoro.com',
    },
  },
  nitro: {
    // 从根级挪到这里（2026-09-17）：值不变，但这是 Nitro **声明过**的键 —— 既有类型检查、
    // 又能真正生效（根级那个位置虽然被 Nitro 读到了，却过不了 TypeScript）。
    compatibilityDate: '2024-04-03',
    output: {
      dir: '.output',
    },
  },
})
