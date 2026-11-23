/** 项目级共享状态（页面/布局共用，避免每个子页各拉一遍） */
import { reactive } from 'vue'
import { api } from '@/api/client'
import type { Environment, GateState, ProjectDetail } from '@/api/types'

interface Entry {
  project: ProjectDetail | null
  environments: Environment[]
  previewCount: number
  previewLimit: number
  gate: GateState | null
  loading: boolean
  error: unknown
}

const cache = reactive<Record<string, Entry>>({})

function entryOf(id: string): Entry {
  if (!cache[id]) {
    cache[id] = { project: null, environments: [], previewCount: 0, previewLimit: 3, gate: null, loading: false, error: null }
  }
  return cache[id]!
}

export function useProject(id: string) {
  const state = entryOf(id)
  let inflight: Promise<void> | null = null

  async function load(): Promise<void> {
    state.loading = true
    state.error = null
    try {
      const [p, envs] = await Promise.all([api.project(id), api.environments(id)])
      state.project = p.data
      state.environments = envs.data.items
      state.previewCount = envs.data.preview_count
      state.previewLimit = envs.data.preview_limit
      state.gate = envs.data.gate
    } catch (e) {
      state.error = e
    } finally {
      state.loading = false
    }
  }

  /**
   * 冷启动/深链入口用：已加载则直接返回，未加载才拉一次，并发调用合并成同一个请求。
   * 子页（如文件页）先 `ensure()` 再取环境，避免在环境尚未加载时就把本地状态报成服务端错误。
   */
  function ensure(): Promise<void> {
    if (state.project && !state.error) return Promise.resolve()
    if (!inflight) inflight = load().finally(() => { inflight = null })
    return inflight
  }

  return { state, load, ensure }
}
