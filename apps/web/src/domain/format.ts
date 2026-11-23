/** 时间、字节、数字格式化（domain，纯函数）。统一 Asia/Shanghai 展示口径（PRD G-07）。 */

const TZ = 'Asia/Shanghai'

const dtf = new Intl.DateTimeFormat('zh-CN', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 2026-11-20 14:05（Asia/Shanghai） */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dtf.format(new Date(iso)).replace(/\//g, '-')
}

export function formatRelative(iso: string | null | undefined, now: Date): string {
  if (!iso) return ''
  const diff = now.getTime() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 列表统一「绝对 + 相对」双格式（PRD G-07） */
export function formatTimeDual(iso: string | null | undefined, now: Date): string {
  if (!iso) return '—'
  return `${formatDateTime(iso)}（${formatRelative(iso, now)}）`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  const text = i === 0 || v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(1)))
  return `${text} ${units[i]}`
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—'
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)).replace(/\//g, '-')
}

/** 预览域名：{project-slug}-{branch-slug}，总长 ≤63（api-spec §6.3） */
export function previewDomain(projectSlug: string, branch: string): string {
  const branchSlug = branch.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
  const raw = `${projectSlug}-${branchSlug}`
  if (raw.length <= 63) return raw
  const hash = Math.abs(hashCode(raw)).toString(16).slice(0, 4)
  return `${raw.slice(0, 58)}-${hash}`
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

/** 日志时间：只显示时分秒，减少噪声 */
export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso))
}
