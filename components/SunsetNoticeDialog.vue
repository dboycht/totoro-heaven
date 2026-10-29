<template>
  <!--
    停更公告（用户 2026-10-29 要求）：
      · 每次启动都弹（用户明确选择，不做"已读就记住"）—— 由 `layouts/default.vue` 在挂载时打开；
      · 可关闭（点「我已知晓」/ 右上角 × / 点遮罩 / 按 Esc），但不可绕过：遮罩常驻、没有"不再提示"的出口；
      · 含体育部回信截图；图可点开放大，窄窗口里也读得清；
      · 「关于」里也放了同一入口（`AboutDialog` 里可再次打开本弹窗 ⇒ 关掉后仍能回看）。
    ⚠️ 这里刻意不加 `persistent` —— 用户要的是"每次启动都提醒"，不是"不点就进不去软件"；
       加 `persistent` 会让遮罩无法关闭，被误认为程序卡死。可关闭 = 不阻塞，每次启动都弹 = 一定会看到。
    ⚠️ 本模板注释里不写 markdown 星号（`tests/mp/uiText.test.ts` 守着：注释里的星号会被抄进真实文案）。
  -->
  <v-dialog v-model="model" max-width="640" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center pt-4 pb-2">
        <v-icon color="error" size="30" class="mr-2">mdi-newspaper-remove</v-icon>
        <span class="text-h6 font-weight-bold">因南航学生向南航体育部举报，本项目永久停更</span>
        <v-spacer />
        <v-btn icon="mdi-close" size="small" variant="text" title="关闭" @click="model = false" />
      </v-card-title>

      <v-card-subtitle class="pb-3">
        相关下载渠道与仓库将陆续关闭 —— 十分抱歉。
      </v-card-subtitle>

      <v-divider />

      <v-card-text class="pt-4">
        <div class="text-body-2 mb-3">
          由于南航学生向南航体育部举报，我方后续将会关闭下载渠道以及相关仓库，本项目<b>永久停止更新</b>。
          <b>十分抱歉</b>，也感谢一路以来的使用与反馈。
        </div>

        <!-- 体育部回信截图（用户 2026-10-29 提供）：点图放大阅读 -->
        <v-sheet border rounded class="pa-2 mb-2">
          <div class="text-caption text-medium-emphasis mb-1 d-flex align-center">
            <v-icon size="16" class="mr-1">mdi-email-open-outline</v-icon>
            南航体育部回信（截图）
            <v-spacer />
            <span class="text-caption">点击图片可放大</span>
          </div>
          <v-img
            :src="NOTICE_IMG"
            :alt="IMG_ALT"
            class="notice-img"
            max-height="260"
            contain
            role="button"
            tabindex="0"
            title="点击放大"
            @click="zoom = true"
            @keydown.enter="zoom = true"
            @keydown.space.prevent="zoom = true"
          />
        </v-sheet>

        <v-alert type="warning" variant="tonal" density="compact" class="mb-0">
          <div class="text-body-2">
            本站与软件内<b>不再提供新版本</b>；已下载的版本仍可离线使用，但其接口随校方与厂商调整可能失效。
            请遵守你所在学校的规定，风险自负。
          </div>
        </v-alert>
      </v-card-text>

      <v-card-actions class="px-4 pb-4">
        <span class="text-caption text-medium-emphasis">此公告每次启动都会显示</span>
        <v-spacer />
        <v-btn color="primary" variant="flat" @click="model = false">我已知晓</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- 放大查看（整屏、可滚动；点任意处或 Esc 关闭） -->
  <v-dialog v-model="zoom" max-width="1000">
    <v-card color="surface">
      <v-card-title class="d-flex align-center py-2">
        <span class="text-subtitle-1">南航体育部回信</span>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" title="关闭" @click="zoom = false" />
      </v-card-title>
      <v-divider />
      <v-card-text class="pa-2">
        <v-img :src="NOTICE_IMG" :alt="IMG_ALT" max-height="80vh" contain @click="zoom = false" />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
/**
 * 停更公告弹窗（2026-10-29）。
 *
 * 图片：`public/notice/sports-dept-reply.png`（随源码入库，打包后的 EXE 内也能取到）。
 * ⚠️ 路径写成**根相对** `/notice/...`，与 `public/` 下的目录一一对应；改文件名时这里与 README/Release 正文要一起改。
 */
const model = defineModel<boolean>({ default: false })

const NOTICE_IMG = '/notice/sports-dept-reply.png'
const IMG_ALT = '南航体育部就校园跑相关代码的回信截图'

/** 放大查看的弹窗状态（与主弹窗独立，关闭放大后主弹窗仍在） */
const zoom = ref(false)

// 关闭主弹窗时顺手收起放大层（避免下次打开时"一进来就是放大的"）
watch(model, (v) => {
  if (!v) zoom.value = false
})
</script>

<style scoped>
.notice-img {
  border-radius: 6px;
  cursor: zoom-in;
  outline-offset: 2px;
}

/* 键盘可达性：聚焦时给个可见轮廓（v-img 默认没有） */
.notice-img:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
}
</style>
