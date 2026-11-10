<script setup lang="ts">
/**
 * **路线库列表的一行**（2026-11-10 抽出）。
 *
 * 为什么单独成组件：跑道编辑页的"本地路线库"里现在有**两组**（手绘跑道 / 真实路径），
 * 两组的行结构完全一样（标题 + 摘要 + 详情展开 + 按钮），差别只有：
 *   · 真实路径**没有「载入」**（用户口径"跑道编辑相关页面应该无法对真实路径进行编辑以及选中、修改"）；
 *   · 真实路径多一个「真实路径」身份标签。
 *
 * ⚠️ 抽出来的**真正理由**不是"少写点代码"，而是 `uiText` 守卫的「同一个按钮文案不得出现两次」：
 *    两组各写一份 ⇒ 「重命名」「删除」各出现两次 ⇒ 守卫判定为"复制粘贴多留了一份"并报红。
 *    这个守卫抓真问题是有效的，**不该为了这次需求往白名单里塞条目**（那等于给守卫开洞）。
 */
import {
  entryDetailRows,
  entrySummaryText,
  historyLogText,
  type TrackEditLog,
  type TrackRouteEntry,
} from '~/utils/mp/trackLibrary'

const props = defineProps<{
  entry: TrackRouteEntry
  /** 显示名（调用方算好：`nameOf` 会用路线库的取名口径） */
  name: string
  /** 详情是否展开 */
  detailOpen: boolean
  /** 编辑历史最多显示几条（与 `trackLibrary` 的上限同源） */
  historyMax: number
  /** 是不是"真实路径"那一组（决定有没有「载入」、要不要身份标签） */
  realPath: boolean
  /** 是不是"当前正在编辑/选用"的那条 */
  current: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-detail'): void
  (e: 'load'): void
  (e: 'rename'): void
  (e: 'remove'): void
}>()

/** 历史条目（原版是 `e.history`；这里只为模板取个短名字） */
const history = (): TrackEditLog[] => (Array.isArray(props.entry.history) ? props.entry.history : [])
</script>

<template>
  <v-list-item class="px-0">
    <v-list-item-title class="text-body-2 d-flex flex-wrap align-center ga-1">
      {{ name }}
      <v-chip v-if="current" size="x-small" color="primary" variant="tonal">{{ realPath ? '正在跑步页选用' : '正在编辑' }}</v-chip>
      <v-chip v-if="realPath" size="x-small" color="warning" variant="tonal">真实路径</v-chip>
      <template v-else>
        <v-chip size="x-small" color="secondary" variant="tonal">地点：{{ entry.lineName || entry.lineId }}</v-chip>
        <v-chip v-if="entry.start" size="x-small" color="error" variant="tonal">起跑点已设</v-chip>
        <v-chip v-if="entry.editCount" size="x-small" color="secondary" variant="tonal">编辑 {{ entry.editCount }} 次</v-chip>
      </template>
    </v-list-item-title>
    <v-list-item-subtitle class="text-caption">{{ entrySummaryText(entry) }}</v-list-item-subtitle>
    <template #append>
      <v-btn size="x-small" variant="text" @click="emit('toggle-detail')">
        {{ detailOpen ? '收起详情' : '详情' }}
      </v-btn>
      <!-- 🔴 真实路径不给「载入」：它是真实跑出来的点列，载进编辑器一保存就把原始几何改写了 -->
      <v-btn v-if="!realPath" size="x-small" variant="text" @click="emit('load')">载入</v-btn>
      <v-btn size="x-small" variant="text" color="primary" @click="emit('rename')">重命名</v-btn>
      <v-btn size="x-small" variant="text" color="error" @click="emit('remove')">删除</v-btn>
    </template>
  </v-list-item>
  <v-expand-transition>
    <div v-if="detailOpen" class="lib-detail mb-2 pa-2">
      <v-table density="compact" class="lib-detail-table mb-2">
        <tbody>
          <tr v-for="row in entryDetailRows(entry)" :key="row.label">
            <td class="text-medium-emphasis lib-detail-label">{{ row.label }}</td>
            <td>{{ row.value }}</td>
          </tr>
        </tbody>
      </v-table>
      <div class="text-caption text-medium-emphasis">编辑历史（最近 {{ historyMax }} 次，最新在上）</div>
      <ul v-if="history().length" class="text-caption pl-4 mt-1 mb-0">
        <li v-for="(log, i) in history()" :key="`log-${i}`">{{ historyLogText(log) }}</li>
      </ul>
      <div v-else class="text-caption pl-1 mt-1">还没有编辑历史（这一条是用旧版本存的）。</div>
    </div>
  </v-expand-transition>
</template>
