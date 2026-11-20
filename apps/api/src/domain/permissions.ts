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
  // 系统管理员不代发（无 deploy:create），但读类默认边界是「数据权限内所有人」（api-spec §3.3）
  sysadmin: ['sys:setting', 'sys:cleanup', 'sys:restore', 'sys:role', 'sys:template', 'admin:audit', 'admin:settings:read', 'project:read', 'project:spec', 'file:read', 'log:read', 'system:backup', 'system:resource'],
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

/** 角色模型变更点：只有模型内已存在且 enabled 的操作位才可能被判定通过 */
export function hasOp(role: Role, op: string): boolean {
  return ROLE_OPS[role].includes(op)
}

/** ------------------------------------------------------------------
 * 角色权限模型（P-18）：模块 × 操作矩阵。
 * `defaultRoleMatrix()` 只给初值；可变状态与保存/回读在 `repo/store.ts`，
 * 服务端鉴权只认「模型 enabled ∩ 人员操作位」，见 store.hasOp。
 * ------------------------------------------------------------------ */
export interface RoleOpRow {
  code: string
  label: string
  enabled: boolean
}

export interface RoleModuleRow {
  module: string
  ops: RoleOpRow[]
}

export interface RoleRow {
  role: Role
  label: string
  modules: RoleModuleRow[]
}

export interface RoleMatrix {
  version: string
  updated_at: string
  roles: RoleRow[]
}

export const ROLE_LABEL: Record<Role, string> = { user: '普通用户', admin: '管理员', sysadmin: '系统管理员' }

/** 操作位 → 模块（页面矩阵的分组；不改变权限码本身） */
const MODULE_OF: Record<string, string> = {
  'project:create': '项目',
  'project:read': '项目',
  'project:update': '项目',
  'project:delete': '项目',
  'project:transfer': '项目',
  'project:spec': '项目',
  'deploy:create': '发布与环境',
  'deploy:rollback': '发布与环境',
  'preview:create': '发布与环境',
  'preview:delete': '发布与环境',
  'file:read': '文件与日志',
  'log:read': '文件与日志',
  'log:ai': '文件与日志',
  'share:create': '协作',
  'share:read': '协作',
  'grant:read': '协作',
  'grant:write': '协作',
  'mcp:manage': '协作',
  'admin:people': '人员与权限',
  'admin:group': '人员与权限',
  'admin:platform': '人员与权限',
  'admin:audit': '审计',
  'admin:settings:read': '系统参数',
  'admin:param:concurrency': '系统参数',
  'admin:param:queue': '系统参数',
  'sys:setting': '系统管理',
  'sys:cleanup': '系统管理',
  'sys:restore': '系统管理',
  'sys:role': '系统管理',
  'sys:template': '系统管理',
  'system:backup': '系统管理',
  'system:resource': '系统管理',
}

/** 操作位 → 中文标签（页面矩阵与人员权限页共用；模型外的码不出现） */
export const OP_LABEL: Record<string, string> = {
  'project:create': '创建项目',
  'project:read': '查看项目/环境/用量',
  'project:update': '改名 / 更新接入包',
  'project:delete': '软删除 / 恢复项目',
  'project:transfer': '转让拥有者',
  'project:spec': '项目资源规格（仅系统管理员）',
  'deploy:create': '发起正式发布',
  'deploy:rollback': '回滚',
  'preview:create': '创建预览',
  'preview:delete': '删除预览',
  'file:read': '文件浏览 / 下载',
  'log:read': '查看日志',
  'log:ai': 'AI 日志分析外发',
  'share:create': '生成 / 撤销分享',
  'share:read': '查看分享',
  'grant:read': '查看授权',
  'grant:write': '增加 / 撤销授权',
  'mcp:manage': '管理自己的 MCP Key',
  'admin:people': '分配人员操作权限',
  'admin:group': '管理项目组',
  'admin:platform': '查看平台视图 / 告警',
  'admin:audit': '查看 / 导出审计',
  'admin:settings:read': '查看系统参数',
  'admin:param:concurrency': '调整并发构建数（唯一例外）',
  'admin:param:queue': '调整排队上限（唯一例外）',
  'sys:setting': '系统设置',
  'sys:cleanup': '清理异常预览',
  'sys:restore': '恢复',
  'sys:role': '定义角色权限模型',
  'sys:template': '维护模板库',
  'system:backup': '备份 / 恢复任务',
  'system:resource': '全局资源 / 数据卷清理',
}

const MODULE_ORDER = ['项目', '发布与环境', '文件与日志', '协作', '人员与权限', '审计', '系统参数', '系统管理']

/** 初值矩阵：来自 ROLE_OPS；version 为模型版本号（保存后由 store 更新） */
export function defaultRoleMatrix(version = 'v1', updatedAt = '2026-11-12T02:00:00.000Z'): RoleMatrix {
  const roles = (['user', 'admin', 'sysadmin'] as Role[]).map((role) => {
    const groups = new Map<string, RoleOpRow[]>()
    for (const code of ROLE_OPS[role]) {
      const module = MODULE_OF[code] ?? '其他'
      const list = groups.get(module) ?? []
      list.push({ code, label: OP_LABEL[code] ?? code, enabled: true })
      groups.set(module, list)
    }
    const modules = [...groups.entries()]
      .sort((a, b) => MODULE_ORDER.indexOf(a[0]) - MODULE_ORDER.indexOf(b[0]))
      .map(([module, ops]) => ({ module, ops }))
    return { role, label: ROLE_LABEL[role], modules }
  })
  return { version, updated_at: updatedAt, roles }
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
