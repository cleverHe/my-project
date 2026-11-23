<script setup lang="ts">
/** P-17 审计：仅追加、1 年保留、CSV 12 列（列名待 T-01 确认，不编造） */
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import type { AuditRow } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import ListShell from '@/components/ListShell.vue'
import { useServerPagedList } from '@/composables/useServerPagedList'
import { formatDateTime } from '@/domain/format'
import { useUi } from '@/stores/ui'

const ui = useUi()
const filter = ref('')
const columns = ref(12)
const columnsConfirmed = ref(false)
const meta = ref<{ append_only: boolean; retention_days: number }>({ append_only: true, retention_days: 365 })
/** 服务端分页（paging-consumer-review）：page/page_size/过滤都发给服务端，total 只认服务端 */
const { page, size, rows, total, loading, error, load, goto, setSize, reset } = useServerPagedList<AuditRow>(async ({ page: p, page_size }) => {
  const action = filter.value.trim()
  const res = await api.audit({ page: p, page_size, ...(action ? { action } : {}) })
  columns.value = res.data.csv_columns
  columnsConfirmed.value = res.data.csv_columns_confirmed
  meta.value = { append_only: res.data.append_only ?? true, retention_days: res.data.retention_days ?? 365 }
  return { items: res.data.items, total: res.data.total, page: res.data.page, page_size: res.data.page_size, has_next: res.data.has_next }
})

/** 查询变化：防抖 300ms 后回第 1 页重新查询（不在前端过滤） */
let debounce: number | undefined
watch(filter, () => {
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => reset(), 300)
})

const emptyText = computed(() => (filter.value.trim() ? '没有匹配的记录。' : '该条件下没有记录。'))

/** 审计只有追加写：有前后值显示变更，没有则显示服务端给出的变更摘要（detail），否则 — */
function changeOf(r: AuditRow): string {
  if (r.before && r.after) return `${r.before} → ${r.after}`
  return r.change ?? '—'
}

function clearFilter() {
  filter.value = ''
  reset()
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Chromium 在 click 后立即 revoke 会截断下载
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportAs(format: 'csv' | 'json') {
  try {
    if (format === 'csv') {
      const res = await api.exportAuditCsv(ui.state.scenario)
      const lines = res.text.trim().split(/\r?\n/)
      const count = Math.max(lines.length - 1, 0)
      downloadText(res.text, res.filename ?? 'audit.csv')
      ui.push('success', '已导出 CSV 文件', [
        `共 ${count} 条；${lines[0]?.split(',').length ?? columns.value} 列（列名待 T-01 业务确认，不编造最终列名）。`,
      ])
      return
    }
    const res = await api.exportAudit('json')
    ui.push('success', '已导出 JSON', [`共 ${res.data.rows} 条。`, 'JSON 同步导出，字段与接口一致。'])
  } catch (e) {
    error.value = e
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>审计</h1>
        <p class="sub">仅追加、不可修改；保留 {{ meta.retention_days }} 天（约 1 年），到期删除、不做归档。</p>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <p v-if="!columnsConfirmed" class="warnbox">CSV 固定 {{ columns }} 列，但列名与字段定义待业务确认（T-01）。导出前不会编造列名，也不会用近似字段凑数。</p>
    <ListShell :total="total" :page="page" :size="size" @update:page="goto($event)" @update:size="setSize">
      <template #actions>
        <button class="btn" @click="exportAs('csv')">导出 CSV</button>
        <button class="btn" @click="exportAs('json')">导出 JSON</button>
      </template>
      <template #filters>
        <input v-model="filter" type="search" placeholder="按操作筛选（如 deploy.start）" aria-label="按操作筛选" />
        <button v-if="filter" class="btn" type="button" @click="clearFilter">清空筛选</button>
      </template>
      <table>
        <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>结果</th><th>来源 IP</th><th>变更摘要</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>{{ formatDateTime(r.at) }}</td>
            <td>{{ r.actor }}</td>
            <td class="mono">{{ r.action }}</td>
            <td>{{ r.object }}</td>
            <td>{{ r.result === 'success' ? '成功' : '失败' }}</td>
            <td class="mono">{{ r.source_ip }}</td>
            <td class="hint">{{ changeOf(r) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="empty">正在加载…</div>
      <div v-else-if="total === 0" class="empty">
        {{ emptyText }}
        <div class="empty-next">
          <template v-if="filter.trim()">清空搜索或换个操作关键词；当前条件共 0 条。</template>
          <template v-else>当前没有审计记录；写操作失败也会留下记录。</template>
          <button v-if="filter.trim()" class="btn" type="button" @click="clearFilter">清空筛选</button>
        </div>
      </div>
    </ListShell>
    <p class="hint">写操作审计失败时，该操作按失败处理；普通读操作（浏览、下载文件）不记审计。</p>
  </div>
</template>
