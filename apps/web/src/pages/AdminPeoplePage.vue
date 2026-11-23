<script setup lang="ts">
/** P-13 人员权限：三类应用角色 + 操作权限；权限撤销 ≤30 秒 */
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import type { AdminUser, AssignableOp, Role } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import ListShell from '@/components/ListShell.vue'
import { matchesKeyword, usePagedList } from '@/composables/usePagedList'
import { useUi } from '@/stores/ui'

const ui = useUi()
const users = ref<AdminUser[]>([])
const assignableByRole = ref<Record<Role, AssignableOp[]> | null>(null)
const error = ref<unknown>(null)
const editing = ref<AdminUser | null>(null)
const draft = ref<string[]>([])
const filter = ref('')
const busy = ref(false)

/** 可分配项只来自服务端角色模型（P-14）：模型外的码不出现、也不可授予 */
const assignable = computed(() => {
  const role = editing.value?.role
  if (!role || !assignableByRole.value) return [] as AssignableOp[]
  return assignableByRole.value[role] ?? []
})

const filtered = computed(() => users.value.filter((u) => matchesKeyword(filter.value, u.display_name, u.feishu_account)))
const { page, size, total, paged, reset, setSize } = usePagedList(() => filtered.value)
watch(filter, reset)

async function load() {
  error.value = null
  try {
    // /sys/roles 只对系统管理员开放（P-18）；管理员用随人员列表下发的可分配项（P-14）
    const u = await api.adminUsers()
    users.value = u.data.items
    assignableByRole.value = u.data.assignable_by_role ?? null
  } catch (e) {
    error.value = e
  }
}

function startEdit(u: AdminUser) {
  editing.value = u
  draft.value = u.operations.slice()
}

function toggle(op: string) {
  const i = draft.value.indexOf(op)
  if (i >= 0) draft.value.splice(i, 1)
  else draft.value.push(op)
}

async function save() {
  if (!editing.value || busy.value) return
  busy.value = true
  try {
    await api.updateUserOps(editing.value.user_id, draft.value)
    // 保存反馈：实际保存入口触发，统一文案「已保存」（visual-baseline §2.7）
    ui.push('success', '已保存', ['≤ 30 秒内生效；已打开的页面在下次请求时被拒绝。', '写操作全部按服务端校验，前端置灰不代表授权。'])
    editing.value = null
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
    <div class="page-head">
      <div>
        <h1>人员权限</h1>
        <p class="sub">三类应用角色：普通用户 / 管理员 / 系统管理员；拥有者、被授权人、项目组是数据关系，不是第四种角色。</p>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <ListShell :total="total" :page="page" :size="size" @update:page="page = $event" @update:size="setSize">
      <template #filters>
        <input v-model="filter" type="search" placeholder="按姓名 / 飞书账号筛选" />
      </template>
      <table>
        <thead><tr><th>姓名</th><th>飞书账号</th><th>角色</th><th>状态</th><th>操作权限</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="u in paged" :key="u.user_id">
            <td>{{ u.display_name }}</td>
            <td class="mono">{{ u.feishu_account }}</td>
            <td>{{ u.role === 'user' ? '普通用户' : u.role === 'admin' ? '管理员' : '系统管理员' }}</td>
            <td>{{ u.status === 'active' ? '正常' : '已停用' }}</td>
            <td class="hint">{{ u.operations.join('、') || '—' }}</td>
            <td><button class="btn" @click="startEdit(u)">分配权限</button></td>
          </tr>
        </tbody>
      </table>
      <div v-if="filtered.length === 0" class="empty">
        没有匹配的人员。
        <div class="empty-next">清空搜索条件；人员来自飞书通讯录，不是在本页新增。</div>
      </div>
    </ListShell>
    <p class="hint">停用账号后：不能登录，已有授权保留但不生效；异常预览可按 GAP-05 由系统管理员人工清理。</p>

    <section v-if="editing" class="panel">
      <div class="panel-head"><h2>分配操作权限：{{ editing.display_name }}</h2><button class="btn ghost" @click="editing = null">关闭</button></div>
      <div v-if="!assignableByRole" class="warnbox">服务端未返回可分配项，暂不能分配；刷新后重试。</div>
      <div v-else-if="assignable.length === 0" class="warnbox">该角色在当前权限模型里没有被定义的操作位。</div>
      <div v-else class="ops">
        <label v-for="op in assignable" :key="op.code" class="checkbox" :class="{ disabled: !op.enabled }">
          <input type="checkbox" :disabled="!op.enabled" :checked="draft.includes(op.code)" @change="toggle(op.code)" />
          {{ op.label }}
          <span class="badge mono">{{ op.code }}</span>
          <span v-if="!op.enabled" class="hint">模型已关闭</span>
        </label>
      </div>
      <div class="row"><button class="btn primary" :disabled="busy" @click="save">保存</button><span class="hint">撤销 ≤30 秒生效；变更写审计。</span></div>
    </section>
  </div>
</template>

<style scoped>
.ops {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 6px;
}
.checkbox.disabled {
  opacity: 0.55;
}
</style>
