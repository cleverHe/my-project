<script setup lang="ts">
/** P-08 文件：只浏览/下载；按项目 + 环境限定；不提供在线删除/改写；无 S3 契约 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import type { FileEntry } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { formatBytes, formatTimeDual } from '@/domain/format'
import { COPY } from '@/domain/text'
import { useProject } from '@/stores/project'
import { useUi } from '@/stores/ui'

const route = useRoute()
const id = String(route.params.id)
const ui = useUi()
const { state } = useProject(id)
const kind = ref<'production' | 'preview'>('production')
const entries = ref<FileEntry[]>([])
const error = ref<unknown>(null)
const loading = ref(false)
const now = new Date('2026-11-20T09:20:00.000Z')

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await api.files(id, kind.value, '/', ui.state.scenario)
    entries.value = res.data.items
  } catch (e) {
    error.value = e
    entries.value = []
  } finally {
    loading.value = false
  }
}

function refuseWrite(action: string) {
  ui.push('info', `${action}：本页不提供`, [COPY.filesReadOnly, '如需改文件，请通过 Git 提交并在预览验证。'])
}

onMounted(load)
</script>

<template>
  <div class="page">
    <ErrorNotice v-if="error" :error="error" />
    <section class="panel">
      <div class="panel-head">
        <h2>文件浏览</h2>
        <div class="row">
          <select v-model="kind" @change="load">
            <option value="production">正式环境</option>
            <option value="preview">预览环境（按分支）</option>
          </select>
          <button class="btn" @click="load">刷新</button>
        </div>
      </div>
      <p class="infobox">{{ COPY.filesReadOnly }} {{ COPY.filesBucketScope }}</p>
      <p v-if="kind === 'preview'" class="hint">当前环境：{{ state.environments.find((e) => e.kind === 'preview')?.branch ?? '（还没有预览）' }}</p>
      <div v-if="loading" class="center-note">加载中…</div>
      <table v-else>
        <thead>
          <tr><th>名称</th><th>类型</th><th class="num">大小</th><th>修改时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="f in entries" :key="f.path">
            <td class="mono">{{ f.path }}</td>
            <td>{{ f.type === 'dir' ? '目录' : '文件' }}</td>
            <td class="num">{{ f.type === 'dir' ? '—' : formatBytes(f.size_bytes) }}</td>
            <td>{{ formatTimeDual(f.modified_at, now) }}</td>
            <td>
              <button class="btn" :disabled="f.type === 'dir'" @click="ui.push('info', '下载（Mock）', ['试跑不产生真实下载；真实环境由 BFF 流式转发。'])">下载</button>
              <button class="btn ghost" @click="refuseWrite('删除')">删除</button>
              <button class="btn ghost" @click="refuseWrite('在线编辑')">编辑</button>
            </td>
          </tr>
          <tr v-if="entries.length === 0">
            <td colspan="5" class="hint">该环境暂无文件。写进容器本地的文件不保证跨部署保留，请写存储桶或申请持久卷。</td>
          </tr>
        </tbody>
      </table>
      <p class="hint">{{ COPY.noS3Api }} 应用存储不是 S3 契约：不要用 S3 SDK 依赖对象存储接口。</p>
      <p class="hint">文件大小限制：单文件 100MB（试跑占位值，T-10 待产品确认；与产品侧的 T-10「暂停与预览」是两条不同记录）。</p>
    </section>
  </div>
</template>
