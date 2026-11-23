/**
 * 试跑 Mock 数据仓（进程内，刷新即重置）。
 * - 结构对齐 api-spec.md v1.0 / data-model.md v1.0 的字段名
 * - 所有时间固定为 2026-11-20 的样例，避免测试随真实时钟漂移
 * - 这里是**模拟数据**，不是真实环境、不是联调结果、不是业务验收证据
 * - 不含任何真实凭据、真实 open_id、真实域名
 */
import type {
  AbnormalPreview,
  AdminUser,
  AlertRow,
  AuditRow,
  BackupPoint,
  DbInfo,
  DeploymentRecord,
  Environment,
  FileEntry,
  GrantItem,
  GroupInfo,
  LogLine,
  Me,
  ProjectDetail,
  RedisInfo,
  RoleModel,
  ShareItem,
  TemplateInfo,
  UserRef,
} from '../types'

export const T0 = '2026-11-20T01:00:00.000Z'
export const NOW = '2026-11-20T09:20:00.000Z'

export interface MockEnv extends Environment {
  project_id: string
  /** 试跑：唤醒/发布演示用 */
  wake_started_at?: string | null
}

export interface MockProject extends ProjectDetail {
  main: { sha: string; committed_at: string; author: string; version_labels: string[] }
  environments: MockEnv[]
  deployments: DeploymentRecord[]
  backups: BackupPoint[]
  files: FileEntry[]
  logs: LogLine[]
  grants: GrantItem[]
  shares: ShareItem[]
  db: DbInfo
}

const userLin: UserRef = { user_id: 'usr_trial_lin', display_name: '林小满' }
const userZhou: UserRef = { user_id: 'usr_trial_zhou', display_name: '周敏' }
const userChen: UserRef = { user_id: 'usr_trial_chen', display_name: '陈可' }

export const me: Me = {
  user_id: userLin.user_id,
  display_name: userLin.display_name,
  role: 'user',
  // 与 BFF 角色模型同一套操作位码（Mock 只做展示，不能另造一套）
  operations: [
    'project:create', 'project:read', 'deploy:create', 'preview:create', 'preview:delete', 'file:read', 'log:read', 'share:create', 'mcp:manage',
  ],
  feishu_status: 'active',
}

/** 三类应用角色（不是第四类；拥有者/被授权人/项目组是数据关系） */
export const roleOperations: Record<Me['role'], string[]> = {
  user: ['project:create', 'project:read', 'deploy:create', 'preview:create', 'preview:delete', 'file:read', 'log:read', 'share:create', 'mcp:manage'],
  admin: ['project:create', 'project:read', 'deploy:create', 'preview:create', 'preview:delete', 'file:read', 'log:read', 'share:create', 'mcp:manage', 'admin:people', 'admin:group', 'admin:platform', 'admin:audit', 'admin:settings:read', 'admin:param:concurrency', 'admin:param:queue'],
  sysadmin: ['project:read', 'project:spec', 'file:read', 'log:read', 'admin:audit', 'admin:settings:read', 'sys:setting', 'sys:cleanup', 'sys:restore', 'sys:role', 'sys:template', 'system:backup', 'system:resource'],
}
function envPreview(id: string, projectId: string, branch: string, slug: string, state: Environment['state'], extra: Partial<MockEnv> = {}): MockEnv {
  return {
    id,
    project_id: projectId,
    kind: 'preview',
    branch,
    slug,
    url: `https://${slug}.deploy.internal`,
    state,
    display_state: state,
    replicas: state === 'sleeping' ? 0 : 1,
    last_access_at: '2026-11-20T08:40:00.000Z',
    sleep_at: state === 'sleeping' ? '2026-11-27T08:00:00.000Z' : null,
    current: { version_label: 'preview', sha: '9c41ab2', built_at: '2026-11-20T07:10:00.000Z' },
    retention: { state: 'retained', note: '预览长期保留；正式发布不会删除预览，分支删除只休眠不删除' },
    created_at: '2026-11-18T03:00:00.000Z',
    updated_at: '2026-11-20T08:40:00.000Z',
    ...extra,
  }
}

function envProduction(id: string, projectId: string, slug: string, state: Environment['state'], extra: Partial<MockEnv> = {}): MockEnv {
  return {
    id,
    project_id: projectId,
    kind: 'production',
    branch: null,
    slug,
    url: `https://${slug}.deploy.internal`,
    state,
    display_state: state,
    replicas: state === 'not_created' ? 0 : 1,
    last_access_at: null,
    sleep_at: null,
    current: { version_label: null, sha: null, built_at: null },
    retention: { state: 'retained', note: '正式环境；回滚以底座实际保留为准' },
    created_at: '2026-11-18T03:00:00.000Z',
    updated_at: '2026-11-20T08:40:00.000Z',
    ...extra,
  }
}

