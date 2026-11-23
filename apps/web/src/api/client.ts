/**
 * 门户 BFF 客户端（唯一出口）。页面/flows 不得直接 fetch。
 * 端点路径与 `api-spec.md` v1.0 一一对应；此处只包装用到的子集。
 */
import { request, requestText, requestBlob, ulid } from './http'
import type {
  AbnormalPreview,
  AdminUser,
  AdminUsersPage,
  AlertRow,
  AuditRow,
  BackupPoint,
  CleanupResult,
  DeploymentRecord,
  Environment,
  FileEntry,
  GateState,
  GrantItem,
  GroupInfo,
  LogLine,
  MainHead,
  Me,
  Page,
  PlatformView,
  ProjectCard,
  ProjectDetail,
  RoleModel,
  ShareItem,
  Task,
  TemplateInfo,
  UsageBreakdown,
} from './types'

type Q = Record<string, string | number | boolean | undefined>

/* ------------------------------------------------------------------
 * 响应适配层（只放服务端 → 页面模型的字段映射，不改业务语义）
 * 服务端可能给契约字段或试跑旧字段，页面只认一套模型。
 * ------------------------------------------------------------------ */
const TEMPLATE_STATUS: Record<string, 'published' | 'offline'> = { active: 'published', published: 'published', deprecated: 'offline', offline: 'offline' }

function toTemplate(raw: Record<string, unknown>): TemplateInfo {
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    shape: (raw.shape as TemplateInfo['shape']) ?? 'blank',
    version: String(raw.version ?? '—'),
    status: TEMPLATE_STATUS[String(raw.status ?? 'active')] ?? 'offline',
    projects_used: Number(raw.projects_used ?? 0),
    has_demo: raw.has_demo === true,
    files: (raw.files as string[]) ?? [],
    skills: (raw.skills as string[]) ?? [],
    build_preset: String(raw.build_preset ?? '—'),
    health_preset: (raw.health_preset as TemplateInfo['health_preset']) ?? 'healthz',
    credential_scan: (raw.credential_scan as TemplateInfo['credential_scan']) ?? 'clean',
  }
}

const REASON_TO_CASE: Record<string, AbnormalPreview['case']> = {
  owner_disabled: 'disabled_owner',
  project_deleted: 'deleted_project',
  not_removable_by_user: 'undeletable',
}

function toAbnormal(raw: Record<string, unknown>): AbnormalPreview {
  const reason = String(raw.reason ?? '')
  return {
    id: String(raw.env_id ?? raw.id ?? ''),
    project_name: String(raw.project_name ?? raw.project ?? '—'),
    branch: String(raw.branch ?? '—'),
    url: String(raw.url ?? ''),
    state: (raw.state as AbnormalPreview['state']) ?? 'not_created',
    case: REASON_TO_CASE[reason] ?? ((raw.case as AbnormalPreview['case']) ?? 'undeletable'),
    last_active_at: String(raw.last_active_at ?? ''),
    size_bytes: Number(raw.size_bytes ?? 0),
  }
}

const PART_LABEL: Record<string, string> = { db: '数据库卷', volumes: '持久卷与运行层', files: '文件存储', logs: '日志（30 天）' }
const PART_KIND: Record<string, UsageBreakdown['parts'][number]['kind']> = {
  db: 'db',
  db_volume: 'db',
  volume: 'volumes',
  volumes: 'volumes',
  persistent_volume: 'volumes',
  app: 'volumes',
  files: 'files',
  logs: 'logs',
}

