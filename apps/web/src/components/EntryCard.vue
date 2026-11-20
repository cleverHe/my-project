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
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.kind {
  font-weight: 600;
  font-size: 13px;
  color: #374151;
}
dl {
  margin: 0;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.meta {
  display: flex;
  gap: 4px;
  font-size: 12px;
  color: #6b7280;
}
dt,
dd {
  margin: 0;
}
dd {
  color: #111827;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: #92400e;
  background: #fffbeb;
  border-radius: 6px;
  padding: 4px 8px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}
.link {
  font-size: 12px;
  color: #1d4ed8;
  text-decoration: none;
}
.primary {
  margin-left: auto;
  border: 1px solid #1d4ed8;
  background: #1d4ed8;
  color: #fff;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
</style>
