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
          <button
            v-for="p in pages"
            :key="p"
            type="button"
            class="pagebtn"
            :class="{ on: p === current }"
            :aria-current="p === current ? 'page' : undefined"
            @click="go(p)"
          >
            {{ p }}
          </button>
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