function toUsage(raw: Record<string, unknown>): UsageBreakdown {
  const used = Number(raw.used_bytes ?? raw.total_bytes ?? (raw.disk as Record<string, unknown> | undefined)?.used_bytes ?? 0)
  const limit = Number(raw.limit_bytes ?? (raw.disk as Record<string, unknown> | undefined)?.limit_bytes ?? 0)
  const rawParts = (raw.parts ?? (raw.disk as Record<string, unknown> | undefined)?.parts ?? []) as Record<string, unknown>[]
  const parts = rawParts.map((p) => {
    const kind = PART_KIND[String(p.kind ?? p.key ?? 'volumes')] ?? 'volumes'
    return { kind, label: String(p.label ?? PART_LABEL[kind]), bytes: Number(p.bytes ?? p.used_bytes ?? 0) }
  })
  const threshold = (raw.threshold as UsageBreakdown['threshold']) ?? { warning: 0.8, action: 'hard_reject' as const, exceeded: limit > 0 && used / limit >= 0.8 }
  return {
    project_id: String(raw.project_id ?? ''),
    used_bytes: used,
    limit_bytes: limit,
    ratio: Number(raw.ratio ?? (limit > 0 ? used / limit : 0)),
    period_minutes: Number(raw.period_minutes ?? 15),
    parts,
    threshold,
    collected_at: String(raw.collected_at ?? ''),
    stale: raw.stale === true,
    stale_note: (raw.stale_note as string | null) ?? null,
  }
}

function toAuditRow(raw: Record<string, unknown>): AuditRow {
  const kind = raw.target_kind ?? raw.object_type
  const targetId = raw.target_id ?? raw.object_id
  return {
    id: String(raw.id ?? ''),
    at: String(raw.at ?? raw.created_at ?? ''),
    actor: String(raw.actor_name ?? raw.actor ?? '—'),
    action: String(raw.action ?? ''),
    object: String(raw.object ?? (kind && targetId ? `${kind}:${targetId}` : '—')),
    result: raw.result === 'failed' ? 'failed' : 'success',
    source_ip: String(raw.source_ip ?? raw.ip ?? '—'),
    change: (raw.change as string | undefined) ?? (raw.detail as string | undefined),
    before: raw.before as string | undefined,
    after: raw.after as string | undefined,
    trace_id: (raw.trace_id as string | undefined) ?? undefined,
    error_code: (raw.error_code as string | null | undefined) ?? null,
  }
}

function toLogLine(raw: Record<string, unknown>, i: number): LogLine {
  return {
    seq: Number(raw.seq ?? i + 1),
    at: String(raw.at ?? ''),
    level: (raw.level as LogLine['level']) ?? 'info',
    text: String(raw.text ?? raw.message ?? ''),
    redacted: raw.redacted === true,
  }
}

