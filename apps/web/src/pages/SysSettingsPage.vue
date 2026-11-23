<script setup lang="ts">
/** P-20 系统设置（仅系统管理员）：项目规格、备份口径、异常预览清理（GAP-05）、恢复 */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import type { AbnormalPreview, ProjectCard } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { backupAttemptLabel, escalateLevel } from '@/domain/deploy'
import { formatBytes, formatTimeDual } from '@/domain/format'
import { COPY } from '@/domain/text'
import { arm, caseLabel, confirm as confirmStep, confirmTextFor, initConfirm, isSelectable, selectableRows, submitItems, summarize } from '@/flows/cleanupFlow'
import { useUi } from '@/stores/ui'

const ui = useUi()
const error = ref<unknown>(null)
const projects = ref<ProjectCard[]>([])
const selectedProject = ref('')
const spec = ref({ cpu: 0.5, memory_mb: 256, disk_gb: 4, preview_limit: 3 })
const abnormal = ref<AbnormalPreview[]>([])
const confirmState = ref(initConfirm())
const summary = ref<ReturnType<typeof summarize> | null>(null)
const restoreOpen = ref(false)
const restoreWord = ref('')
const backupStatus = ref<Record<string, unknown> | null>(null)
const now = new Date()

const project = computed(() => projects.value.find((p) => p.id === selectedProject.value) ?? null)
const failedBackupLabel = backupAttemptLabel({ attempts: 4, max_attempts: 3, result: 'failed' })
const selectable = computed(() => selectableRows(abnormal.value))

async function load() {
  error.value = null
  try {
    const [p, a, s] = await Promise.all([api.projects({ status: 'all' }), api.abnormalPreviews(), api.backupStatus()])
    projects.value = p.data.items
    abnormal.value = a.data.items
    backupStatus.value = s.data as unknown as Record<string, unknown>
    if (!selectedProject.value && projects.value[0]) {
      selectedProject.value = projects.value[0].id
      syncSpec()
    }
  } catch (e) {
    error.value = e
  }
}

function syncSpec() {
  if (!project.value) return
  spec.value = {
    cpu: project.value.spec.cpu,
    memory_mb: project.value.spec.memory_mb,
    disk_gb: Math.round(project.value.spec.disk_bytes / 1024 ** 3),
    preview_limit: project.value.spec.preview_limit,
  }
}

async function saveSpec() {
  if (!project.value) return
  try {
    await api.updateSpec(project.value.id, { cpu: spec.value.cpu, memory_mb: spec.value.memory_mb, disk_bytes: spec.value.disk_gb * 1024 ** 3, preview_limit: spec.value.preview_limit }, ui.state.scenario)
    ui.push('success', '已保存', ['规格已更新：扩容需重启生效；缩减立即限制；已用数据不会被删除。', '该操作仅系统管理员可执行，已写审计。'])
    await load()
  } catch (e) {
    error.value = e
  }
}

function toggle(id: string) {
  const list = confirmState.value.selected
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  else list.push(id)
  confirmState.value.stage = 'idle'
}

function firstConfirm() {
  confirmState.value = arm(confirmState.value, abnormal.value)
  if (confirmState.value.error) ui.push('warn', '无法继续', [confirmState.value.error])
}

async function secondConfirm() {
  confirmState.value = confirmStep(confirmState.value)
  if (confirmState.value.error) {
    ui.push('warn', '无法继续', [confirmState.value.error])
    return
  }
  try {
    const items = submitItems(confirmState.value, abnormal.value)
    // 二次确认文案由所选数量决定，服务端逐字比对；不匹配就不发请求
    const res = await api.cleanupPreviews(items, confirmTextFor(items.length), ui.state.scenario)
    summary.value = summarize(res.data)
    ui.push(summary.value.failed > 0 ? 'warn' : 'success', '清理完成', [summary.value.text, summary.value.nextStep])
    confirmState.value = initConfirm()
    await load()
  } catch (e) {
    error.value = e
  }
}

