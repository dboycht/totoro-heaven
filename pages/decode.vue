<template>
  <div>
    <v-card class="pa-4">
      <v-card-title>
        <v-icon color="primary" class="mr-2">mdi-script-text-key-outline</v-icon>
        请求内容解码（联调辅助）
      </v-card-title>
      <v-card-subtitle>粘贴龙猫校园接口的 RSA（pkcs1）base64 密文，查看加密前请求内容。</v-card-subtitle>

      <v-card-text>
        <v-textarea
          v-model="cipher"
          label="RSA 密文 (base64)"
          variant="outlined"
          rows="6"
          auto-grow
          placeholder="----- 在此粘贴密文 -----"
          filled
        />
        <v-btn color="primary" :prepend-icon="'mdi-key-outline'" :loading="decoding" @click="decode">
          解码
        </v-btn>
      </v-card-text>

      <v-card-text v-if="result">
        <v-divider class="mb-3" />
        <div class="text-subtitle-1 mb-1">解码结果</div>
        <pre class="rounded pa-3 bg-surface-variant overflow-x-auto">{{ result }}</pre>
      </v-card-text>

      <v-card-text v-if="errMsg">
        <v-alert type="error" variant="tonal">{{ errMsg }}</v-alert>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { decryptRequestContent } from '~/src/utils/encryptRequestContent'

definePageMeta({ title: '解码' })

const cipher = ref('')
const result = ref('')
const errMsg = ref('')
const decoding = ref(false)

function decode() {
  if (!cipher.value.trim()) {
    errMsg.value = '请先粘贴密文'
    return
  }
  decoding.value = true
  errMsg.value = ''
  result.value = ''
  try {
    const obj = decryptRequestContent(cipher.value.trim())
    result.value = JSON.stringify(obj, null, 2)
  } catch (e) {
    errMsg.value = `解码失败：${(e as Error).message}`
  } finally {
    decoding.value = false
  }
}
</script>