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
  border: 1px solid #ffccc7;
  background: #fff2f0;
  border-radius: 8px;
  padding: 12px 14px;
  color: #4a1d1d;
  font-size: 13px;
}
.err.compact {
  padding: 8px 10px;
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
