<script setup lang="ts">
/** P-08 文件：只浏览/下载；按项目 + 环境限定；不提供在线删除/改写；无 S3 契约 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import type { FileEntry } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import ListShell from '@/components/ListShell.vue'
import { usePagedList } from '@/composables/usePagedList'
import { formatBytes, formatTimeDual } from '@/domain/format'
import { COPY } from '@/domain/text'
import { useProject } from '@/stores/project'
import { useUi } from '@/stores/ui'

const route = useRoute()
const id = String(route.params.id)
const ui = useUi()
const { state, ensure } = useProject(id)
const kind = ref<'production' | 'preview'>('production')
const entries = ref<FileEntry[]>([])
const error = ref<unknown>(null)
const loading = ref(false)
const ready = ref(false)
const now = new Date('2026-11-20T09:20:00.000Z')

const envId = computed(() => state.environments.find((e) => e.kind === kind.value)?.id ?? '')
const noEnvironment = computed(() => ready.value && !envId.value)
const { page, size, total, paged, setSize } = usePagedList(() => entries.value)

async function load() {
  loading.value = true
  error.value = null
  try {
    // 深链/刷新时项目与环境还没加载：先 ensure，再判断是否有环境（本地状态不报成服务端错误）
    await ensure()
    ready.value = true
    if (!envId.value) {
      entries.value = []
      return
    }
    const res = await api.files(id, envId.value, '/', ui.state.scenario)
    entries.value = res.data.items
  } catch (e) {
    error.value = e
    entries.value = []
  } finally {
    loading.value = false
  }
}

const downloading = ref<string | null>(null)

/** 真实下载：经 BFF 只读代理拿到字节流；浏览器触发保存（不发 JSON、不改文件） */
async function download(f: FileEntry) {
  if (f.type === 'dir') return
  downloading.value = f.path
  try {
    const res = await api.downloadFile(id, envId.value, f.path, ui.state.scenario)
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = res.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 立刻 revoke 可能把还没开始的下载掐断（Chromium 上偶发），等一拍再释放
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    ui.push('success', '下载已开始', [`文件：${res.filename}`, `字节数：${res.bytes}${res.mock ? '（试跑替身内容，非真实应用文件）' : ''}`])
  } catch (e) {
    error.value = e
  } finally {
    downloading.value = null
  }
}

onMounted(load)
watch(kind, load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>文件</h1>
        <p class="sub">按项目与环境限定，只读浏览和下载；不提供在线删除或改写。</p>
      </div>
    </div>
    <ErrorNotice v-if="error" :error="error" />
    <p class="infobox">{{ COPY.filesReadOnly }} {{ COPY.filesBucketScope }}</p>
    <ListShell :total="total" :page="page" :size="size" @update:page="page = $event" @update:size="setSize">
      <template #actions>
        <select v-model="kind" aria-label="选择环境" @change="load">
          <option value="production">正式环境</option>
          <option value="preview">预览环境（按分支）</option>
        </select>
        <button class="btn" @click="load">刷新</button>
      </template>
      <div v-if="loading" class="center-note">加载中…</div>
      <div v-else-if="state.error" class="center-note">
        <ErrorNotice :error="state.error" compact />
        <button class="btn" @click="load">重试</button>
      </div>
      <div v-else-if="noEnvironment" class="center-note">
        <p>该项目还没有{{ kind === 'preview' ? '可查看的预览环境' : '正式环境' }}；先创建预览或发布正式后再看文件。</p>
        <p class="hint">预览长期保留；正式发布不会删除预览。文件页只读，不提供在线删除/改写。</p>
      </div>
      <template v-else>
        <table v-if="entries.length > 0">
          <thead>
            <tr><th>名称</th><th>类型</th><th class="num">大小</th><th>修改时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="f in paged" :key="f.path">
              <td class="mono">{{ f.path }}</td>
              <td>{{ f.type === 'dir' ? '目录' : '文件' }}</td>
              <td class="num">{{ f.type === 'dir' ? '—' : formatBytes(f.size_bytes) }}</td>
              <td>{{ formatTimeDual(f.modified_at, now) }}</td>
              <td>
                <button class="btn" :disabled="f.type === 'dir' || downloading === f.path" @click="download(f)">
                  {{ downloading === f.path ? '下载中…' : '下载' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">
          该环境暂无文件。
          <div class="empty-next">写进容器本地的文件不保证跨部署保留，请写存储桶或申请持久卷。</div>
        </div>
      </template>
    </ListShell>
    <p v-if="kind === 'preview'" class="hint">当前环境：{{ state.environments.find((e) => e.kind === 'preview')?.branch ?? '（还没有预览）' }}</p>
    <p class="hint">{{ COPY.noS3Api }} 应用存储不是 S3 契约：不要用 S3 SDK 依赖对象存储接口。</p>
    <p class="hint">文件大小限制：单文件 100MB（试跑占位值，T-10 待产品确认；与产品侧的 T-10「暂停与预览」是两条不同记录）。</p>
  </div>
</template>
