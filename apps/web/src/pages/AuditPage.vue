<script setup lang="ts">
/** P-17 审计：仅追加、1 年保留、CSV 12 列（列名待 T-01 确认，不编造） */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import type { AuditRow } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatDateTime } from '@/domain/format'
import { useUi } from '@/stores/ui'

const ui = useUi()
const rows = ref<AuditRow[]>([])
const error = ref<unknown>(null)
const total = ref(0)
const columns = ref(12)
const columnsConfirmed = ref(false)
const filter = ref('')
const page = ref(1)

const shown = computed(() => (filter.value ? rows.value.filter((r) => r.action.includes(filter.value) || r.actor.includes(filter.value)) : rows.value))

async function load() {
  error.value = null
  try {
    const res = await api.audit({ page: page.value })
    rows.value = res.data.items
    total.value = res.data.total
    columns.value = res.data.csv_columns
    columnsConfirmed.value = res.data.csv_columns_confirmed
  } catch (e) {
    error.value = e
  }
}

async function exportAs(format: 'csv' | 'json') {
  try {
    const res = await api.exportAudit(format)
    ui.push('success', `已导出 ${res.data.format.toUpperCase()}`, [
      `共 ${res.data.rows} 条。`,
      format === 'csv' ? `CSV 固定 ${columns.value} 列；具体列名待业务确认（T-01），本次导出不编造列名。` : 'JSON 同步导出，字段与接口一致。',
    ])
  } catch (e) {
    error.value = e
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div><h1>审计</h1><p class="sub">仅追加、不可修改；保留 1 年。</p></div>
      <div class="row">
        <input v-model="filter" type="text" placeholder="按操作/操作人筛选" />
        <button class="btn" @click="exportAs('csv')">导出 CSV</button>
        <button class="btn" @click="exportAs('json')">导出 JSON</button>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="!columnsConfirmed" class="warnbox">CSV 固定 {{ columns }} 列，但列名与字段定义待业务确认（T-01）。导出前不会编造列名，也不会用近似字段凑数。</p>
    <section class="panel">
      <div class="panel-head"><h2>记录（{{ shown.length }} / {{ total }}）</h2><span class="hint">写操作审计失败时，该操作按失败处理。</span></div>
      <table>
        <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>结果</th><th>来源 IP</th><th>变更</th></tr></thead>
        <tbody>
          <tr v-for="r in shown" :key="r.id">
            <td>{{ formatDateTime(r.at) }}</td>
            <td>{{ r.actor }}</td>
            <td class="mono">{{ r.action }}</td>
            <td>{{ r.object }}</td>
            <td>{{ r.result === 'success' ? '成功' : '失败' }}</td>
            <td class="mono">{{ r.source_ip }}</td>
            <td class="hint">{{ r.before ? `${r.before} → ${r.after}` : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
