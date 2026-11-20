import { describe, expect, it } from 'vitest'
import { adjustParamVerdict, can, denyReason, editableSystemParameter, projectWriteEntry, roleOperations, visibleNav, ADMIN_PARAM_EXCEPTIONS } from '@/domain/permissions'
import { COPY } from '@/domain/text'

describe('系统参数边界（GAP-01 / GAP-04）', () => {
  it('管理员只能调并发与队列两项', () => {
    expect(editableSystemParameter('admin', 'build_concurrency')).toBe(true)
    expect(editableSystemParameter('admin', 'queue_limit')).toBe(true)
    expect(editableSystemParameter('admin', 'backup_time')).toBe(false)
    expect(editableSystemParameter('admin', 'project_spec')).toBe(false)
    expect(ADMIN_PARAM_EXCEPTIONS).toEqual(['build_concurrency', 'queue_limit'])
  })

  it('项目规格只有系统管理员可调，普通用户与管理员都被拒', () => {
    expect(editableSystemParameter('sysadmin', 'project_spec')).toBe(true)
    expect(adjustParamVerdict('admin', 'project_spec', 4, 4, 8).ok).toBe(false)
    expect(adjustParamVerdict('user', 'build_concurrency', 2, 3, 3).ok).toBe(false)
  })

  it('压测后只可下调不可上调', () => {
    expect(adjustParamVerdict('admin', 'build_concurrency', 3, 3, 3).ok).toBe(true)
    expect(adjustParamVerdict('admin', 'build_concurrency', 2, 3, 3).ok).toBe(true)
    const up = adjustParamVerdict('admin', 'build_concurrency', 3, 2, 3)
    expect(up.ok).toBe(false)
    expect(up.errorCode).toBe('system.param_raise_forbidden')
    expect(adjustParamVerdict('admin', 'build_concurrency', 4, 3, 3).errorCode).toBe('system.param_out_of_range')
  })

  it('非整数或超范围被拒', () => {
    expect(adjustParamVerdict('admin', 'queue_limit', 0, 10, 10).errorCode).toBe('system.param_out_of_range')
    expect(adjustParamVerdict('admin', 'queue_limit', 11, 10, 10).errorCode).toBe('system.param_out_of_range')
  })
})

describe('角色与数据关系分离', () => {
  it('只有三类应用角色，拥有者/被授权人/项目组不是角色', () => {
    expect(roleOperations('user')).not.toContain('sys:setting')
    expect(roleOperations('admin')).toContain('admin:param:queue')
    expect(roleOperations('sysadmin')).toContain('project:spec')
    expect(roleOperations('sysadmin')).not.toContain('admin:param:queue')
  })

  it('置灰必须给出缺什么（不能只写无权限）', () => {
    expect(denyReason('project:spec')).toBe(COPY.specSysadminOnly)
    expect(denyReason('sys:setting').length).toBeGreaterThan(10)
  })

  it('被授权人本身不提升写操作能力', () => {
    expect(projectWriteEntry('granted', 'deploy:create', []).visible).toBe(false)
    expect(projectWriteEntry('granted', 'deploy:create', ['deploy:create']).visible).toBe(true)
    expect(projectWriteEntry('none', 'project:read', []).visible).toBe(false)
  })

  it('无权限的菜单项不渲染', () => {
    const userNav = visibleNav('user', roleOperations('user')).map((n) => n.key)
    expect(userNav).not.toContain('sys-settings')
    expect(userNav).not.toContain('admin-people')
    const sysNav = visibleNav('sysadmin', roleOperations('sysadmin')).map((n) => n.key)
    expect(sysNav).toContain('sys-settings')
    expect(can('user', 'sys:cleanup')).toBe(false)
  })
})
