<script setup lang="ts">
import { computed } from 'vue'
import type { DisplayState } from '@/api/types'
import { displayStateLabel, displayStateTone } from '@/domain/status'

const props = withDefaults(defineProps<{ state: DisplayState | 'pending'; label?: string }>(), { label: '' })
const text = computed(() => props.label || (props.state === 'pending' ? '进行中' : displayStateLabel(props.state)))
const tone = computed(() => (props.state === 'pending' ? 'info' : displayStateTone(props.state)))
</script>

<template>
  <span class="pill" :class="tone">{{ text }}</span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  font-size: 12px;
  line-height: 1;
  border: 1px solid transparent;
  white-space: nowrap;
}
.ok {
  background: #e8f7ee;
  color: #1a7f45;
  border-color: #b7e4c7;
}
.warn {
  background: #fff4e5;
  color: #9a4b00;
  border-color: #ffd8a8;
}
.muted {
  background: #f2f3f5;
  color: #606266;
  border-color: #e4e7ed;
}
.info {
  background: #eaf2ff;
  color: #1d4ed8;
  border-color: #c7d9ff;
}
</style>
