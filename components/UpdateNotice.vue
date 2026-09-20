<template>
  <!-- ① 发现新版本：黄色报警 -->
  <v-alert
    v-if="hasUpdate"
    type="warning"
    variant="flat"
    density="comfortable"
    :class="compact ? 'mt-3' : 'mb-4'"
  >
    <div class="font-weight-bold">
      <v-icon class="mr-1">mdi-update</v-icon>发现新版本 v{{ latest }}（你正在用 v{{ appVersion }}）
    </div>
    <div class="text-body-2">
      <b>请下载并使用最新版本</b>：旧版本可能无法使用（校方接口 / 小程序会变），甚至可能产生<b>无效记录</b>。
    </div>
    <div class="d-flex flex-wrap ga-2 mt-2">
      <v-btn size="small" color="warning" variant="flat" prepend-icon="mdi-download" :href="releasesUrl" target="_blank" rel="noopener">
        去下载最新版
      </v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="checking" @click="checkNow">立即检测</v-btn>
      <v-btn v-if="!compact" size="small" variant="text" prepend-icon="mdi-close" @click="dismissUpdate()">
        忽略本次（24 小时）
      </v-btn>
    </div>
  </v-alert>

  <!-- ② 连不上 GitHub：明确提示怎么做 -->
  <v-alert v-else-if="error" type="warning" variant="tonal" density="comfortable" :class="compact ? 'mt-3' : 'mb-4'">
    <div class="font-weight-bold">
      <v-icon class="mr-1">mdi-wifi-off</v-icon>无法连接到 GitHub —— 无法确认是否有新版本
    </div>
    <div class="text-body-2">{{ error }}</div>
    <div class="d-flex flex-wrap ga-2 mt-2">
      <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" :loading="checking" @click="checkNow">立即检测</v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-github" :href="repoUrl" target="_blank" rel="noopener">
        打开仓库页确认
      </v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-download" :href="releasesUrl" target="_blank" rel="noopener">
        直接看 Releases
      </v-btn>
    </div>
  </v-alert>

  <!-- ③ 正常常驻提示 -->
  <v-alert v-else type="info" variant="tonal" density="compact" :class="compact ? 'mt-3' : 'mb-4'">
    <span class="text-body-2">
      📌 <b>请始终使用最新版本</b>：每次发版都会修 bug、跟进校方与小程序的变化；<b>旧版本可能失效甚至产生无效记录</b>。
      当前 <b>v{{ appVersion }}</b>
      <a :href="releasesUrl" target="_blank" rel="noopener" class="text-primary">查看最新版</a>
      <span v-if="checking" class="text-medium-emphasis"> · 正在检测…</span>
      <!-- ⚠️ 2026-09-20 审计修复：原先只判 `latest` 就写"已是最新" —— 点过「忽略本次」之后
           `hasUpdate=false` 但 `latest` 仍是那个**更新的**版本 ⇒ 会显示"已是最新（远端 v1.1.13）"
           这种自相矛盾的话（还要加上"已是最新"是假的）。现在按**版本比较**决定措辞。 -->
      <span v-else-if="latest && !isNewerVersion(latest, appVersion)" class="text-medium-emphasis">
        · 已是最新（远端 v{{ latest }}，{{ checkedText }}）
      </span>
      <span v-else-if="latest" class="text-medium-emphasis"> · 已忽略本次提醒（远端 v{{ latest }}，{{ checkedText }}）</span>
      <v-btn size="x-small" variant="text" class="ml-2" prepend-icon="mdi-refresh" :loading="checking" @click="checkNow">
        立即检测
      </v-btn>
    </span>
  </v-alert>
</template>

<script setup lang="ts">
/** 版本比较（判断"远端是不是真的更新"）——"已是最新"这句必须按它来说，不能只看 `latest` 有没有值 */
import { isNewerVersion } from '~/utils/mp/version'

/**
 * 「请使用最新版本」提示 + 「立即检测」（2026-09-16 用户要求）
 *
 * - 工作台顶部（`compact=false`）：三态 —— 有新版本→黄色报警；连不上 GitHub→提示怎么做；正常→常驻行 + 立即检测
 * - 「关于」对话框（`compact=true`）：同样提示，但紧凑些、不显示"忽略本次"
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const showSnackbar = useNotice()
const { latest, hasUpdate, checking, error, checkedAt, fromCache, appVersion, releasesUrl, repoUrl, checkForUpdate, forceCheck, dismissUpdate } =
  useUpdateCheck()

/** 手动「立即检测」：强制重新请求，并把结果直接反馈给用户 */
const checkNow = async () => {
  await forceCheck()
  if (error.value) showSnackbar('无法连接到 GitHub：请检查网络，或确认仓库是否已改名/迁移', 'warning')
  else if (hasUpdate.value) showSnackbar(`发现新版本 v${latest.value}，请下载最新版使用`, 'warning')
  else showSnackbar(`已是最新版本（v${appVersion.value}）${latest.value ? ` · 远端 v${latest.value}` : ''}`, 'success')
}

/** 上次检测时间的相对文案（⚠️ 用缓存时明确标注"本地缓存"，避免看起来像刚查过） */
const checkedText = computed(() => {
  if (!checkedAt.value) return '未检测'
  const sec = Math.max(0, Math.round((Date.now() - checkedAt.value) / 1000))
  const age = sec < 60 ? '刚刚' : sec < 3600 ? `${Math.floor(sec / 60)} 分钟前` : `${Math.floor(sec / 3600)} 小时前`
  return fromCache.value ? `${age}的结果（本地缓存，点「立即检测」刷新）` : `${age}检测`
})

onMounted(() => void checkForUpdate())
</script>
