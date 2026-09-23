<template>
  <!--
    鸣谢页（2026-09-23 新增，用户要求"先生成界面，后面再接进软件"）

    薄页面：真正的界面在 `components/CreditsView.vue`。
    这里刻意不给任何导航加东西 —— 顶栏菜单、`pages/*/[tab].vue` 的 GROUP.tabs 都原样不动。
    临时访问地址：http://127.0.0.1:3000/credits

    示例数据给两条，用来说明"支持多条"：
      · 序号 0 是用户点名要的示例（`@Dusk` / 参与相关内部测试），页面刚打开显示的就是它；
      · 序号 1 只是占位格式示例，不是真实的人，接进软件时整段换掉即可。
  -->
  <CreditsView :items="CREDITS" />
</template>

<script setup lang="ts">
import type { CreditItem } from '~/components/CreditsView.vue'

/**
 * 鸣谢名单（示例数据）。
 * 只写"名称 + 一行介绍"，不放学号、姓名、token 之类任何真实隐私数据。
 */
const CREDITS: CreditItem[] = [
  { name: '@Dusk', intro: '参与相关内部测试' },
  { name: '@示例名称', intro: '介绍文案写在这一行' },
]
</script>
