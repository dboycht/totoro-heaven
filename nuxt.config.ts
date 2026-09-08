import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: false },
  ssr: false,
  modules: [],
  css: [
    'vuetify/styles',
    '@mdi/font/css/materialdesignicons.css',
    'leaflet/dist/leaflet.css',
    '~/assets/css/main.css',
  ],
  watch: {
    ignored: ['**/_source-study/**', '**/origin/**', '**/totoro-paradise-main.zip'],
  },
  devServer: {
    port: 3000,
  },
  vite: {
    server: {
      watch: {
        ignored: ['**/_source-study/**', '**/origin/**', '**/totoro-paradise-main.zip'],
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
        { name: 'description', content: '阳光跑（乐学/龙猫校园）跑步记录辅助工具' },
      ],
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/vnd.microsoft.icon', href: '/logo.ico' },
      ],
    },
  },
  runtimeConfig: {
    totoro: {
      // 龙猫校园服务端（客户端若需直连请设置）host
      baseUrl: 'https://app.xtotoro.com',
      // 微信开放平台 OAuth appid（与龙猫 App 内登记一致）
      wechatAppId: 'wx20976a32c7a2fd75',
    },
  },
  nitro: {
    output: {
      dir: '.output',
    },
  },
})