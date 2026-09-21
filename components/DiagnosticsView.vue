<template>
  <!--
    「数据 → 诊断」页主体（2026-09-21）

    用户要求：诊断与「记录」「日志」**并列**显示（而不是塞在日志页里），所以它在本分组里
    与 `RecordsView.vue` / `LogsView.vue` 同级、各占一个子页（`/data/diagnostics`）。

    内容本身仍是自成一体的 `DiagnosticsExportCard.vue`（操作说明 + 开始/结束录制 + 包内容预览 + 导出）。
    这一层只做"页"的身份，便于以后要加"页级"布局（例如再放一个"最近导出记录"）时不动卡片本身。
  -->
  <DiagnosticsExportCard />
</template>
