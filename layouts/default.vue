<template>
  <v-layout>
    <v-app-bar color="surface" elevation="0" border>
      <v-app-bar-title class="d-flex align-center gap-2">
        <v-icon color="primary">mdi-weather-sunny</v-icon>
        <span class="font-weight-bold">Totoro Heaven</span>
        <span class="text-caption text-medium-emphasis">阳光跑助手</span>
      </v-app-bar-title>
      <template v-if="session?.token">
        <v-btn to="/scanned" :prepend-icon="'mdi-map-marker-path'" text="阳光跑" variant="text" />
        <v-btn to="/freerun" :prepend-icon="'mdi-run-fast'" text="自由跑" variant="text" />
        <v-btn to="/records" :prepend-icon="'mdi-history'" text="记录" variant="text" />
        <v-btn to="/decode" :prepend-icon="'mdi-script-text-key-outline'" text="解码" variant="text" />
        <v-btn icon="mdi-logout" @click="doLogout" title="退出登录" />
      </template>
      <template v-else>
        <v-btn to="/decode" :prepend-icon="'mdi-script-text-key-outline'" text="解码" variant="text" />
      </template>
    </v-app-bar>

    <v-main>
      <v-container fluid class="py-6" style="max-width: 1200px">
        <slot />
      </v-container>
    </v-main>
  </v-layout>
</template>

<script setup lang="ts">
import { useSession } from '~/composables/useSession'

const { session, clearSession, isLoggedIn } = useSession()
const router = useRouter()

function doLogout() {
  clearSession()
  router.push('/')
}
</script>