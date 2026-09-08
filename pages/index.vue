<template>
  <v-row justify="center">
    <v-col cols="12" md="6" lg="5">
      <v-card class="pa-6">
        <v-card-title class="text-center">
          <v-icon color="primary" size="40">mdi-weather-sunny</v-icon>
        </v-card-title>
        <v-card-subtitle class="text-center text-subtitle-1">
          龙猫校园 · 阳光跑登录
        </v-card-subtitle>

        <v-card-text class="text-center">
          <template v-if="qrImg">
            <p class="text-body-2 text-medium-emphasis mb-3">
              使用「微信」扫描下方二维码完成登录
            </p>
            <v-img
              :src="qrImg"
              :width="200"
              :height="200"
              class="mx-auto border-thin rounded"
              contain
              referrerpolicy="no-referrer"
            />
          </template>
          <v-progress-circular v-else indeterminate color="primary" class="my-8" />

          <v-alert v-if="errorMsg" type="error" variant="tonal" class="mt-4" dense>
            {{ errorMsg }}
          </v-alert>
        </v-card-text>

        <v-card-actions class="justify-center pb-4">
          <v-btn color="primary" :prepend-icon="'mdi-qrcode-scan'" :loading="checking" @click="startCheck">
            我已扫码
          </v-btn>
          <v-btn :prepend-icon="'mdi-refresh'" variant="text" @click="refreshQr">
            刷新二维码
          </v-btn>
        </v-card-actions>

        <v-divider class="mx-4" />

        <div class="text-center py-3">
          <v-btn variant="tonal" color="warning" :prepend-icon="'mdi-bug-outline'" @click="enterDebugMode">
            调试模式（跳过扫码，无法提交）
          </v-btn>
        </div>

        <v-alert type="info" variant="tonal" class="mx-4 mb-4" density="compact">
          扫码后服务器会向龙猫接口发起登录，并同步拉取学校/版本信息，之后进入跑步页面。
        </v-alert>
      </v-card>
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import { TotoroApiWrapper } from '~/src/wrappers/TotoroApiWrapper'
import { useSession } from '~/composables/useSession'

definePageMeta({ title: '登录' })

const { setSession, setDebugSession } = useSession()
const { setDebugPaper } = useDebugSunRunPaper()
const router = useRouter()

const qrUuid = ref('')
const qrImg = ref('')
const errorMsg = ref('')
const checking = ref(false)

async function loadQr() {
  try {
    const data = await $fetch<{ uuid: string; imgUrl: string }>('/api/scanQr')
    qrUuid.value = data.uuid
    qrImg.value = data.imgUrl
    errorMsg.value = ''
  } catch (e) {
    console.error(e)
    errorMsg.value = '获取二维码失败，请重试'
  }
}

async function startCheck() {
  if (!qrUuid.value) return
  checking.value = true
  errorMsg.value = ''
  try {
    const { code } = await $fetch<{ code: string }>(`/api/scanQr/${qrUuid.value}`)
    const [lessee] = await Promise.all([
      TotoroApiWrapper.getLesseeServer(code),
      TotoroApiWrapper.getAppAd(code),
    ])
    if (!lessee.token) {
      errorMsg.value = (lessee.message as string) || '登录失败'
      return
    }
    const profile = await TotoroApiWrapper.login({ token: lessee.token })
    setSession({ ...profile, token: lessee.token, code, data: null })

    const l = {
      token: lessee.token,
      campusId: profile.campusId,
      schoolId: profile.schoolId,
      stuNumber: profile.stuNumber,
    }
    await Promise.all([
      TotoroApiWrapper.getAppFrontPage(l),
      TotoroApiWrapper.getAppSlogan(l),
      TotoroApiWrapper.updateAppVersion(l),
      TotoroApiWrapper.getAppNotice(l),
    ])
    router.push('/scanned')
  } catch (e) {
    console.error(e)
    errorMsg.value = '龙猫服务器错误'
  } finally {
    checking.value = false
  }
}

function refreshQr() {
  loadQr()
}

function enterDebugMode() {
  setDebugSession()
  setDebugPaper()
  router.push('/scanned')
}

onMounted(loadQr)
</script>