export const projects: MockProject[] = [
  {
    id: 'prj_trial_ai_cs',
    name: '智能客服',
    slug: 'ai-cs',
    status: 'active',
    owner: userLin,
    relation: 'owner',
    preview: { slot: 'recent', total: 2, limit: 3, items: [] },
    production: { state: 'running', url: 'https://ai-cs.deploy.internal', sha: '3f2a9c1be7d94c20a5f1', version_label: 'v1.2.0', updated_at: '2026-11-20T06:30:00.000Z' },
    quota: { used_bytes: 1159641169, limit_bytes: 4294967296, ratio: 0.27, warning: false },
    updated_at: '2026-11-20T08:40:00.000Z',
    created_at: '2026-11-12T02:00:00.000Z',
    spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4294967296, preview_limit: 3 },
    grant_summary: { people: 3, groups: 1, limit_people: 50, limit_groups: 10 },
    gate: { paused: false, reason: null, paused_since: null, resume_mechanism: 'T-08_undefined' },
    main: { sha: '3f2a9c1be7d94c20a5f1d8e0c4b6a2f0d1e3c5b7', committed_at: '2026-11-20T05:55:00.000Z', author: '林小满', version_labels: ['v1.2.0', 'v1.1.0', 'v1.0.0'] },
    environments: [
      envPreview('env_trial_ai_cs_feat_order', 'prj_trial_ai_cs', 'feat/order', 'ai-cs-feat-order', 'running', { updated_at: '2026-11-20T08:40:00.000Z' }),
      envPreview('env_trial_ai_cs_feat_pay', 'prj_trial_ai_cs', 'feat/pay', 'ai-cs-feat-pay', 'sleeping', { updated_at: '2026-11-19T10:00:00.000Z' }),
      envProduction('env_trial_ai_cs_prod', 'prj_trial_ai_cs', 'ai-cs', 'running', {
        current: { version_label: 'v1.2.0', sha: '3f2a9c1be7d94c20a5f1', built_at: '2026-11-20T06:28:00.000Z' },
        updated_at: '2026-11-20T06:30:00.000Z',
      }),
    ],
    deployments: [
      { id: 'dep_trial_1', version_label: 'v1.2.0', sha: '3f2a9c1be7d94c20a5f1', built_at: '2026-11-20T06:28:00.000Z', result: 'success', operator: '林小满', probe_level: 'healthz', backup_id: 'bkp_trial_pre_1', rollbackable: true, missing_reason: null, env_kind: 'production', branch: null },
      { id: 'dep_trial_2', version_label: 'v1.1.0', sha: '7b2c8d4e1f6a9035c7e2', built_at: '2026-11-18T09:10:00.000Z', result: 'success', operator: '林小满', probe_level: 'healthz', backup_id: null, rollbackable: true, missing_reason: null, env_kind: 'production', branch: null },
      { id: 'dep_trial_3', version_label: 'v1.0.1', sha: '1a9f7e3c5d2b8046f1a3', built_at: '2026-11-15T07:45:00.000Z', result: 'failed', operator: '林小满', probe_level: 'root', backup_id: null, rollbackable: false, missing_reason: '构建镜像已被底座回收，无法回退到该版本', env_kind: 'production', branch: null },
      { id: 'dep_trial_4', version_label: 'preview', sha: '9c41ab2d8e5f7136b4c0', built_at: '2026-11-20T07:10:00.000Z', result: 'success', operator: '林小满', probe_level: 'healthz', backup_id: null, rollbackable: true, missing_reason: null, env_kind: 'preview', branch: 'feat/order' },
    ],
    backups: [
      { id: 'bkp_trial_pre_1', kind: 'pre_publish', created_at: '2026-11-20T06:20:00.000Z', scope: '智能客服 · 全部环境（含预览）', result: 'success', expires_at: '2026-12-20T06:20:00.000Z', attempts: 1, max_attempts: 3, note: '发布前备份：构建成功后执行，成功后才切流' },
      { id: 'bkp_trial_auto_2', kind: 'auto', created_at: '2026-11-20T02:00:00.000Z', scope: '智能客服 · 全部环境（含预览）', result: 'success', expires_at: '2026-12-20T02:00:00.000Z', attempts: 1, max_attempts: 3, note: '每日全量备份' },
      { id: 'bkp_trial_auto_1', kind: 'auto', created_at: '2026-11-19T02:00:00.000Z', scope: '智能客服 · 全部环境（含预览）', result: 'success', expires_at: '2026-12-19T02:00:00.000Z', attempts: 2, max_attempts: 3, note: '每日全量备份（第 2 次尝试成功）' },
    ],
    files: [
      { name: 'avatars', path: '/avatars/', size_bytes: 0, modified_at: '2026-11-20T04:10:00.000Z', type: 'dir' },
      { name: 'avatar-001.png', path: '/avatars/avatar-001.png', size_bytes: 245760, modified_at: '2026-11-20T04:12:00.000Z', type: 'file' },
      { name: 'export-2026-11-19.csv', path: '/export-2026-11-19.csv', size_bytes: 1048576, modified_at: '2026-11-19T18:02:00.000Z', type: 'file' },
    ],
    logs: [
      { seq: 1, at: '2026-11-20T08:30:01.000Z', level: 'info', text: 'server listening on 0.0.0.0:8080' },
      { seq: 2, at: '2026-11-20T08:31:12.000Z', level: 'info', text: 'GET /healthz 200 3ms' },
      { seq: 3, at: '2026-11-20T08:33:40.000Z', level: 'warn', text: 'slow query 812ms table=orders', redacted: false },
      { seq: 4, at: '2026-11-20T08:35:02.000Z', level: 'error', text: 'POST /api/orders 500 db connection timeout (dsn=postgres://app:***@db:5432/apps)', redacted: true },
      { seq: 5, at: '2026-11-20T08:36:10.000Z', level: 'info', text: 'GET /api/orders 200 41ms' },
    ],
    grants: [
      { id: 'grt_trial_1', subject_type: 'user', subject_name: '周敏', subject_status: 'active', level: 'visible', source: 'owner', created_at: '2026-11-13T03:00:00.000Z' },
      { id: 'grt_trial_2', subject_type: 'user', subject_name: '陈可', subject_status: 'active', level: 'visible', source: 'owner', created_at: '2026-11-14T06:20:00.000Z' },
      { id: 'grt_trial_3', subject_type: 'group', subject_name: '客服业务组', subject_status: 'active', level: 'visible', source: 'owner', created_at: '2026-11-15T01:00:00.000Z' },
    ],
    shares: [
      { id: 'shr_trial_1', env_kind: 'preview', branch: 'feat/order', url: 'https://ai-cs-feat-order.deploy.internal', created_by: '林小满', created_at: '2026-11-19T07:00:00.000Z', status: 'active', revoked_at: null },
    ],
    db: { engine: 'postgresql', state: 'running', host: 'postgres-trial.internal:5432', database: 'app_ai_cs', password_hint: 'reset_only' },
  },
  {
    id: 'prj_trial_report',
    name: '报销助手',
    slug: 'expense-bot',
    status: 'active',
    owner: userZhou,
    relation: 'granted',
    relation_label: '来自：周敏',
    preview: { slot: 'recent', total: 0, limit: 3, items: [] },
    production: { state: 'not_created', url: null, sha: null, version_label: null, updated_at: null },
    quota: { used_bytes: 314572800, limit_bytes: 4294967296, ratio: 0.07, warning: false },
    updated_at: '2026-11-19T09:00:00.000Z',
    created_at: '2026-11-17T02:00:00.000Z',
    spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4294967296, preview_limit: 3 },
    grant_summary: { people: 2, groups: 0, limit_people: 50, limit_groups: 10 },
    gate: { paused: false, reason: null, paused_since: null, resume_mechanism: 'T-08_undefined' },
    main: { sha: 'c4d5e6f708192a3b4c5d6e7f80912a3b4c5d6e7f', committed_at: '2026-11-19T08:40:00.000Z', author: '周敏', version_labels: [] },
    environments: [
      envProduction('env_trial_report_prod', 'prj_trial_report', 'expense-bot', 'not_created'),
    ],
    deployments: [],
    backups: [
      { id: 'bkp_trial_report_1', kind: 'auto', created_at: '2026-11-20T02:00:00.000Z', scope: '报销助手 · 全部环境（含预览）', result: 'success', expires_at: '2026-12-20T02:00:00.000Z', attempts: 1, max_attempts: 3, note: '每日全量备份' },
    ],
    files: [],
    logs: [
      { seq: 1, at: '2026-11-19T08:40:00.000Z', level: 'info', text: '项目创建完成：仓库、规范、4 个 Skill 已注入' },
    ],
    grants: [
      { id: 'grt_trial_report_1', subject_type: 'user', subject_name: '林小满', subject_status: 'active', level: 'visible', source: 'owner', created_at: '2026-11-17T03:00:00.000Z' },
    ],
    shares: [],
    db: { engine: 'none', state: 'not_created', host: null, database: null, password_hint: 'reset_only' },
  },
  {
    id: 'prj_trial_kb',
    name: '知识库检索',
    slug: 'kb-search',
    status: 'active',
    owner: userChen,
    relation: 'group',
    relation_label: '来自：项目组 平台研发组',
    preview: { slot: 'recent', total: 3, limit: 3, items: [] },
    production: { state: 'running', url: 'https://kb-search.deploy.internal', sha: '8e7d6c5b4a39281706f5', version_label: 'v0.9.1', updated_at: '2026-11-19T15:20:00.000Z' },
    quota: { used_bytes: 3521873183, limit_bytes: 4294967296, ratio: 0.82, warning: true },
    updated_at: '2026-11-19T15:20:00.000Z',
    created_at: '2026-10-28T02:00:00.000Z',
    spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4294967296, preview_limit: 3 },
    grant_summary: { people: 0, groups: 1, limit_people: 50, limit_groups: 10 },
    gate: { paused: true, reason: 'daily_backup_failed', paused_since: '2026-11-20T02:40:00.000Z', resume_mechanism: 'T-08_undefined' },
    main: { sha: '8e7d6c5b4a39281706f5e4d3c2b1a09876f5e4d3', committed_at: '2026-11-19T14:00:00.000Z', author: '陈可', version_labels: ['v0.9.1', 'v0.9.0'] },
    environments: [
      envPreview('env_trial_kb_rag', 'prj_trial_kb', 'feat/rag', 'kb-search-feat-rag', 'running', { updated_at: '2026-11-19T15:00:00.000Z' }),
      envPreview('env_trial_kb_gone', 'prj_trial_kb', 'feat/old-ui', 'kb-search-feat-old-ui', 'sleeping', { branch_deleted: true, updated_at: '2026-11-10T02:00:00.000Z' }),
      envPreview('env_trial_kb_stuck', 'prj_trial_kb', 'feat/vector', 'kb-search-feat-vector', 'sleeping', { residual: true, updated_at: '2026-11-02T02:00:00.000Z' }),
      envProduction('env_trial_kb_prod', 'prj_trial_kb', 'kb-search', 'running', {
        current: { version_label: 'v0.9.1', sha: '8e7d6c5b4a39281706f5', built_at: '2026-11-19T15:18:00.000Z' },
        updated_at: '2026-11-19T15:20:00.000Z',
      }),
    ],
    deployments: [
      { id: 'dep_trial_kb_1', version_label: 'v0.9.1', sha: '8e7d6c5b4a39281706f5', built_at: '2026-11-19T15:18:00.000Z', result: 'success', operator: '陈可', probe_level: 'healthz', backup_id: null, rollbackable: true, missing_reason: null, env_kind: 'production', branch: null },
      { id: 'dep_trial_kb_2', version_label: 'v0.9.0', sha: '2b3c4d5e6f708192a3b4', built_at: '2026-11-12T06:00:00.000Z', result: 'success', operator: '陈可', probe_level: 'root', backup_id: null, rollbackable: true, missing_reason: null, env_kind: 'production', branch: null },
    ],
    backups: [
      { id: 'bkp_trial_kb_fail', kind: 'auto', created_at: '2026-11-20T02:00:00.000Z', scope: '知识库检索 · 全部环境（含预览）', result: 'failed', expires_at: '2026-12-20T02:00:00.000Z', attempts: 4, max_attempts: 3, note: '每日全量备份：任务内自动重试 3 次仍失败，计 1 次失败并暂停新发布' },
    ],
    files: [
      { name: 'corpus', path: '/corpus/', size_bytes: 0, modified_at: '2026-11-19T02:00:00.000Z', type: 'dir' },
      { name: 'faq.jsonl', path: '/corpus/faq.jsonl', size_bytes: 8388608, modified_at: '2026-11-19T02:00:00.000Z', type: 'file' },
    ],
    logs: [
      { seq: 1, at: '2026-11-19T15:18:00.000Z', level: 'info', text: 'index reload finished: 12,408 documents' },
      { seq: 2, at: '2026-11-19T15:19:30.000Z', level: 'warn', text: 'embedding gateway latency 2.4s' },
    ],
    grants: [
      { id: 'grt_trial_kb_1', subject_type: 'group', subject_name: '平台研发组', subject_status: 'active', level: 'visible', source: 'owner', created_at: '2026-10-28T02:10:00.000Z' },
      { id: 'grt_trial_kb_2', subject_type: 'user', subject_name: '离职同事', subject_status: 'disabled', level: 'visible', source: 'owner', created_at: '2026-10-30T02:10:00.000Z' },
    ],
    shares: [],
    db: { engine: 'postgresql', state: 'running', host: 'postgres-trial.internal:5432', database: 'app_kb', password_hint: 'reset_only' },
  },
  {
    id: 'prj_trial_legacy',
    name: '旧版工单',
    slug: 'legacy-ticket',
    status: 'soft_deleted',
    owner: userLin,
    relation: 'owner',
    preview: { slot: 'recent', total: 0, limit: 3, items: [] },
    production: { state: 'not_created', url: null, sha: null, version_label: null, updated_at: null },
    quota: { used_bytes: 0, limit_bytes: 4294967296, ratio: 0, warning: false },
    updated_at: '2026-11-10T02:00:00.000Z',
    created_at: '2026-09-01T02:00:00.000Z',
    spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4294967296, preview_limit: 3 },
    grant_summary: { people: 0, groups: 0, limit_people: 50, limit_groups: 10 },
    gate: { paused: false, reason: null, paused_since: null, resume_mechanism: 'T-08_undefined' },
    main: { sha: 'ffffffffffffffffffffffffffffffffffffffff', committed_at: '2026-11-01T02:00:00.000Z', author: '林小满', version_labels: [] },
    environments: [envProduction('env_trial_legacy_prod', 'prj_trial_legacy', 'legacy-ticket', 'not_created')],
    deployments: [],
    backups: [],
    files: [],
    logs: [],
    grants: [],
    shares: [],
    db: { engine: 'none', state: 'not_created', host: null, database: null, password_hint: 'reset_only' },
  },
]

