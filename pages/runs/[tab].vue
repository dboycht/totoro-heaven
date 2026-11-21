<template>
  <!-- `flat`：跑步页自带卡片布局，不要再套一层卡（见 TabGroupShell 的注释） -->
  <TabGroupShell :group="GROUP" flat>
    <RunWorkspace />
  </TabGroupShell>
</template>

<script setup lang="ts">
/**
 * 「跑步」分组：`/runs/sunrun`（阳光跑）、`/runs/ytu`（研途健行）、`/runs/freerun`（自由跑）
 *
 * ## 2026-09-20 立组（用户要求）
 * 用户要求："把自由跑阳光跑放到一个标签页"（此前是导航里两个平级入口）。
 * 三者**共用同一个引擎组件** `components/RunWorkspace.vue`（跑步机状态本来就是跨页面共享的 `useState`），
 * 所以这里只是给同一份内容套上"分组标签"外壳，**不需要复制任何逻辑**。
 *
 * ## 🆕 2026-09-29 加第三个小标签「研途健行【建议】」（GitHub issue #13 + 用户四条口径）
 * 用户原话："将研途健行专门做一个选项卡【建议】，与阳光跑，自由跑同列，启动时进行识别并提示"。
 *   🔄 2026-11-21（用户口径）：标签上的「【建议】」删掉（与「测试」标注同批清理的漏网之鱼；历史原话保留）。
 *   · **判据是通用的**（`routeRequirementOf(task).kind === 'free'`，即"服务端未下发线路"），
 *     **不是**把某所学校写死 —— 研途健行只是这一类任务里的一个实例；
 *   · `RunWorkspace` 内部据此**主动提示**（站错页时给一键切换入口，站对页时确认一句），
 *     并多出一块「路径与配速设置」（目标里程 / 圈数 / 配速）；
 *   · ⚠️ **提交口径一个字都没变**：`ytu` 与 `sunrun` 一样是 `runType=0`（带任务号、不带线路标识）。
 *
 * ⚠️ 关键：`RunWorkspace` 靠**路由末段**判断当前是哪种跑法（`sunrun` / `ytu` / `freerun`），
 *    所以本页只需给出正确的 URL；口径与提交逻辑都在 RunWorkspace / runner / submitPayload 里。
 *    ⚠️ 加标签时**必须同时改三处**（漏一处就是"URL 能开、内容却是别的页"或 404）：
 *      ① 本文件的 `validate` 白名单；② 本文件的 `GROUP.tabs`；③ `RunWorkspace` 里的路由判定
 *      （`isFreeTab` / `isSunRun` —— 尤其别写成 `runTab === 'sunrun'`，那样新标签会掉进自由跑分支）。
 */
import RunWorkspace from '~/components/RunWorkspace.vue'

definePageMeta({
  validate: (route) => ['sunrun', 'ytu', 'freerun'].includes(String(route.params.tab ?? '')),
})

const GROUP = {
  base: '/runs',
  label: '跑步',
  icon: 'mdi-run-fast',
  hint: '阳光跑 / 研途健行 / 自由跑（同一套引擎，仅提交口径与设置项不同）',
  tabs: [
    { key: 'sunrun', label: '阳光跑', icon: 'mdi-white-balance-sunny' },
    { key: 'ytu', label: '研途健行', icon: 'mdi-map-marker-path' },
    { key: 'freerun', label: '自由跑', icon: 'mdi-run' },
  ],
} as const
</script>
