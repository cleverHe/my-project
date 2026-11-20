/**
 * DTO 类型 —— 严格对齐 `api-spec.md` v1.0（工作区根目录）。
 * 只声明前端消费的字段；规范允许后端先加未声明字段，前端忽略未知字段（api-spec §1.6）。
 * 本文件不含任何服务凭据；凭据永不下发到前端（technical-review §3.6）。
 */

export type Role = 'user' | 'admin' | 'sysadmin'
export type ProjectRelation = 'owner' | 'granted' | 'group' | 'none'
/** 展示态只有三种，README Q14 / PRD G-11；内部中间态用 pending 表达 */
export type DisplayState = 'running' | 'sleeping' | 'not_created'

export interface UserRef {
  user_id: string
  display_name: string
}

export interface Me {
  user_id: string
  display_name: string
  role: Role
  /** 本人四级操作权限（服务端下发；前端只用于隐藏入口，不作为校验依据） */
  operations: string[]
  feishu_status: 'active' | 'disabled'
}

export interface Quota {
  used_bytes: number
  limit_bytes: number
  ratio: number
  warning: boolean
}

export interface PreviewItem {
  id: string
  branch: string
  url: string
  display_state: DisplayState
  pending?: boolean
  last_access_at: string | null
  branch_deleted?: boolean
  residual?: boolean
  updated_at: string
}

export interface PreviewSlot {
  slot: 'recent'
  total: number
  limit: number
  items: PreviewItem[]
}

export interface ProductionSlot {
  state: DisplayState | 'publishing'
  url: string | null
  sha: string | null
  version_label: string | null
  updated_at: string | null
}

export interface ProjectCard {
  id: string
  name: string
  slug: string
  status: 'active' | 'soft_deleted' | 'creating'
  owner: UserRef
  relation: ProjectRelation
  relation_label?: string
  preview: PreviewSlot
  production: ProductionSlot
  quota: Quota
  spec: { cpu: number; memory_mb: number; disk_bytes: number; preview_limit: number }
  updated_at: string
}

export interface ProjectDetail extends ProjectCard {
  created_at: string
  spec: { cpu: number; memory_mb: number; disk_bytes: number; preview_limit: number }
  grant_summary: { people: number; groups: number; limit_people: number; limit_groups: number }
  gate: GateState
}

export interface GateState {
  paused: boolean
  reason: 'daily_backup_failed' | 'offsite_sync_failed' | null
  paused_since: string | null
  /** 解除机制原文未定（T-08）；前端只展示「需系统管理员处理」 */
  resume_mechanism: 'T-08_undefined'
}

export interface Environment {
  id: string
  project_id: string
  kind: 'preview' | 'production'
  branch: string | null
  slug: string
  url: string
  state: DisplayState
  display_state: DisplayState
  replicas: number
  last_access_at: string | null
  sleep_at: string | null
  current: { version_label: string | null; sha: string | null; built_at: string | null }
  retention: { state: 'retained'; note: string }
  /** 分支已删除但预览保留（GAP-03） */
  branch_deleted?: boolean
  /** 删除未完成、资源残留（GAP-05） */
  residual?: boolean
  created_at: string
  updated_at: string
}

export interface DeploymentRecord {
  id: string
  version_label: string
  sha: string
  built_at: string
  result: 'success' | 'failed'
  operator: string
  probe_level: 'healthz' | 'root' | 'tcp'
  backup_id: string | null
  rollbackable: boolean
  missing_reason: string | null
  env_kind: 'preview' | 'production'
  branch: string | null
}

export interface TaskStep {
  key: string
  label: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  error?: { errorCode: string; message: string; nextStep: string } | null
}

export interface Task {
  id: string
  type: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  phase: DeployPhase | null
  attempt: number
  max_attempts: number
  steps: TaskStep[]
  sha: string | null
  version_label: string | null
  created_at: string
  finished_at: string | null
  error?: { errorCode: string; message: string; nextStep: string } | null
}

/** 发布阶段（顺序固定；备份步骤仅在勾选发布前备份时出现） */
export type DeployPhase = 'queued' | 'building' | 'healthcheck' | 'backup' | 'switching' | 'done' | 'failed'

export interface MainHead {
  branch: 'main'
  sha: string
  short_sha: string
  committed_at: string
  author: string
  version_labels: string[]
}