export const api = {
  me: () => request<Me>('/me'),

  /** 试跑专用 Mock 登录（真实环境不存在该端点，只能走飞书 OAuth） */
  trialLogin: () => request<Me>('/auth/trial-login', { method: 'POST', body: {} }),
  /** 试跑专用：把「试跑角色切换」落到服务端会话；生产 BFF 无此端点（会 404），前端捕获后保持只演示 */
  trialRole: (role: 'user' | 'admin' | 'sysadmin') => request<Me>('/auth/trial-role', { method: 'POST', body: { role } }),
  loginStart: (redirect: string) => request<{ redirect_url: string }>('/auth/feishu/start', { method: 'POST', body: {}, query: { redirect } }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST', body: {} }),

  projects: (q: Q = {}) => request<Page<ProjectCard>>('/projects', { query: q }),
  project: (id: string) => request<ProjectDetail & { deleted?: boolean }>(`/projects/${id}`),
  createProject: (body: Record<string, unknown>) => request<{ project: ProjectCard; task: { id: string } }>('/projects', { method: 'POST', body, idempotencyKey: ulid('idem') }),
  mainHead: (id: string) => request<MainHead>(`/projects/${id}/main`),

  environments: (id: string, kind?: 'preview' | 'production') =>
    request<{ items: Environment[]; preview_count: number; preview_limit: number; gate: GateState }>(`/projects/${id}/environments`, { query: kind ? { kind } : {} }),
  createPreview: (id: string, branch: string, scenario?: string) =>
    request<{ environment: Environment; task: { id: string } }>(`/projects/${id}/environments`, { method: 'POST', body: { kind: 'preview', branch }, idempotencyKey: ulid('idem'), scenario }),
  wakePreview: (envId: string, scenario?: string) => request<{ id: string; display_state: string; took_seconds: number }>(`/environments/${envId}:wake`, { method: 'POST', body: {}, scenario }),
  deletePreview: (envId: string, branch: string, scenario?: string) =>
    request<{ deleted: boolean; released_slot: boolean }>(`/environments/${envId}`, { method: 'DELETE', body: { confirm_branch: branch }, scenario }),

  deploy: (envId: string, body: { version_label?: string; sha?: string; backup?: boolean }, scenario?: string) =>
    request<{ task: { id: string } }>(`/environments/${envId}:deploy`, { method: 'POST', body, idempotencyKey: ulid('idem'), scenario }),
  task: (taskId: string) => request<Task>(`/tasks/${taskId}`),
  deployments: (envId: string) => request<{ items: DeploymentRecord[] }>(`/environments/${envId}/deployments`),
  rollback: (envId: string, deploymentId: string, reason: string, scenario?: string) =>
    request<{ target_version: string; smoke: string }>(`/environments/${envId}:rollback`, { method: 'POST', body: { deployment_id: deploymentId, reason }, idempotencyKey: ulid('idem'), scenario }),

  usage: async (id: string, scenario?: string) => {
    const res = await request<Record<string, unknown>>(`/projects/${id}/usage`, { scenario })
    return { ...res, data: toUsage(res.data) }
  },
  /** api-spec §8.4 规范形状：GET /files?project_id&env_id&path=（只读浏览；无 S3 契约） */
  files: async (id: string, envId: string, path = '/', scenario?: string) => {
    const res = await request<{ entries: { name: string; type: string; size: number | null; modified_at: string }[]; path: string; read_only: boolean }>(
      '/files',
      { query: { project_id: id, env_id: envId, path }, scenario },
    )
    return {
      ...res,
      data: {
        items: res.data.entries.map((e): FileEntry => ({ name: e.name, path: `${res.data.path === '/' ? '' : res.data.path}/${e.name}`, size_bytes: e.size ?? 0, modified_at: e.modified_at, type: e.type === 'dir' ? 'dir' : 'file' })),
        path: res.data.path,
        read_only: res.data.read_only,
      },
    }
  },
  /** api-spec §8.1 下载：只读、按项目 + 环境限定；返回真实字节（试跑为替身文件内容） */
  downloadFile: (id: string, envId: string, path: string, scenario?: string) =>
    requestBlob('/files:download', { query: { project_id: id, env_id: envId, path }, scenario }),
  logs: async (id: string, source: 'runtime' | 'build' | 'archive', scenario?: string) => {
    const res = await request<{ items?: Record<string, unknown>[]; lines?: { at: string; level: string; text: string }[]; source: string; retention_days: number; redacted: boolean; ai_hint?: { available: boolean; reason?: string } }>(
      `/projects/${id}/logs`,
      { query: { source }, scenario },
    )
    // 兼容 §8.2 的 lines 与试跑替身的 items：页面只接 items，缺字段就明确报错而不是渲染空行
    const raw = res.data.items ?? res.data.lines ?? []
    return { ...res, data: { ...res.data, items: raw.map(toLogLine) } }
  },
  /** api-spec §8.2 规范形状（按环境取日志；页面按项目聚合展示时仍用 logs()） */
  envLogs: (envId: string, source: 'build' | 'runtime' | 'history' = 'runtime', scenario?: string) =>
    request<{ source: string; lines: { at: string; level: string; text: string }[]; next_cursor: string | null; truncated: boolean; ai_hint: { available: boolean; reason?: string }; retention_days: number; redacted: boolean }>(
      `/environments/${envId}/logs`,
      { query: { source }, scenario },
    ),
  logAi: (id: string, scenario?: string) => request<{ hint: string; sent_bytes: number; redacted: boolean }>(`/projects/${id}/logs/ai`, { method: 'POST', body: {}, scenario }),

  grants: (id: string) => request<{ items: GrantItem[]; level_options: string[]; limits: { people: number; groups: number; group_members: number } }>(`/projects/${id}/grants`),
  addGrants: (id: string, subjects: { type: 'user' | 'group'; name: string }[]) =>
    request<{ results: { name: string; ok: boolean; errorCode?: string; reason?: string }[]; applied: number; failed: number }>(`/projects/${id}/grants`, { method: 'POST', body: { subjects } }),
  revokeGrant: (grantId: string) => request<{ revoked: boolean; effective_within_seconds: number }>(`/grants/${grantId}`, { method: 'DELETE' }),

  shares: (id: string) => request<{ items: ShareItem[] }>(`/projects/${id}/shares`),
  /** 同时带 `env_id`（api-spec 形状）与 `env_kind/branch`（Mock 派发器形状），由服务端取有效的那个 */
  createShare: (id: string, env: { envId?: string; envKind: 'preview' | 'production'; branch: string | null }) =>
    request<ShareItem>(`/projects/${id}/shares`, { method: 'POST', body: { env_id: env.envId, env_kind: env.envKind, branch: env.branch } }),
  revokeShare: (shareId: string) => request<{ revoked: boolean }>(`/shares/${shareId}`, { method: 'DELETE' }),

  backups: (id: string) => request<{ items: BackupPoint[]; retention_days: number }>(`/projects/${id}/backups`),
  manualBackup: (id: string, scenario?: string) => request<BackupPoint>(`/projects/${id}/backups`, { method: 'POST', body: {}, idempotencyKey: ulid('idem'), scenario }),

  accessPack: (id: string) => request<{ files: string[]; update_note: string }>(`/projects/${id}/access-pack`),
  updateAccessPack: (id: string, scenario?: string) =>
    request<{ changes: { added: number; updated: number; kept_user_edits: number; conflicts: { file: string; rule: string; why: string; action: string }[] } }>(`/projects/${id}/access-pack/update`, { method: 'POST', body: {}, scenario }),

  mcpKeys: () =>
    request<{ items: { key_id: string; name: string; fingerprint_prefix: string; created_at: string; last_used_at: string; status: string }[]; note: string }>('/mcp-keys'),
  createMcpKey: () => request<{ key_id: string; plaintext_once: string; fingerprint_prefix: string }>('/mcp-keys', { method: 'POST', body: {} }),
  revokeMcpKey: (keyId: string) => request<{ key_id: string; revoked: boolean }>(`/mcp-keys/${keyId}`, { method: 'DELETE' }),

  transfer: (id: string, to: string, reason?: string) => request<{ pending_confirmation: boolean }>(`/projects/${id}/transfer`, { method: 'POST', body: { to, reason } }),
  softDelete: (id: string, confirmName: string) => request<{ status: string }>(`/projects/${id}`, { method: 'DELETE', body: { confirm_name: confirmName } }),
  restore: (id: string) => request<{ status: string }>(`/projects/${id}/restore`, { method: 'POST', body: {} }),

  // 管理员
  adminUsers: (q: Q = {}) => request<AdminUsersPage>('/admin/users', { query: q }),
  updateUserOps: (userId: string, operations: string[]) => request<{ updated: boolean }>(`/admin/users/${userId}`, { method: 'PATCH', body: { operations } }),
  adminGroups: () => request<{ items: GroupInfo[]; member_limit: number }>('/groups'),
  dissolveGroup: (id: string) => request<{ dissolved: boolean }>(`/groups/${id}:dissolve`, { method: 'POST', body: {} }),
  adminPlatform: (scenario?: string) => request<PlatformView & { params: PlatformView['params']; paused: unknown }>('/admin/platform', { scenario }),
  adminSettings: (key: string, value: number, scenario?: string) =>
    request<{ key: string; value: number }>(`/admin/settings/${key}`, { method: 'PATCH', body: { value }, scenario }),
  // §10.4：列表必须带 page/page_size/has_next，total 为同过滤条件总数（v1.2 DEF-V02）
  audit: async (q: Q = {}) => {
    const res = await request<Page<Record<string, unknown>> & { csv_columns: number; csv_columns_confirmed: boolean; append_only?: boolean; retention_days?: number; note: string }>('/audit', { query: q })
    return { ...res, data: { ...res.data, items: res.data.items.map(toAuditRow) } }
  },
  // api-spec §9.4：导出是 GET（format 走 query），CSV 固定 12 列（字段名待业务确认）
  exportAudit: (format: 'csv' | 'json', q: Q = {}) =>
    request<{ format: string; rows: number; columns?: string[] }>('/audit/export', { query: { ...q, format } }),
  /** CSV 导出必须拿到原始文本（不能 JSON 解析）；文件名来自 Content-Disposition */
  exportAuditCsv: (scenario?: string) => requestText('/audit/export', { query: { format: 'csv' }, scenario }),
  alerts: () => request<{ items: AlertRow[] }>('/admin/alerts'),

  // 系统管理员
  roles: async () => {
    const res = await request<RoleModel>('/sys/roles')
    // 角色模型为空说明服务端没给矩阵（不能靠前端本地补一份假矩阵）
    if (!Array.isArray(res.data.roles) || res.data.roles.length === 0) {
      throw new Error('角色权限模型为空：服务端未返回模块 × 操作矩阵。')
    }
    return res
  },
  saveRoles: (model: RoleModel) => request<{ version: string; affected: Record<string, number> }>('/sys/roles', { method: 'PUT', body: { version: model.version, roles: model.roles } }),
  templates: async (scenario?: string) => {
    const res = await request<{ items: Record<string, unknown>[] }>('/templates', { scenario })
    return { ...res, data: { items: res.data.items.map(toTemplate).filter((t) => t.status === 'published') } }
  },
  /** 系统管理员模板管理（含已下线；api-spec §5.6 只约束 /templates 返回 active） */
  sysTemplates: async () => {
    const res = await request<{ items: Record<string, unknown>[] }>('/sys/templates')
    return { ...res, data: { items: res.data.items.map(toTemplate) } }
  },
  templateAction: async (id: string, action: 'publish' | 'offline') => {
    const res = await request<{ template: Record<string, unknown> }>(
      action === 'publish' ? `/admin/templates/${id}/versions` : `/admin/templates/${id}/deprecate`,
      { method: 'POST', body: {} },
    )
    return { ...res, data: { ...res.data, template: toTemplate(res.data.template) } }
  },
  sysSettings: () => request<{ settings: Record<string, unknown>; security: { key: string; label: string; state: string; note: string }[]; paused: unknown }>('/sys/settings'),
  updateSpec: (projectId: string, spec: Record<string, number>, scenario?: string) => request<{ spec: Record<string, number>; effective_at: string }>(`/projects/${projectId}/spec`, { method: 'PATCH', body: spec, scenario }),
  abnormalPreviews: async () => {
    const res = await request<{ items: Record<string, unknown>[]; scope_note: string }>('/admin/previews/cleanup-candidates')
    return { ...res, data: { ...res.data, items: res.data.items.map(toAbnormal) } }
  },
  /** api-spec §10.6：payload 为 { items[{env_id,reason}], confirm, confirm_text }，结果逐条返回 */
  cleanupPreviews: async (items: { env_id: string; reason: string }[], confirmText: string, scenario?: string) => {
    const res = await request<CleanupResult>('/admin/previews:cleanup', {
      method: 'POST',
      body: { items, confirm: true, confirm_text: confirmText },
      idempotencyKey: ulid('idem'),
      scenario,
    })
    return res
  },
  restoreBackup: (backupId: string, confirmWord: string) =>
    request<{ task_id: string; stages: string[] }>('/admin/restores', { method: 'POST', body: { backup_id: backupId, confirm: confirmWord, scope: 'platform' }, idempotencyKey: ulid('idem') }),
  backupStatus: () => request<{
    daily: { retry_in_task: number; failure_counts: number; pause_on_failure: boolean; note: string }
    sync: { retry_in_task: number; failure_counts: number; pause_on_failure: boolean; note: string }
    escalate_after_consecutive: number
    paused: unknown
    resume_mechanism: string
  }>('/sys/backup-status'),
}
