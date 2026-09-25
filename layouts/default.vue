<template>
  <v-layout>
    <v-app-bar color="surface" elevation="0" border>
      <v-app-bar-title class="d-flex align-center gap-2">
        <v-icon color="primary">mdi-weather-sunny</v-icon>
        <span class="font-weight-bold">龙猫天堂</span>
        <span class="text-caption text-medium-emphasis">Totoro Heaven · 阳光跑助手</span>
      </v-app-bar-title>

      <v-btn to="/" variant="text" prepend-icon="mdi-home-outline" class="text-none">工作台</v-btn>
      <!-- 2026-09-20（用户要求）：阳光跑 / 自由跑 合并成一个「跑步」分组，
           组内两个小标签各有独立 URL（`/runs/sunrun`、`/runs/freerun`），
           旧地址 `/run`、`/freerun` 保留为跳转 ⇒ 旧书签不失效。 -->
      <v-btn to="/runs" variant="text" prepend-icon="mdi-run-fast" class="text-none">跑步</v-btn>
      <!-- 早操签到：**常驻显示**（用户 2026-09-18 明确要求）。
           页面自身会按服务端返回区分"需要签到 / 本学校无需签到"，所以不需要靠导航项隐藏来避嫌；
           常驻的好处是需要签到的大一同学**一眼就能看到这个入口**（不必先读一次真实数据才现身）。 -->
      <v-btn to="/morning-sign" variant="text" prepend-icon="mdi-clock-check-outline" class="text-none">
        早操签到
      </v-btn>
      <!-- 2026-09-20 分组重构（用户要求）：原来 跑道编辑/签到区域/记录/日志 是 4 个平级入口，
           现在收成 2 个分组，组内小标签各自有独立 URL（`/field/...`、`/data/...`）。
           旧的 4 个路由仍保留（重定向到新位置），所以旧书签不会失效。 -->
      <v-btn to="/field" variant="text" prepend-icon="mdi-map-marker-radius" class="text-none">我的场地</v-btn>
      <v-btn to="/data" variant="text" prepend-icon="mdi-database-outline" class="text-none">数据</v-btn>
      <v-btn to="/version-info" variant="text" prepend-icon="mdi-image-multiple-outline" class="text-none">版本</v-btn>
      <!-- 鸣谢（2026-09-25 用户要求接进正式软件）：以前只能按 `/credits` 直连访问，现在给一个顶栏入口。
           页面本身是整屏的"片尾式"名单（彩带 + 缓慢滚动 / 放得下就全显），组件 `components/CreditsView.vue` 未改。 -->
      <v-btn to="/credits" variant="text" prepend-icon="mdi-heart-outline" class="text-none">鸣谢</v-btn>
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
 * 早操签到导航项已改为**常驻显示**（用户 2026-09-18 要求）⇒ 这里**不再做自动探测**。
 *
 * 为什么不留探测：它原先唯一的用途就是"读过一次后决定导航项是否出现"；导航项常驻后，
 * 这个探测只会让**每次打开应用都白打一次接口**（需要签到的同学进那个页还会再读一次）。
 * 现在改为**按需读取**：进「早操签到」页或点页内「重新读取」时才发请求（只读，无写操作）。
 */

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
