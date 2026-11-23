<script setup lang="ts">
/** P-11 接入与规范：MCP 单用户 Key（只存指纹）+ 规范/Skill 包更新（不覆盖用户改动） */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatDateTime } from '@/domain/format'
import { COPY } from '@/domain/text'
import { useUi } from '@/stores/ui'

const route = useRoute()
const id = String(route.params.id)
const ui = useUi()
// api-spec §7.8：GET /mcp-keys 只返回指纹前缀与状态，不返回明文
const key = ref<{ key_id: string; fingerprint_prefix: string; status: string; created_at: string; last_used_at: string } | null>(null)
const plaintext = ref<string | null>(null)
const files = ref<string[]>([])
const update = ref<{ added: number; updated: number; kept_user_edits: number; conflicts: { file: string; rule: string; why: string; action: string }[] } | null>(null)
const error = ref<unknown>(null)
const confirmRevoke = ref(false)
const confirmUpdate = ref(false)

async function load() {
  error.value = null
  try {
    const [k, p] = await Promise.all([api.mcpKeys(), api.accessPack(id)])
    key.value = k.data.items[0] ?? null
    files.value = p.data.files
  } catch (e) {
    error.value = e
  }
}

async function rotate() {
  try {
    const res = await api.createMcpKey()
    plaintext.value = res.data.plaintext_once
    ui.push('success', '新 Key 已生成', [COPY.mcpKeyOnce, '调用失败会在 1 分钟内随撤销生效。'])
    await load()
  } catch (e) {
    error.value = e
  }
}

async function revoke() {
  confirmRevoke.value = false
  try {
    if (key.value) await api.revokeMcpKey(key.value.key_id)
    plaintext.value = null
    ui.push('success', 'Key 已撤销', ['≤1 分钟内所有 Agent 调用失败；不会影响已有部署。'])
    await load()
  } catch (e) {
    error.value = e
  }
}

async function doUpdate() {
  confirmUpdate.value = false
  try {
    const res = await api.updateAccessPack(id, ui.state.scenario)
    update.value = res.data.changes
    ui.push('success', '已保存', [`规范已更新：新增 ${res.data.changes.added}、更新 ${res.data.changes.updated}、保留你的改动 ${res.data.changes.kept_user_edits}。`])
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
      <div class="panel-head"><h2>MCP 单用户 Key</h2><span class="badge">只存指纹</span></div>
      <dl class="kv" v-if="key">
        <dt>指纹</dt><dd class="mono">{{ key.fingerprint_prefix }}</dd>
        <dt>状态</dt><dd>{{ key.status === 'active' ? '有效' : '已撤销' }}</dd>
        <dt>创建时间</dt><dd>{{ formatDateTime(key.created_at) }}</dd>
        <dt>最近使用</dt><dd>{{ formatDateTime(key.last_used_at) }}</dd>
      </dl>
      <div v-if="plaintext" class="warnbox">
        <strong>明文只显示这一次：</strong>
        <div class="mono plain">{{ plaintext }}</div>
        <div>请立即保存到本地凭据管理器；不要提交到仓库、不要贴到聊天或日志里。</div>
      </div>
      <div class="row">
        <button class="btn primary" @click="rotate">{{ key?.status === 'active' ? '轮换 Key' : '生成 Key' }}</button>
        <button class="btn danger" :disabled="key?.status !== 'active'" @click="confirmRevoke = true">撤销 Key</button>
      </div>
      <p class="hint">Key 绑定单个用户；发布/回滚仍需你本人在 5 分钟内确认，Agent 不能自批。撤销 ≤1 分钟生效。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>规范与 Skill 包</h2><span class="badge">模板更新不覆盖你的文件</span></div>
      <ul class="files">
        <li v-for="f in files" :key="f" class="mono">{{ f }}</li>
      </ul>
      <p class="hint">{{ COPY.updateSpecHardRules }}</p>
      <button class="btn" @click="confirmUpdate = true">检查并更新规范</button>
      <div v-if="update" class="infobox">
        <div>新增 {{ update.added }} · 更新 {{ update.updated }} · 保留你的改动 {{ update.kept_user_edits }}</div>
        <div v-for="c in update.conflicts" :key="c.file">
          冲突：{{ c.file }} → 规则「{{ c.rule }}」（{{ c.why }}）：{{ c.action }}
        </div>
      </div>
    </section>

    <ConfirmDialog :open="confirmRevoke" title="撤销 MCP Key" confirm-text="确认撤销" @cancel="confirmRevoke = false" @confirm="revoke">
      <p>撤销后 1 分钟内所有使用该 Key 的 Agent 调用失败；已有部署不受影响。</p>
      <p class="hint">撤销不可恢复，需要重新生成新的 Key。</p>
    </ConfirmDialog>

    <ConfirmDialog :open="confirmUpdate" title="更新规范/Skill 包" :danger="false" confirm-text="确认更新" @cancel="confirmUpdate = false" @confirm="doUpdate">
      <p>{{ COPY.updateSpecHardRules }}</p>
      <p class="hint">与平台硬约束冲突时会列出差异并要求对齐，不会静默改动你的自定义内容。</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.plain {
  background: var(--color-bg-2);
  border: 1px dashed var(--warning-6);
  border-radius: var(--console-radius-control);
  padding: 6px 8px;
  margin: 4px 0;
  word-break: break-all;
}
.files {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
</style>