export interface BackupPoint {
  id: string
  kind: 'auto' | 'manual' | 'pre_publish'
  created_at: string
  scope: string
  result: 'success' | 'failed'
  expires_at: string
  attempts: number
  max_attempts: number
  note: string
}

export interface GrantItem {
  id: string
  subject_type: 'user' | 'group'
  subject_name: string
  subject_status: 'active' | 'disabled' | 'group_dissolved' | 'member_removed'
  /** 授权只有「可见」一档（README 9.1#23 最终口径） */
  level: 'visible'
  source: 'owner' | 'admin'
  created_at: string
}

export interface ShareItem {
  id: string
  env_kind: 'preview' | 'production'
  branch: string | null
  url: string
  created_by: string
  created_at: string
  status: 'active' | 'revoked'
  revoked_at: string | null
}

export interface FileEntry {
  name: string
  path: string
  size_bytes: number
  modified_at: string
  type: 'file' | 'dir'
}

export interface LogLine {
  seq: number
  at: string
  level: 'info' | 'warn' | 'error'
  text: string
  redacted?: boolean
}

export interface UsageBreakdown {
  cpu: { used: number; limit: number }
  memory_mb: { used: number; limit: number }
  disk: {
    used_bytes: number
    limit_bytes: number
    parts: { key: 'db_volume' | 'persistent_volume' | 'files' | 'logs'; label: string; used_bytes: number }[]
  }
  collected_at: string
  stale: boolean
}

export interface DbInfo {
  engine: 'postgresql' | 'mysql' | 'mongodb' | 'none'
  state: DisplayState | 'provisioning'
  host: string | null
  database: string | null
  /** 明文密码永不下发；只有重置入口 */
  password_hint: 'reset_only'
}

export interface RedisInfo {
  shared: true
  shard: string
  used_ratio: number
  warn_at: number
  reject_at: number
  note: string
}

export interface TemplateInfo {
  id: string
  name: string
  shape: 'static' | 'api' | 'fullstack' | 'blank'
  version: string
  status: 'published' | 'offline'
  projects_used: number
  has_demo: boolean
  files: string[]
  skills: string[]
  build_preset: string
  health_preset: 'healthz' | 'root' | 'tcp'
  credential_scan: 'clean' | 'blocked'
}

export interface AuditRow {
  id: string
  at: string
  actor: string
  action: string
  object: string
  result: 'success' | 'failed'
  source_ip: string
  before?: string
  after?: string
}

export interface AlertRow {
  id: string
  level: 'warning' | 'critical'
  object: string
  at: string
  handled: boolean
  text: string
}

export interface AdminUser {
  user_id: string
  display_name: string
  feishu_account: string
  role: Role
  status: 'active' | 'disabled'
  operations: string[]
}

export interface GroupInfo {
  id: string
  name: string
  member_count: number
  project_count: number
  status: 'active' | 'dissolved'
  member_limit: number
}

export interface PlatformView {
  version: string
  digest_locked: boolean
  digest_note: string
  ports_public: boolean
  cert_expires_days: number
  authz_ok: boolean
  gateway_ok: boolean
  gitlab_ok: boolean
  dokploy_ok: boolean
  params: { build_concurrency: number; queue_limit: number; max_build_concurrency: number; max_queue_limit: number }
  host: { cpu_ratio: number; memory_ratio: number; disk_ratio: number }
  redis: RedisInfo
  backups: { last_success_at: string | null; last_failure_at: string | null; last_failure_reason: string | null }
  sync: { last_success_at: string | null; last_failure_at: string | null; last_failure_reason: string | null }
  webhook: { installed: number; failed_projects: string[] }
  security: { key: string; label: string; state: 'pass' | 'fail' | 'not_run'; note: string }[]
}

export interface AbnormalPreview {
  id: string
  project_name: string
  branch: string
  url: string
  state: DisplayState
  case: 'disabled_owner' | 'deleted_project' | 'undeletable'
  last_active_at: string
  size_bytes: number
}

export interface RoleModel {
  version: string
  updated_at: string
  roles: { role: Role; label: string; modules: { module: string; ops: { code: string; label: string; enabled: boolean }[] }[] }[]
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  has_next: boolean
}

export interface ApiErrorBody {
  errorCode: string
  message: string
  nextStep: string
  traceId: string
  details?: Record<string, unknown>
}
