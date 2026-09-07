import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'

export default defineNuxtPlugin((nuxtApp) => {
  const vuetify = createVuetify({
    components,
    directives,
    theme: {
      defaultTheme: 'dark',
      themes: {
        dark: {
          dark: true,
          colors: {
            primary: '#4CAF50',
            secondary: '#26A69A',
            accent: '#FFB74D',
            error: '#EF5350',
            info: '#42A5F5',
            success: '#66BB6A',
            warning: '#FFA726',
            background: '#121212',
            surface: '#1E1E1E',
          },
        },
      },
    },
    defaults: {
      VBtn: { variant: 'tonal' },
      VCard: { variant: 'elevated' },
    },
  })
  nuxtApp.vueApp.use(vuetify)
})