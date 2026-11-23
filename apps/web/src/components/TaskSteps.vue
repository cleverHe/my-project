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
  flex-direction: column;
  gap: var(--playdayy-size-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.rail li {
  display: flex;
  align-items: baseline;
  gap: var(--playdayy-size-2);
  border: 1px solid var(--color-neutral-3);
  border-radius: var(--console-radius-control);
  padding: var(--playdayy-size-2) var(--playdayy-size-3);
  font-size: 13px;
  color: var(--color-text-2);
  background: var(--color-bg-2);
}
.rail li .idx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-fill-2);
  color: var(--color-text-2);
  font-size: 12px;
}
.rail li.now {
  border-color: var(--primary-5);
  color: var(--primary-7);
  background: var(--primary-1);
}
.rail li.now .idx {
  background: var(--primary-6);
  color: #fff;
}
.rail li.done {
  border-color: var(--success-6);
  color: var(--success-6);
}
.rail li.failed {
  border-color: var(--danger-6);
  background: var(--danger-1);
  color: var(--danger-6);
}
.rail li.failed .idx {
  background: var(--danger-6);
  color: #fff;
}
.meta {
  display: flex;
  gap: var(--playdayy-size-4);
  font-size: 12px;
  color: var(--color-text-2);
  flex-wrap: wrap;
}
</style>
