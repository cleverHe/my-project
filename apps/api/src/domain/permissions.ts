/**
 * 权限模型（服务端是唯一权威；前端渲染只是提示）
 * - 三类应用角色：user / admin / sysadmin（角色，不是研发岗位）
 * - 拥有者 / 被授权人 / 项目组是数据关系，不提升写能力
 * - GAP-01：项目资源规格只有系统管理员可调
 * - GAP-04：管理员只能调构建并发与队列上限，且压测结论内只可下调
 */
export type Role = 'user' | 'admin' | 'sysadmin'

export const ADMIN_PARAM_EXCEPTIONS = ['build_concurrency', 'deploy_queue_limit'] as const
export type AdminParam = (typeof ADMIN_PARAM_EXCEPTIONS)[number]

export const ROLE_OPS: Record<Role, string[]> = {
  user: ['project:create', 'project:read', 'deploy:create', 'preview:create', 'preview:delete', 'file:read', 'log:read', 'share:create', 'mcp:manage'],
  admin: [
    'project:create',
    'project:read',
    'deploy:create',
    'preview:create',
    'preview:delete',
    'file:read',
    'log:read',
    'share:create',
    'mcp:manage',
    'admin:people',
    'admin:settings:read',
    'admin:group',
    'admin:platform',
    'admin:audit',
    'admin:param:concurrency',
    'admin:param:queue',
  ],
  sysadmin: ['sys:setting', 'sys:cleanup', 'sys:restore', 'sys:role', 'sys:template', 'admin:audit', 'admin:settings:read', 'project:read', 'project:spec', 'system:backup', 'system:resource'],
}

export const ROLE_OPS_REQUIRED: Record<string, string> = {
  'sys:setting': '系统设置只有系统管理员可用。',
  'sys:cleanup': '异常预览清理只有系统管理员可用。',
  'sys:restore': '恢复只有系统管理员可用。',
  'admin:param:concurrency': '构建并发只有管理员（系统管理员之外的最高级应用角色）可调。',
  'project:spec': '项目资源规格只有系统管理员可调。',
}

/** 操作 → 需要的角色操作位；不在表内的写操作按项目数据关系 + 权限系统判定 */
/** 需要系统级权限的端点（正则；按顺序匹配） */
const OP_RULES: { method: string; re: RegExp; op: string }[] = [
  { method: 'GET', re: /^\/admin\/users$/, op: 'admin:people' },
  { method: 'PATCH', re: /^\/admin\/users\/[^/]+$/, op: 'admin:people' },
  { method: 'GET', re: /^\/admin\/groups$/, op: 'admin:group' },
  { method: 'POST', re: /^\/admin\/groups\/[^/]+\/dissolve$/, op: 'admin:group' },
  { method: 'GET', re: /^\/admin\/platform$/, op: 'admin:platform' },
  { method: 'GET', re: /^\/admin\/audit(\/export)?$/, op: 'admin:audit' },
  { method: 'POST', re: /^\/admin\/audit\/export$/, op: 'admin:audit' },
  { method: 'GET', re: /^\/admin\/alerts$/, op: 'admin:platform' },
  { method: 'PATCH', re: /^\/admin\/settings$/, op: 'admin:param:queue' },
  { method: 'PATCH', re: /^\/admin\/settings\/(build_concurrency|deploy_queue_limit)$/, op: 'admin:param:queue' },
  { method: 'GET', re: /^\/admin\/settings$/, op: 'admin:settings:read' },
  // 发布/回滚只由「发布者」角色做：系统管理员不代发（api-spec §7.2 / §7.5）
  { method: 'POST', re: /^\/environments\/[^/]+(?::|\/)deploy$/, op: 'deploy:create' },
  { method: 'POST', re: /^\/environments\/[^/]+(?::|\/)rollback$/, op: 'deploy:create' },
  { method: 'GET', re: /^\/admin\/backups$/, op: 'system:backup' },
  { method: 'POST', re: /^\/admin\/backups:run$/, op: 'system:backup' },
  { method: 'GET', re: /^\/admin\/previews\/cleanup-candidates$/, op: 'system:resource' },
  { method: 'POST', re: /^\/admin\/previews:cleanup$/, op: 'system:resource' },
  { method: 'GET', re: /^\/mcp-keys$/, op: 'mcp:manage' },
  { method: 'POST', re: /^\/mcp-keys$/, op: 'mcp:manage' },
  { method: 'DELETE', re: /^\/mcp-keys\/[^/]+$/, op: 'mcp:manage' },
  { method: 'GET', re: /^\/mcp\/v1\/capabilities$/, op: 'mcp:manage' },
  { method: 'GET', re: /^\/sys\/settings$/, op: 'sys:setting' },
  { method: 'PATCH', re: /^\/sys\/settings$/, op: 'sys:setting' },
  { method: 'GET', re: /^\/sys\/roles$/, op: 'sys:role' },
  { method: 'PUT', re: /^\/sys\/roles$/, op: 'sys:role' },
  { method: 'GET', re: /^\/sys\/templates$/, op: 'sys:template' },
  // api-spec 规范路径（与 /sys/* 分权：模板库对所有登录用户只读，管理动作仍限系统管理员）
  { method: 'GET', re: /^\/templates$/, op: 'project:read' },
  { method: 'GET', re: /^\/templates\/[^/]+\/versions$/, op: 'project:read' },
  { method: 'POST', re: /^\/admin\/templates(\/[^/]+\/(versions|deprecate))?$/, op: 'sys:template' },
  { method: 'GET', re: /^\/environments\/[^/]+\/logs(\/tail)?$/, op: 'log:read' },
  { method: 'GET', re: /^\/files(\/(stat|download))?$/, op: 'file:read' },
  { method: 'POST', re: /^\/admin\/restores$/, op: 'system:backup' },
  { method: 'POST', re: /^\/sys\/templates\/[^/]+\/(publish|offline)$/, op: 'sys:template' },
  { method: 'GET', re: /^\/sys\/previews\/abnormal$/, op: 'sys:cleanup' },
  { method: 'POST', re: /^\/sys\/previews\/cleanup$/, op: 'sys:cleanup' },
  { method: 'POST', re: /^\/sys\/restore$/, op: 'sys:restore' },
  { method: 'GET', re: /^\/sys\/backup-status$/, op: 'sys:setting' },
]

