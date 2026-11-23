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
  border-radius: var(--border-radius-medium);
  font-size: 12px;
  line-height: 1;
  border: 1px solid transparent;
  white-space: nowrap;
}
.ok {
  background: var(--success-1);
  color: var(--success-6);
  border-color: var(--success-6);
}
.warn {
  background: var(--warning-1);
  color: var(--warning-6);
  border-color: var(--warning-6);
}
.muted {
  background: var(--color-fill-2);
  color: var(--color-text-2);
  border-color: var(--color-neutral-3);
}
.info {
  background: var(--primary-1);
  color: var(--primary-7);
  border-color: var(--primary-5);
}
</style>
