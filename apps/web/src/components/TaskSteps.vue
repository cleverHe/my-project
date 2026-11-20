<script setup lang="ts">
/** 发布阶段进度：顺序固定，当前步与失败步都要显式 */
import { computed } from 'vue'
import type { Task } from '@/api/types'
import { PHASE_LABEL, deployStages } from '@/domain/deploy'
import { formatDateTime } from '@/domain/format'

const props = defineProps<{ task: Task; withBackup: boolean }>()
const stages = computed(() => deployStages(props.withBackup).filter((p) => p !== 'done'))
const currentIndex = computed(() => (props.task.phase ? stages.value.indexOf(props.task.phase as never) : -1))
</script>

<template>
  <ol class="rail">
    <li v-for="(s, i) in stages" :key="s" :class="{ done: i < currentIndex, now: i === currentIndex, failed: task.status === 'failed' && i === currentIndex }">
      <span class="idx">{{ i + 1 }}</span>
      <span class="label">{{ PHASE_LABEL[s] }}</span>
      <span v-if="i === currentIndex && task.status === 'failed'" class="state">失败</span>
    </li>
  </ol>
  <div class="meta">
    <span>状态：{{ task.status === 'queued' ? '排队中' : task.status === 'running' ? '进行中' : task.status === 'succeeded' ? '成功' : '失败' }}</span>
    <span v-if="task.sha">实际构建 SHA：{{ task.sha.slice(0, 7) }}</span>
    <span v-if="task.finished_at">结束：{{ formatDateTime(task.finished_at) }}</span>
  </div>
</template>

<style scoped>
.rail {
  display: flex;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 0 0 8px;
  flex-wrap: wrap;
}
.rail li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #e5e7eb;
  font-size: 12px;
  color: #6b7280;
  background: #fff;
}
.idx {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f3f4f6;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}
.rail li.now {
  border-color: #1d4ed8;
  color: #1d4ed8;
  background: #eff6ff;
}
.rail li.now .idx {
  background: #1d4ed8;
  color: #fff;
}
.rail li.done {
  border-color: #b7e4c7;
  color: #1a7f45;
}
.rail li.failed {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}
.rail li.failed .idx {
  background: #dc2626;
  color: #fff;
}
.meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #6b7280;
  flex-wrap: wrap;
}
</style>
