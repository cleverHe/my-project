<script setup lang="ts">
/** P-09 日志：实时/构建/归档三源；8 类脱敏；AI 默认关、需确认、失败回退规则高亮 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import type { LogLine } from '@/api/types'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatClock, formatDateTime } from '@/domain/format'
import { COPY } from '@/domain/text'
import { useUi } from '@/stores/ui'

const route = useRoute()
const id = String(route.params.id)
const ui = useUi()
const source = ref<'runtime' | 'build' | 'archive'>('runtime')
const lines = ref<LogLine[]>([])
const error = ref<unknown>(null)
const aiError = ref<unknown>(null)
const aiHint = ref<string | null>(null)
const aiConfirmOpen = ref(false)
const levelFilter = ref<'all' | 'error' | 'warn'>('all')

const shown = computed(() => (levelFilter.value === 'all' ? lines.value : lines.value.filter((l) => l.level === levelFilter.value)))

async function load() {
  error.value = null
  aiHint.value = null
  try {
    const res = await api.logs(id, source.value, ui.state.scenario)
    lines.value = res.data.items
  } catch (e) {
    error.value = e
    lines.value = []
  }
}

async function runAi() {
  aiConfirmOpen.value = false
  aiError.value = null
  try {
    const res = await api.logAi(id, ui.state.scenario)
    aiHint.value = res.data.hint
  } catch (e) {
    aiError.value = e
    aiHint.value = '规则高亮已回退：E-1042 数据库连接池耗尽（AI 不可用不影响排查）。'
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <ErrorNotice v-if="error" :error="error" />
    <section class="panel">
      <div class="panel-head">
        <h2>日志</h2>
        <div class="row">
          <select v-model="source" @change="load">
            <option value="runtime">运行日志（实时）</option>
            <option value="build">构建日志</option>
            <option value="archive">历史日志（转存，保留 30 天）</option>
          </select>
          <select v-model="levelFilter">
            <option value="all">全部级别</option>
            <option value="error">仅 error</option>
            <option value="warn">仅 warn</option>
          </select>
        </div>
      </div>
      <p class="hint">日志保留 30 天并计入项目配额；以下内容已做 8 类脱敏（凭据、Cookie、连接串密码、身份证、手机号、邮箱、token、私钥）。</p>
      <div class="log">
        <div v-for="l in shown" :key="l.seq" class="line" :class="l.level">
          <span class="t mono">{{ formatClock(l.at) }}</span>
          <span class="lv">{{ l.level }}</span>
          <span class="txt mono">{{ l.text }}</span>
          <span v-if="l.redacted" class="badge">已脱敏</span>
        </div>
        <div v-if="shown.length === 0" class="hint">暂无日志。</div>
      </div>
      <div class="row">
        <button class="btn" :disabled="!lines.some((l) => l.level === 'error')" @click="aiConfirmOpen = true">AI 分析错误</button>
        <span class="hint">AI 默认关闭；开启后每次仅发送脱敏错误片段，额度 500 次/月，失败回退规则高亮。</span>
      </div>
      <div v-if="aiHint" class="okbox">{{ COPY.aiHintDisclaimer }} {{ aiHint }}</div>
      <ErrorNotice v-if="aiError" :error="aiError" compact />
      <p class="hint">构建日志时间：{{ formatDateTime('2026-11-20T06:28:00.000Z') }}（示例）；审计会记录 AI 外发行为。</p>
    </section>

    <ConfirmDialog :open="aiConfirmOpen" title="发送脱敏错误片段到 AI" :danger="false" confirm-text="确认发送并分析" @cancel="aiConfirmOpen = false" @confirm="runAi">
      <p>{{ COPY.aiSendConfirm }}</p>
      <p class="hint">不发送完整日志，不发送凭据；每次外发写入审计（操作人、时间、字节数）。</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.log {
  background: #0f172a;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 340px;
  overflow: auto;
}
.line {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.line.warn .lv {
  color: #fbbf24;
}
.line.error .lv {
  color: #f87171;
}
.t {
  color: #94a3b8;
  flex: 0 0 auto;
}
.lv {
  flex: 0 0 44px;
  text-transform: uppercase;
  color: #7dd3fc;
}
.txt {
  word-break: break-all;
}
.badge {
  background: #1e293b;
  border-color: #334155;
  color: #cbd5e1;
}
</style>
