<script setup lang="ts">
/** P-04/P-05/P-06 部署页：main HEAD、发布、预览、部署记录与回滚、暂停闸门 */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import { isApiError } from '@/api/http'
import type { DeploymentRecord, MainHead, Task } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ErrorNotice from '@/components/ErrorNotice.vue'
import StatusPill from '@/components/StatusPill.vue'
import TaskSteps from '@/components/TaskSteps.vue'
import { DEPLOY, backupAttemptLabel, guardDeploy, rollbackVerdict } from '@/domain/deploy'
import { formatTimeDual, shortSha } from '@/domain/format'
import { canCreatePreview, envDisplayName, previewQuotaText } from '@/domain/status'
import { COPY } from '@/domain/text'
import { pollTask } from '@/flows/pollTask'
import { useProject } from '@/stores/project'
import { useSession } from '@/stores/session'
import { useUi } from '@/stores/ui'
import { useRoute } from 'vue-router'

const route = useRoute()
const id = String(route.params.id)
const session = useSession()
const ui = useUi()
const { state, load } = useProject(id)

const now = new Date('2026-11-20T09:20:00.000Z')
const main = ref<MainHead | null>(null)
const history = ref<DeploymentRecord[]>([])
const error = ref<unknown>(null)
const busy = ref('')

const versionLabel = ref('')
const withBackup = ref(true)
const publishConfirmOpen = ref(false)
const publishProgress = ref(false)
const task = ref<Task | null>(null)
const taskWithBackup = ref(true)

const newBranch = ref('')
const deleteTarget = ref<{ envId: string; branch: string } | null>(null)
const deleteConfirm = ref('')
const wakeTarget = ref<string | null>(null)
const rollbackTarget = ref<DeploymentRecord | null>(null)
const rollbackReason = ref('')

const prodEnv = computed(() => state.environments.find((e) => e.kind === 'production') ?? null)
const previews = computed(() => state.environments.filter((e) => e.kind === 'preview'))
const existingLabels = computed(() => history.value.map((d) => d.version_label))
const envBusy = computed(() => Boolean(task.value && (task.value.status === 'running' || task.value.status === 'queued')))

const guard = computed(() =>
  guardDeploy({
    gate: state.gate ?? { paused: false, reason: null, paused_since: null, resume_mechanism: 'T-08_undefined' },
    envBusy: envBusy.value,
    queueLength: 1,
    mainSha: main.value?.sha ?? null,
    versionLabel: versionLabel.value,
    existingLabels: existingLabels.value,
    hasBuildPermission: state.project?.relation === 'owner' || session.ops.value.includes('deploy:create'),
  }),
)

const suggested = computed(() => {
  const last = history.value.find((d) => d.env_kind === 'production' && d.result === 'success')
  if (!last) return 'v1.0.0'
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(last.version_label)
  if (!m) return 'v1.0.0'
  return `v${m[1]}.${m[2]}.${Number(m[3]) + 1}`
})

async function loadAll() {
  await load()
  error.value = null
  try {
    const [m, h] = await Promise.all([api.mainHead(id), prodEnv.value ? api.deployments(prodEnv.value.id) : Promise.resolve({ data: { items: [] as DeploymentRecord[] } })])
    main.value = m.data
    history.value = h.data.items
    if (!versionLabel.value) versionLabel.value = suggested.value
  } catch (e) {
    error.value = e
  }
}

function startPublish() {
  if (!guard.value.ok) return
  publishConfirmOpen.value = true
}

async function doPublish() {
  publishConfirmOpen.value = false
  if (!prodEnv.value) return
  busy.value = 'publish'
  error.value = null
  publishProgress.value = true
  taskWithBackup.value = withBackup.value
  try {
    const res = await api.deploy(prodEnv.value.id, { version_label: versionLabel.value, backup: withBackup.value }, ui.state.scenario)
    const polled = await pollTask(res.data.task.id, { maxPolls: 10, intervalMs: 400 })
    task.value = polled.task
    if (polled.task.status === 'succeeded') {
      ui.push('success', '发布成功', [`版本 ${versionLabel.value} 已切换；发布确认在 5 分钟内有效且不可代批。`])
      await loadAll()
    } else {
      ui.push('error', '发布未成功', [polled.task.error?.message ?? '见任务详情。', '流量未切换，未自动重试。'])
    }
  } catch (e) {
    error.value = e
    ui.push('error', '发布被拒绝', [isApiError(e) ? e.message : '见页面提示。'])
  } finally {
    busy.value = ''
  }
}