export function hasOp(role: Role, op: string): boolean {
  return ROLE_OPS[role].includes(op)
}

/** 返回该请求要求的权限位；null 表示按项目数据关系 + 权限系统判定 */
export function requiresOp(method: string, path: string): string | null {
  const p = path.split('?')[0] ?? ''
  for (const rule of OP_RULES) {
    if (rule.method === method && rule.re.test(p)) return rule.op
  }
  return null
}

/** 调整系统参数的判定（GAP-01 / GAP-04） */
export interface ParamVerdict {
  ok: boolean
  errorCode?: 'admin.param_forbidden' | 'admin.param_raise_forbidden' | 'admin.param_out_of_range'
  reason?: string
}

export function adjustParamVerdict(role: Role, key: string, next: number, current: number, max: number, sysadminOnly = false): ParamVerdict {
  // 判定顺序：取值越界 → 上调（压测后只可下调）→ 角色/可调范围
  if (!Number.isInteger(next) || next < 1 || next > max) {
    return { ok: false, errorCode: 'admin.param_out_of_range', reason: `填写 1–${max} 之间的整数。` }
  }
  if (next > current) {
    return { ok: false, errorCode: 'admin.param_raise_forbidden', reason: '按既定规则，压测后只可下调、不可上调。' }
  }
  if (sysadminOnly && role !== 'sysadmin') {
    return { ok: false, errorCode: 'admin.param_forbidden', reason: '该参数只有系统管理员可调。' }
  }
  if (!sysadminOnly) {
    if (role !== 'admin' && role !== 'sysadmin') {
      return { ok: false, errorCode: 'admin.param_forbidden', reason: '该参数只有管理员可调。' }
    }
    if (!(ADMIN_PARAM_EXCEPTIONS as readonly string[]).includes(key)) {
      return { ok: false, errorCode: 'admin.param_forbidden', reason: '管理员只能调构建并发与队列上限。' }
    }
  }
  return { ok: true }
}

/** 权限缓存：撤销后最迟 30 秒生效，这里给出 TTL 常量（缓存实现由 authz 层负责） */
export const PERMISSION_CACHE_TTL_MS = 30_000