async function doRestore() {
  try {
    const res = await api.restoreBackup('bkp_trial_auto_2', restoreWord.value)
    ui.push('success', '恢复任务已创建', [`阶段：${res.data.stages.join(' → ')}`, '中断可重试，不留半可用状态；恢复后需逐项校验。'])
    restoreOpen.value = false
    restoreWord.value = ''
  } catch (e) {
    error.value = e
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head"><div><h1>系统设置</h1><p class="sub">仅系统管理员；下表能力管理员与普通用户不可见也不可调用。</p></div></div>
    <ErrorNotice v-if="error" :error="error" />

    <section class="panel">
      <div class="panel-head"><h2>项目资源规格</h2><span class="badge">GAP-01：仅系统管理员</span></div>
      <div class="row">
        <select v-model="selectedProject" @change="syncSpec">
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <span v-if="project" class="hint">已用 {{ formatBytes(project.quota.used_bytes) }} / {{ formatBytes(project.quota.limit_bytes) }}</span>
      </div>
      <div class="row">
        <label class="field"><span>CPU（C）</span><input v-model.number="spec.cpu" type="number" step="0.1" min="0.1" style="width: 110px" /></label>
        <label class="field"><span>内存（MB）</span><input v-model.number="spec.memory_mb" type="number" min="64" step="64" style="width: 120px" /></label>
        <label class="field"><span>磁盘（GB）</span><input v-model.number="spec.disk_gb" type="number" min="1" style="width: 100px" /></label>
        <label class="field"><span>预览上限</span><input v-model.number="spec.preview_limit" type="number" min="1" max="3" style="width: 100px" /></label>
        <button class="btn primary" @click="saveSpec">保存规格</button>
      </div>
      <p class="hint">默认 0.5C / 256MB / 4GB 是项目总量，含数据库卷、持久卷、文件与日志。调整后不删除已有数据。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>备份与告警口径</h2></div>
      <dl class="kv" v-if="backupStatus">
        <dt>每日全量备份</dt>
        <dd>{{ (backupStatus.daily as Record<string, unknown>).note }}</dd>
        <dt>异地同步</dt>
        <dd>{{ (backupStatus.sync as Record<string, unknown>).note }}</dd>
        <dt>升级条件</dt>
        <dd>连续 {{ backupStatus.escalate_after_consecutive }} 次失败升级为 {{ escalateLevel(2) }} 告警</dd>
        <dt>解除暂停</dt>
        <dd>{{ backupStatus.resume_mechanism }}</dd>
      </dl>
      <p class="hint">示例：某次每日备份 {{ failedBackupLabel }}，因此计 1 次失败并暂停新发布。</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>异常预览清理</h2>
        <span class="badge">GAP-05：仅三种情形</span>
      </div>
      <p class="warnbox">{{ COPY.cleanupScope }} 需要两次确认，逐条写审计。</p>
      <table>
        <thead><tr><th></th><th>项目</th><th>分支</th><th>情形</th><th>最后活跃</th><th class="num">占用</th></tr></thead>
        <tbody>
          <tr v-for="a in abnormal" :key="a.id" :class="{ disabled: !isSelectable(a) }">
            <td><input type="checkbox" :disabled="!isSelectable(a)" :checked="confirmState.selected.includes(a.id)" @change="toggle(a.id)" /></td>
            <td>{{ a.project_name }}</td>
            <td class="mono">{{ a.branch }}</td>
            <td>{{ caseLabel(a.case) }}</td>
            <td>{{ formatTimeDual(a.last_active_at, now) }}</td>
            <td class="num">{{ formatBytes(a.size_bytes) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">可选 {{ selectable.length }} 项；正常预览不会出现在列表，也无法被勾选。</p>
      <div class="row">
        <button class="btn" :disabled="confirmState.selected.length === 0 || confirmState.stage === 'submitting'" @click="firstConfirm">第一步：确认范围</button>
        <template v-if="confirmState.stage === 'armed'">
          <input v-model="confirmState.reason" type="text" placeholder="清理原因（写入每条审计）" style="min-width: 260px" />
          <button class="btn danger" @click="secondConfirm">第二步：执行清理</button>
        </template>
      </div>
      <div v-if="summary" :class="summary.failed > 0 ? 'warnbox' : 'okbox'">
        <p>{{ summary.text }} {{ summary.nextStep }}</p>
        <table v-if="summary.failures.length > 0">
          <thead><tr><th>环境</th><th>错误码</th><th>原因</th><th>下一步</th></tr></thead>
          <tbody>
            <tr v-for="f in summary.failures" :key="f.env_id">
              <td class="mono">{{ f.env_id }}</td>
              <td class="mono">{{ f.errorCode }}</td>
              <td>{{ f.message }}</td>
              <td>{{ f.nextStep }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>恢复</h2><span class="badge">高风险</span></div>
      <p class="hint">恢复覆盖全部环境、门户授权/模板、Dokploy 记录与镜像；回滚不会回滚数据库，数据库恢复只在这里做。</p>
      <button class="btn danger" @click="restoreOpen = true">从备份恢复…</button>
    </section>

    <ConfirmDialog v-model="restoreWord" :open="restoreOpen" title="从备份恢复" input-label="输入 RESTORE 确认" confirm-text="开始恢复" :disabled="restoreWord !== 'RESTORE'" @cancel="restoreOpen = false" @confirm="doRestore">
      <p>恢复期间会停止写入；中断可重试，不留半可用状态。</p>
      <p class="hint">恢复后需逐项校验（数据库、文件、门户授权、底座记录、镜像）。</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
tr.disabled {
  opacity: 0.55;
}
</style>
