<script setup lang="ts">
/**
 * 流体云式顶部通知（1.1.9 需求①，用户 2026-09-17 提出）
 *
 * 用途：**导入 / 读取数据**这类"有过程"的操作给一条顶部浮层提示 ——
 *   · 云朵外形（柔和阴影 + 两团侧翼小云 + 缓慢上下浮动），玻璃质感，不遮操作区；
 *   · **点一下立刻消失**（用户明确要求「点击消失」），另有自动淡出兜底（由调用方给 timeout）；
 *   · 纯展示组件：**只收 props、只发一个 `dismiss` 事件**，不碰任何全局状态（逻辑留在 `app.vue`）。
 *
 * 为什么单独一个组件：`app.vue` 里只放"挂哪儿、什么时候关"，云的画法与交互留在这一处，
 * 以后要调外形不必动全局提示逻辑。
 */
const props = withDefaults(
  defineProps<{
    /** 提示文案（调用方已保证非空） */
    text: string
    /** 语义色：info / success / warning / error（只用于图标与左侧色条，云体保持中性玻璃感） */
    color?: string
    /** 是否可点击消失（默认 true；关掉时只剩自动淡出） */
    clickable?: boolean
  }>(),
  { color: 'info', clickable: true },
)

const emit = defineEmits<{ dismiss: [] }>()

/** 语义色 → 图标（与 Vuetify 的 alert 图标口径一致，用户一眼能分辨成功/失败） */
const icon = computed(
  () =>
    ({
      success: 'mdi-check-circle-outline',
      warning: 'mdi-alert-outline',
      error: 'mdi-close-circle-outline',
      info: 'mdi-information-outline',
    })[props.color] ?? 'mdi-information-outline',
)

const onClick = () => {
  if (props.clickable) emit('dismiss')
}
</script>

<template>
  <div
    class="cloud-notice"
    :class="[`is-${color}`, { 'is-clickable': clickable }]"
    role="status"
    :title="clickable ? '点一下即可关闭' : ''"
    @click="onClick"
  >
    <div class="cloud-cloud">
      <span class="cloud-puff cloud-puff-a" aria-hidden="true" />
      <span class="cloud-puff cloud-puff-b" aria-hidden="true" />
      <div class="cloud-body">
        <v-icon :icon="icon" size="20" class="cloud-icon" />
        <div class="cloud-content">
          <div class="cloud-text">{{ text }}</div>
          <div v-if="clickable" class="cloud-hint">点一下即可关闭</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 定位层：整条挂在顶部居中；pointer-events:none 让云外的区域照常能点 */
.cloud-notice {
  position: fixed;
  top: 74px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 2600;
}

/* 云体：一层淡渐变 + 柔和外阴影；blur 让它像"流体"而不是卡片 */
.cloud-cloud {
  position: relative;
  pointer-events: auto;
  max-width: min(86vw, 560px);
  filter: drop-shadow(0 10px 22px rgba(0, 0, 0, 0.42));
  animation: cloud-float 3.6s ease-in-out infinite;
}

/* 侧翼小云：两团一样底色的小圆，制造"多个圆弧叠出来的云"轮廓 */
.cloud-puff {
  position: absolute;
  border-radius: 50%;
  background: rgba(240, 245, 252, 0.94);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.22);
}
.cloud-puff-a {
  width: 68px;
  height: 68px;
  left: -18px;
  bottom: -14px;
}
.cloud-puff-b {
  width: 48px;
  height: 48px;
  right: -14px;
  bottom: -10px;
}

.cloud-body {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(250, 252, 255, 0.98) 0%, rgba(233, 240, 250, 0.96) 100%);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.55);
  color: #14243c;
  font-size: 14px;
  line-height: 1.35;
}

.cloud-content {
  min-width: 0;
}
.cloud-text {
  font-weight: 600;
  word-break: break-word;
}
.cloud-hint {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.6;
  margin-top: 1px;
}

/* 语义色：只染图标与左侧色条，云体保持中性（整片染绿/染红会很像错误弹窗） */
.cloud-icon {
  flex: 0 0 auto;
}
.cloud-body {
  border-left: 4px solid #1565c0;
}
.is-info .cloud-icon {
  color: #1565c0;
}
.is-success .cloud-body {
  border-left-color: #2e7d32;
}
.is-success .cloud-icon {
  color: #2e7d32;
}
.is-warning .cloud-body {
  border-left-color: #ef6c00;
}
.is-warning .cloud-icon {
  color: #ef6c00;
}
.is-error .cloud-body {
  border-left-color: #c62828;
}
.is-error .cloud-icon {
  color: #c62828;
}

.is-clickable {
  cursor: pointer;
}
.is-clickable:hover .cloud-body {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35) inset;
}

@keyframes cloud-float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

/* 尊重"减少动态效果"偏好（系统级无障碍设置） */
@media (prefers-reduced-motion: reduce) {
  .cloud-cloud {
    animation: none;
  }
}
</style>
