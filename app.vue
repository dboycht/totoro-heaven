<template>
  <v-app>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>

    <!--
      全局提示条（**普通矩形**，2026-09-18 按用户要求把云朵浮层整块删掉）：
      · 顶部居中、成功/警告/错误各有底色（Vuetify 语义色）；
      · **点一下（或点右侧 ×）立即关闭**，不点则到点自动消失；
      · 浮层之外不挡鼠标 —— 只有提示条本身接收点击；
      · 🆕 **进出场动画**（2026-09-18 用户问"为啥没有动画"后补上）：自上而下淡入 + 轻微放大，
        关闭时淡出并向上收起（点条身或点 × 都一样）。
    -->
    <Transition name="notice-in">
      <div v-if="notice.show" class="notice-wrap" @click="hideNotice">
        <v-alert
          :type="alertType"
          variant="flat"
          density="comfortable"
          elevation="8"
          class="notice-bar"
          role="status"
        >
          <div class="d-flex align-center ga-2">
            <span class="notice-text">{{ notice.text }}</span>
            <v-btn
              icon="mdi-close"
              size="x-small"
              variant="text"
              class="ml-2"
              title="关闭"
              @click.stop="hideNotice"
            />
          </div>
        </v-alert>
      </div>
    </Transition>
  </v-app>
</template>

<script setup lang="ts">
import { NOTICE_KEY, type NoticeOptions } from '~/composables/useNotice'

/**
 * 全局提示条（唯一出口）：页面/组件通过 `useNotice()`（见 `composables/useNotice.ts`）调用。
 *
 * 签名（**未变**，调用方无需改动）：
 *   showNotice(text, color?)                                 // 默认 3 秒后自动消失
 *   showNotice(text, color, { timeout: 0 })                   // 不自动消失，等用户点掉
 *   showNotice(text, color, { cloud: true })                  // ⚠️ 兼容参数，**现在与普通提示完全一样**
 *
 * 📌 2026-09-18：用户看过一版"流体云式"浮层后**明确否掉**（要求换成正常矩形、可点击关闭），
 *    所以云朵组件（`components/CloudNotice.vue`）已**删除**；`cloud` 这个字段保留但**不再有形态含义**，
 *    仅为不改动 7 处调用方而存在（后续轮次可安全清理）。
 */
const notice = useState('globalSnackbar', () => ({
  show: false,
  text: '',
  color: 'info' as string,
}))

/** 普通提示的固定时长（与 1.1.8 及以前完全一致） */
const PLAIN_TIMEOUT_MS = 3000

/**
 * 语义色 → Vuetify alert 类型。
 * 映射表**固定**：不用 `:type="notice.color"` 直传，避免以后有人往 `color` 里塞非语义值
 * （如 `#22c55e`）导致 alert 类型失效、静默变成默认蓝色。
 */
const alertType = computed(() => {
  const c = String(notice.value.color ?? '')
  return c === 'success' || c === 'warning' || c === 'error' ? c : 'info'
})

let timer: ReturnType<typeof setTimeout> | null = null
const clearTimer = () => {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/**
 * 关闭提示。**必须能重复调用**：点击关闭后定时器还会到点，重复关闭不能报错、
 * 也不能把"之后新弹的那条"关掉（E29 的教训：收尾动作改错状态 ⇒ 卡死/闪没）。
 */
const hideNotice = () => {
  clearTimer()
  notice.value = { ...notice.value, show: false }
}

provide(NOTICE_KEY, (msg: string, c = 'info', options?: NoticeOptions) => {
  clearTimer()
  notice.value = { show: true, text: msg, color: c }
  // 每条提示**重新计时**（连续调用 = 一直显示最新那条，而不是被第一条的定时器提前关掉）
  const timeout = options?.timeout ?? PLAIN_TIMEOUT_MS
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
/* 定位层：顶部居中；pointer-events:none 让提示条之外的区域照常可点 */
.notice-wrap {
  position: fixed;
  top: 74px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 2600;
  padding: 0 12px;
}

/* 矩形提示条：本身接收点击（点一下即关）
   ⚠️ 2026-09-18 用户反馈"右边一堆空白不美观"：`v-alert` 作为 flex 子项默认会被拉伸到满宽
   （`flex-grow`）⇒ 用 `flex: 0 0 auto` + `width: fit-content` 让它**只占文字宽度**；
   文案很长时才由 `max-width` 兜底换行。 */
.notice-bar {
  pointer-events: auto;
  cursor: pointer;
  flex: 0 0 auto;
  width: fit-content;
  max-width: min(88vw, 640px);
  border-radius: 6px;
}

.notice-text {
  word-break: break-word;
}

/*
 * 进出场动画（2026-09-18 用户问"为啥没有动画"后补上）
 *
 * 关键：**过渡要加在 `.notice-bar`（v-alert）上，不能加在 `.notice-wrap` 上** ——
 * wrap 是 `position: fixed` 的定位层，对它做位移不会让提示条动（这是常见的"动画看不出效果"原因）。
 * 另外 v-alert 自带 `opacity` 过渡（v-alert--variant-flat 的 transition），
 * 我们只覆盖 `transition-duration`（更跟手），**不动 transition 属性本身**，避免和 Vuetify 打架。
 */
.notice-bar {
  transition-duration: 0.22s;
}

/* 进入：自上而下淡入 + 轻微放大（从 0.96 长到 1） */
.notice-in-enter-from,
.notice-in-enter-to {
  transition-duration: 0.22s;
}
.notice-in-enter-from {
  opacity: 0;
  transform: translateY(-12px) scale(0.96);
}
.notice-in-enter-to {
  opacity: 1;
  transform: translateY(0) scale(1);
}

/* 离开：淡出 + 略缩小并向上收起（关闭的方向与"从上方飘来"一致，看着不突兀） */
.notice-in-leave-from,
.notice-in-leave-to {
  transition-duration: 0.18s;
}
.notice-in-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.notice-in-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.97);
}

/* 尊重系统"减少动态效果"：直接不做位移，只保留极短的淡入淡出 */
@media (prefers-reduced-motion: reduce) {
  .notice-in-enter-from,
  .notice-in-leave-to {
    transform: none;
  }
}
</style>
