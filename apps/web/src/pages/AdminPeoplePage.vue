<script setup lang="ts">
/** P-13 人员权限：三类应用角色 + 操作权限；权限撤销 ≤30 秒 */
import { onMounted, ref } from 'vue'
import { api } from '@/api/client'
import type { AdminUser } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { useUi } from '@/stores/ui'

const ui = useUi()
const users = ref<AdminUser[]>([])
const error = ref<unknown>(null)
const editing = ref<AdminUser | null>(null)
const draft = ref<string[]>([])

async function load() {
  error.value = null
  try {
    users.value = (await api.adminUsers()).data.items
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
  if (!editing.value) return
  try {
    await api.updateUserOps(editing.value.user_id, draft.value)
    ui.push('success', '权限已更新', ['≤30 秒内生效；已打开的页面在下次请求时被拒绝。', '写操作全部按服务端校验，前端置灰不代表授权。'])
    editing.value = null
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
      <div>
        <h1>人员权限</h1>
        <p class="sub">三类应用角色：普通用户 / 管理员 / 系统管理员；拥有者、被授权人、项目组是数据关系，不是第四种角色。</p>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <section class="panel">
      <table>
        <thead><tr><th>姓名</th><th>飞书账号</th><th>角色</th><th>状态</th><th>操作权限</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.user_id">
            <td>{{ u.display_name }}</td>
            <td class="mono">{{ u.feishu_account }}</td>
            <td>{{ u.role === 'user' ? '普通用户' : u.role === 'admin' ? '管理员' : '系统管理员' }}</td>
            <td>{{ u.status === 'active' ? '正常' : '已停用' }}</td>
            <td class="hint">{{ u.operations.join('、') || '—' }}</td>
            <td><button class="btn" @click="startEdit(u)">分配权限</button></td>
          </tr>
        </tbody>
      </table>
      <p class="hint">停用账号后：不能登录，已有授权保留但不生效；异常预览可按 GAP-05 由系统管理员人工清理。</p>
    </section>

    <section v-if="editing" class="panel">
      <div class="panel-head"><h2>分配操作权限：{{ editing.display_name }}</h2><button class="btn ghost" @click="editing = null">关闭</button></div>
      <div class="ops">
        <label v-for="op in ['project:read','project:create','deploy:create','deploy:rollback','grant:manage','share:manage','file:read','log:read','log:ai','mcp:key']" :key="op" class="checkbox">
          <input type="checkbox" :checked="draft.includes(op)" @change="toggle(op)" />
          {{ op }}
        </label>
      </div>
      <div class="row"><button class="btn primary" @click="save">保存</button><span class="hint">撤销 ≤30 秒生效；变更写审计。</span></div>
    </section>
  </div>
</template>

<style scoped>
.ops {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px;
}
</style>
