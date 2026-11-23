<script setup lang="ts">
/** P-12 备份：每日全量 + 异地同步两套口径；尝试次数按 GAP-06 展示 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import type { BackupPoint } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { FAILURE_RULES, backupAttemptLabel, escalateLevel } from '@/domain/deploy'
import { formatDateTime } from '@/domain/format'
import { COPY } from '@/domain/text'
import { useUi } from '@/stores/ui'

const route = useRoute()
const id = String(route.params.id)
const ui = useUi()
const items = ref<BackupPoint[]>([])
const error = ref<unknown>(null)
const busy = ref(false)

async function load() {
  error.value = null
  try {
    const res = await api.backups(id)
    items.value = res.data.items
  } catch (e) {
    error.value = e
  }
}

async function manual() {
  busy.value = true
  try {
    await api.manualBackup(id, ui.state.scenario)
    ui.push('success', '手动备份完成', ['保留 30 天；每日全量备份不受影响。'])
    await load()
  } catch (e) {
    error.value = e
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <ErrorNotice v-if="error" :error="error" />
    <section class="panel">
      <div class="panel-head"><h2>备份</h2><span class="badge">保留 30 天 · RPO ≤ 24h · RTO ≤ 4h</span></div>
      <div class="row rules">
        <div class="rule">
          <strong>{{ FAILURE_RULES.daily_backup.label }}</strong>
          <p>{{ FAILURE_RULES.daily_backup.text }}</p>
          <p class="hint">失败计数为 1；连续 2 次升级 {{ escalateLevel(2) }} 告警。</p>
        </div>
        <div class="rule">
          <strong>{{ FAILURE_RULES.offsite_sync.label }}</strong>
          <p>{{ FAILURE_RULES.offsite_sync.text }}</p>
          <p class="hint">与每日备份是两套口径，不能合并成「重试 3 次再暂停」。</p>
        </div>
      </div>
      <p class="hint">{{ COPY.gateImpact }} 备份范围覆盖全部环境（含预览）、门户授权/模板、Dokploy 记录与镜像。</p>
      <button class="btn" :disabled="busy" @click="manual">立即手动备份</button>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>备份记录</h2></div>
      <table>
        <thead><tr><th>类型</th><th>范围</th><th>结果</th><th>尝试</th><th>时间</th><th>过期</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="b in items" :key="b.id">
            <td>{{ b.kind === 'auto' ? '每日全量' : b.kind === 'pre_publish' ? '发布前' : '手动' }}</td>
            <td>{{ b.scope }}</td>
            <td>{{ b.result === 'success' ? '成功' : '失败' }}</td>
            <td>{{ backupAttemptLabel(b) }}</td>
            <td>{{ formatDateTime(b.created_at) }}</td>
            <td>{{ formatDateTime(b.expires_at) }}</td>
            <td class="hint">{{ b.note }}</td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="7" class="hint">还没有备份记录。</td></tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>恢复</h2></div>
      <p class="hint">恢复是独立的高风险操作，需系统管理员二次确认并逐项校验；回滚不会回滚数据库，数据库恢复走这里。</p>
      <RouterLink class="btn" to="/sys/settings">前往系统设置执行恢复</RouterLink>
    </section>
  </div>
</template>

<style scoped>
.rules {
  align-items: stretch;
  gap: 10px;
}
.rule {
  flex: 1;
  min-width: 260px;
  border: 1px solid var(--color-neutral-3);
  border-radius: var(--console-radius-control);
  padding: 10px;
  font-size: 13px;
}
.rule p {
  margin: 4px 0 0;
}
</style>
