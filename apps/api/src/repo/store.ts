/**
 * 试跑用内存仓储：只为跑通契约，不是真实持久层。
 * 真实实现需接 PostgreSQL + 底座 API；ENV01–ENV09 未完成前不得声称已联调。
 */
import type { AbnormalPreview, AuditRow, Environment, GroupRow, Project, ShareLink, Task, User } from '../types.js'
import { defaultRoleMatrix, ROLE_OPS, type Role, type RoleMatrix } from '../domain/permissions.js'

export const T0 = '2026-11-20T09:20:00.000Z'
const GATE_OPEN = { paused: false, reason: null, paused_since: null, resume_mechanism: 'T-08_undefined' } as const

/** 人员操作位初值：每人一份副本，避免与 ROLE_OPS 共享引用 */
const USER_SEED: User[] = [
  { user_id: 'usr_trial_lin', display_name: '林小满', feishu_account: 'lin.xiaoman', role: 'user', status: 'active', groups: ['grp_platform'], operations: [...ROLE_OPS.user] },
  { user_id: 'usr_trial_zhou', display_name: '周敏', feishu_account: 'zhou.min', role: 'admin', status: 'active', groups: ['grp_platform'], operations: [...ROLE_OPS.admin] },
  { user_id: 'usr_trial_zheng', display_name: '郑巍', feishu_account: 'zheng.wei', role: 'sysadmin', status: 'active', groups: [], operations: [...ROLE_OPS.sysadmin] },
  { user_id: 'usr_trial_chen', display_name: '陈可', feishu_account: 'chen.ke', role: 'user', status: 'active', groups: ['grp_platform'], operations: [...ROLE_OPS.user] },
  { user_id: 'usr_trial_leave', display_name: '离职账号', feishu_account: 'left.user', role: 'user', status: 'disabled', groups: [], operations: [] },
]

/** 试跑内存仓储：人员操作位与角色模型都是可变状态（P-14 / P-18） */
export const users: User[] = structuredClone(USER_SEED)

export function userById(id: string): User | undefined {
  return users.find((u) => u.user_id === id)
}

/** ------------------------------------------------------------------
 * 角色权限模型（P-18）试跑存储
 * - 保存后立即生效：鉴权只看「模型 enabled ∩ 人员操作位」
 * - 人员操作位只能是模型内已有的项（P-14），模型外不出现也不可授予
 * ------------------------------------------------------------------ */
export const roleModel: RoleMatrix = defaultRoleMatrix()

/** 某角色在模型内被启用（enabled=true）的操作位 */
export function enabledOpsOf(role: Role, matrix: RoleMatrix = roleModel): string[] {
  return matrix.roles
    .filter((r) => r.role === role)
    .flatMap((r) => r.modules.flatMap((m) => m.ops.filter((o) => o.enabled).map((o) => o.code)))
}

/** 模型内定义过的操作位（无论是否启用）——人员权限页只能勾选这些 */
export function definedOpsOf(role: Role, matrix: RoleMatrix = roleModel): string[] {
  return matrix.roles.filter((r) => r.role === role).flatMap((r) => r.modules.flatMap((m) => m.ops.map((o) => o.code)))
}

/** 人员权限页的可勾选项：按角色列出模型内已定义的操作位（含标签与是否启用） */
export function assignableOpsByRole(matrix: RoleMatrix = roleModel): Record<Role, { code: string; label: string; enabled: boolean }[]> {
  return Object.fromEntries(
    matrix.roles.map((r) => [r.role, r.modules.flatMap((m) => m.ops.map((o) => ({ code: o.code, label: o.label, enabled: o.enabled })))]),
  ) as Record<Role, { code: string; label: string; enabled: boolean }[]>
}

/** 本人最终操作位：人员操作位 ∩ 模型启用项；停用账号一律为空 */
export function effectiveOps(user: User): string[] {
  if (user.status !== 'active') return []
  const enabled = new Set(enabledOpsOf(user.role))
  return user.operations.filter((op) => enabled.has(op))
}

/** 服务端唯一判定入口：审计、路由守卫都用它（不能只看静态 ROLE_OPS） */
export function userHasOp(userId: string, op: string): boolean {
  const u = userById(userId)
  return u ? effectiveOps(u).includes(op) : false
}

export function setUserOps(userId: string, ops: string[]): User | undefined {
  const u = userById(userId)
  if (!u) return undefined
  u.operations = [...ops]
  return u
}

export type SaveMatrixResult =
  | { ok: true; version: string; affected: Record<Role, number> }
  | { ok: false; reason: string; details?: Record<string, unknown> }

