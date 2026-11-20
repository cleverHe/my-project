/**
 * 门户 BFF 客户端（唯一出口）。页面/flows 不得直接 fetch。
 * 端点路径与 `api-spec.md` v1.0 一一对应；此处只包装用到的子集。
 */
import { request, ulid } from './http'
import type {
  AbnormalPreview,
  AdminUser,
  AlertRow,
  AuditRow,
  BackupPoint,
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

export const api = {
  me: () => request<Me>('/me'),

  /** 试跑专用 Mock 登录（真实环境不存在该端点，只能走飞书 OAuth） */
  trialLogin: () => request<Me>('/auth/trial-login', { method: 'POST', body: {} }),
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

  usage: (id: string, scenario?: string) => request<UsageBreakdown>(`/projects/${id}/usage`, { scenario }),
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
  logs: (id: string, source: 'runtime' | 'build' | 'archive', scenario?: string) =>
    request<{ items: LogLine[]; source: string; retention_days: number; redacted: boolean }>(`/projects/${id}/logs`, { query: { source }, scenario }),
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
  createShare: (id: string, envKind: 'preview' | 'production', branch: string | null) =>
    request<ShareItem>(`/projects/${id}/shares`, { method: 'POST', body: { env_kind: envKind, branch } }),
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
  adminUsers: () => request<Page<AdminUser>>('/admin/users'),
  updateUserOps: (userId: string, operations: string[]) => request<{ updated: boolean }>(`/admin/users/${userId}`, { method: 'PATCH', body: { operations } }),
  adminGroups: () => request<{ items: GroupInfo[]; member_limit: number }>('/groups'),
  dissolveGroup: (id: string) => request<{ dissolved: boolean }>(`/groups/${id}:dissolve`, { method: 'POST', body: {} }),
  adminPlatform: (scenario?: string) => request<PlatformView & { params: PlatformView['params']; paused: unknown }>('/admin/platform', { scenario }),
  adminSettings: (key: string, value: number, scenario?: string) =>
    request<{ key: string; value: number }>(`/admin/settings/${key}`, { method: 'PATCH', body: { value }, scenario }),
  audit: (q: Q = {}) => request<{ items: AuditRow[]; total: number; csv_columns: number; csv_columns_confirmed: boolean; note: string }>('/audit', { query: q }),
  // api-spec §9.4：导出是 GET（format 走 query），CSV 固定 12 列（字段名待业务确认）
  exportAudit: (format: 'csv' | 'json', q: Q = {}) =>
    request<{ format: string; rows: number; columns?: string[] }>('/audit/export', { query: { ...q, format } }),
  alerts: () => request<{ items: AlertRow[] }>('/admin/alerts'),

  // 系统管理员
  roles: () => request<RoleModel>('/sys/roles'),
  saveRoles: (model: RoleModel) => request<{ version: string; affected: Record<string, number> }>('/sys/roles', { method: 'PUT', body: model }),
  templates: () => request<{ items: TemplateInfo[] }>('/templates'),
  templateAction: (id: string, action: 'publish' | 'offline') =>
    request<{ template: TemplateInfo }>(action === 'publish' ? `/admin/templates/${id}/versions` : `/admin/templates/${id}:deprecate`, { method: 'POST', body: {} }),
  sysSettings: () => request<{ settings: Record<string, unknown>; security: { key: string; label: string; state: string; note: string }[]; paused: unknown }>('/sys/settings'),
  updateSpec: (projectId: string, spec: Record<string, number>, scenario?: string) => request<{ spec: Record<string, number>; effective_at: string }>(`/projects/${projectId}/spec`, { method: 'PATCH', body: spec, scenario }),
  abnormalPreviews: () => request<{ items: AbnormalPreview[]; scope_note: string }>('/admin/previews/cleanup-candidates'),
  cleanupPreviews: (ids: string[], scenario?: string) =>
    request<{ rows: { id: string; project: string; branch: string; case: string; result: string; reason: string }[]; done: number; residual: number }>('/admin/previews:cleanup', { method: 'POST', body: { ids }, idempotencyKey: ulid('idem'), scenario }),
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
