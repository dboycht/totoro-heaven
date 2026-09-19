<template>
  <v-layout>
    <v-app-bar color="surface" elevation="0" border>
      <v-app-bar-title class="d-flex align-center gap-2">
        <v-icon color="primary">mdi-weather-sunny</v-icon>
        <span class="font-weight-bold">龙猫天堂</span>
        <span class="text-caption text-medium-emphasis">Totoro Heaven · 阳光跑助手</span>
      </v-app-bar-title>

      <v-btn to="/" variant="text" prepend-icon="mdi-home-outline" class="text-none">工作台</v-btn>
      <!-- 2026-09-18：阳光跑 / 自由跑 拆成两个独立标签（各自 URL），早操签到独立成项 -->
      <v-btn to="/run" variant="text" prepend-icon="mdi-white-balance-sunny" class="text-none">阳光跑</v-btn>
      <v-btn to="/freerun" variant="text" prepend-icon="mdi-run" class="text-none">自由跑</v-btn>
      <!-- 早操签到：**只在"本账号确实需要签到"时出现**（我校实测返回"本学校无需签到"，
           所以多数人不会看到这一项；需要签到的大一同学首次读取后它才出现） -->
      <v-btn v-if="mornSignRequired" to="/morning-sign" variant="text" prepend-icon="mdi-clock-check-outline" class="text-none">
        早操签到
      </v-btn>
      <v-btn to="/track-editor" variant="text" prepend-icon="mdi-vector-polyline" class="text-none">跑道编辑</v-btn>
      <v-btn to="/records" variant="text" prepend-icon="mdi-format-list-bulleted" class="text-none">记录</v-btn>
      <v-btn to="/logs" variant="text" prepend-icon="mdi-text-box-search-outline" class="text-none">日志</v-btn>
      <v-btn to="/version-info" variant="text" prepend-icon="mdi-image-multiple-outline" class="text-none">版本</v-btn>
      <v-spacer />

      <v-chip :color="isRealSession ? 'success' : 'default'" variant="tonal" size="small" class="mr-2">
        <v-icon start size="16">{{ isRealSession ? 'mdi-cellphone-link' : 'mdi-information-outline' }}</v-icon>
        {{ isRealSession ? '真实数据' : '未连接' }}
      </v-chip>
      <v-chip v-if="isLoggedIn && isRealSession" color="primary" variant="tonal" size="small" class="mr-2">
        <v-icon start size="16">mdi-cellphone-check</v-icon>
        真实会话已就绪
      </v-chip>
      <v-btn v-if="isLoggedIn && isRealSession" icon="mdi-logout" title="退出登录（并清除本机 token）" @click="doLogout" />

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
const { isLoggedIn, session } = useMpSession()
const { logoutAndClearSession } = useMpReal()
const showSnackbar = useNotice()

/**
 * 早操签到导航项：只有"本账号确实需要签到"时才显示（`required` 由只读接口读过一次后置位）。
 * ⚠️ 这里**只是触发一次只读探测**（`getMornSignPaper`），**没有任何写操作**；失败静默（导航项就不出现）。
 */
const { required: mornSignRequired, status: mornStatus, loadMornSignTask } = useMpMorningSign()
onMounted(() => {
  // 有真实会话且还没读过 → 探测一次，用于决定导航项是否出现
  if (isLoggedIn.value && mornStatus.value === 'idle') void loadMornSignTask()
})

/** 真实会话 = 存了非 demo 前缀的 token（演示会话 token 以 `demo-` 开头） */
const isRealSession = computed(() => Boolean(session.value?.token) && !session.value?.token?.startsWith('demo-'))

/**
 * 顶栏「退出登录」——⚠️ 必须走**彻底**清除（2026-09-18 发布前审计 S1）：
 * 此前这里直接绑 `clearSession`，只删 `localStorage['mp_session']`，
 * 而缓存里那份**完整 token 还在** ⇒ 点「恢复」就能一键登回去（"退出登录"形同虚设）。
 * 现在与工作台的「清除会话」统一走 `logoutAndClearSession()`（会话 + 缓存 token 一起清 + 复位界面）。
 */
const doLogout = () => {
  logoutAndClearSession()
  showSnackbar('已退出登录（本机 token 与缓存已一并清除）', 'info', { cloud: true })
}

const aboutOpen = ref(false)
</script>
