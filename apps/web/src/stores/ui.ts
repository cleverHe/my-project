/** 全局提示与故障注入面板状态（纯 UI，不含业务规则） */
import { reactive, readonly } from 'vue'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'warn' | 'info'
  title: string
  lines: string[]
}

interface UiState {
  toasts: Toast[]
  scenario: string
}

const state = reactive<UiState>({ toasts: [], scenario: '' })
let seq = 0

export function useUi() {
  function push(kind: Toast['kind'], title: string, lines: string[] = []) {
    seq += 1
    const toast: Toast = { id: seq, kind, title, lines }
    state.toasts.push(toast)
    window.setTimeout(() => dismiss(toast.id), 8000)
  }
  function dismiss(id: number) {
    const i = state.toasts.findIndex((t) => t.id === id)
    if (i >= 0) state.toasts.splice(i, 1)
  }
  function setScenario(next: string) {
    state.scenario = next
  }
  return { state: readonly(state), push, dismiss, setScenario }
}

/** 故障注入场景（仅 Mock 生效；真实 BFF 不识别） */
export const SCENARIOS: { value: string; label: string }[] = [
  { value: '', label: '正常' },
  { value: 'deploy_build_fail', label: '发布：构建失败' },
  { value: 'deploy_health_fail', label: '发布：健康检查失败（自动退回）' },
  { value: 'deploy_backup_fail', label: '发布：备份失败（阻断切流）' },
  { value: 'deploy_timeout', label: '发布：30 分钟超时' },
  { value: 'wake_timeout', label: '预览：唤醒 60 秒超时' },
  { value: 'delete_residual', label: '预览：删除后资源残留' },
  { value: 'preview_limit', label: '预览：名额已满' },
  { value: 'authz_down', label: '权限系统不可用（写操作全部拒绝）' },
  { value: 'template_down', label: '模板库不可用（回退空白模板）' },
  { value: 'storage_down', label: '文件存储不可用' },
  { value: 'archive_fail', label: '日志转存失败' },
  { value: 'ai_timeout', label: '日志 AI 超时（回退规则高亮）' },
  { value: 'collect_fail', label: '用量采集失败（数字滞后）' },
  { value: 'cleanup_partial', label: '异常预览清理部分残留' },
]
