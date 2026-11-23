<script setup lang="ts">
/** 三段式错误展示（发生了什么 / 影响 / 下一步）+ 错误码与 traceId */
import { computed } from 'vue'
import { explainError, formatError } from '@/domain/errors'

const props = defineProps<{ error: unknown; compact?: boolean }>()
const view = computed(() => formatError(explainError(props.error as never)))
</script>

<template>
  <div class="err" :class="{ compact }" role="alert">
    <div class="head">{{ view.head }}</div>
    <ul>
      <li v-for="line in view.lines" :key="line">{{ line }}</li>
    </ul>
    <slot />
  </div>
</template>

<style scoped>
.err {
  border: 1px solid var(--danger-6);
  background: var(--danger-1);
  border-radius: var(--console-radius-control);
  padding: var(--playdayy-size-3) var(--playdayy-size-4);
  color: var(--color-text-1);
  font-size: 13px;
}
.err.compact {
  padding: var(--playdayy-size-2) var(--playdayy-size-3);
  font-size: 12px;
}
.head {
  font-weight: 600;
  margin-bottom: 6px;
}
ul {
  margin: 0;
  padding-left: 18px;
}
li {
  margin: 2px 0;
  line-height: 1.55;
}
</style>
