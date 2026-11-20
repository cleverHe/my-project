<script setup lang="ts">
/** P-03 创建项目向导：名称 → 模板 → 数据库 → 完成；模板不可用可回退空白模板；+ 创建中进度 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/client'
import type { Task, TemplateInfo } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import TaskSteps from '@/components/TaskSteps.vue'
import { pollTask } from '@/flows/pollTask'
import { useUi } from '@/stores/ui'

const router = useRouter()
const ui = useUi()
const step = ref<1 | 2 | 3 | 4>(1)
const name = ref('')
const templateId = ref<string>('')
const database = ref<'none' | 'postgresql'>('none')
const templates = ref<TemplateInfo[]>([])
const templateError = ref<unknown>(null)
const error = ref<unknown>(null)
const creating = ref(false)
const task = ref<Task | null>(null)
const createdId = ref<string | null>(null)
const fallbackToBlank = ref(false)

const nameOk = computed(() => name.value.trim().length >= 2)
const canNext = computed(() => {
  if (step.value === 1) return nameOk.value
  if (step.value === 2) return Boolean(templateId.value)
  return true
})
const selected = computed(() => templates.value.find((t) => t.id === templateId.value) ?? null)

async function loadTemplates() {
  try {
    const res = await api.templates()
    templates.value = res.data.items.filter((t) => t.status === 'published')
  } catch (e) {
    templateError.value = e
    templates.value = []
  }
}

function useBlankFallback() {
  const blank = templates.value.find((t) => t.id === 'tpl_blank')
  if (blank) {
    templateId.value = blank.id
    fallbackToBlank.value = true
    ui.push('warn', '已回退到空白模板', ['仍会注入规范与 4 个门户 Skill；不会建立空仓库。', '该模板未识别构建/健康检查预设，发布前需手动选择。'])
  }
}

async function submit() {
  creating.value = true
  error.value = null
  try {
    const res = await api.createProject({ name: name.value.trim(), template_id: templateId.value, database: database.value })
    createdId.value = res.data.project.id
    step.value = 4
    const polled = await pollTask(res.data.task.id, { maxPolls: 8, intervalMs: 400, fetchTask: (id) => api.task(id).then((r) => r.data) })
    task.value = polled.task
    if (polled.task.status === 'succeeded') ui.push('success', '项目创建完成', ['仓库、规范、4 个门户 Skill 已注入。'])
  } catch (e) {
    error.value = e
    if ((e as { errorCode?: string }).errorCode === 'project.template_unavailable') {
      ui.push('error', '模板不可用', ['可改用空白模板重试；系统没有建空仓库。'])
      step.value = 2
    }
  } finally {
    creating.value = false
  }
}

onMounted(loadTemplates)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>创建项目</h1>
        <p class="sub">四步：名称 → 模板 → 数据库 → 完成。资源规格按项目默认 0.5C / 256MB / 4GB，仅系统管理员可调整。</p>
      </div>
    </div>

    <ol class="wizard">
      <li v-for="(label, i) in ['名称', '模板', '数据库', '完成']" :key="label" :class="{ active: step === i + 1, done: step > i + 1 }">
        <span class="dot">{{ i + 1 }}</span>{{ label }}
      </li>
    </ol>

    <ErrorNotice v-if="error" :error="error" />

    <section v-if="step === 1" class="panel">
      <label class="field">
        <span>项目名称（必填，全局唯一）</span>
        <input v-model="name" type="text" placeholder="例如：智能客服" />
      </label>
      <p v-if="!nameOk" class="hint">至少 2 个字符。名称会用于仓库名与预览域名前缀。</p>
      <p class="hint">创建后拥有者默认为你；被授权人与项目组不能转成「第四种角色」。</p>
    </section>

    <section v-else-if="step === 2" class="panel">
      <ErrorNotice v-if="templateError" :error="templateError" compact />
      <div v-if="templates.length === 0" class="warnbox">
        模板库暂时不可用。可选择「空白模板」继续：仍会注入 AGENTS.md/CLAUDE.md、平台文档与 4 个 Skill，构建与健康检查需手动选择。
        <button class="btn" style="margin-left: 8px" @click="useBlankFallback">使用空白模板</button>
      </div>
      <div class="tpl-grid">
        <label v-for="t in templates" :key="t.id" class="tpl" :class="{ picked: templateId === t.id }">
          <input v-model="templateId" type="radio" :value="t.id" />
          <div>
            <strong>{{ t.name }}</strong>
            <span class="badge">{{ t.version }}</span>
            <p class="hint">{{ t.has_demo ? '含最小可运行 demo' : '不含 demo（仅规范与 Skill）' }} · 已用于 {{ t.projects_used }} 个项目</p>
            <p class="hint">构建预设：{{ t.build_preset }} · 健康检查：{{ t.health_preset }}</p>
          </div>
        </label>
      </div>
      <p v-if="fallbackToBlank" class="infobox">已使用空白模板；后续可在系统设置中补齐构建与健康检查预设。</p>
    </section>

    <section v-else-if="step === 3" class="panel">
      <label class="checkbox"><input v-model="database" type="radio" value="none" /> 不需要数据库（仅静态站/无状态服务）</label>
      <label class="checkbox"><input v-model="database" type="radio" value="postgresql" /> 需要 PostgreSQL（在 4GB 项目总量内，含数据库卷）</label>
      <p class="hint">数据库不属于「第四个环境」；预览与正式共用同一实例的不同 schema，凭据隔离。</p>
    </section>

    <section v-else class="panel">
      <div class="row">
        <strong>{{ task?.status === 'succeeded' ? '创建完成' : '正在创建…' }}</strong>
        <span v-if="createdId" class="mono badge">{{ createdId }}</span>
      </div>
      <TaskSteps v-if="task" :task="task" :with-backup="false" />
      <ErrorNotice v-if="task?.error" :error="{ ...task.error, traceId: 'trc_trial_create' }" />
      <ul class="hint">
        <li>仓库：私有，默认分支 main；预览 Webhook 只装在预览应用，正式应用关闭 AutoDeploy 且无 Webhook。</li>
        <li>规范与 Skill：AGENTS.md / CLAUDE.md / docs/PLATFORM.md / .deploy/mcp.json / skills/。</li>
        <li>失败不会留下半成品：任一步失败即整体回滚，并给出原因与下一步。</li>
      </ul>
      <div class="row">
        <button v-if="task?.status === 'succeeded' && createdId" class="btn primary" @click="router.push(`/projects/${createdId}/deploy`)">进入项目</button>
        <button v-else class="btn" :disabled="creating" @click="submit">重试创建</button>
      </div>
    </section>

    <div class="row">
      <button class="btn" :disabled="step === 1" @click="step = (step - 1) as 1 | 2 | 3">上一步</button>
      <button v-if="step < 3" class="btn primary" :disabled="!canNext" @click="step = (step + 1) as 2 | 3">下一步</button>
      <button v-if="step === 3" class="btn primary" :disabled="creating" @click="submit">创建项目</button>
    </div>
  </div>
</template>

<style scoped>
.wizard {
  display: flex;
  gap: 18px;
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 12px;
  color: var(--c-sub);
}
.wizard li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--c-line);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  background: #fff;
}
.wizard li.active {
  color: var(--c-primary);
  font-weight: 600;
}
.wizard li.active .dot {
  border-color: var(--c-primary);
  background: var(--c-primary);
  color: #fff;
}
.wizard li.done .dot {
  border-color: #b7e4c7;
  background: #e8f7ee;
  color: #1a7f45;
}
.tpl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}
.tpl {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  gap: 8px;
  cursor: pointer;
}
.tpl.picked {
  border-color: var(--c-primary);
  background: #f7faff;
}
.tpl strong {
  margin-right: 6px;
}
</style>
