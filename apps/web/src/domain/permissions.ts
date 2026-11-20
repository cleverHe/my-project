/**
 * 前端权限与可见性（domain 层，纯函数）。
 *
 * 硬规则（PRD G-02 / technical-review §8.1）：前端只决定「渲染什么、置灰什么、给什么原因」，
 * 服务端是唯一校验权威。任何函数名都不得被当成安全边界。
 */
import type { ProjectRelation, Role } from '@/api/types'
import { COPY } from './text'

export type OpCode =
  | 'project:create'
  | 'project:read'
  | 'project:spec'
  | 'env:create'
  | 'env:delete'
  | 'deploy:create'
  | 'deploy:rollback'
  | 'grant:manage'
  | 'share:manage'
  | 'file:read'
  | 'log:read'
  | 'log:ai'
  | 'mcp:key'
  | 'admin:user'
  | 'admin:group'
  | 'admin:project:transfer'
  | 'admin:project:restore'
  | 'admin:platform'
  | 'admin:param:concurrency'
  | 'admin:param:queue'
  | 'audit:read'
  | 'sys:role'
  | 'sys:template'
  | 'sys:setting'
  | 'sys:cleanup'
  | 'sys:backup'
  | 'sys:restore'

/** 角色默认操作集（系统管理员定义的模型可再分配；这里是默认展示口径） */
const ROLE_OPS: Record<Role, OpCode[]> = {
  user: ['project:read', 'project:create', 'env:create', 'env:delete', 'deploy:create', 'deploy:rollback', 'grant:manage', 'share:manage', 'file:read', 'log:read', 'log:ai', 'mcp:key'],
  admin: ['project:read', 'admin:user', 'admin:group', 'admin:platform', 'admin:param:concurrency', 'admin:param:queue', 'admin:project:transfer', 'admin:project:restore', 'grant:manage', 'share:manage', 'audit:read'],
  sysadmin: ['project:read', 'sys:role', 'sys:template', 'sys:setting', 'sys:cleanup', 'project:spec', 'sys:backup', 'sys:restore', 'audit:read'],
}

/** 只有这两项是管理员的系统参数例外（GAP-04） */
export const ADMIN_PARAM_EXCEPTIONS = ['build_concurrency', 'queue_limit'] as const
export type AdminParamKey = (typeof ADMIN_PARAM_EXCEPTIONS)[number]

export function roleOperations(role: Role): OpCode[] {
  return ROLE_OPS[role].slice()
}

export function can(role: Role, op: OpCode, serverOps?: string[]): boolean {
  const ops = serverOps && serverOps.length > 0 ? serverOps : ROLE_OPS[role]
  return ops.includes(op)
}

/**
 * 置灰时必须给「缺什么」（PRD G-03），不允许只写「无权限」。
 */
export function denyReason(op: OpCode): string {
  switch (op) {
    case 'project:spec':
      return COPY.specSysadminOnly
    case 'sys:setting':
    case 'sys:backup':
    case 'sys:restore':
    case 'sys:role':
    case 'sys:template':
      return '该能力仅系统管理员可用；管理员不可修改系统参数、角色模型与模板库。'
    case 'sys:cleanup':
      return '异常预览清理仅系统管理员可执行。'
    case 'admin:user':
    case 'admin:group':
    case 'admin:platform':
      return '该能力仅管理员可用（人员权限、项目组、平台视图）。'
    case 'deploy:create':
      return '发布需本人在项目内具备发布操作权限。'
    case 'deploy:rollback':
      return '回滚需本人在项目内具备回滚操作权限。'
    case 'grant:manage':
      return '授权管理仅项目拥有者或管理员可操作。'
    default:
      return '当前角色没有该操作权限，需要管理员在角色权限模型中分配。'
  }
}

/** 数据可见性：拥有者 / 被授权人 / 项目组（数据关系，不是角色） */
export function canSeeProject(role: Role, relation: ProjectRelation): boolean {
  if (role === 'sysadmin') return true
  return relation !== 'none'
}

/** 项目内写入口：拥有者默认可写；被授权人看本人操作权限；管理员代授权不算提权 */
export function projectWriteEntry(relation: ProjectRelation, op: OpCode, ops: string[]): { visible: boolean; reason?: string } {
  if (relation === 'none') return { visible: false, reason: '你对该项目没有数据权限。' }
  if (relation === 'owner') return { visible: true }
  if (ops.includes(op)) return { visible: true }
  return { visible: false, reason: denyReason(op) }
}

/** 系统参数可编辑判定（GAP-01 + GAP-04） */
export function editableSystemParameter(role: Role, key: string): boolean {
  if (role === 'sysadmin') return true
  if (role === 'admin') return (ADMIN_PARAM_EXCEPTIONS as readonly string[]).includes(key)
  return false
}

/**
 * 上调/下调规则：既有规则「压测后并发与队列只下调不可上调」。
 * `current` 为空表示尚无压测结论（试跑阶段默认只下调）。
 */
export function adjustParamVerdict(
  role: Role,
  key: string,
  next: number,
  current: number,
  max: number,
): { ok: boolean; errorCode?: string; reason?: string } {
  if (!editableSystemParameter(role, key)) {
    return { ok: false, errorCode: 'authz.forbidden', reason: '该参数仅系统管理员可调整。' }
  }
  // 越界优先报范围错（含超过压测确认的硬上限）；范围内的上调按既定规则拒绝
  if (!Number.isInteger(next) || next < 1 || next > max) {
    return { ok: false, errorCode: 'system.param_out_of_range', reason: `填写 1–${max} 之间的整数。` }
  }
  if (next > current) {
    return { ok: false, errorCode: 'system.param_raise_forbidden', reason: '按既定规则，压测后并发与队列只可下调、不可上调。' }
  }
  return { ok: true }
}

/** 侧栏：无权限的菜单项不渲染（不是灰色可点） */
export interface NavItem {
  key: string
  label: string
  to: string
  role: Role[]
  op?: OpCode
}

export const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', to: '/dashboard', role: ['user', 'admin', 'sysadmin'] },
  { key: 'wizard', label: '创建项目', to: '/wizard', role: ['user'] },
  { key: 'admin-people', label: '人员权限', to: '/admin/people', role: ['admin'], op: 'admin:user' },
  { key: 'admin-groups', label: '项目组', to: '/admin/groups', role: ['admin'], op: 'admin:group' },
  { key: 'admin-platform', label: '平台视图', to: '/admin/platform', role: ['admin'], op: 'admin:platform' },
  { key: 'admin-audit', label: '审计', to: '/admin/audit', role: ['admin', 'sysadmin'], op: 'audit:read' },
  { key: 'sys-roles', label: '角色权限模型', to: '/sys/roles', role: ['sysadmin'], op: 'sys:role' },
  { key: 'sys-templates', label: '模板库', to: '/sys/templates', role: ['sysadmin'], op: 'sys:template' },
  { key: 'sys-settings', label: '系统设置', to: '/sys/settings', role: ['sysadmin'], op: 'sys:setting' },
]

export function visibleNav(role: Role, ops?: string[]): NavItem[] {
  return NAV.filter((n) => n.role.includes(role) && (!n.op || can(role, n.op, ops)))
}
