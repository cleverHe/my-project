/**
 * 异常预览批量清理（GAP-05）：
 * - 范围只限三种异常情形；正常预览不可选，也不在删除范围
 * - 二次确认（勾选 → 输入清理原因/再次确认），逐条审计
 * - 逐条结果展示；失败要说明残留与下一步，不静默
 */
import type { AbnormalPreview, CleanupFailure, CleanupResult } from '@/api/types'

export const ABNORMAL_CASES = ['disabled_owner', 'deleted_project', 'undeletable'] as const
export type AbnormalCase = (typeof ABNORMAL_CASES)[number]

const CASE_LABEL: Record<AbnormalCase, string> = {
  disabled_owner: '拥有者已停用',
  deleted_project: '项目已删除',
  undeletable: '用户无法自行删除（残留）',
}

export function caseLabel(c: string): string {
  return CASE_LABEL[c as AbnormalCase] ?? '未知情形'
}

/** 只有这三种情形可选；其它一律不可勾选（防误删正常预览） */
export function isSelectable(item: Pick<AbnormalPreview, 'case'>): boolean {
  return (ABNORMAL_CASES as readonly string[]).includes(item.case)
}

export function selectableRows(items: AbnormalPreview[]): AbnormalPreview[] {
  return items.filter(isSelectable)
}

export type CleanupStage = 'idle' | 'armed' | 'submitting' | 'done'

export interface CleanupConfirmState {
  stage: CleanupStage
  selected: string[]
  reason: string
  canSubmit: boolean
  step: 1 | 2
  error?: string
}

export function initConfirm(): CleanupConfirmState {
  return { stage: 'idle', selected: [], reason: '', canSubmit: false, step: 1 }
}

/** 第一次确认：必须有勾选，且勾选项全部在允许范围内 */
export function arm(state: CleanupConfirmState, items: AbnormalPreview[]): CleanupConfirmState {
  const allowed = new Set(selectableRows(items).map((i) => i.id))
  const violates = state.selected.some((id) => !allowed.has(id))
  if (state.selected.length === 0) return { ...state, stage: 'idle', step: 1, canSubmit: false, error: '至少勾选一项要清理的预览。' }
  if (violates) return { ...state, stage: 'idle', step: 1, canSubmit: false, error: '所选范围包含正常预览，已阻止提交（本功能只能清理三种异常情形）。' }
  return { ...state, stage: 'armed', step: 2, canSubmit: false, error: undefined }
}

/** 第二次确认：必须填写原因（逐条写审计） */
export function confirm(state: CleanupConfirmState): CleanupConfirmState {
  if (state.stage !== 'armed') return { ...state, error: '请先完成第一次确认。' }
  if (!state.reason.trim()) return { ...state, error: '请填写清理原因，该原因会写入每一条审计记录。' }
  return { ...state, stage: 'submitting', canSubmit: true, error: undefined }
}

export interface CleanupSummary {
  succeeded: number
  failed: number
  total: number
  text: string
  nextStep: string
  failures: CleanupFailure[]
}

/** api-spec §10.6：二次确认文案必须与所选数量一致（服务端逐字比对） */
export function confirmTextFor(count: number): string {
  return `清理 ${count} 个异常预览`
}

/** 提交项：只带 env_id + 原因；情形以服务端候选为准，不在前端伪造枚举 */
export function submitItems(state: CleanupConfirmState, items: AbnormalPreview[]): { env_id: string; reason: string }[] {
  const reason = state.reason.trim()
  return state.selected
    .filter((id) => items.some((i) => i.id === id && isSelectable(i)))
    .map((id) => ({ env_id: id, reason }))
}

export function summarize(res: CleanupResult): CleanupSummary {
  const total = res.succeeded.length + res.failed.length
  return {
    succeeded: res.succeeded.length,
    failed: res.failed.length,
    total,
    text: `共 ${total} 条：成功 ${res.succeeded.length} 条，失败 ${res.failed.length} 条（释放 ${res.succeeded.reduce((n, r) => n + r.freed_bytes, 0)} 字节）。`,
    nextStep: res.failed.length > 0 ? '失败项仍占用资源与预览名额；可按下一步提示重试，或由系统管理员按运维流程处理持久卷。' : '全部清理完成，预览名额已释放，每条都已写审计。',
    failures: res.failed,
  }
}

/** 正常预览不得出现在列表（服务端口径一致） */
export function assertNoNormalPreview(items: AbnormalPreview[]): { ok: boolean; offenders: string[] } {
  const offenders = items.filter((i) => !isSelectable(i)).map((i) => i.id)
  return { ok: offenders.length === 0, offenders }
}