/** 保存角色模型：只接受模型内已存在的操作位；启用状态可在启/停之间切换，不可新增权限码。 */
export function saveRoleModel(input: unknown): SaveMatrixResult {
  const body = (input ?? {}) as { roles?: { role?: string; modules?: { module?: string; ops?: { code?: string; enabled?: boolean }[] }[] }[] }
  if (!Array.isArray(body.roles) || body.roles.length !== 3) return { ok: false, reason: '必须且只能提交三类应用角色的完整模型。' }
  const roles = body.roles
  const seen = new Set<string>()
  for (const r of roles) {
    const role = r?.role as Role | undefined
    if (!role || !['user', 'admin', 'sysadmin'].includes(role)) return { ok: false, reason: '角色只能是 user / admin / sysadmin。' }
    seen.add(role)
    const allowed = new Set(definedOpsOf(role))
    const ops = (r?.modules ?? []).flatMap((m) => m?.ops ?? [])
    const unknownCodes = ops.filter((o) => !o?.code || !allowed.has(o.code)).map((o) => o.code ?? '(missing)')
    if (unknownCodes.length > 0) {
      return { ok: false, reason: '提交了角色模型里不存在的操作位。', details: { role, unknownCodes, note: '不能通过保存请求新增权限码。' } }
    }
    if (ops.length !== allowed.size) {
      return { ok: false, reason: '提交的操作位不完整。', details: { role, expected: allowed.size, got: ops.length } }
    }
  }
  if (seen.size !== 3) return { ok: false, reason: '必须提交三种应用角色。' }

  const now = new Date().toISOString()
  const next = structuredClone(roleModel)
  for (const r of roles) {
    const role = r.role as Role
    const target = next.roles.find((x) => x.role === role)!
    for (const m of r.modules ?? []) {
      const tMod = target.modules.find((x) => x.module === m.module)
      if (!tMod) continue
      for (const op of m.ops ?? []) {
        const tOp = tMod.ops.find((x) => x.code === op.code)
        if (tOp) tOp.enabled = op.enabled === true
      }
    }
  }
  roleModel.roles = next.roles
  roleModel.version = `v${Date.now()}`
  roleModel.updated_at = now
  const affected = { user: 0, admin: 0, sysadmin: 0 } as Record<Role, number>
  for (const u of users) if (u.status === 'active') affected[u.role] += 1
  return { ok: true, version: roleModel.version, affected }
}

function env(partial: Partial<Environment> & Pick<Environment, 'id' | 'project_id' | 'kind' | 'slug'>): Environment {
  return {
    branch: null,
    url: `https://${partial.slug}.deploy.internal`,
    display_state: 'running',
    replicas: 1,
    last_access_at: T0,
    current: { version_label: null, sha: null, built_at: null },
    retention: { state: 'retained', note: '预览长期保留：正式发布不会删除预览，分支删除只休眠不删除。' },
    created_at: '2026-11-10T02:00:00.000Z',
    updated_at: T0,
    ...partial,
  } as Environment
}

