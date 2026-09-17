import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  // ⚠️ 2026-09-17 移除 `compatibilityDate`（vue-tsc 查出）：它是 **Nuxt 3.12+ 才有的键**，
  //    本项目锁定 **nuxt 3.9.1**，`nuxt/schema` 里没有该键 ⇒ 运行时是**空操作**、却让 typecheck 失败。
  //    将来升级 Nuxt 到 ≥3.12 时再加回（届时它才真正生效）。
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
  devServer: {
    port: 3000,
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
    output: {
      dir: '.output',
    },
  },
})
