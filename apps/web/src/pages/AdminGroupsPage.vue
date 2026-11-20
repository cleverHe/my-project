<script setup lang="ts">
/** P-14 项目组：组上限 200 人；解散影响授权，不删项目 */
import { onMounted, ref } from 'vue'
import { api } from '@/api/client'
import type { GroupInfo } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { useUi } from '@/stores/ui'

const ui = useUi()
const groups = ref<GroupInfo[]>([])
const limit = ref(200)
const error = ref<unknown>(null)
const target = ref<GroupInfo | null>(null)

async function load() {
  try {
    const res = await api.adminGroups()
    groups.value = res.data.items
    limit.value = res.data.member_limit
  } catch (e) {
    error.value = e
  }
}

async function dissolve() {
  if (!target.value) return
  try {
    await api.dissolveGroup(target.value.id)
    ui.push('success', '项目组已解散', ['成员对该组的项目授权失效；项目本身与项目拥有者不变。'])
    target.value = null
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
      <div><h1>项目组</h1><p class="sub">组是授权对象，不是角色；单个项目组上限 {{ limit }} 人。</p></div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <section class="panel">
      <table>
        <thead><tr><th>名称</th><th class="num">成员</th><th class="num">关联项目</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="g in groups" :key="g.id">
            <td>{{ g.name }}</td>
            <td class="num">{{ g.member_count }} / {{ g.member_limit }}</td>
            <td class="num">{{ g.project_count }}</td>
            <td>{{ g.status === 'active' ? '正常' : '已解散' }}</td>
            <td><button class="btn danger" :disabled="g.status !== 'active'" @click="target = g">解散</button></td>
          </tr>
        </tbody>
      </table>
      <p class="hint">超过人数上限时创建会被拒绝，不会静默截断成员。</p>
    </section>

    <ConfirmDialog :open="Boolean(target)" title="解散项目组" confirm-text="确认解散" @cancel="target = null" @confirm="dissolve">
      <p>解散「{{ target?.name }}」后，成员通过该组获得的项目授权立即失效。</p>
      <p class="hint">不会删除任何项目；项目拥有者不变。此操作不可撤销。</p>
    </ConfirmDialog>
  </div>
</template>
