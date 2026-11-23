<script setup lang="ts">
/** 入口槽位卡：两个槽位（最近更新预览 / 正式）；状态永远只三种 + 进行中 */
import type { EntrySlotView } from '@/domain/status'
import StatusPill from './StatusPill.vue'

defineProps<{ slot: EntrySlotView; hint?: string | null }>()
const emit = defineEmits<{ (e: 'action', key: EntrySlotView['primaryAction']['key']): void }>()
</script>

<template>
  <div class="card">
    <header>
      <span class="kind">{{ slot.label }}</span>
      <StatusPill :state="slot.state" />
    </header>
    <dl>
      <template v-for="m in slot.meta" :key="m.key">
        <div class="meta">
          <dt>{{ m.key === 'branch' ? '分支' : m.key === 'count' ? '预览数' : m.key === 'version' ? '版本' : 'SHA' }}</dt>
          <dd>{{ m.value }}</dd>
        </div>
      </template>
    </dl>
    <p v-if="slot.hint || hint" class="hint">{{ slot.hint || hint }}</p>
    <div class="actions">
      <a v-if="slot.state === 'running' && slot.url" class="link" :href="slot.url" target="_blank" rel="noopener">打开地址</a>
      <button type="button" class="primary" @click="emit('action', slot.primaryAction.key)">{{ slot.primaryAction.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--color-neutral-3);
  border-radius: var(--console-radius-panel);
  padding: var(--playdayy-size-3);
  background: var(--color-bg-2);
  display: flex;
  flex-direction: column;
  gap: var(--playdayy-size-2);
  min-width: 0;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--playdayy-size-2);
}
.kind {
  font-weight: 600;
  font-size: 14px;
  color: var(--color-text-1);
}
dl {
  margin: 0;
  display: flex;
  gap: var(--playdayy-size-4);
  flex-wrap: wrap;
}
.meta {
  display: flex;
  gap: var(--playdayy-size-1);
  font-size: 13px;
  color: var(--color-text-2);
}
dt,
dd {
  margin: 0;
}
dd {
  color: var(--color-text-1);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-1);
  background: var(--warning-1);
  border: 1px solid var(--warning-6);
  border-radius: var(--console-radius-control);
  padding: var(--playdayy-size-1) var(--playdayy-size-2);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--playdayy-size-2);
  margin-top: auto;
}
.link {
  font-size: 13px;
  color: var(--primary-6);
  text-decoration: none;
}
.primary {
  margin-left: auto;
  border: 1px solid var(--primary-6);
  background: var(--primary-6);
  color: #fff;
  border-radius: var(--console-radius-control);
  height: var(--console-control-h);
  padding: 0 12px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
</style>