/** Dashboard 卡片：预览槽位取「最近更新的 1 个」，多预览只给 total */
export function cardOf(p: MockProject) {
  const previews = p.environments.filter((e) => e.kind === 'preview' && e.state !== 'not_created')
  const recent = previews.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]
  const prod = p.environments.find((e) => e.kind === 'production')
  return {
    ...p,
    preview: {
      slot: 'recent' as const,
      total: previews.length,
      limit: p.spec.preview_limit,
      items: recent
        ? [
            {
              id: recent.id,
              branch: recent.branch ?? '',
              url: recent.url,
              display_state: recent.display_state,
              last_access_at: recent.last_access_at,
              branch_deleted: recent.branch_deleted ?? false,
              residual: recent.residual ?? false,
              updated_at: recent.updated_at,
            },
          ]
        : [],
    },
    production: {
      state: (prod?.state ?? 'not_created') as 'running' | 'sleeping' | 'not_created',
      url: prod?.state === 'not_created' ? null : prod?.url ?? null,
      sha: prod?.current.sha ?? null,
      version_label: prod?.current.version_label ?? null,
      updated_at: prod?.updated_at ?? null,
    },
  }
}

export const templates: TemplateInfo[] = [
  { id: 'tpl_static', name: '静态站', shape: 'static', version: 'v3', status: 'published', projects_used: 12, has_demo: true, files: ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/'], skills: ['查状态', '看日志', '发预览', '查部署记录'], build_preset: 'node scripts/build-static.mjs', health_preset: 'healthz', credential_scan: 'clean' },
  { id: 'tpl_api', name: '带数据库的 API', shape: 'api', version: 'v5', status: 'published', projects_used: 7, has_demo: true, files: ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/', 'migrations/'], skills: ['查状态', '看日志', '发预览', '查部署记录'], build_preset: 'npm ci && npm run build', health_preset: 'healthz', credential_scan: 'clean' },
  { id: 'tpl_fullstack', name: '全栈', shape: 'fullstack', version: 'v4', status: 'published', projects_used: 5, has_demo: true, files: ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/', 'web/', 'api/'], skills: ['查状态', '看日志', '发预览', '查部署记录'], build_preset: 'npm ci && npm run build', health_preset: 'root', credential_scan: 'clean' },
  { id: 'tpl_blank', name: '空白模板（只有规范与 Skill）', shape: 'blank', version: 'v2', status: 'published', projects_used: 3, has_demo: false, files: ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/'], skills: ['查状态', '看日志', '发预览', '查部署记录'], build_preset: '未识别 · 需用户选择', health_preset: 'tcp', credential_scan: 'clean' },
  { id: 'tpl_legacy_api', name: '旧版 API（已下线）', shape: 'api', version: 'v2', status: 'offline', projects_used: 4, has_demo: true, files: ['AGENTS.md'], skills: [], build_preset: 'npm ci && npm start', health_preset: 'healthz', credential_scan: 'clean' },
]

export const adminUsers: AdminUser[] = [
  { user_id: 'usr_trial_lin', display_name: '林小满', feishu_account: 'lin.xiaoman', role: 'user', status: 'active', operations: roleOperations.user },
  { user_id: 'usr_trial_zhou', display_name: '周敏', feishu_account: 'zhou.min', role: 'admin', status: 'active', operations: roleOperations.admin },
  { user_id: 'usr_trial_zheng', display_name: '郑巍', feishu_account: 'zheng.wei', role: 'sysadmin', status: 'active', operations: roleOperations.sysadmin },
  { user_id: 'usr_trial_chen', display_name: '陈可', feishu_account: 'chen.ke', role: 'user', status: 'active', operations: roleOperations.user },
  { user_id: 'usr_trial_leave', display_name: '离职同事', feishu_account: 'left.user', role: 'user', status: 'disabled', operations: [] },
]

export const groups: GroupInfo[] = [
  { id: 'grp_trial_kefu', name: '客服业务组', member_count: 18, project_count: 2, status: 'active', member_limit: 200 },
  { id: 'grp_trial_platform', name: '平台研发组', member_count: 42, project_count: 5, status: 'active', member_limit: 200 },
  { id: 'grp_trial_old', name: '旧项目组（已解散）', member_count: 0, project_count: 0, status: 'dissolved', member_limit: 200 },
]

export const redis: RedisInfo = {
  shared: true,
  shard: 'shard-biz-02',
  used_ratio: 0.34,
  warn_at: 32,
  reject_at: 40,
  note: '按业务组共享分片，不按项目独占；容量不足由系统管理员扩实例（单位 GB）',
}

export const settings = {
  build_concurrency: 3,
  queue_limit: 10,
  max_build_concurrency: 3,
  max_queue_limit: 10,
  /** 压测后只下调不可上调（已定规则） */
  can_raise_after_poc: false,
  backup_time: '02:00',
  backup_retention_days: 30,
  offsite_target: '异地对象存储（底座主机之外）',
  ai_log_enabled_default: false,
  file_max_upload_mb: 100,
}

export const platform: PlatformViewSeed = {
  version: '0.29.13',
  digest_locked: false,
  digest_note: 'digest 实际值待 PoC 回填（T-03），当前仅锁版本号',
  ports_public: false,
  cert_expires_days: 214,
  authz_ok: true,
  gateway_ok: true,
  gitlab_ok: true,
  dokploy_ok: true,
  host: { cpu_ratio: 0.41, memory_ratio: 0.66, disk_ratio: 0.58 },
  backups: { last_success_at: '2026-11-20T02:20:00.000Z', last_failure_at: '2026-11-20T02:40:00.000Z', last_failure_reason: '知识库检索 · 每日全量备份任务内重试 3 次仍失败' },
  sync: { last_success_at: '2026-11-20T03:10:00.000Z', last_failure_at: null, last_failure_reason: null },
  webhook: { installed: 2, failed_projects: ['旧版工单'] },
  security: [
    { key: 'dokploy_version', label: '底座版本 ≥ 0.29.13', state: 'pass', note: '0.29.13' },
    { key: 'digest', label: '镜像 digest 锁定', state: 'not_run', note: '待 PoC（T-03）' },
    { key: 'secret', label: 'BETTER_AUTH_SECRET 非默认值', state: 'pass', note: '不显示值' },
    { key: 'ports', label: '面板 / API / 3000 端口不对公网', state: 'pass', note: '仅内网 + VPN' },
    { key: 'cert', label: '内部 CA 与泛域名证书', state: 'pass', note: '剩余 214 天' },
    { key: 'license', label: '许可合规（未改 /proprietary、未启企业功能）', state: 'pass', note: 'LICENSE / NOTICE 存在' },
    { key: 'capacity', label: '容量压测（100+ 项目 / 400 环境 / 3 并发）', state: 'not_run', note: 'PoC 0/15，未执行' },
  ],
}
export interface PlatformViewSeed {
  version: string
  digest_locked: boolean
  digest_note: string
  ports_public: boolean
  cert_expires_days: number
  authz_ok: boolean
  gateway_ok: boolean
  gitlab_ok: boolean
  dokploy_ok: boolean
  host: { cpu_ratio: number; memory_ratio: number; disk_ratio: number }
  backups: { last_success_at: string | null; last_failure_at: string | null; last_failure_reason: string | null }
  sync: { last_success_at: string | null; last_failure_at: string | null; last_failure_reason: string | null }
  webhook: { installed: number; failed_projects: string[] }
  security: { key: string; label: string; state: 'pass' | 'fail' | 'not_run'; note: string }[]
}

export const abnormalPreviews: AbnormalPreview[] = [
  { id: 'env_abn_1', project_name: '旧版工单', branch: 'feat/refund', url: 'https://legacy-ticket-feat-refund.deploy.internal', state: 'sleeping', case: 'disabled_owner', last_active_at: '2026-10-02T02:00:00.000Z', size_bytes: 314572800 },
  { id: 'env_abn_2', project_name: '已删项目-促销页', branch: 'feat/promo', url: 'https://promo-feat-promo.deploy.internal', state: 'sleeping', case: 'deleted_project', last_active_at: '2026-09-18T02:00:00.000Z', size_bytes: 209715200 },
  { id: 'env_abn_3', project_name: '知识库检索', branch: 'feat/vector', url: 'https://kb-search-feat-vector.deploy.internal', state: 'sleeping', case: 'undeletable', last_active_at: '2026-11-02T02:00:00.000Z', size_bytes: 524288000 },
]

export interface AuditSeed {
  items: AuditRow[]
}
export const audit: AuditRow[] = [
  { id: 'aud_1', at: '2026-11-20T06:30:00.000Z', actor: '林小满', action: 'deploy.publish', object: '智能客服 / v1.2.0 / 3f2a9c1', result: 'success', source_ip: '10.12.***.24', before: 'v1.1.0', after: 'v1.2.0' },
  { id: 'aud_2', at: '2026-11-20T06:20:00.000Z', actor: '林小满', action: 'backup.pre_publish', object: '智能客服 / bkp_trial_pre_1', result: 'success', source_ip: '10.12.***.24' },
  { id: 'aud_3', at: '2026-11-20T02:40:00.000Z', actor: 'system', action: 'gate.pause', object: '知识库检索 / 每日全量备份失败', result: 'success', source_ip: '—' },
  { id: 'aud_4', at: '2026-11-19T07:00:00.000Z', actor: '林小满', action: 'share.create', object: '智能客服 / feat/order', result: 'success', source_ip: '10.12.***.24' },
  { id: 'aud_5', at: '2026-11-18T03:20:00.000Z', actor: '周敏', action: 'grant.create', object: '报销助手 / 林小满', result: 'success', source_ip: '10.12.***.31' },
  { id: 'aud_6', at: '2026-11-17T09:10:00.000Z', actor: '林小满', action: 'deploy.publish', object: '智能客服 / v1.1.0 / 7b2c8d4', result: 'success', source_ip: '10.12.***.24', before: 'v1.0.1', after: 'v1.1.0' },
  { id: 'aud_7', at: '2026-11-16T08:00:00.000Z', actor: '郑巍', action: 'cleanup.abnormal_preview', object: '旧版工单 / feat/refund', result: 'failed', source_ip: '10.12.***.7' },
  { id: 'aud_8', at: '2026-11-15T02:10:00.000Z', actor: '林小满', action: 'grant.create', object: '智能客服 / 客服业务组', result: 'success', source_ip: '10.12.***.24' },
  { id: 'aud_9', at: '2026-11-14T06:20:00.000Z', actor: '林小满', action: 'grant.create', object: '智能客服 / 陈可', result: 'success', source_ip: '10.12.***.24' },
  { id: 'aud_10', at: '2026-11-10T02:00:00.000Z', actor: '林小满', action: 'project.soft_delete', object: '旧版工单', result: 'success', source_ip: '10.12.***.24' },
]

export const alerts: AlertRow[] = [
  { id: 'alt_1', level: 'warning', object: '知识库检索 / 每日全量备份', at: '2026-11-20T02:40:00.000Z', handled: false, text: '每日全量备份任务内重试 3 次仍失败，计 1 次失败并暂停新发布；已运行环境继续服务。' },
  { id: 'alt_2', level: 'warning', object: '平台 / 共享 Redis shard-biz-02', at: '2026-11-19T22:10:00.000Z', handled: false, text: '共享 Redis 分片使用率 34GB，超过 32GB 告警阈值，未到 40GB 拒绝阈值。' },
]

export const roleModel: RoleModel = {
  "version": "v1",
  "updated_at": "2026-11-12T02:00:00.000Z",
  "roles": [
    {
      "role": "user",
      "label": "普通用户",
      "modules": [
        {
          "module": "项目",
          "ops": [
            {
              "code": "project:create",
              "label": "创建项目",
              "enabled": true
            },
            {
              "code": "project:read",
              "label": "查看项目/环境/用量",
              "enabled": true
            }
          ]
        },
        {
          "module": "发布与环境",
          "ops": [
            {
              "code": "deploy:create",
              "label": "发起正式发布",
              "enabled": true
            },
            {
              "code": "preview:create",
              "label": "创建预览",
              "enabled": true
            },
            {
              "code": "preview:delete",
              "label": "删除预览",
              "enabled": true
            }
          ]
        },
        {
          "module": "文件与日志",
          "ops": [
            {
              "code": "file:read",
              "label": "文件浏览 / 下载",
              "enabled": true
            },
            {
              "code": "log:read",
              "label": "查看日志",
              "enabled": true
            }
          ]
        },
        {
          "module": "协作",
          "ops": [
            {
              "code": "share:create",
              "label": "生成 / 撤销分享",
              "enabled": true
            },
            {
              "code": "mcp:manage",
              "label": "管理自己的 MCP Key",
              "enabled": true
            }
          ]
        }
      ]
    },
    {
      "role": "admin",
      "label": "管理员",
      "modules": [
        {
          "module": "项目",
          "ops": [
            {
              "code": "project:create",
              "label": "创建项目",
              "enabled": true
            },
            {
              "code": "project:read",
              "label": "查看项目/环境/用量",
              "enabled": true
            }
          ]
        },
        {
          "module": "发布与环境",
          "ops": [
            {
              "code": "deploy:create",
              "label": "发起正式发布",
              "enabled": true
            },
            {
              "code": "preview:create",
              "label": "创建预览",
              "enabled": true
            },
            {
              "code": "preview:delete",
              "label": "删除预览",
              "enabled": true
            }
          ]
        },
        {
          "module": "文件与日志",
          "ops": [
            {
              "code": "file:read",
              "label": "文件浏览 / 下载",
              "enabled": true
            },
            {
              "code": "log:read",
              "label": "查看日志",
              "enabled": true
            }
          ]
        },
        {
          "module": "协作",
          "ops": [
            {
              "code": "share:create",
              "label": "生成 / 撤销分享",
              "enabled": true
            },
            {
              "code": "mcp:manage",
              "label": "管理自己的 MCP Key",
              "enabled": true
            }
          ]
        },
        {
          "module": "人员与权限",
          "ops": [
            {
              "code": "admin:people",
              "label": "分配人员操作权限",
              "enabled": true
            },
            {
              "code": "admin:group",
              "label": "管理项目组",
              "enabled": true
            },
            {
              "code": "admin:platform",
              "label": "查看平台视图 / 告警",
              "enabled": true
            }
          ]
        },
        {
          "module": "审计",
          "ops": [
            {
              "code": "admin:audit",
              "label": "查看 / 导出审计",
              "enabled": true
            }
          ]
        },
        {
          "module": "系统参数",
          "ops": [
            {
              "code": "admin:settings:read",
              "label": "查看系统参数",
              "enabled": true
            },
            {
              "code": "admin:param:concurrency",
              "label": "调整并发构建数（唯一例外）",
              "enabled": true
            },
            {
              "code": "admin:param:queue",
              "label": "调整排队上限（唯一例外）",
              "enabled": true
            }
          ]
        }
      ]
    },
    {
      "role": "sysadmin",
      "label": "系统管理员",
      "modules": [
        {
          "module": "项目",
          "ops": [
            {
              "code": "project:read",
              "label": "查看项目/环境/用量",
              "enabled": true
            },
            {
              "code": "project:spec",
              "label": "项目资源规格（仅系统管理员）",
              "enabled": true
            }
          ]
        },
        {
          "module": "文件与日志",
          "ops": [
            {
              "code": "file:read",
              "label": "文件浏览 / 下载",
              "enabled": true
            },
            {
              "code": "log:read",
              "label": "查看日志",
              "enabled": true
            }
          ]
        },
        {
          "module": "审计",
          "ops": [
            {
              "code": "admin:audit",
              "label": "查看 / 导出审计",
              "enabled": true
            }
          ]
        },
        {
          "module": "系统参数",
          "ops": [
            {
              "code": "admin:settings:read",
              "label": "查看系统参数",
              "enabled": true
            }
          ]
        },
        {
          "module": "系统管理",
          "ops": [
            {
              "code": "sys:setting",
              "label": "系统设置",
              "enabled": true
            },
            {
              "code": "sys:cleanup",
              "label": "清理异常预览",
              "enabled": true
            },
            {
              "code": "sys:restore",
              "label": "恢复",
              "enabled": true
            },
            {
              "code": "sys:role",
              "label": "定义角色权限模型",
              "enabled": true
            },
            {
              "code": "sys:template",
              "label": "维护模板库",
              "enabled": true
            },
            {
              "code": "system:backup",
              "label": "备份 / 恢复任务",
              "enabled": true
            },
            {
              "code": "system:resource",
              "label": "全局资源 / 数据卷清理",
              "enabled": true
            }
          ]
        }
      ]
    }
  ]
} as RoleModel

export const mcpKey = reactiveKey()
function reactiveKey() {
  return { created_at: '2026-11-12T02:00:00.000Z', fingerprint: 'mcp_7f3a****', status: 'active' as 'active' | 'revoked', last_used_at: '2026-11-20T08:10:00.000Z' }
}

/** 运行期可变状态（单次会话内有效） */
export const state = {
  paused: { kb: true, reason: 'daily_backup_failed' as const, since: '2026-11-20T02:40:00.000Z' },
  tasks: new Map<string, import('../types').Task>(),
  idempotent: new Map<string, unknown>(),
  cleanupReports: [] as { at: string; operator: string; rows: { id: string; result: string }[] }[],
}