async function createPreview() {
  if (!canCreatePreview(state.previewCount, state.previewLimit).ok) {
    ui.push('warn', '预览名额已满', [canCreatePreview(state.previewCount, state.previewLimit).reason ?? ''])
    return
  }
  busy.value = 'preview'
  error.value = null
  try {
    const res = await api.createPreview(id, newBranch.value.trim(), ui.state.scenario)
    const t = await pollTask(res.data.task.id, { maxPolls: 8, intervalMs: 400 })
    if (t.task.status === 'succeeded') {
      ui.push('success', '预览已创建', ['预览长期保留：正式发布不会删除它。', `地址：${res.data.environment.url}`])
      newBranch.value = ''
      await loadAll()
    } else {
      ui.push('error', '预览部署失败', [t.task.error?.message ?? ''])
    }
  } catch (e) {
    error.value = e
  } finally {
    busy.value = ''
  }
}

async function wake(envId: string) {
  wakeTarget.value = envId
  error.value = null
  try {
    const res = await api.wakePreview(envId, ui.state.scenario)
    ui.push('success', `已唤醒（${res.data.took_seconds} 秒）`, ['休眠期间为 0 副本，唤醒上限 60 秒。'])
    await loadAll()
  } catch (e) {
    error.value = e
  } finally {
    wakeTarget.value = null
  }
}

async function doDeletePreview() {
  if (!deleteTarget.value) return
  busy.value = 'delete'
  error.value = null
  try {
    const res = await api.deletePreview(deleteTarget.value.envId, deleteConfirm.value, ui.state.scenario)
    ui.push('success', '预览已删除', ['应用、库、桶、持久卷一并删除，不可恢复。', `名额是否释放：${res.data.released_slot ? '是' : '否'}`])
    deleteTarget.value = null
    deleteConfirm.value = ''
    await loadAll()
  } catch (e) {
    error.value = e
  } finally {
    busy.value = ''
  }
}

function openRollback(d: DeploymentRecord) {
  rollbackTarget.value = d
  rollbackReason.value = ''
}

async function doRollback() {
  const d = rollbackTarget.value
  if (!d || !prodEnv.value) return
  const verdict = rollbackVerdict(d, rollbackReason.value, true)
  if (!verdict.ok) {
    ui.push('warn', '不能回滚', [verdict.reason ?? ''])
    return
  }
  try {
    const res = await api.rollback(prodEnv.value.id, d.id, rollbackReason.value, ui.state.scenario)
    ui.push('success', `已回滚到 ${res.data.target_version}`, [`业务冒烟：${res.data.smoke} 连续通过。`, COPY.rollbackNoDb])
    rollbackTarget.value = null
    await loadAll()
  } catch (e) {
    error.value = e
  }
}

async function sharePreview(envId: string) {
  const env = previews.value.find((e) => e.id === envId)
  if (!env) return
  try {
    const res = await api.createShare(id, 'preview', env.branch ?? null)
    ui.push('success', '分享链接已生成', [res.data.url, COPY.shareNotGrant])
  } catch (e) {
    error.value = e
  }
}

onMounted(loadAll)
</script>

