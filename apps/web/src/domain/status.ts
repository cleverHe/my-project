/**
 * 状态词与保留口径（domain，纯函数）。
 * 展示态只有三种（README Q14 / PRD G-11）：运行中 / 已休眠 / 未创建。
 * GAP-03：预览长期保留；正式发布不删除预览；页面不得出现「发布后清理」。
 */
import type { DisplayState, Environment, PreviewItem, PreviewSlot } from '@/api/types'
import { COPY, DISPLAY_STATE_LABEL } from './text'

export function displayStateLabel(state: DisplayState): string {
  return DISPLAY_STATE_LABEL[state]
}

export function displayStateTone(state: DisplayState): 'ok' | 'warn' | 'muted' {
  if (state === 'running') return 'ok'
  if (state === 'sleeping') return 'warn'
  return 'muted'
}

/** 中间态不进入展示词，用 pending 表达 */
export function pendingLabel(action: 'waking' | 'deploying'): string {
  return action === 'waking' ? '正在唤醒' : '正在发布'
}

export interface EntrySlotView {
  kind: 'preview' | 'production'
  state: DisplayState
  label: string
  url: string | null
  primaryAction: { key: 'open' | 'wake' | 'create_preview' | 'publish' | 'progress'; label: string }
  meta: { key: string; value: string }[]
  hint: string | null
}

export function previewSlotView(slot: PreviewSlot): EntrySlotView {
  const recent = slot.items[0]
  if (!recent) {
    return {
      kind: 'preview',
      state: 'not_created',
      label: '预览',
      url: null,
      primaryAction: { key: 'create_preview', label: '去创建预览' },
      meta: [{ key: 'count', value: `0 / ${slot.limit}` }],
      hint: '推一个非 main 分支即可生成预览地址',
    }
  }
  return {
    kind: 'preview',
    state: recent.display_state,
    label: '预览',
    url: recent.url,
    primaryAction: recent.display_state === 'sleeping' ? { key: 'wake', label: '唤醒' } : { key: 'open', label: '打开预览' },
    meta: [
      { key: 'branch', value: recent.branch },
      { key: 'count', value: `${slot.total} / ${slot.limit}` },
    ],
    hint: recent.branch_deleted ? '分支已删除，预览已保留' : recent.display_state === 'sleeping' ? '7 天闲置缩 0 副本，点击唤醒（最长 60 秒）' : null,
  }
}

export function productionSlotView(p: { state: string; url: string | null; sha: string | null; version_label: string | null; updated_at: string | null }): EntrySlotView {
  if (p.state === 'not_created' || !p.url) {
    return {
      kind: 'production',
      state: 'not_created',
      label: '正式',
      url: null,
      primaryAction: { key: 'publish', label: '去发布' },
      meta: [],
      hint: '只能发 main 最新提交，且必须在本页手动点发布',
    }
  }
  return {
    kind: 'production',
    state: p.state === 'publishing' ? 'running' : (p.state as DisplayState),
    label: '正式',
    url: p.url,
    primaryAction: p.state === 'publishing' ? { key: 'progress', label: '查看发布进度' } : { key: 'open', label: '打开正式' },
    meta: [
      { key: 'version', value: p.version_label ?? '—' },
      { key: 'sha', value: p.sha ? p.sha.slice(0, 7) : '—' },
    ],
    hint: null,
  }
}

/** 多预览：≥2 才出现「查看全部 N 个」 */
export function multiPreview(slot: PreviewSlot): { visible: boolean; label: string } {
  return { visible: slot.total > 1, label: `查看全部 ${slot.total} 个` }
}

/** 预览计数按未删除记录；停止/休眠不释放名额 */
export function previewCount(previews: Pick<PreviewItem, 'display_state'>[]): number {
  return previews.length
}

export function previewQuotaText(count: number, limit: number): string {
  return `已用 ${count} / ${limit}；${COPY.previewCountRule}`
}

export function canCreatePreview(count: number, limit: number): { ok: boolean; reason?: string } {
  if (count >= limit) {
    return { ok: false, reason: `已有 ${limit} 个预览，请先删除不再需要的预览（按未删除记录计数，停止/休眠不释放名额）。` }
  }
  return { ok: true }
}

/** GAP-03 保留状态卡：固定四个字段；不含「发布后清理」 */
export interface RetentionView {
  retention: string
  count: string
  backup: string
  lastPublishImpact: string
}

export function retentionView(previewCountValue: number, limit: number): RetentionView {
  return {
    retention: COPY.previewRetention,
    count: `${previewCountValue} / ${limit}`,
    backup: COPY.previewBackupRelation,
    lastPublishImpact: COPY.previewNotTouchedByPublish,
  }
}

/** 环境名称与地址：预览按分支，正式唯一 */
export function envDisplayName(env: Pick<Environment, 'kind' | 'branch'>): string {
  return env.kind === 'production' ? '正式环境' : `预览 · ${env.branch ?? ''}`
}

export type ProjectStatus = 'active' | 'soft_deleted' | 'creating'

export function projectStatusLabel(status: ProjectStatus): string {
  if (status === 'soft_deleted') return '已删除（30 天内可恢复）'
  if (status === 'creating') return '创建中'
  return '正常'
}

/** 软删除提示页可显示的信息（PRD P-21：不展示任何项目内容，名称除外） */
export function deletedProjectView(name: string, deletedAt: string, now: Date): { name: string; daysLeft: number; text: string } {
  const elapsed = Math.floor((now.getTime() - new Date(deletedAt).getTime()) / 86_400_000)
  const daysLeft = Math.max(0, 30 - elapsed)
  return {
    name,
    daysLeft,
    text: daysLeft > 0 ? `该项目已删除，30 天内可恢复（剩余 ${daysLeft} 天）。` : '该项目已不存在。',
  }
}
