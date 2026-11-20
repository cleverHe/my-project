import { describe, expect, it } from 'vitest'
import { abnormalPreviews } from '@/api/mock/db'
import { applyDeploySuccess, dispatch } from '@/api/mock/handlers'
import { explainError, formatError } from '@/domain/errors'
import { formatBytes, formatDateTime, formatRelative, previewDomain, shortSha } from '@/domain/format'
import { quotaLevel, quotaMessage, usageStaleNotice } from '@/domain/quota'
import { arm, assertNoNormalPreview, caseLabel, confirm, initConfirm, isSelectable, selectableRows, summarize } from '@/flows/cleanupFlow'

describe('GAP-05 异常预览清理', () => {
  it('只有三种情形可选，正常预览不在范围', () => {
    expect(selectableRows(abnormalPreviews)).toHaveLength(3)
    expect(isSelectable({ case: 'normal' as never })).toBe(false)
    expect(assertNoNormalPreview(abnormalPreviews).ok).toBe(true)
    expect(caseLabel('deleted_project')).toBe('项目已删除')
  })

  it('两次确认：先范围，再原因；空选与越界都被拦住', () => {
    let s = initConfirm()
    expect(arm(s, abnormalPreviews).error).toContain('至少勾选')
    s = arm({ ...s, selected: ['env_abn_1'] }, abnormalPreviews)
    expect(s.stage).toBe('armed')
    expect(confirm({ ...s, reason: '' }).error).toContain('清理原因')
    const final = confirm({ ...s, reason: '账号停用后清理' })
    expect(final.stage).toBe('submitting')
    expect(final.canSubmit).toBe(true)
  })

  it('混入正常预览时拒绝提交', () => {
    const mixed = [...abnormalPreviews, { ...abnormalPreviews[0]!, id: 'env_normal', case: 'normal' as never }]
    const s = arm({ ...initConfirm(), selected: ['env_normal'] }, mixed)
    expect(s.stage).toBe('idle')
    expect(s.error).toContain('正常预览')
  })

  it('逐条汇总成功/残留', () => {
    const sum = summarize([{ result: 'deleted' }, { result: 'still_residual' }])
    expect(sum.text).toContain('成功 1 条，残留 1 条')
    expect(sum.nextStep).toContain('名额')
  })
})

describe('Mock 契约与错误口径', () => {
  const auth = { csrfToken: 't', userId: 'usr_trial_lin' }

  it('未登录返回 401，不返回业务数据', () => {
    const r = dispatch({ method: 'GET', path: '/projects', auth: { csrfToken: null, userId: null }, traceId: 'trc_t' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.errorCode).toBe('auth.session_expired')
  })

  it('权限系统不可用时写操作 fail-closed', () => {
    const r = dispatch({ method: 'POST', path: '/projects/prj_trial_ai_cs/shares', body: { env_kind: 'preview', branch: 'feat/order' }, scenario: 'authz_down', auth, traceId: 'trc_t' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(503)
  })

  it('预览名额满时拒绝，并明确不自动淘汰', () => {
    const r = dispatch({ method: 'POST', path: '/projects/prj_trial_kb/environments', body: { kind: 'preview', branch: 'feat/new' }, auth, traceId: 'trc_t' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('未释放名额')
  })

  it('暂停项目拒绝新发布', () => {
    const r = dispatch({ method: 'POST', path: '/environments/env_trial_kb_prod:deploy', body: { version_label: 'v9.9.9' }, auth, traceId: 'trc_t' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.errorCode).toBe('deploy.backup_paused')
  })

  it('没有权限调整系统参数返回 403 并指出正确路径', () => {
    const r = dispatch({ method: 'PATCH', path: '/admin/settings', body: { key: 'backup_time', value: 1 }, auth, traceId: 'trc_t' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.errorCode).toBe('authz.forbidden')
  })

  it('错误渲染固定三段并带 errorCode/traceId', () => {
    const view = formatError(explainError({ errorCode: 'deploy.backup_paused', message: '', nextStep: '', traceId: 'trc_x' }))
    expect(view.head).toContain('发生了什么')
    expect(view.lines.join('|')).toContain('影响')
    expect(view.lines.join('|')).toContain('下一步')
    expect(view.lines.join('|')).toContain('trc_x')
    const unknown = explainError({ errorCode: 'weird.code', message: 'x', nextStep: 'y', traceId: 'trc_y' })
    expect(unknown.what).toBe('x')
    expect(unknown.nextStep).toBe('y')
  })

  it('applyDeploySuccess 只写部署记录，不删除预览（GAP-03）', () => {
    const before = dispatch({ method: 'GET', path: '/projects/prj_trial_ai_cs/environments', auth, traceId: 'trc_t' })
    const previewCountBefore = before.ok ? (before.data as { items: unknown[] }).items.filter((e) => (e as { kind: string }).kind === 'preview').length : 0
    applyDeploySuccess({ id: 't', type: 'deploy.production', status: 'running', phase: 'done', attempt: 1, max_attempts: 1, steps: [], sha: 'f'.repeat(40), version_label: 'v1.3.0', created_at: '', finished_at: '', _project: 'prj_trial_ai_cs', _kind: 'production' } as never)
    const after = dispatch({ method: 'GET', path: '/projects/prj_trial_ai_cs/environments', auth, traceId: 'trc_t' })
    const previewCountAfter = after.ok ? (after.data as { items: unknown[] }).items.filter((e) => (e as { kind: string }).kind === 'preview').length : 0
    expect(previewCountAfter).toBe(previewCountBefore)
    expect(previewCountAfter).toBe(2)
  })
})

describe('格式化与阈值', () => {
  it('字节/时间/SHA', () => {
    expect(formatBytes(4 * 1024 ** 3)).toBe('4 GB')
    expect(formatBytes(0)).toBe('0 B')
    expect(shortSha('3f2a9c1be7d94c20a5f1')).toBe('3f2a9c1')
    expect(shortSha(null)).toBe('—')
    expect(formatDateTime('2026-11-20T01:00:00.000Z')).toContain('2026')
    expect(formatRelative('2026-11-20T08:50:00.000Z', new Date('2026-11-20T09:20:00.000Z'))).toBe('30 分钟前')
  })

  it('预览域名裁剪到 63 字符内且稳定', () => {
    const long = previewDomain('a-very-long-project-slug', 'feature/'.padEnd(80, 'x'))
    expect(long.length).toBeLessThanOrEqual(63)
    expect(previewDomain('ai-cs', 'feat/order')).toBe('ai-cs-feat-order')
  })

  it('配额阈值 80% 告警、100% 阻断，并给出谁能处理', () => {
    expect(quotaLevel(0.5)).toBe('normal')
    expect(quotaLevel(0.82)).toBe('warn')
    expect(quotaLevel(1)).toBe('blocked')
    expect(quotaMessage(0.9, 'user').action).toContain('系统管理员')
    expect(quotaMessage(0.9, 'sysadmin').action).toContain('系统设置')
    expect(usageStaleNotice('2026-11-20 09:15', true)).toContain('可能滞后')
  })
})