<template>
  <div class="page">
    <ErrorNotice v-if="error" :error="error" />

    <section class="panel">
      <div class="panel-head">
        <h2>main 最新提交</h2>
        <span class="badge">只发 main HEAD</span>
      </div>
      <dl class="kv" v-if="main">
        <dt>提交</dt>
        <dd class="mono">{{ shortSha(main.sha) }} · {{ main.author }} · {{ formatTimeDual(main.committed_at, now) }}</dd>
        <dt>版本标签</dt>
        <dd>{{ main.version_labels.length ? main.version_labels.join('、') : '暂无' }}</dd>
      </dl>
      <p class="hint">{{ COPY.mainHeadOnly }} {{ COPY.noAutoDeploy }} 显示的是实际构建 SHA，不提供历史提交发布入口。</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>发布正式环境</h2>
        <StatusPill :state="prodEnv?.display_state ?? 'not_created'" />
      </div>
      <div class="row">
        <label class="field">
          <span>版本标签</span>
          <input v-model="versionLabel" type="text" placeholder="v1.2.0" />
        </label>
        <label class="checkbox" style="margin-top: 18px">
          <input v-model="withBackup" type="checkbox" />
          发布前备份（可选）
        </label>
        <button class="btn primary" :disabled="!guard.ok || busy === 'publish'" @click="startPublish">发布 main 最新提交</button>
      </div>
      <p v-if="!guard.ok" class="warnbox">{{ guard.reason }} {{ guard.nextStep }}</p>
      <p class="hint">{{ COPY.deployConcurrency }} {{ COPY.deployShaRace }} 发布与回滚需本人操作并在 5 分钟内确认，Agent 不能代批。</p>
      <p class="hint">发布顺序：构建成功 → 备份（勾选时）→ 切流；备份失败会阻断发布，已运行环境继续服务。</p>
    </section>

    <section v-if="publishProgress && task" class="panel">
      <div class="panel-head"><h2>发布任务</h2><span class="badge">{{ task.id }}</span></div>
      <TaskSteps :task="task" :with-backup="taskWithBackup" />
      <ErrorNotice v-if="task.error" :error="{ ...task.error, traceId: 'trc_trial_task' }" />
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>预览（{{ state.previewCount }} / {{ state.previewLimit }}）</h2>
        <span class="hint">{{ previewQuotaText(state.previewCount, state.previewLimit) }}</span>
      </div>
      <div class="row">
        <input v-model="newBranch" type="text" placeholder="分支名，例如 feat/order（不能是 main）" style="min-width: 260px" />
        <button class="btn" :disabled="!newBranch.trim() || busy === 'preview'" @click="createPreview">创建预览</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>分支</th>
            <th>状态</th>
            <th>地址</th>
            <th>最后更新</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in previews" :key="p.id">
            <td class="mono">{{ p.branch }}</td>
            <td>
              <StatusPill :state="p.display_state" />
              <span v-if="p.branch_deleted" class="badge">分支已删除 · 预览保留</span>
              <span v-if="p.residual" class="badge">残留</span>
            </td>
            <td><a :href="p.url" target="_blank" rel="noopener">{{ p.url }}</a></td>
            <td>{{ formatTimeDual(p.updated_at, now) }}</td>
            <td class="row">
              <button v-if="p.display_state === 'sleeping'" class="btn" :disabled="wakeTarget === p.id" @click="wake(p.id)">唤醒</button>
              <button class="btn" @click="sharePreview(p.id)">分享</button>
              <button class="btn danger" @click="deleteTarget = { envId: p.id, branch: p.branch ?? '' }; deleteConfirm = ''">删除</button>
            </td>
          </tr>
          <tr v-if="previews.length === 0">
            <td colspan="5" class="hint">还没有预览。推一个非 main 分支即可生成预览地址。</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">{{ COPY.previewRetention }} 删除是唯一释放名额的方式；停止/休眠不释放。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>部署记录（正式）</h2><span class="hint">{{ COPY.rollbackScope }}</span></div>
      <table>
        <thead>
          <tr>
            <th>版本</th>
            <th>SHA</th>
            <th>结果</th>
            <th>操作人</th>
            <th>构建时间</th>
            <th>回滚</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in history" :key="d.id">
            <td>{{ d.version_label }}</td>
            <td class="mono">{{ shortSha(d.sha) }}</td>
            <td>{{ d.result === 'success' ? '成功' : '失败' }}</td>
            <td>{{ d.operator }}</td>
            <td>{{ formatTimeDual(d.built_at, now) }}</td>
            <td>
              <template v-if="d.rollbackable">
                <button class="btn" @click="openRollback(d)">回滚到此版本</button>
              </template>
              <span v-else class="hint">{{ d.missing_reason ?? '不可回退' }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="hint">{{ COPY.rollbackNoDb }} 回滚后连续 {{ DEPLOY.smokePasses }} 次业务冒烟通过才算完成。</p>
    </section>

    <ConfirmDialog
      v-model="deleteConfirm"
      :open="Boolean(deleteTarget)"
      title="删除预览"
      :input-label="`请输入分支名以确认：${deleteTarget?.branch}`"
      confirm-text="删除预览及其数据"
      :disabled="deleteConfirm !== deleteTarget?.branch"
      @cancel="deleteTarget = null"
      @confirm="doDeletePreview"
    >
      <p class="hint">删除会移除应用、数据库、存储桶与持久卷，不可恢复；预览数据也会从后续每日备份中移除。</p>
      <p class="hint">正常预览的删除只能由拥有者手动发起；系统不会因为正式发布或分支删除自动删除预览。</p>
    </ConfirmDialog>

    <ConfirmDialog
      :open="publishConfirmOpen"
      title="确认发布"
      confirm-text="确认发布（本人操作）"
      :danger="false"
      @cancel="publishConfirmOpen = false"
      @confirm="doPublish"
    >
      <p>将发布 main 最新提交（{{ shortSha(main?.sha) }}）到正式环境，版本标签 {{ versionLabel }}。</p>
      <p class="hint">本次确认 5 分钟内有效；发布不可取消，超时 30 分钟按失败处理且不自动重试。</p>
      <p v-if="withBackup" class="hint">顺序：构建成功 → 备份 → 切流；备份失败则阻断发布。</p>
    </ConfirmDialog>

    <ConfirmDialog
      v-model="rollbackReason"
      :open="Boolean(rollbackTarget)"
      title="回滚确认"
      input-label="回滚原因（回退到更早版本必填，会写入审计）"
      confirm-text="确认回滚"
      @cancel="rollbackTarget = null"
      @confirm="doRollback"
    >
      <p>目标版本：{{ rollbackTarget?.version_label }}（{{ shortSha(rollbackTarget?.sha) }}）</p>
      <p class="hint">{{ COPY.rollbackNoDb }} 回滚范围以底座实际保留为准。</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
td .badge {
  margin-left: 6px;
}
</style>
