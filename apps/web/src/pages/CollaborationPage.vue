<script setup lang="ts">
/** P-10 授权与分享：两件事分开；授权只有「可见」一档；分享不等于授权 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import type { GrantItem, ShareItem } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatDateTime } from '@/domain/format'
import { COPY } from '@/domain/text'
import { useUi } from '@/stores/ui'

const route = useRoute()
const id = String(route.params.id)
const ui = useUi()
const grants = ref<GrantItem[]>([])
const shares = ref<ShareItem[]>([])
const limits = ref({ people: 50, groups: 10, group_members: 200 })
const error = ref<unknown>(null)
const subjectName = ref('')
const subjectType = ref<'user' | 'group'>('user')
const revokeGrantTarget = ref<GrantItem | null>(null)
const revokeShareTarget = ref<ShareItem | null>(null)

async function load() {
  error.value = null
  try {
    const [g, s] = await Promise.all([api.grants(id), api.shares(id)])
    grants.value = g.data.items
    limits.value = g.data.limits
    shares.value = s.data.items
  } catch (e) {
    error.value = e
  }
}

async function addGrant() {
  if (!subjectName.value.trim()) return
  error.value = null
  try {
    const res = await api.addGrants(id, [{ type: subjectType.value, name: subjectName.value.trim() }])
    const failed = res.data.results.filter((r) => !r.ok)
    if (failed.length) ui.push('warn', '部分未添加', failed.map((f) => `${f.name}：${f.reason ?? ''}`))
    else ui.push('success', '已授权（仅可见）', [COPY.singleGrantLevel])
    subjectName.value = ''
    await load()
  } catch (e) {
    error.value = e
  }
}

async function revokeGrant() {
  if (!revokeGrantTarget.value) return
  try {
    const res = await api.revokeGrant(revokeGrantTarget.value.id)
    ui.push('success', '已回收授权', [`≤ ${res.data.effective_within_seconds} 秒内入口与仓库权限同时失效；不影响其他人的授权。`])
    revokeGrantTarget.value = null
    await load()
  } catch (e) {
    error.value = e
  }
}

async function createShare(kind: 'preview' | 'production') {
  try {
    const env = kind === 'production' ? null : shares.value[0]?.branch ?? 'feat/order'
    const res = await api.createShare(id, kind, env)
    ui.push('success', '已生成分享链接', [res.data.url, COPY.shareNotGrant])
    await load()
  } catch (e) {
    error.value = e
  }
}

async function revokeShare() {
  if (!revokeShareTarget.value) return
  try {
    await api.revokeShare(revokeShareTarget.value.id)
    ui.push('success', '分享链接已撤销', [COPY.shareRevokeScope])
    revokeShareTarget.value = null
    await load()
  } catch (e) {
    error.value = e
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <ErrorNotice v-if="error" :error="error" />

    <section class="panel">
      <div class="panel-head">
        <h2>授权（数据可见性）</h2>
        <span class="badge">只有「可见」一档 · 上限 {{ limits.people }} 人 / {{ limits.groups }} 组</span>
      </div>
      <p class="infobox">{{ COPY.singleGrantLevel }} 拥有者是项目属性；授权人与项目组是数据关系，不是第四种角色。</p>
      <div class="row">
        <select v-model="subjectType">
          <option value="user">人员</option>
          <option value="group">项目组（≤ {{ limits.group_members }} 人）</option>
        </select>
        <input v-model="subjectName" type="text" placeholder="姓名或项目组名" style="min-width: 240px" />
        <button class="btn primary" :disabled="!subjectName.trim()" @click="addGrant">添加授权</button>
      </div>
      <table>
        <thead>
          <tr><th>对象</th><th>类型</th><th>状态</th><th>级别</th><th>授权来源</th><th>时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="g in grants" :key="g.id">
            <td>{{ g.subject_name }}</td>
            <td>{{ g.subject_type === 'user' ? '人员' : '项目组' }}</td>
            <td>{{ g.subject_status === 'active' ? '正常' : '已停用（授权保留但不生效）' }}</td>
            <td>可见</td>
            <td>{{ g.source === 'owner' ? '拥有者授权' : g.source }}</td>
            <td>{{ formatDateTime(g.created_at) }}</td>
            <td><button class="btn danger" @click="revokeGrantTarget = g">回收</button></td>
          </tr>
          <tr v-if="grants.length === 0"><td colspan="7" class="hint">还没有授权任何人。</td></tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>分享（只生成链接）</h2>
        <span class="hint">分享与授权独立：没有数据权限的人打开链接会 403</span>
      </div>
      <div class="row">
        <button class="btn" @click="createShare('production')">生成正式环境链接</button>
        <button class="btn" @click="createShare('preview')">生成预览链接</button>
      </div>
      <table>
        <thead><tr><th>环境</th><th>分支</th><th>链接</th><th>创建人</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in shares" :key="s.id">
            <td>{{ s.env_kind === 'production' ? '正式' : '预览' }}</td>
            <td class="mono">{{ s.branch ?? '—' }}</td>
            <td class="mono">{{ s.url }}</td>
            <td>{{ s.created_by }}</td>
            <td>{{ s.status === 'active' ? '有效' : `已撤销（${formatDateTime(s.revoked_at)}）` }}</td>
            <td><button class="btn" :disabled="s.status !== 'active'" @click="revokeShareTarget = s">撤销分享</button></td>
          </tr>
          <tr v-if="shares.length === 0"><td colspan="6" class="hint">还没有分享链接。</td></tr>
        </tbody>
      </table>
      <p class="hint">{{ COPY.shareNotGrant }} {{ COPY.shareRevokeScope }}</p>
    </section>

    <ConfirmDialog :open="Boolean(revokeGrantTarget)" title="回收授权" confirm-text="确认回收" @cancel="revokeGrantTarget = null" @confirm="revokeGrant">
      <p>将回收对 {{ revokeGrantTarget?.subject_name }} 的授权。对方会失去该项目数据可见性（≤30 秒生效）。</p>
      <p class="hint">这不等于撤销分享链接；如已分享，需在下方单独撤销。</p>
    </ConfirmDialog>

    <ConfirmDialog :open="Boolean(revokeShareTarget)" title="撤销分享链接" confirm-text="确认撤销" @cancel="revokeShareTarget = null" @confirm="revokeShare">
      <p>{{ COPY.shareRevokeScope }}</p>
      <p class="hint">只影响这一条链接，不改变任何人的项目授权。</p>
    </ConfirmDialog>
  </div>
</template>
