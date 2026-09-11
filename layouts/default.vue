<template>
  <v-layout>
    <v-app-bar color="surface" elevation="0" border>
      <v-app-bar-title class="d-flex align-center gap-2">
        <v-icon color="primary">mdi-weather-sunny</v-icon>
        <span class="font-weight-bold">龙猫天堂</span>
        <span class="text-caption text-medium-emphasis">Totoro Heaven · 阳光跑助手</span>
      </v-app-bar-title>

      <v-chip v-if="isLoggedIn" color="primary" variant="tonal" size="small" class="mr-2">
        <v-icon start size="16">mdi-cellphone-check</v-icon>
        小程序会话已就绪
      </v-chip>
      <v-btn v-if="isLoggedIn" icon="mdi-logout" title="清除小程序会话" @click="clearSession" />

      <v-btn icon="mdi-information-outline" title="关于" @click="aboutOpen = true" />
      <AboutDialog v-model="aboutOpen" />
    </v-app-bar>

    <v-main>
      <v-container fluid class="py-6" style="max-width: 1200px">
        <slot />
      </v-container>
    </v-main>
  </v-layout>
</template>

<script setup lang="ts">
import { useMpSession } from '~/composables/useMpSession'

// 1.1.x 起唯一后端为微信小程序（wxxcx.xtotoro.com），会话由 mp_session 承载
const { isLoggedIn, clearSession } = useMpSession()

const aboutOpen = ref(false)
</script>
