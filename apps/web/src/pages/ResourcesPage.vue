<script setup lang="ts">
/** P-07 资源与用量：按项目总量（含库卷/持久卷/文件/日志）；规格仅系统管理员可调整 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import type { UsageBreakdown } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatBytes, formatPercent, formatTimeDual } from '@/domain/format'
import { quotaMessage, usageStaleNotice } from '@/domain/quota'
import { COPY } from '@/domain/text'
import { useSession } from '@/stores/session'
import { useProject } from '@/stores/project'
import { useUi } from '@/stores/ui'

const route = useRoute()
const id = String(route.params.id)
const session = useSession()
const ui = useUi()
const { state } = useProject(id)
const usage = ref<UsageBreakdown | null>(null)
const error = ref<unknown>(null)
const now = new Date('2026-11-20T09:20:00.000Z')

const msg = computed(() => quotaMessage(state.project?.quota.ratio ?? 0, session.role.value))
const specEditable = computed(() => session.role.value === 'sysadmin')

async function load() {
  try {
    const res = await api.usage(id, ui.state.scenario)
    usage.value = res.data
  } catch (e) {
    error.value = e
  }
}

function tryEditSpec() {
  ui.push('warn', '规格调整入口在系统设置', [COPY.specSysadminOnly, '管理员与普通用户都不是调整入口。'])
}

onMounted(load)
</script>

<template>
  <div class="page">
    <ErrorNotice v-if="error" :error="error" />
    <section class="panel">
      <div class="panel-head">
        <h2>资源用量</h2>
        <span class="hint">{{ usageStaleNotice(usage?.collected_at ?? '2026-11-20 09:15', Boolean(usage?.stale)) }}</span>
      </div>
      <div v-if="state.project" class="row cards">
        <div class="mini">
          <span class="hint">CPU（规格上限）</span>
          <strong>{{ state.project.spec.cpu }} C</strong>
          <span class="hint">本期未采集 CPU 用量</span>
        </div>
        <div class="mini">
          <span class="hint">内存（规格上限）</span>
          <strong>{{ state.project.spec.memory_mb }} MB</strong>
          <span class="hint">本期未采集内存用量</span>
        </div>
        <div class="mini">
          <span class="hint">磁盘（含日志）</span>
          <strong>{{ formatBytes(usage?.used_bytes ?? state.project.quota.used_bytes) }} / {{ formatBytes(usage?.limit_bytes ?? state.project.quota.limit_bytes) }}</strong>
          <span class="hint">{{ formatPercent(usage?.ratio ?? state.project.quota.ratio) }}</span>
        </div>
      </div>
      <p :class="msg.level === 'normal' ? 'okbox' : 'warnbox'">{{ msg.text }} {{ msg.action }}</p>
      <div class="bar"><i :style="{ width: `${Math.min(100, (state.project?.quota.ratio ?? 0) * 100)}%` }"></i></div>
      <p class="hint">配额按项目总量计算：数据库卷、持久卷、文件与 30 天日志全部计入；采集每 15 分钟一次，数字可能滞后但限制实时生效。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>磁盘分项</h2><span class="badge">合计 = 项目配额</span></div>
      <table>
        <thead>
          <tr><th>分项</th><th class="num">占用</th><th class="num">占项目配额</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in usage?.parts ?? []" :key="p.kind">
            <td>{{ p.label }}</td>
            <td class="num">{{ formatBytes(p.bytes) }}</td>
            <td class="num">{{ formatPercent(p.bytes / (usage?.limit_bytes || 1)) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        合计 {{ formatBytes(usage?.used_bytes ?? 0) }} = 项目配额占用；达到 {{ formatPercent(usage?.threshold.warning ?? 0.8) }} 触发告警，超过上限按 {{ usage?.threshold.action === 'hard_reject' ? '硬拒绝' : '硬拒绝' }} 处理。
        日志转存保留 30 天并计入配额；不提供 S3 / 对象存储 API。{{ COPY.noS3Api }}
      </p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>项目资源规格</h2></div>
      <dl class="kv" v-if="state.project">
        <dt>CPU / 内存</dt>
        <dd>{{ state.project.spec.cpu }} C / {{ state.project.spec.memory_mb }} MB</dd>
        <dt>磁盘上限</dt>
        <dd>{{ formatBytes(state.project.spec.disk_bytes) }}</dd>
        <dt>预览上限</dt>
        <dd>{{ state.project.spec.preview_limit }} 个</dd>
      </dl>
      <div class="row">
        <button v-if="!specEditable" class="btn" disabled>规格调整（仅系统管理员）</button>
        <button v-if="!specEditable" class="btn ghost" @click="tryEditSpec">为什么不能改？</button>
        <RouterLink v-if="specEditable" class="btn primary" to="/sys/settings">前往系统设置调整</RouterLink>
      </div>
      <p class="hint">{{ COPY.specSysadminOnly }} 调整后：扩容需重启生效，缩减立即限制；不改动已有数据。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>采集时间</h2></div>
      <p class="hint">{{ usage ? formatTimeDual(usage.collected_at, now) : '—' }}（每 15 分钟采集一次）</p>
    </section>
  </div>
</template>

<style scoped>
.cards {
  gap: 10px;
}
.mini {
  border: 1px solid var(--color-neutral-3);
  border-radius: var(--console-radius-control);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  min-width: 160px;
}
.bar {
  height: 8px;
  background: var(--color-fill-2);
  border-radius: var(--border-radius-medium);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--warning-6);
}
</style>
