import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: false },
  ssr: false,
  modules: [],
  css: [
    'vuetify/styles',
    '@mdi/font/css/materialdesignicons.css',
    '~/assets/css/main.css',
  ],
  watch: {
    ignored: ['**/_mp-analyze/**', '**/.mp-test-build/**'],
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
