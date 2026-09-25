<template>
  <!--
    鸣谢页（2026-09-23 新增，用户要求"先生成界面，后面再接进软件"）

    薄页面：真正的界面在 `components/CreditsView.vue`。
    这里刻意不给任何导航加东西 —— 顶栏菜单、`pages/*/[tab].vue` 的 GROUP.tabs 都原样不动。
    临时访问地址：
      · http://127.0.0.1:3000/credits            两条（放得下 ⇒ 全部静态显示）
      · http://127.0.0.1:3000/credits?demo=long  40 条（放不下 ⇒ 片尾式滚动）
      · http://127.0.0.1:3000/credits?demo=none  0 条（验证兜底不白屏）

    默认给两条，页面刚打开显示的就是它们：
      · 序号 0 = `@Dusk` / 参与相关内部测试（用户点名保留）；
      · 序号 1 = `@TecntOvO` / 协助「研途健行」任务实测（2026-09-25 加，背景见 HANDOVER 附录 I）。
    要再加人：照 `CreditItem`（名称 + 一行介绍）往数组里加即可 ——
    文案只写"称呼 + 做了什么"，不放学号、姓名、token 之类任何真实隐私数据。
    `?demo=long` 那 40 条是占位示例（统一叫"同学 NN"），只为演示片尾滚动。
  -->
  <CreditsView :items="items" play-on-mount />
</template>

<script setup lang="ts">
import type { CreditItem } from '~/components/CreditsView.vue'

/**
 * 鸣谢名单（真实贡献者）。
 * 只写"名称 + 一行介绍"，不放学号、姓名、token 之类任何真实隐私数据。
 */
const CREDITS: CreditItem[] = [
  { name: '@Dusk', intro: '参与相关内部测试' },
  { name: '@TecntOvO', intro: '协助「研途健行」任务实测' },
]

/** 40 条占位示例：只为演示"条目多到放不下时的片尾滚动"，不是真实的人 */
function longList(): CreditItem[] {
  return Array.from({ length: 40 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0')
    return { name: `@示例同学${n}`, intro: '参与相关内部测试' }
  })
}

const route = useRoute()
/** demo 取值：long = 40 条；none = 0 条；其余（含缺省）= 默认两条 */
const items = computed<CreditItem[]>(() => {
  const demo = String(route.query.demo || '')
  if (demo === 'long') return longList()
  if (demo === 'none') return []
  return CREDITS
})
</script>
