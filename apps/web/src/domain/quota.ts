/** 配额与用量阈值（domain，纯函数）。quota 按项目总量：含数据库卷、持久卷、文件、日志。 */

export const QUOTA = {
  warnRatio: 0.8,
  blockRatio: 1,
  collectIntervalMinutes: 15,
} as const

export type QuotaLevel = 'normal' | 'warn' | 'blocked'

export function quotaLevel(ratio: number): QuotaLevel {
  if (ratio >= QUOTA.blockRatio) return 'blocked'
  if (ratio >= QUOTA.warnRatio) return 'warn'
  return 'normal'
}

export function quotaMessage(ratio: number, role: 'user' | 'admin' | 'sysadmin'): { level: QuotaLevel; text: string; action: string } {
  const level = quotaLevel(ratio)
  const pct = Math.round(ratio * 100)
  if (level === 'blocked') {
    return {
      level,
      text: `磁盘已用 ${pct}%，达到上限，新的发布/开通会被拒绝。`,
      action: role === 'sysadmin' ? '在系统设置中调整规格，或清理不需要的预览。' : '联系系统管理员调整规格（仅系统管理员可调整）；可先删除不需要的预览。',
    }
  }
  if (level === 'warn') {
    return {
      level,
      text: `磁盘已用 ${pct}%，超过 80% 告警线。`,
      action: role === 'sysadmin' ? '在系统设置中调整项目规格，或清理不需要的预览。' : '删除不再需要的预览或文件；扩容需系统管理员在系统设置中处理。',
    }
  }
  return { level, text: `磁盘已用 ${pct}%。`, action: '暂无动作；数字每 15 分钟采集一次，可能有延迟。' }
}

export function usageStaleNotice(collectedAt: string, stale: boolean): string {
  return stale ? `用量采集失败，当前显示 ${collectedAt} 的数据，可能滞后；限制仍然生效。` : `数据采集于 ${collectedAt}（每 15 分钟一次）。`
}

/** 磁盘分项四项固定（含日志计入配额，README 参数表） */
export const DISK_PARTS = ['db_volume', 'persistent_volume', 'files', 'logs'] as const