const SEED: Project[] = [
  {
    id: 'prj_trial_ai_cs',
    name: '智能客服',
    slug: 'ai-cs',
    status: 'active',
    owner_id: 'usr_trial_lin',
    owner_name: '林小满',
    relation: 'owner',
    relation_label: '你是拥有者',
    spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4 * 1024 ** 3, preview_limit: 3 },
    quota_used_bytes: Math.round(1.1 * 1024 ** 3),
    gate: { ...GATE_OPEN },
    grant_people: ['usr_trial_chen'],
    grant_groups: ['grp_platform'],
    environments: [
      env({ id: 'env_trial_cs_prev1', project_id: 'prj_trial_ai_cs', kind: 'preview', branch: 'feat/order', slug: 'ai-cs-feat-order' }),
      env({
        id: 'env_trial_cs_prev2',
        project_id: 'prj_trial_ai_cs',
        kind: 'preview',
        branch: 'feat/old-ui',
        slug: 'ai-cs-feat-old-ui',
        display_state: 'sleeping',
        replicas: 0,
        branch_deleted: true,
        last_access_at: '2026-11-01T02:00:00.000Z',
      }),
      env({ id: 'env_trial_cs_prev3', project_id: 'prj_trial_ai_cs', kind: 'preview', branch: 'feat/search', slug: 'ai-cs-feat-search' }),
      env({
        id: 'env_trial_cs_prod',
        project_id: 'prj_trial_ai_cs',
        kind: 'production',
        slug: 'ai-cs',
        current: { version_label: 'v1.2.0', sha: '3f2a9c1be7d94c20a5f1', built_at: '2026-11-20T08:40:00.000Z' },
      }),
    ],
    deployments: [
      { id: 'dep_trial_1', container: 'env_trial_cs_prod', version_label: 'v1.2.0', sha: '3f2a9c1be7d94c20a5f1', built_at: '2026-11-20T08:40:00.000Z', result: 'success', rollbackable: true, missing_reason: null, operator: '林小满' },
      { id: 'dep_trial_2', container: 'env_trial_cs_prod', version_label: 'v1.1.0', sha: '7b2c8d4a1f3e9b60c2d5', built_at: '2026-11-18T09:10:00.000Z', result: 'success', rollbackable: true, missing_reason: null, operator: '林小满' },
      { id: 'dep_trial_3', container: 'env_trial_cs_prod', version_label: 'v1.0.1', sha: '1a9f7e3c5b2d8f4079ae', built_at: '2026-11-15T07:45:00.000Z', result: 'failed', rollbackable: false, missing_reason: '构建镜像已被底座回收，无法回退到该版本', operator: '林小满' },
    ],
    created_at: '2026-10-28T02:00:00.000Z',
    updated_at: '2026-11-20T08:40:00.000Z',
  },
  {
    id: 'prj_trial_kb',
    name: '知识库检索',
    slug: 'kb-search',
    status: 'active',
    owner_id: 'usr_trial_chen',
    owner_name: '陈可',
    relation: 'group',
    relation_label: '来自：项目组 平台研发组',
    spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4 * 1024 ** 3, preview_limit: 3 },
    quota_used_bytes: Math.round(3.4 * 1024 ** 3),
    gate: { paused: true, reason: 'daily_backup_failed', paused_since: '2026-11-20T02:40:00.000Z', resume_mechanism: 'T-08_undefined' },
    grant_people: [],
    grant_groups: ['grp_platform'],
    environments: [
      env({ id: 'env_trial_kb_prev1', project_id: 'prj_trial_kb', kind: 'preview', branch: 'feat/rag', slug: 'kb-search-feat-rag' }),
      env({
        id: 'env_trial_kb_prev2',
        project_id: 'prj_trial_kb',
        kind: 'preview',
        branch: 'feat/old-ui',
        slug: 'kb-search-feat-old-ui',
        display_state: 'sleeping',
        replicas: 0,
        branch_deleted: true,
      }),
      env({ id: 'env_trial_kb_prev3', project_id: 'prj_trial_kb', kind: 'preview', branch: 'feat/vector', slug: 'kb-search-feat-vector', residual: true }),
      env({
        id: 'env_trial_kb_prod',
        project_id: 'prj_trial_kb',
        kind: 'production',
        slug: 'kb-search',
        current: { version_label: 'v0.9.1', sha: '8e7d6c5b4a3f2e1d0c9b', built_at: '2026-11-19T14:00:00.000Z' },
      }),
    ],
    deployments: [
      { id: 'dep_kb_1', container: 'env_trial_kb_prod', version_label: 'v0.9.1', sha: '8e7d6c5b4a3f2e1d0c9b', built_at: '2026-11-19T14:00:00.000Z', result: 'success', rollbackable: true, missing_reason: null, operator: '陈可' },
    ],
    created_at: '2026-10-30T03:00:00.000Z',
    updated_at: '2026-11-20T02:40:00.000Z',
  },
]

export const projects: Project[] = structuredClone(SEED)

/** 试跑：每个测试/进程重启回到同一份种子，避免用例间互相污染 */
export function resetStore() {
  projects.splice(0, projects.length, ...structuredClone(SEED))
  tasks.clear()
  audits.splice(0, audits.length)
  idempotency.clear()
  shareLinks.splice(0, shareLinks.length)
  abnormalPreviews.splice(0, abnormalPreviews.length, ...structuredClone(ABNORMAL_SEED))
  users.splice(0, users.length, ...structuredClone(USER_SEED))
  const fresh = defaultRoleMatrix()
  roleModel.version = fresh.version
  roleModel.updated_at = fresh.updated_at
  roleModel.roles = fresh.roles
  templates.splice(0, templates.length, ...structuredClone(TEMPLATE_SEED))
  const grp = groups[0]
  if (grp) grp.status = 'active'
  Object.assign(settings, structuredClone(SETTINGS_SEED))
  platform.authz_ok = true
  platform.dokploy_ok = true
}

export const tasks = new Map<string, Task>()
export const audits: AuditRow[] = []
export const idempotency = new Map<string, { requestHash: string; response: unknown; status: number }>()

/**
 * 分享链接（试跑内存表，与项目授权完全独立）。
 * 真实实现：share_link 表只存 token_hash（data-model §4.5）；试跑不落明文 token，
 * url 为演示域名（Q08 未定），不代表最终域名。
 */
export const shareLinks: ShareLink[] = []

