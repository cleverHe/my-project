<script setup lang="ts">
/** P-19 模板库：版本状态、下线不影响已建项目 */
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import type { TemplateInfo } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import ListShell from '@/components/ListShell.vue'
import { matchesKeyword, usePagedList } from '@/composables/usePagedList'
import { useUi } from '@/stores/ui'

const ui = useUi()
const items = ref<TemplateInfo[]>([])
const error = ref<unknown>(null)
const filter = ref('')
const state = ref<'all' | 'published' | 'offline'>('all')

const filtered = computed(() =>
  items.value.filter(
    (t) =>
      matchesKeyword(filter.value, t.name, t.version) &&
      (state.value === 'all' || (state.value === 'published' ? t.status === 'published' : t.status !== 'published')),
  ),
)
const { page, size, total, paged, reset, setSize } = usePagedList(() => filtered.value)
watch([filter, state], reset)

async function load() {
  try {
    // 管理页看全量（含已下线历史版本）；/templates 只返回已发布
    items.value = (await api.sysTemplates()).data.items
  } catch (e) {
    error.value = e
  }
}

async function act(t: TemplateInfo, action: 'publish' | 'offline') {
  try {
    await api.templateAction(t.id, action)
    ui.push('success', action === 'publish' ? '模板已发布' : '模板已下线', ['下线后不可用于新建项目；已建项目不受影响。'])
    await load()
  } catch (e) {
    error.value = e
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head"><div><h1>模板库</h1><p class="sub">模板含规范与 4 个门户 Skill；不可用时可回退空白模板（不会建空仓库）。</p></div></div>
    <ErrorNotice v-if="error" :error="error" />
    <ListShell :total="total" :page="page" :size="size" @update:page="page = $event" @update:size="setSize">
      <template #filters>
        <select v-model="state" style="width: 120px">
          <option value="all">全部状态</option>
          <option value="published">已发布</option>
          <option value="offline">已下线</option>
        </select>
        <input v-model="filter" type="search" placeholder="按模板名 / 版本筛选" />
      </template>
      <table>
        <thead><tr><th>模板</th><th>版本</th><th>形态</th><th>Demo</th><th class="num">使用项目</th><th>凭证扫描</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="t in paged" :key="t.id">
            <td>{{ t.name }}</td>
            <td class="mono">{{ t.version }}</td>
            <td>{{ t.shape }}</td>
            <td>{{ t.has_demo ? '有' : '无' }}</td>
            <td class="num">{{ t.projects_used }}</td>
            <td>{{ t.credential_scan === 'clean' ? '干净' : t.credential_scan }}</td>
            <td>{{ t.status === 'published' ? '已发布' : '已下线' }}</td>
            <td class="row">
              <button v-if="t.status !== 'published'" class="btn" @click="act(t, 'publish')">发布</button>
              <button v-else class="btn danger" @click="act(t, 'offline')">下线</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="filtered.length === 0" class="empty">
        没有匹配的模板。
        <div class="empty-next">清空筛选条件；已下线版本仍保留在这里，不会删除。</div>
      </div>
    </ListShell>
    <p class="hint">状态是真实值：已下线只标 deprecated，不删除历史版本，也不影响已建项目；下线后新建向导立即不再出现该模板。</p>
    <p class="hint">模板与规范更新不得覆盖用户已修改的文件；冲突应列出并要求对齐（见项目「接入与规范」页）。</p>
  </div>
</template>
