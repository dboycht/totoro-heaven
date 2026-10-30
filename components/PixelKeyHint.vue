<script setup lang="ts">
/**
 * 像素风键位图（2026-10-30，用户要求）：画在游戏页**上半部分**，告诉用户怎么玩。
 *
 * 用户原话：「原版只有上下，我们映射左右也为上下，映射AB也为上下；相关标注使用像素风格标注在页面上半部分」
 * 定稿键位：**↑ / ← / → 跳跃；↓ / A / B 蹲下**（`components/ChibiRunGame.vue` 里做了按键映射）。
 *
 * ## 为什么自己画点阵而不是用系统字体
 * 页面上其它文字都是系统字体，混进来会破坏像素风；这里用 5×7 点阵手写方向键与字母，
 * 每个"点"是一个 4px 方块（锐利边缘），中文标签用等宽粗体陪衬。
 *
 * ## 不挡操作
 * 整块 `pointer-events: none`：它只负责"看"，不接收任何鼠标/键盘事件（游戏照常玩）。
 */
const emit = defineEmits<{ (e: 'unlock'): void }>()

/** 5×7 点阵字形：每行 5 位，"1"=点亮 */
const GLYPHS: Record<string, string[]> = {
  '↑': ['00100', '01110', '10101', '00100', '00100', '00100', '00100'],
  '↓': ['00100', '00100', '00100', '00100', '10101', '01110', '00100'],
  '←': ['00100', '01000', '11111', '01000', '00100', '00000', '00000'],
  '→': ['00100', '00010', '11111', '00010', '00100', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}

/** 把一行文字按 5×7 点阵排成"行 × 列"的布尔矩阵（供模板逐格渲染） */
function pixelRows(text: string): boolean[][] {
  const rows: boolean[][] = Array.from({ length: 7 }, () => [] as boolean[])
  for (const ch of Array.from(text)) {
    const g = GLYPHS[ch.toUpperCase()] ?? GLYPHS[' ']!
    for (let r = 0; r < 7; r++) {
      for (const bit of g[r]!) rows[r]!.push(bit === '1')
      rows[r]!.push(false) // 字间距 1 格
    }
  }
  return rows
}

/** 两行键位说明（点阵画键名，中文标签在右侧） */
const LINES = [
  { key: '↑ ← →', label: '跳跃' },
  { key: '↓ A B', label: '蹲下' },
]
const lineRows = LINES.map((l) => ({ ...l, rows: pixelRows(l.key) }))
const titleRows = pixelRows('TOTORO HEAVEN')
</script>

<template>
  <div class="controls-hint" aria-hidden="true">
    <div class="hint-frame">
      <div class="hint-title">
        <div v-for="(row, r) in titleRows" :key="r" class="pix-row">
          <span v-for="(on, c) in row" :key="c" class="pix" :class="{ on }" />
        </div>
      </div>

      <div class="hint-rows">
        <div v-for="line in lineRows" :key="line.key" class="hint-row">
          <div class="pix-group">
            <div v-for="(row, r) in line.rows" :key="r" class="pix-row">
              <span v-for="(on, c) in row" :key="c" class="pix" :class="{ on }" />
            </div>
          </div>
          <span class="hint-label">{{ line.label }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.controls-hint {
  position: absolute;
  top: 64px;
  left: 0;
  right: 0;
  z-index: 4;
  display: flex;
  justify-content: center;
  pointer-events: none; /* 绝不挡按键 / 点击 */
  user-select: none;
}
.hint-frame {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px 28px 18px;
  border: 4px solid #2b2b2b;
  background: rgba(255, 255, 255, 0.58);
  box-shadow: 6px 6px 0 rgba(43, 43, 43, 0.16);
}
.pix-row {
  display: flex;
}
.pix {
  width: 4px;
  height: 4px;
  background: transparent;
  flex: 0 0 auto;
}
.pix.on {
  background: #2b2b2b;
}
.hint-title .pix {
  width: 3px;
  height: 3px;
}
.pix-group {
  display: flex;
  flex-direction: column;
}
.hint-rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hint-row {
  display: flex;
  align-items: center;
  gap: 18px;
}
.hint-label {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.16em;
  color: #2b2b2b;
}
/* 窗口较小时整体缩小，免得压到游戏画面 */
@media (max-width: 1000px) {
  .hint-frame {
    transform: scale(0.75);
    transform-origin: top center;
  }
}
@media (max-height: 700px) {
  .controls-hint {
    top: 54px;
  }
  .hint-frame {
    transform: scale(0.68);
    transform-origin: top center;
  }
}
</style>
