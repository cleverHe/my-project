/** 契约类型（与前端 apps/web/src/api/types.ts 对齐；api-spec v1.0） */
export type DisplayState = 'running' | 'sleeping' | 'not_created'
export type Relation = 'owner' | 'granted' | 'group' | 'none'

export interface User {
  user_id: string
  display_name: string
  role: 'user' | 'admin' | 'sysadmin'
  status: 'active' | 'disabled'
  groups: string[]
  operations: string[]
}

export interface Spec {
  cpu: number
  memory_mb: number
  disk_bytes: number
  preview_limit: number
}

export interface Environment {
  id: string
  project_id: string
  kind: 'preview' | 'production'
  branch: string | null
  slug: string
  url: string
  display_state: DisplayState
  replicas: number
  last_access_at: string | null
  current: { version_label: string | null; sha: string | null; built_at: string | null }
  retention: { state: 'retained'; note: string }
  branch_deleted?: boolean
  residual?: boolean
  created_at: string
  updated_at: string
}

export interface GateState {
  paused: boolean
  reason: 'daily_backup_failed' | 'offsite_sync_failed' | null
  paused_since: string | null
  resume_mechanism: 'T-08_undefined'
}

export interface Project {
  id: string
  name: string
  slug: string
  status: 'active' | 'soft_deleted'
  owner_id: string
  owner_name: string
  relation: Relation
  relation_label: string
  spec: Spec
  quota_used_bytes: number
  gate: GateState
  grant_people: string[]
  grant_groups: string[]
  environments: Environment[]
  deployments: DeploymentRecord[]
  created_at: string
  updated_at: string
}

export interface DeploymentRecord {
  id: string
  container: string
  version_label: string
  sha: string
  built_at: string
  result: 'success' | 'failed'
  rollbackable: boolean
  missing_reason: string | null
  operator: string
}

export interface Task {
  id: string
  type: 'deploy.production' | 'deploy.preview' | 'preview.create' | 'project.create' | 'backup.restore'
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  phase: string | null
  attempt: number
  max_attempts: number
  steps: { key: string; label: string; status: 'pending' | 'running' | 'done' | 'failed' }[]
  sha?: string | null
  version_label?: string | null
  error?: { errorCode: string; message: string; nextStep: string }
  created_at: string
  finished_at: string | null
}

export interface AuditRow {
  id: string
  at: string
  actor_id: string
  actor_name: string
  action: string
  target_kind: string
  target_id: string
  result: 'success' | 'failed'
  error_code: string | null
  ip: string
  detail: string
  trace_id: string
}

/** 分享链接（与项目授权独立；撤销只让本条链接失效，不授予/回收任何项目授权） */
export interface ShareLink {
  id: string
  project_id: string
  env_id: string
  env_kind: 'preview' | 'production'
  branch: string | null
  /** 展示用链接（不返回明文 token；真实实现只存 token_hash） */
  url: string
  created_by: { user_id: string; display_name: string }
  created_at: string
  expires_at: string | null
  status: 'active' | 'revoked'
  revoked_at: string | null
}

/** 项目组（授权对象，不是角色） */
export interface GroupRow {
  id: string
  name: string
  member_count: number
  project_count: number
  status: 'active' | 'dissolved'
  member_limit: number
}

export interface AbnormalPreview {
  id: string
  project_id: string
  project_name: string
  branch: string
  case: 'disabled_owner' | 'deleted_project' | 'undeletable'
  state: DisplayState
  last_active_at: string
  size_bytes: number
}
