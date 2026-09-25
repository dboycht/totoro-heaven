<template>
  <!--
    鸣谢页（2026-09-23 新增；2026-09-25 起接进正式软件 —— 顶栏「鸣谢」入口，见 `layouts/default.vue`）

    薄页面：真正的界面在 `components/CreditsView.vue`（整屏片尾式名单：彩带 + 放不下时缓慢滚动）。
    名单数据 = 下面的 `CREDITS`。维护方式：用开发副本的 `鸣谢名单编辑面板.html` 填/改 →「保存到文件」→ 告诉代理，
    由代理生成进这里（别再手工改本文件，否则又变成两份输入源）。

    调试参数（`?demo` 只给开发期看两种极端形态，正式使用不需要）：
      · /credits            默认 = `CREDITS`（两条，放得下 ⇒ 全部静态显示）
      · /credits?demo=long  40 条占位（放不下 ⇒ 片尾式滚动）
      · /credits?demo=none  0 条（验证兜底不白屏）

    默认两条就是当前收录的贡献者：
      · 序号 0 = `@Dusktides` / 参与相关内部测试（用户点名保留）；
      · 序号 1 = `@TecntOvO` / 协助适配「研途健行」（2026-09-25 加，背景见 HANDOVER 附录 I）。
    要再加人：走上面说的面板流程；文案只写"称呼 + 做了什么"，不放学号、姓名、token 之类任何真实隐私数据。
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
  { name: '@Dusktides', intro: '参与相关内部测试' },
  { name: '@TecntOvO', intro: '协助适配「研途健行」' },
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
