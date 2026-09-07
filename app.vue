<template>
  <v-app>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <v-snackbar
      v-model="snackbar.show"
      :color="snackbar.color"
      location="top"
      timeout="3000"
    >
      {{ snackbar.text }}
    </v-snackbar>
  </v-app>
</template>

<script setup lang="ts">
// 全局提示条
const snackbar = useState('globalSnackbar', () => ({
  show: false,
  text: '',
  color: 'info' as string,
}))

provide('showSnackbar', (msg: string, c = 'info') => {
  snackbar.value = { show: true, text: msg, color: c }
  setTimeout(() => {
    if (snackbar.value) snackbar.value.show = false
  }, 3000)
})
</script>