<script setup lang="ts">
/**
 * ListShell：按配置平台 list.shell 等价还原（visual-baseline §2.4）
 * - 左「操作」右「查询」；窄容器由 styles.css 的 @container 规则换行
 * - 面板圆角用 --border-radius-small（源码值），分页区 52px，总数在左、控件在右
 * - 默认每页 10，可选 10/20/50/100/200；空列表保留第 1 页与「共 0 条」
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    total: number
    page: number
    size: number
    pageSizes?: number[]
    unit?: string
    jump?: boolean
  }>(),
  { pageSizes: () => [10, 20, 50, 100, 200], unit: '条', jump: true },
)
const emit = defineEmits<{ (e: 'update:page', value: number): void; (e: 'update:size', value: number): void }>()

const pages = computed(() => Math.max(1, Math.ceil(props.total / props.size)))
const current = computed(() => Math.min(Math.max(1, props.page), pages.value))

/**
 * 页码窗口：页数多时只展示「首 + 当前附近 3 个 + 尾」，中间用省略号。
 * 为什么不用全量页码：206 条 / 每页 10 会有 21 个页码按钮，控件换行把分页区撑成两行，
 * 总数会被挤到上一行（配置平台 ListShell 是「总数在左、控件在右」同一行）。
 */
const PAGE_WINDOW = 3
type PageCell = number | 'gap-l' | 'gap-r'
const pageItems = computed<PageCell[]>(() => {
  const last = pages.value
  const cur = current.value
  if (last <= PAGE_WINDOW * 2 + 3) return Array.from({ length: last }, (_, i) => i + 1)
  const cells: PageCell[] = [1]
  const start = Math.max(2, cur - PAGE_WINDOW)
  const end = Math.min(last - 1, cur + PAGE_WINDOW)
  if (start > 2) cells.push('gap-l')
  for (let p = start; p <= end; p += 1) cells.push(p)
  if (end < last - 1) cells.push('gap-r')
  cells.push(last)
  return cells
})

function go(next: number) {
  const target = Math.min(Math.max(1, next), pages.value)
  if (target !== props.page) emit('update:page', target)
}
function onSize(e: Event) {
  const next = Number((e.target as HTMLSelectElement).value) || 10
  if (next !== props.size) emit('update:size', next)
}
function onJump(e: KeyboardEvent) {
  if (e.key !== 'Enter') return
  const input = e.target as HTMLInputElement
  go(Number(input.value) || 1)
  input.value = ''
}
</script>

<template>
  <div class="list-shell">
    <div class="list-toolbar">
      <div class="toolbar-actions"><slot name="actions" /></div>
      <div class="toolbar-filters"><slot name="filters" /></div>
    </div>
    <div class="list-panel">
      <div class="list-content"><slot /></div>
      <div class="pagination-bar">
        <span class="pager-total">共 {{ total }} {{ unit }}</span>
        <span class="pager-ctrl">
          <label class="pager-size">
            <span class="hint">每页</span>
            <select :value="size" aria-label="每页条数" @change="onSize">
              <option v-for="n in pageSizes" :key="n" :value="n">{{ n }}</option>
            </select>
            <span class="hint">{{ unit }}</span>
          </label>
          <button type="button" class="pagebtn" :disabled="current <= 1" @click="go(current - 1)">上一页</button>
          <template v-for="cell in pageItems" :key="String(cell)">
            <span v-if="cell === 'gap-l' || cell === 'gap-r'" class="pagegap" aria-hidden="true">…</span>
            <button
              v-else
              type="button"
              class="pagebtn"
              :class="{ on: cell === current }"
              :aria-current="cell === current ? 'page' : undefined"
              @click="go(cell as number)"
            >
              {{ cell }}
            </button>
          </template>
          <button type="button" class="pagebtn" :disabled="current >= pages" @click="go(current + 1)">下一页</button>
          <span v-if="jump" class="pager-jump">
            <span class="hint">跳至</span>
            <input class="jump" type="text" aria-label="跳至页码" @keydown="onJump" />
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