/** 项目组（试跑内存表）。成员/项目计数为只读展示字段，组上限 200 人。 */
export const groups: GroupRow[] = [
  { id: 'grp_platform', name: '平台研发组', member_count: 4, project_count: 2, status: 'active', member_limit: 200 },
]

const ABNORMAL_SEED: AbnormalPreview[] = [
  { id: 'env_abn_1', project_id: 'prj_trial_legacy', project_name: '旧版工单', branch: 'feat/refund', case: 'disabled_owner', state: 'sleeping', last_active_at: '2026-10-02T02:00:00.000Z', size_bytes: 300 * 1024 ** 2 },
  { id: 'env_abn_2', project_id: 'prj_trial_gone', project_name: '已删项目-促销页', branch: 'feat/promo', case: 'deleted_project', state: 'sleeping', last_active_at: '2026-09-18T02:00:00.000Z', size_bytes: 200 * 1024 ** 2 },
  { id: 'env_abn_3', project_id: 'prj_trial_kb', project_name: '知识库检索', branch: 'feat/vector', case: 'undeletable', state: 'running', last_active_at: '2026-11-02T02:00:00.000Z', size_bytes: 500 * 1024 ** 2 },
]

export const abnormalPreviews: AbnormalPreview[] = structuredClone(ABNORMAL_SEED)

const SETTINGS_SEED = {
  build_concurrency: 3,
  queue_limit: 10,
  max_build_concurrency: 3,
  max_queue_limit: 10,
  backup_time: '02:30',
  backup_retry_in_task: 3,
  offsite_sync_retry_in_task: 0,
  retention_days: 30,
  escalate_after_consecutive: 2,
  resume_mechanism: 'T-08_undefined',
}

export const settings: typeof SETTINGS_SEED = structuredClone(SETTINGS_SEED)

export const platform = {
  version: '0.29.13',
  digest: 'sha256:pending-poc',
  digest_note: 'Q25 digest 待 PoC 核对，不用最新标签冒充锁定版本',
  authz_ok: true,
  dokploy_ok: true,
}

/**
 * 门户模板库元数据（P-19 / api-spec §5.6）。
 * `status` 用契约口径 active/deprecated：active=已发布可用，deprecated=已下线（历史保留）。
 * 不是平台生成应用模板（Q29）的代码范围。
 */
export interface TemplateRow {
  id: string
  name: string
  stack: string
  shape: 'static' | 'api' | 'fullstack' | 'blank'
  version: string
  status: 'active' | 'deprecated'
  projects_used: number
  has_demo: boolean
  has_spec: boolean
  has_skills: boolean
  files: string[]
  skills: string[]
  build_preset: string
  health_preset: 'healthz' | 'root' | 'tcp'
  credential_scan: 'clean' | 'blocked'
  note: string
}

const TEMPLATE_SEED: TemplateRow[] = [
  { id: 'tpl_ai_chat', name: 'AI 对话应用', stack: 'Node + Vue + BFF（Q29 平台约定）', shape: 'fullstack', version: 'v1.0.0', status: 'active', projects_used: 6, has_demo: true, has_spec: true, has_skills: true, files: ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/'], skills: ['查状态', '看日志', '发预览', '查部署记录'], build_preset: 'node-vue-bff', health_preset: 'healthz', credential_scan: 'clean', note: '含规范与 4 个门户 MCP Skill' },
  { id: 'tpl_ai_report', name: 'AI 报告生成', stack: 'Node + Vue + BFF（Q29 平台约定）', shape: 'api', version: 'v2.1.0', status: 'active', projects_used: 3, has_demo: true, has_spec: true, has_skills: true, files: ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/'], skills: ['查状态', '看日志', '发预览', '查部署记录'], build_preset: 'node-vue-bff', health_preset: 'root', credential_scan: 'clean', note: '含规范与 4 个门户 MCP Skill' },
  { id: 'tpl_blank', name: '空白模板', stack: '最小可运行 demo（无）', shape: 'blank', version: 'v1.0.0', status: 'active', projects_used: 1, has_demo: false, has_spec: true, has_skills: true, files: ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/'], skills: ['查状态', '看日志', '发预览', '查部署记录'], build_preset: '未识别 · 需用户选择', health_preset: 'tcp', credential_scan: 'clean', note: '回退时使用，不会静默替换已选模板；只含规范与 Skill' },
]

export const templates: TemplateRow[] = structuredClone(TEMPLATE_SEED)

export const me = {
  user_id: 'usr_trial_lin',
  display_name: '林小满',
  role: 'user' as const,
  groups: ['grp_platform'],
  operations: [...ROLE_OPS.user],
  session_expires_at: '2026-11-20T17:20:00.000Z',
  mock: true,
}

export function projectById(id: string): Project | undefined {
  return projects.find((p) => p.id === id)
}
