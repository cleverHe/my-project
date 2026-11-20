<script setup lang="ts">
/** 项目布局：抬头 + 暂停闸门横幅 + GAP-03 保留状态卡 + 子页导航 */
import { computed, onMounted, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { retentionView } from '@/domain/status'
import { COPY } from '@/domain/text'
import { useProject } from '@/stores/project'
import { useSession } from '@/stores/session'

const route = useRoute()
const session = useSession()
const id = computed(() => String(route.params.id))
const { state, load } = useProject(id.value)

const tabs = computed(() => [
  { to: `/projects/${id.value}/deploy`, label: '部署' },
  { to: `/projects/${id.value}/resources`, label: '资源' },
  { to: `/projects/${id.value}/files`, label: '文件' },
  { to: `/projects/${id.value}/logs`, label: '日志' },
  { to: `/projects/${id.value}/collaboration`, label: '授权与分享' },
  { to: `/projects/${id.value}/access`, label: '接入与规范' },
  { to: `/projects/${id.value}/backups`, label: '备份' },
])

const retention = computed(() => retentionView(state.previewCount, state.previewLimit))

onMounted(load)
watch(id, load)
</script>

<template>
  <div class="page">
    <ErrorNotice v-if="state.error" :error="state.error" />
    <template v-else>
      <div class="page-head">
        <div>
          <h1>{{ state.project?.name ?? '加载中…' }}</h1>
          <p class="sub">
            拥有者：{{ state.project?.owner.display_name ?? '—' }} ·
            <span class="mono">{{ state.project?.slug }}</span> ·
            {{ state.project?.relation === 'owner' ? '你是拥有者' : state.project?.relation_label ?? '' }}
          </p>
        </div>
        <RouterLink class="btn" to="/dashboard">返回 Dashboard</RouterLink>
      </div>

      <div v-if="state.gate?.paused" class="warnbox gate">
        <strong>{{ COPY.gatePaused }}</strong> · {{ state.gate.reason === 'offsite_sync_failed' ? '异地同步失败 1 次' : '每日全量备份任务内重试 3 次仍失败' }}
        <div>{{ COPY.gateImpact }}</div>
        <div>{{ COPY.gateNext }}</div>
        <div class="hint">暂停开始时间：{{ state.gate.paused_since }}</div>
      </div>

      <section class="panel retention">
        <div class="panel-head"><h2>预览保留</h2><span class="badge">GAP-03 已确认</span></div>
        <dl class="kv">
          <dt>保留策略</dt>
          <dd>{{ retention.retention }}</dd>
          <dt>当前预览数</dt>
          <dd>{{ retention.count }}（{{ COPY.previewCountRule }}）</dd>
          <dt>与备份的关系</dt>
          <dd>{{ retention.backup }}</dd>
          <dt>最近一次正式发布</dt>
          <dd>{{ retention.lastPublishImpact }}</dd>
        </dl>
      </section>

      <nav class="tabs">
        <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" :class="{ active: route.path.startsWith(t.to) }">{{ t.label }}</RouterLink>
      </nav>

      <RouterView :key="id" />
    </template>
  </div>
</template>

<style scoped>
.gate {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.retention {
  gap: 6px;
}
</style>
