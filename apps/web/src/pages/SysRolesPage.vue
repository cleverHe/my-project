<script setup lang="ts">
/** P-18 角色权限模型：系统管理员定义操作权限；授权只有「可见」一档不可改 */
import { onMounted, ref } from 'vue'
import { api } from '@/api/client'
import type { RoleModel } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatDateTime } from '@/domain/format'
import { useUi } from '@/stores/ui'

const ui = useUi()
const model = ref<RoleModel | null>(null)
const error = ref<unknown>(null)
const dirty = ref(false)

async function load() {
  try {
    model.value = (await api.roles()).data
  } catch (e) {
    error.value = e
  }
}

function toggle(roleIdx: number, modIdx: number, opIdx: number) {
  const op = model.value?.roles[roleIdx]?.modules[modIdx]?.ops[opIdx]
  if (!op) return
  op.enabled = !op.enabled
  dirty.value = true
}

async function save() {
  if (!model.value) return
  try {
    const res = await api.saveRoles(model.value)
    ui.push('success', '已保存', [`已生效（${res.data.version}）：≤30 秒生效；影响普通用户 ${res.data.affected.user} 人、管理员 ${res.data.affected.admin} 人、系统管理员 ${res.data.affected.sysadmin} 人。`, '变更写审计；不允许把授权扩成「可写」等级。'])
    dirty.value = false
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
      <div><h1>角色权限模型</h1><p class="sub">只有三类应用角色；拥有者/被授权人/项目组属于项目数据关系，不能在这里变成角色。</p></div>
      <div class="row">
        <span v-if="model" class="badge">{{ model.version }} · 更新于 {{ formatDateTime(model.updated_at) }}</span>
        <button class="btn primary" :disabled="!dirty" @click="save">保存并生效</button>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <p class="infobox">授权等级固定为「可见」一档，不可在此扩展；被授权人具体能做什么由本页的操作权限决定。</p>
    <section v-for="(r, ri) in model?.roles ?? []" :key="r.role" class="panel">
      <div class="panel-head"><h2>{{ r.label }}（{{ r.role }}）</h2></div>
      <div v-for="(m, mi) in r.modules" :key="m.module" class="module">
        <strong>{{ m.module }}</strong>
        <div class="ops">
          <label v-for="(op, oi) in m.ops" :key="op.code" class="checkbox">
            <input type="checkbox" :checked="op.enabled" @change="toggle(ri, mi, oi)" />
            {{ op.label }}
            <span class="badge mono">{{ op.code }}</span>
          </label>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.module {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px dashed var(--c-line);
  padding-top: 8px;
}
.module:first-of-type {
  border-top: none;
  padding-top: 0;
}
.ops {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 4px;
}
</style>
