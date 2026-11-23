<script setup lang="ts">
/** P-15/P-16 平台视图：健康、备份/同步、安全基线、仅两项可调参数（GAP-04） */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatPercent, formatTimeDual } from '@/domain/format'
import { COPY } from '@/domain/text'
import { useSession } from '@/stores/session'
import { useUi } from '@/stores/ui'

const session = useSession()
const ui = useUi()
const data = ref<Record<string, unknown> | null>(null)
const error = ref<unknown>(null)
const now = new Date('2026-11-20T09:20:00.000Z')
const concurrency = ref(3)
const queue = ref(10)

const params = computed(() => ({ build_concurrency: 3, queue_limit: 10, max_build_concurrency: 3, max_queue_limit: 10, ...((data.value?.params ?? {}) as Record<string, number>) }))
const host = computed(() => (data.value?.host ?? {}) as Record<string, number>)
const backups = computed(() => (data.value?.backups ?? {}) as Record<string, string | null>)
const sync = computed(() => (data.value?.sync ?? {}) as Record<string, string | null>)
const webhook = computed(() => (data.value?.webhook ?? { installed: 0, failed_projects: [] as string[] }) as { installed: number; failed_projects: string[] })
const security = computed(() => (data.value?.security ?? []) as { key: string; label: string; state: string; note: string }[])
const isAdmin = computed(() => session.role.value === 'admin')

async function load() {
  error.value = null
  try {
    const res = await api.adminPlatform(ui.state.scenario)
    data.value = res.data as unknown as Record<string, unknown>
    concurrency.value = (res.data.params as Record<string, number>).build_concurrency ?? 3
    queue.value = (res.data.params as Record<string, number>).queue_limit ?? 10
  } catch (e) {
    error.value = e
  }
}

async function saveParam(key: 'build_concurrency' | 'queue_limit', value: number) {
  try {
    const res = await api.adminSettings(key, value, ui.state.scenario)
    ui.push('success', '已保存', [`参数已更新：${key} = ${res.data.value}；只对新任务生效，正在运行的任务不受影响。`, '压测后只可下调，不可上调。'])
    await load()
  } catch (e) {
    error.value = e
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div><h1>平台视图</h1><p class="sub">健康、备份、安全基线；系统参数只有两项可由管理员调整。</p></div>
      <span v-if="!isAdmin" class="badge">当前角色只读</span>
    </div>
    <ErrorNotice v-if="error" :error="error" />

    <template v-if="data">
      <section class="panel">
        <div class="panel-head"><h2>组件连通性</h2></div>
        <dl class="kv">
          <dt>Dokploy</dt><dd>{{ data.dokploy_ok ? '正常' : '不可用' }} · 版本 {{ String(data.version) }}（digest：{{ String(data.digest_note) }}）</dd>
          <dt>GitLab 适配</dt><dd>{{ data.gitlab_ok ? '正常' : '不可用' }} · 官方 OAuth 优先，Generic Git 可切换</dd>
          <dt>ForwardAuth</dt><dd>{{ data.authz_ok ? '正常' : '不可用' }} · 未登录 302、无权 403（服务端校验）</dd>
          <dt>门户</dt><dd>{{ data.gateway_ok ? '正常' : '不可用' }}</dd>
          <dt>主机水位</dt>
          <dd>CPU {{ formatPercent(host.cpu_ratio ?? 0) }} · 内存 {{ formatPercent(host.memory_ratio ?? 0) }} · 磁盘 {{ formatPercent(host.disk_ratio ?? 0) }}</dd>
        </dl>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>备份与异地同步</h2></div>
        <dl class="kv">
          <dt>最近成功备份</dt><dd>{{ formatTimeDual(backups.last_success_at, now) }}</dd>
          <dt>最近失败</dt><dd>{{ formatTimeDual(backups.last_failure_at, now) }} · {{ backups.last_failure_reason ?? '无' }}</dd>
          <dt>异地同步</dt><dd>{{ sync.last_failure_at ? `失败：${sync.last_failure_reason}` : `成功 ${formatTimeDual(sync.last_success_at, now)}` }}</dd>
          <dt>预览 Webhook</dt><dd>已安装 {{ webhook.installed }} 个 · 失败项目：{{ (webhook.failed_projects ?? []).join('、') || '无' }}</dd>
        </dl>
        <p class="hint">{{ COPY.dailyBackupRetry }} {{ COPY.offsiteSyncOnce }}</p>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>系统参数（仅两项例外）</h2><span class="badge">GAP-04</span></div>
        <p class="infobox">{{ COPY.adminParamException }} 其余参数（备份时间、保留期、配额、模板、角色模型）只有系统管理员可改。</p>
        <div class="row">
          <label class="field">
            <span>并发构建数（当前 {{ params.build_concurrency }}，上限 {{ params.max_build_concurrency }}）</span>
            <input v-model.number="concurrency" type="number" min="1" :max="params.max_build_concurrency" style="width: 120px" />
          </label>
          <button class="btn" :disabled="!isAdmin" @click="saveParam('build_concurrency', concurrency)">保存</button>
          <label class="field">
            <span>排队上限（当前 {{ params.queue_limit }}，上限 {{ params.max_queue_limit }}）</span>
            <input v-model.number="queue" type="number" min="1" :max="params.max_queue_limit" style="width: 120px" />
          </label>
          <button class="btn" :disabled="!isAdmin" @click="saveParam('queue_limit', queue)">保存</button>
        </div>
        <p class="hint">上调会被拒绝（system.param_raise_forbidden）；修改只对新任务生效，并写审计。</p>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>安全基线</h2><span class="hint">未执行的不写「通过」</span></div>
        <table>
          <thead><tr><th>项</th><th>状态</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="s in security" :key="s.key">
              <td>{{ s.label }}</td>
              <td>{{ s.state === 'pass' ? '通过' : s.state === 'fail' ? '不通过' : '未执行' }}</td>
              <td class="hint">{{ s.note }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
    <div v-else class="center-note">加载中…</div>
  </div>
</template>
