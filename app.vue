<template>
  <v-app>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>

    <!--
      提示条有两种形态（1.1.9）：
      · 普通提示 = 原来的 v-snackbar（行为逐字不变：default 色、3 秒自动消失）；
      · **流体云**（`cloud: true`）= 顶部云朵浮层，用于「导入/读取数据」这类有过程的操作，
        点一下立即消失，未点则到点自动淡出（`CloudNotice` 只负责画，逻辑都在这里）。
    -->
    <v-snackbar
      v-if="!notice.cloud"
      :model-value="notice.show"
      :color="notice.color"
      location="top"
      timeout="3000"
      @update:model-value="(v: boolean) => (notice.show = v)"
    >
      {{ notice.text }}
    </v-snackbar>

    <ClientOnly v-else>
      <Transition name="cloud-fade">
        <CloudNotice
          v-if="notice.show"
          :text="notice.text"
          :color="notice.color"
          :clickable="notice.clickable"
          @dismiss="hideNotice"
        />
      </Transition>
    </ClientOnly>
  </v-app>
</template>

<script setup lang="ts">
import { NOTICE_KEY, type NoticeOptions } from '~/composables/useNotice'

/**
 * 全局提示条（唯一出口）：页面/组件通过 `useNotice()`（见 `composables/useNotice.ts`）调用。
 *
 * 签名（1.1.9 起扩展，**旧调用全部原样可用**）：
 *   showNotice(text, color?)                       // 老形态：顶部条，3 秒自动消失
 *   showNotice(text, color, { cloud: true })        // 流体云：点一下消失，默认 5.5 秒淡出
 *   showNotice(text, color, { cloud: true, timeout: 0 })  // 云 + 不自动消失（等点击）
 *
 * ⚠️ 同一条提示**位置不变**：这里只有一份状态，云与条只会出现一个（`cloud` 切换形态）。
 */
const notice = useState('globalSnackbar', () => ({
  show: false,
  text: '',
  color: 'info' as string,
  /** ✅ 用云朵浮层（默认 false = 原来的顶部条） */
  cloud: false,
  /** 云是否可点击消失（默认 true） */
  clickable: true,
}))

/** 普通提示的固定时长（与 1.1.8 及以前完全一致，不改既有手感） */
const PLAIN_TIMEOUT_MS = 3000
/** 云的默认时长：比普通提示长一点，够看清"正在读取…"又不至于赖着不走 */
const CLOUD_TIMEOUT_MS = 5500

let timer: ReturnType<typeof setTimeout> | null = null
const clearTimer = () => {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/**
 * 关闭提示。**必须能重复调用**：点击消失后定时器还会到点，重复关闭不能报错、不能把新提示关掉
 * （E29 的教训：状态被上一次的收尾动作改掉 ⇒ 卡死/闪没）。
 */
const hideNotice = () => {
  clearTimer()
  notice.value = { ...notice.value, show: false }
}

provide(NOTICE_KEY, (msg: string, c = 'info', options?: NoticeOptions) => {
  clearTimer()
  const cloud = options?.cloud === true
  notice.value = {
    show: true,
    text: msg,
    color: c,
    cloud,
    clickable: options?.clickable !== false,
  }
  // 每条提示**重新计时**（连续调用 = 一直显示最新那条，而不是被第一条的定时器提前关掉）
  const timeout = options?.timeout ?? (cloud ? CLOUD_TIMEOUT_MS : PLAIN_TIMEOUT_MS)
  if (timeout > 0) {
    timer = setTimeout(() => {
      // 期间又被换成别的提示时不关（比较 text：这是唯一能区分"同一条"的字段）
      if (notice.value.text === msg) hideNotice()
      timer = null
    }, timeout)
  }
})
</script>

<style scoped>
/* 云的进出场：淡入 + 轻微下坠（比"啪"地出现更像云飘过来） */
.cloud-fade-enter-active,
.cloud-fade-leave-active {
  transition: opacity 0.28s ease, transform 0.28s ease;
}
.cloud-fade-enter-from,
.cloud-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.97);
}
</style>
