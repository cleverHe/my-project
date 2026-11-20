import { describe, expect, it } from 'vitest'
import { buildApp, trialOptionsFromEnv } from '../src/app.js'
import { ERROR_TABLE } from '../src/domain/errors.js'
import { adjustParamVerdict, ADMIN_PARAM_EXCEPTIONS, ROLE_OPS } from '../src/domain/permissions.js'
import { resetStore } from '../src/repo/store.js'

const CSRF = 'csrf_test'
const H = { 'x-trial-user': 'usr_trial_lin', 'x-csrf-token': CSRF }
const COOKIE = `trial_user=usr_trial_lin; trial_csrf=${CSRF}`

async function client(opts: Parameters<typeof buildApp>[0] = {}) {
  resetStore()
  // 测试夹具显式 opt-in 试跑能力（F-03）：默认 buildApp() 是 fail-safe 关闭，
  // 需要场景注入/任务同步推进的用例必须显式声明，不得依赖"未设置即开启"。
  const app = buildApp({ allowScenario: true, autoAdvanceTasks: true, ...opts })
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, extra: Record<string, string> = {}, user = 'usr_trial_lin') => {
    const res = await app.inject({ method, url, payload: body as never, headers: { cookie: `trial_user=${user}; trial_csrf=${CSRF}`, 'x-csrf-token': CSRF, ...extra } })
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers }
  }
  return { app, call }
}

describe('健康检查与启动契约', () => {
  it('/healthz 返回 2xx 且不含敏感字段', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/healthz')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const text = JSON.stringify(r.body).toLowerCase()
    for (const bad of ['password', 'secret', 'token', 'open_id', 'dsn']) expect(text.includes(bad)).toBe(false)
    await app.close()
  })

  it('每个响应都带 traceId 头，便于排查', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/healthz')
    expect(String(r.headers['x-trace-id'] ?? '')).toMatch(/^trc_/)
    await app.close()
  })
})

describe('会话与权限（服务端权威）', () => {
  it('未登录返回 401 auth.unauthenticated，不返回业务数据', async () => {
    const { app } = await client()
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).errorCode).toBe('auth.unauthenticated')
    await app.close()
  })

  it('写操作缺少 CSRF 令牌被拒绝', async () => {
    const { app } = await client()
    const res = await app.inject({ method: 'POST', url: '/api/v1/projects/prj_trial_ai_cs/environments', payload: { kind: 'preview', branch: 'feat/x' }, headers: { 'x-trial-user': 'usr_trial_lin' } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).errorCode).toBe('auth.csrf_invalid')
    await app.close()
  })

  it('普通用户调用系统级端点返回 403 并指明需要什么', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/api/v1/sys/settings')
    expect(r.status).toBe(403)
    expect(r.body.errorCode).toBe('authz.forbidden')
    expect(r.body.details.required).toBe('sys:setting')
    await app.close()
  })

  it('管理员不能调系统参数（只能调并发/队列）', async () => {
    const { app, call } = await client()
    const r = await call('PATCH', '/api/v1/admin/settings', { key: 'backup_time', value: '03:00' }, {}, 'usr_trial_zhou')
    expect(r.status).toBe(403)
    expect(r.body.errorCode).toBe('admin.param_forbidden')
    await app.close()
  })

  it('管理员上调并发被拒（压测结论内只可下调）', async () => {
    const { app, call } = await client()
    const up = await call('PATCH', '/api/v1/admin/settings', { key: 'build_concurrency', value: 4 }, {}, 'usr_trial_zhou')
    expect(up.status).toBe(422)
    expect(up.body.errorCode).toBe('admin.param_out_of_range')
    const ok = await call('PATCH', '/api/v1/admin/settings', { key: 'build_concurrency', value: 2 }, {}, 'usr_trial_zhou')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ key: 'build_concurrency', value: 2 })
    await app.close()
  })

  it('项目规格只有系统管理员可改（普通用户/管理员均 403）', async () => {
    const { app, call } = await client()
    for (const user of ['usr_trial_lin', 'usr_trial_zhou']) {
      const r = await call('PATCH', '/api/v1/projects/prj_trial_ai_cs/spec', { cpu: 1 }, {}, user)
      expect(r.status).toBe(403)
      expect(r.body.errorCode).toBe('authz.forbidden')
    }
    const ok = await call('PATCH', '/api/v1/projects/prj_trial_ai_cs/spec', { cpu: 1, memory_mb: 512 }, {}, 'usr_trial_zheng')
    expect(ok.status).toBe(200)
    expect(ok.body.spec.cpu).toBe(1)
    await app.close()
  })

  it('权限系统不可用时写操作 fail-closed（503），读不受影响', async () => {
    const { app, call } = await client()
    const w = await call('POST', '/api/v1/projects/prj_trial_ai_cs/shares', { env_kind: 'preview', branch: 'feat/order' }, { 'x-trial-user': 'usr_trial_lin' })
    expect(w.status).toBe(201)
    const r = await call('POST', '/api/v1/projects/prj_trial_ai_cs/shares?scenario=authz_down', { env_kind: 'preview', branch: 'feat/order' })
    expect(r.status).toBe(503)
    expect(r.body.errorCode).toBe('authz.unavailable')
    const read = await call('GET', '/api/v1/projects?scenario=authz_down')
    expect(read.status).toBe(200)
    await app.close()
  })
})

describe('发布契约（闸门 / 互斥 / 超时 / 实际 SHA）', () => {
  it('备份失败暂停后拒绝新发布，并给出解除方式而非自动恢复', async () => {
    const { app, call } = await client()
    const r = await call('POST', '/api/v1/environments/env_trial_kb_prod:deploy', { version_label: 'v9.9.9' }, { 'idempotency-key': 'idem-paused' })
    expect(r.status).toBe(423)
    expect(r.body.errorCode).toBe('deploy.backup_paused')
    expect(r.body.nextStep).toContain('T-08')
    await app.close()
  })

  it('正常发布：排队 → 构建 → 健康检查 → 备份 → 切流，完成后写入记录并保留预览', async () => {
    const { app, call } = await client()
    const before = await call('GET', '/api/v1/projects/prj_trial_ai_cs/environments')
    const previewsBefore = before.body.items.filter((e: { kind: string }) => e.kind === 'preview').length

    const start = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy', { version_label: 'v1.3.0', backup: true }, { 'idempotency-key': 'idem-deploy-1' })
    expect(start.status).toBe(202)
    const taskId = start.body.task.id

    let status = 'running'
    let steps: { key: string; status: string }[] = []
    for (let i = 0; i < 8; i += 1) {
      const t = await call('GET', `/api/v1/tasks/${taskId}`)
      status = t.body.status
      steps = t.body.steps
      if (status !== 'running') break
    }
    expect(status).toBe('succeeded')
    expect(steps.map((s) => s.key)).toEqual(['queued', 'building', 'healthcheck', 'backup', 'switching'])

    const after = await call('GET', '/api/v1/projects/prj_trial_ai_cs/environments')
    const previewsAfter = after.body.items.filter((e: { kind: string }) => e.kind === 'preview').length
    expect(previewsAfter).toBe(previewsBefore)

    const dep = await call('GET', '/api/v1/environments/env_trial_cs_prod/deployments')
    expect(dep.body.items[0].version_label).toBe('v1.3.0')
    expect(dep.body.items[0].sha).toMatch(/^[0-9a-f]{7,}$/)
    await app.close()
  })

  it('同一环境并发发布被拒（互斥），且不自动重试', async () => {
    // 需要观察“发布中”中间态：显式关闭任务自动推进（默认即关闭，这里写清以表明依赖）
    const { app, call } = await client({ autoAdvanceTasks: false })
    const a = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy', { version_label: 'v2.0.0' }, { 'idempotency-key': 'idem-a' })
    expect(a.status).toBe(202)
    const noKey = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy', { version_label: 'v2.2.0' })
    expect(noKey.status).toBe(400)
    expect(noKey.body.errorCode).toBe('request.idempotency_required')
    const b = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy', { version_label: 'v2.1.0' }, { 'idempotency-key': 'idem-b' })
    expect(b.status).toBe(409)
    expect(b.body.errorCode).toBe('deploy.already_running')
    const sys = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy', { version_label: 'v2.3.0' }, { 'idempotency-key': 'idem-sys' }, 'usr_trial_zheng')
    expect(sys.status).toBe(403)
    expect(sys.body.errorCode).toBe('authz.forbidden')
    await app.close()
  })

  it('版本标签格式错误与重复都被拒绝', async () => {
    const { app, call } = await client()
    const bad = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy', { version_label: '2.0' }, { 'idempotency-key': 'idem-bad' })
    expect(bad.status).toBe(400)
    expect(bad.body.errorCode).toBe('request.param_invalid')
    const dup = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy', { version_label: 'v1.2.0' }, { 'idempotency-key': 'idem-dup' })
    expect(dup.status).toBe(400)
    expect(dup.body.errorCode).toBe('request.param_invalid')
    await app.close()
  })

  it('构建失败：任务失败且没有切流', async () => {
    const { app, call } = await client()
    const start = await call('POST', '/api/v1/environments/env_trial_cs_prod:deploy?scenario=deploy_build_fail', { version_label: 'v3.0.0' }, { 'idempotency-key': 'idem-buildfail' })
    const t = await call('GET', `/api/v1/tasks/${start.body.task.id}`)
    expect(t.body.status).toBe('failed')
    expect(t.body.error.message).toContain('构建失败')
    expect(t.body.error.nextStep).toContain('没有切换流量')
    await app.close()
  })

  it('回滚：不可回退记录给出原因；跨环境回滚被拒；不回滚数据库', async () => {
    const { app, call } = await client()
    const noKey = await call('POST', '/api/v1/environments/env_trial_cs_prod:rollback', { deployment_id: 'dep_trial_2', reason: 'x' })
    expect(noKey.status).toBe(400)
    expect(noKey.body.errorCode).toBe('request.idempotency_required')
    const missing = await call('POST', '/api/v1/environments/env_trial_cs_prod:rollback', { deployment_id: 'dep_trial_3', reason: '回到失败前' }, { 'idempotency-key': 'idem-rb-1' })
    expect(missing.status).toBe(404)
    expect(missing.body.errorCode).toBe('rollback.target_missing')
    const iso = await call('POST', '/api/v1/environments/env_trial_cs_prod:rollback', { deployment_id: 'dep_kb_1', reason: 'x' }, { 'idempotency-key': 'idem-rb-2' })
    expect(iso.status).toBe(404)
    expect(iso.body.errorCode).toBe('rollback.target_missing')
    const ok = await call('POST', '/api/v1/environments/env_trial_cs_prod:rollback', { deployment_id: 'dep_trial_2', reason: '回到稳定版' }, { 'idempotency-key': 'idem-rb-3' })
    expect(ok.status).toBe(200)
    expect(ok.body.smoke).toContain('数据库不会被回滚')
    await app.close()
  })
})

describe('GAP-03 / GAP-05 预览与清理', () => {
  it('预览名额满（含休眠与残留）时拒绝，且不自动淘汰', async () => {
    const { app, call } = await client()
    const r = await call('POST', '/api/v1/projects/prj_trial_kb/environments', { kind: 'preview', branch: 'feat/new' })
    expect(r.status).toBe(429)
    expect(r.body.errorCode).toBe('preview.limit_reached')
    expect(r.body.nextStep).toContain('不会自动淘汰')
    await app.close()
  })

  it('分支已删除的预览不能直接删除（保留优先），也不会被自动清理', async () => {
    const { app, call } = await client()
    const r = await call('DELETE', '/api/v1/environments/env_trial_kb_prev2', { confirm_branch: 'feat/old-ui' })
    expect(r.status).toBe(409)
    expect(r.body.errorCode).toBe('preview.branch_deleted')
    await app.close()
  })

  it('删除预览需二次确认分支名，删除后释放名额', async () => {
    const { app, call } = await client()
    const wrong = await call('DELETE', '/api/v1/environments/env_trial_cs_prev1', { confirm_branch: 'feat/wrong' })
    expect(wrong.status).toBe(422)
    const ok = await call('DELETE', '/api/v1/environments/env_trial_cs_prev1', { confirm_branch: 'feat/order' })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ deleted: true, released_slot: true })
    await app.close()
  })

  it('唤醒超时可注入，且不进入半可用状态', async () => {
    const { app, call } = await client()
    const r = await call('POST', '/api/v1/environments/env_trial_cs_prev2:wake?scenario=wake_timeout')
    expect(r.status).toBe(504)
    expect(r.body.errorCode).toBe('preview.wake_timeout')
    await app.close()
  })

  it('清理：只有异常范围可选，需两次确认 + 原因，逐条返回结果', async () => {
    const { app, call } = await client({ allowScenario: true })
    const list = await call('GET', '/api/v1/sys/previews/abnormal', undefined, {}, 'usr_trial_zheng')
    expect(list.status).toBe(200)
    expect(list.body.items.every((a: { case: string }) => ['disabled_owner', 'deleted_project', 'undeletable'].includes(a.case))).toBe(true)

    const normal = await call('POST', '/api/v1/sys/previews/cleanup', { ids: ['env_trial_cs_prev1'], reason: '正常预览不该被清理', confirm: true }, {}, 'usr_trial_zheng')
    expect(normal.status).toBe(422)
    expect(normal.body.errorCode).toBe('preview.cleanup_scope_invalid')

    const noConfirm = await call('POST', '/api/v1/sys/previews/cleanup', { ids: ['env_abn_1'], reason: '账号停用后清理' }, {}, 'usr_trial_zheng')
    expect(noConfirm.status).toBe(422)
    expect(noConfirm.body.errorCode).toBe('preview.cleanup_confirm_required')

    const done = await call('POST', '/api/v1/sys/previews/cleanup?scenario=cleanup_partial', { ids: ['env_abn_1', 'env_abn_3'], reason: '账号停用后清理', confirm: true }, {}, 'usr_trial_zheng')
    expect(done.status).toBe(200)
    expect(done.body.done).toBe(1)
    expect(done.body.residual).toBe(1)
    await app.close()
  })

  it('普通用户调用清理返回 403', async () => {
    const { app, call } = await client()
    const r = await call('POST', '/api/v1/sys/previews/cleanup', { ids: ['env_abn_1'], reason: 'x', confirm: true })
    expect(r.status).toBe(403)
    await app.close()
  })
})

describe('幂等 / 审计 / 错误目录', () => {
  it('同幂等键同体重放，同键异体 409', async () => {
    const { app, call } = await client()
    // 预览上限 3：先删一个预览腾出名额（删除不自动，手动确认分支名）
    await call('DELETE', '/api/v1/environments/env_trial_cs_prev3', { confirm_branch: 'feat/search' })
    const a = await call('POST', '/api/v1/projects/prj_trial_ai_cs/environments', { kind: 'preview', branch: 'feat/idem' }, { 'idempotency-key': 'k1' })
    expect(a.status).toBe(201)
    const b = await call('POST', '/api/v1/projects/prj_trial_ai_cs/environments', { kind: 'preview', branch: 'feat/idem' }, { 'idempotency-key': 'k1' })
    expect(b.status).toBe(201)
    expect(b.headers['idempotent-replay']).toBe('true')
    const c = await call('POST', '/api/v1/projects/prj_trial_ai_cs/environments', { kind: 'preview', branch: 'feat/other' }, { 'idempotency-key': 'k1' })
    expect(c.status).toBe(409)
    expect(c.body.errorCode).toBe('request.idempotency_conflict')
    await app.close()
  })

  it('失败响应不占用幂等键（不会把 403/422 回放成 202 pending）', async () => {
    const { app, call } = await client()
    const first = await call('PATCH', '/api/v1/admin/settings/build_concurrency', { value: 9 }, { 'idempotency-key': 'idem-fail-1' }, 'usr_trial_zhou')
    expect(first.status).toBe(422)
    const retry = await call('PATCH', '/api/v1/admin/settings/build_concurrency', { value: 9 }, { 'idempotency-key': 'idem-fail-1' }, 'usr_trial_zhou')
    expect(retry.status).toBe(422)
    expect(retry.headers['idempotent-replay']).toBeUndefined()
    const ok = await call('PATCH', '/api/v1/admin/settings/build_concurrency', { value: 2 }, { 'idempotency-key': 'idem-ok-1' }, 'usr_trial_zhou')
    expect(ok.status).toBe(200)
    const replay = await call('PATCH', '/api/v1/admin/settings/build_concurrency', { value: 2 }, { 'idempotency-key': 'idem-ok-1' }, 'usr_trial_zhou')
    expect(replay.status).toBe(200)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body).toMatchObject({ key: 'build_concurrency', value: 2 })
    await app.close()
  })

  it('审计写失败 → 操作按失败处理（不做无审计的写）', async () => {
    const { app, call } = await client({ auditFail: () => true })
    await call('DELETE', '/api/v1/environments/env_trial_cs_prev3', { confirm_branch: 'feat/search' })
    const r = await call('POST', '/api/v1/projects/prj_trial_ai_cs/environments', { kind: 'preview', branch: 'feat/audit-fail' })
    expect(r.status).toBe(500)
    expect(r.body.errorCode).toBe('audit.write_failed')
    const list = await call('GET', '/api/v1/projects/prj_trial_ai_cs/environments')
    expect(list.body.items.some((e: { branch: string }) => e.branch === 'feat/audit-fail')).toBe(false)
    await app.close()
  })

  it('审计为追加写并保留 12 列未确认的口径', async () => {
    const { app, call } = await client()
    await call('POST', '/api/v1/mcp/key', {}, { 'idempotency-key': 'mk1' }, 'usr_trial_lin')
    const a = await call('GET', '/api/v1/admin/audit', undefined, {}, 'usr_trial_zhou')
    expect(a.status).toBe(200)
    expect(a.body.items.length).toBeGreaterThan(0)
    expect(a.body.csv_columns).toBe(12)
    expect(a.body.csv_columns_confirmed).toBe(false)
    expect(a.body.note).toContain('T-01')
    const row = a.body.items[0]
    for (const key of ['id', 'at', 'actor_id', 'action', 'target_kind', 'target_id', 'result', 'trace_id']) expect(row[key]).toBeTruthy()
    await app.close()
  })

  it('恢复必须输入 RESTORE，并覆盖全部环境与门户数据', async () => {
    const { app, call } = await client()
    const bad = await call('POST', '/api/v1/sys/restore', { backup_id: 'bkp_trial_auto_1', confirm_word: 'restore' }, {}, 'usr_trial_zheng')
    expect(bad.status).toBe(422)
    expect(bad.body.errorCode).toBe('backup.restore_confirm_required')
    const ok = await call('POST', '/api/v1/sys/restore', { backup_id: 'bkp_trial_auto_1', confirm_word: 'RESTORE' }, {}, 'usr_trial_zheng')
    expect(ok.status).toBe(202)
    expect(ok.body.stages.join(' ')).toContain('恢复门户授权/模板')
    await app.close()
  })

  it('备份口径：每日 3 次重试 / 异地 1 次即暂停 / 连续 2 次升级', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/api/v1/sys/backup-status', undefined, {}, 'usr_trial_zheng')
    expect(r.body.daily.retry_in_task).toBe(3)
    expect(r.body.sync.retry_in_task).toBe(0)
    expect(r.body.escalate_after_consecutive).toBe(2)
    expect(r.body.resume_mechanism).toContain('T-08')
    await app.close()
  })

  it('错误目录里每个码都有三段式文案与 HTTP 状态', () => {
    for (const [code, row] of Object.entries(ERROR_TABLE)) {
      expect(row.status).toBeGreaterThanOrEqual(400)
      expect(row.what.length).toBeGreaterThan(2)
      expect(row.impact.length).toBeGreaterThan(2)
      expect(row.nextStep.length).toBeGreaterThan(2)
      expect(code).toBeTruthy()
    }
    expect(Object.keys(ERROR_TABLE).length).toBeGreaterThan(20)
  })

  it('未知端点返回 404 且说明未定义，不 200 蒙混', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/api/v1/not-a-real-endpoint')
    expect(r.status).toBe(404)
    expect(r.body.errorCode).toBe('request.path_unknown')
    await app.close()
  })
})

describe('权限模型单元', () => {
  it('三种应用角色，系统操作只在 sysadmin', () => {
    expect(ROLE_OPS.user).not.toContain('sys:setting')
    expect(ROLE_OPS.admin).not.toContain('sys:setting')
    expect(ROLE_OPS.sysadmin).toContain('sys:setting')
    expect(ADMIN_PARAM_EXCEPTIONS).toEqual(['build_concurrency', 'deploy_queue_limit'])
  })

  it('参数判定：范围优先，其次不可上调', () => {
    expect(adjustParamVerdict('admin', 'deploy_queue_limit', 0, 10, 10).errorCode).toBe('admin.param_out_of_range')
    expect(adjustParamVerdict('admin', 'deploy_queue_limit', 11, 10, 10).errorCode).toBe('admin.param_out_of_range')
    expect(adjustParamVerdict('admin', 'deploy_queue_limit', 10, 8, 10).errorCode).toBe('admin.param_raise_forbidden')
    expect(adjustParamVerdict('admin', 'deploy_queue_limit', 8, 10, 10).ok).toBe(true)
    expect(adjustParamVerdict('admin', 'backup_time', 2, 2, 3).errorCode).toBe('admin.param_forbidden')
  })
})

describe('试跑开关显式 opt-in（F-03）', () => {
  it('默认 buildApp() 关闭：场景注入、QA 身份、试跑登录全部失效', async () => {
    resetStore()
    const app = buildApp()
    const health = await app.inject({ method: 'GET', url: '/healthz' })
    expect(health.statusCode).toBe(200)

    // 场景注入被忽略：authz_down 不再触发 503
    const shadow = await app.inject({ method: 'GET', url: '/api/v1/projects?scenario=authz_down', headers: { 'x-trial-user': 'usr_trial_lin' } })
    expect(shadow.statusCode).toBe(401)

    // X-QA-Role 身份注入失效
    const qa = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-qa-role': 'sysadmin' } })
    expect(qa.statusCode).toBe(401)
    expect(qa.json().errorCode).toBe('auth.unauthenticated')

    // 试跑登录端点关闭
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/trial-login', payload: {} })
    expect(login.statusCode).toBe(404)
    expect(login.json().errorCode).toBe('request.path_unknown')
    await app.close()
  })

  it('显式 allowScenario=true 后场景注入与 QA 身份生效（仍需显式传参）', async () => {
    const { app, call } = await client({ allowScenario: true, autoAdvanceTasks: false })
    const hit = await call('POST', '/api/v1/projects/prj_trial_ai_cs/shares?scenario=authz_down', { env_kind: 'preview', branch: 'feat/order' })
    expect(hit.status).toBe(503)
    expect(hit.body.errorCode).toBe('authz.unavailable')
    const qa = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-qa-role': 'sysadmin' } })
    expect(qa.statusCode).toBe(200)
    expect(qa.json().role).toBe('sysadmin')
    await app.close()
  })

  it('server.ts 环境变量解析：只有 TRIAL_SCENARIO 严格等于 "1" 才开', () => {
    expect(trialOptionsFromEnv({})).toEqual({ allowScenario: false, autoAdvanceTasks: false })
    expect(trialOptionsFromEnv({ TRIAL_SCENARIO: '0' })).toEqual({ allowScenario: false, autoAdvanceTasks: false })
    expect(trialOptionsFromEnv({ TRIAL_SCENARIO: 'true' })).toEqual({ allowScenario: false, autoAdvanceTasks: false })
    expect(trialOptionsFromEnv({ TRIAL_SCENARIO: '1' })).toEqual({ allowScenario: true, autoAdvanceTasks: true })
  })
})

describe('api-spec 规范路径（F-01 兼容映射）', () => {
  it('GET /templates 普通用户可读，GET /templates/{id}/versions 可用', async () => {
    const { app, call } = await client()
    const t = await call('GET', '/api/v1/templates')
    expect(t.status).toBe(200)
    expect(Array.isArray(t.body.items)).toBe(true)
    expect(t.body.items[0].has_demo).toBe(true)
    const v = await call('GET', '/api/v1/templates/tpl_ai_chat/versions')
    expect(v.status).toBe(200)
    expect(v.body.items[0].version).toBe('v1.0.0')
    const missing = await call('GET', '/api/v1/templates/tpl_none/versions')
    expect(missing.status).toBe(422)
    expect(missing.body.errorCode).toBe('project.template_unavailable')
    await app.close()
  })

  it('DELETE /projects/{id} 与兼容别名 POST /projects/{id}/delete 行为一致', async () => {
    const { app, call } = await client()
    const bad = await call('DELETE', '/api/v1/projects/prj_trial_ai_cs', { confirm_name: '错的' })
    expect(bad.status).toBe(422)
    expect(bad.body.errorCode).toBe('request.invalid')
    const ok = await call('DELETE', '/api/v1/projects/prj_trial_ai_cs', { confirm_name: '智能客服' })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('soft_deleted')
    await app.close()
  })

  it('分享：创建后可在列表看到并撤销，撤销不回收项目授权（QA-DEF-03）', async () => {
    const { app, call } = await client()
    const grantsBefore = await call('GET', '/api/v1/projects/prj_trial_ai_cs/grants')
    const empty = await call('GET', '/api/v1/projects/prj_trial_ai_cs/shares')
    expect(empty.body.items).toEqual([])
    const created = await call('POST', '/api/v1/projects/prj_trial_ai_cs/shares', { env_id: 'env_trial_cs_prod' })
    expect(created.status).toBe(201)
    expect(created.body.id).toMatch(/^shr_/)
    const listed = await call('GET', '/api/v1/projects/prj_trial_ai_cs/shares')
    expect(listed.body.items.map((s: { id: string }) => s.id)).toContain(created.body.id)
    expect(listed.body.items[0].status).toBe('active')
    const revoked = await call('DELETE', `/api/v1/shares/${created.body.id}`)
    expect(revoked.status).toBe(200)
    expect(revoked.body.revoked).toBe(true)
    const after = await call('GET', '/api/v1/projects/prj_trial_ai_cs/shares')
    expect(after.body.items[0].status).toBe('revoked')
    expect(after.body.items[0].revoked_at).toBeTruthy()
    const grantsAfter = await call('GET', '/api/v1/projects/prj_trial_ai_cs/grants')
    expect(grantsAfter.body.items.length).toBe(grantsBefore.body.items.length)
    const missing = await call('DELETE', '/api/v1/shares/shr_missing')
    expect(missing.status).toBe(404)
    expect(missing.body.errorCode).toBe('share.not_found')
    await app.close()
  })

  it('授权列表字段与门户类型一致（subject_type/subject_name/subject_status/source）（QA-DEF-02）', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/api/v1/projects/prj_trial_ai_cs/grants')
    expect(r.status).toBe(200)
    const person = r.body.items.find((g: { subject_type: string }) => g.subject_type === 'user')
    expect(person.subject_name).toBe('陈可')
    expect(person.subject_status).toBe('active')
    expect(person.source).toBe('owner')
    expect(person.level).toBe('visible')
    expect(person.created_at).toBeTruthy()
    const group = r.body.items.find((g: { subject_type: string }) => g.subject_type === 'group')
    expect(group.subject_name).toBe('平台研发组')
    await app.close()
  })

  it('重复授权按幂等返回 grant.exists，不产生第二行；回收后列表移除', async () => {
    const { app, call } = await client()
    const dup = await call('POST', '/api/v1/projects/prj_trial_ai_cs/grants', { subjects: [{ type: 'user', name: '陈可' }] })
    expect(dup.status).toBe(207)
    expect(dup.body.results[0].ok).toBe(false)
    expect(dup.body.results[0].errorCode).toBe('grant.exists')
    const before = await call('GET', '/api/v1/projects/prj_trial_ai_cs/grants')
    const chen = before.body.items.find((g: { subject_name: string }) => g.subject_name === '陈可')
    const add = await call('POST', '/api/v1/projects/prj_trial_ai_cs/grants', { subjects: [{ type: 'user', name: '周敏' }] })
    expect(add.body.applied).toBe(1)
    const mid = await call('GET', '/api/v1/projects/prj_trial_ai_cs/grants')
    expect(mid.body.items.filter((g: { subject_name: string }) => g.subject_name === '周敏')).toHaveLength(1)
    const rev = await call('DELETE', `/api/v1/grants/${chen.id}`)
    expect(rev.status).toBe(200)
    const after = await call('GET', '/api/v1/projects/prj_trial_ai_cs/grants')
    expect(after.body.items.some((g: { subject_name: string }) => g.subject_name === '陈可')).toBe(false)
    const again = await call('DELETE', `/api/v1/grants/${chen.id}`)
    expect(again.status).toBe(404)
    expect(again.body.errorCode).toBe('grant.not_found')
    await app.close()
  })

  it('api-spec 形状 POST /grants 的 subject_type/subject_id 可用，且拒绝 level', async () => {
    const { app, call } = await client()
    const ok = await call('POST', '/api/v1/projects/prj_trial_ai_cs/grants', { subject_type: 'user', subject_id: 'usr_trial_chen' })
    expect(ok.body.results[0].errorCode).toBe('grant.exists')
    const bad = await call('POST', '/api/v1/projects/prj_trial_ai_cs/grants', { level: 'visible', subjects: [{ type: 'user', name: '陈可' }] })
    expect(bad.status).toBe(400)
    expect(bad.body.errorCode).toBe('request.param_invalid')
    await app.close()
  })

  it('试跑角色切换落服务端会话（QA-DEF-06）：切换后系统管理员端点可用，且仅试跑模式存在', async () => {
    const { app } = await client()
    const switched = await app.inject({ method: 'POST', url: '/api/v1/auth/trial-role', payload: { role: 'sysadmin' }, headers: { cookie: `trial_user=usr_trial_lin; trial_csrf=${CSRF}`, 'x-csrf-token': CSRF } })
    expect(switched.statusCode).toBe(200)
    expect(JSON.parse(switched.body).role).toBe('sysadmin')
    const setCookie = String(switched.headers['set-cookie'] ?? '')
    const roleCookie = /trial_role=([^;]+)/.exec(setCookie)?.[1]
    const userCookie = /trial_user=([^;]+)/.exec(setCookie)?.[1]
    expect(roleCookie).toBe('sysadmin')
    const settings = await app.inject({ method: 'GET', url: '/api/v1/sys/settings', headers: { cookie: `trial_user=${userCookie}; trial_role=${roleCookie}; trial_csrf=${CSRF}` } })
    expect(settings.statusCode).toBe(200)
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/trial-role', payload: { role: 'root' }, headers: { cookie: `trial_user=usr_trial_lin; trial_csrf=${CSRF}`, 'x-csrf-token': CSRF } })
    expect(bad.statusCode).toBe(400)
    await app.close()
    // 非试跑模式：端点关闭（fail-safe）
    const prod = buildApp()
    const off = await prod.inject({ method: 'POST', url: '/api/v1/auth/trial-role', payload: { role: 'sysadmin' } })
    expect(off.statusCode).toBe(404)
    await prod.close()
  })

  it('授权/分享写操作只有拥有者能做：被授权人 403、系统管理员不代发', async () => {
    const { app, call } = await client()
    const byChen = await call('POST', '/api/v1/projects/prj_trial_ai_cs/grants', { subjects: [{ type: 'user', name: '周敏' }] }, {}, 'usr_trial_chen')
    expect(byChen.status).toBe(403)
    expect(byChen.body.errorCode).toBe('authz.forbidden')
    const shareByChen = await call('POST', '/api/v1/projects/prj_trial_ai_cs/shares', { env_id: 'env_trial_cs_prod' }, {}, 'usr_trial_chen')
    expect(shareByChen.status).toBe(403)
    const bySys = await call('POST', '/api/v1/projects/prj_trial_ai_cs/shares', { env_id: 'env_trial_cs_prod' }, {}, 'usr_trial_zheng')
    expect(bySys.status).toBe(403)
    const byOwner = await call('POST', '/api/v1/projects/prj_trial_ai_cs/shares', { env_id: 'env_trial_cs_prod' })
    expect(byOwner.status).toBe(201)
    const revokeByOther = await call('DELETE', `/api/v1/shares/${byOwner.body.id}`, undefined, {}, 'usr_trial_chen')
    expect(revokeByOther.status).toBe(403)
    await app.close()
  })

  it('组列表返回 member_count/project_count/status，解散后状态变更（QA-DEF-05）', async () => {
    const { app, call } = await client()
    const asAdmin = await call('GET', '/api/v1/groups', undefined, {}, 'usr_trial_zhou')
    expect(asAdmin.body.items[0].member_count).toBe(4)
    expect(asAdmin.body.items[0].project_count).toBe(2)
    expect(asAdmin.body.items[0].status).toBe('active')
    expect(asAdmin.body.items[0].member_limit).toBe(200)
    const dis = await call('POST', '/api/v1/groups/grp_platform:dissolve', { confirm: true }, {}, 'usr_trial_zhou')
    expect(dis.body.status).toBe('dissolved')
    const after = await call('GET', '/api/v1/groups', undefined, {}, 'usr_trial_zhou')
    expect(after.body.items[0].status).toBe('dissolved')
    await app.close()
  })

  it('GET /groups 与 POST /groups/{id}:dissolve 命中既有实现并保留权限位', async () => {
    const { app, call } = await client()
    const asUser = await call('GET', '/api/v1/groups')
    expect(asUser.status).toBe(403)
    expect(asUser.body.errorCode).toBe('authz.forbidden')
    const asAdmin = await call('GET', '/api/v1/groups', undefined, {}, 'usr_trial_zhou')
    expect(asAdmin.status).toBe(200)
    const dis = await call('POST', '/api/v1/groups/grp_platform:dissolve', { confirm: true }, {}, 'usr_trial_zhou')
    expect(dis.status).toBe(200)
    expect(dis.body.dissolved).toBe(true)
    await app.close()
  })

  it('GET /environments/{id}/logs 返回契约形状（source/lines/ai_hint）', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/api/v1/environments/env_trial_cs_prod/logs?source=build')
    expect(r.status).toBe(200)
    expect(r.body.source).toBe('build')
    expect(Array.isArray(r.body.lines)).toBe(true)
    expect(r.body.lines[0].text).toContain('/healthz')
    expect(r.body.ai_hint.available).toBe(false)
    const missing = await call('GET', '/api/v1/environments/env_none/logs')
    expect(missing.status).toBe(404)
    expect(missing.body.errorCode).toBe('env.not_found')
    await app.close()
  })

  it('PATCH /projects/{id} 只改名；slug 不可变；拥有者变更走 transfer', async () => {
    const { app, call } = await client()
    const ok = await call('PATCH', '/api/v1/projects/prj_trial_ai_cs', { name: '智能客服 2' })
    expect(ok.status).toBe(200)
    expect(ok.body.name).toBe('智能客服 2')
    const slug = await call('PATCH', '/api/v1/projects/prj_trial_ai_cs', { name: 'x', slug: 'other' })
    expect(slug.status).toBe(422)
    expect(slug.body.errorCode).toBe('project.slug_immutable')
    const owner = await call('PATCH', '/api/v1/projects/prj_trial_ai_cs', { owner_user_id: 'usr_trial_chen' })
    expect(owner.status).toBe(400)
    const other = await call('PATCH', '/api/v1/projects/prj_trial_ai_cs', { name: 'y' }, {}, 'usr_trial_zhou')
    expect(other.status).toBe(403)
    await app.close()
  })

  it('POST /admin/restores 兼容映射到恢复逻辑（仍需系统管理员 + 确认词）', async () => {
    const { app, call } = await client()
    const bad = await call('POST', '/api/v1/admin/restores', { backup_id: 'bkp_trial_auto_1', confirm: 'restore', scope: 'platform' }, { 'idempotency-key': 'rs-1' }, 'usr_trial_zheng')
    expect(bad.status).toBe(422)
    // 错误码命名差异已登记（api-spec 未逐一定义恢复错误码；实现沿用 backup.restore_confirm_required）
    expect(bad.body.errorCode).toBe('backup.restore_confirm_required')
    const ok = await call('POST', '/api/v1/admin/restores', { backup_id: 'bkp_trial_auto_1', confirm: 'RESTORE', scope: 'platform' }, { 'idempotency-key': 'rs-2' }, 'usr_trial_zheng')
    expect([200, 202]).toContain(ok.status)
    await app.close()
  })
})

describe('api-spec 文件读取契约（§8.4）', () => {
  it('/files、/files:stat、/files:download 共用只读边界并可下载', async () => {
    resetStore()
    const app = buildApp({ allowScenario: true, autoAdvanceTasks: true })
    const call = (method: string, url: string) =>
      app.inject({ method: method as 'GET', url, headers: { 'x-qa-role': 'user' } })

    const list = await call('GET', '/api/v1/files?project_id=prj_trial_ai_cs&env_id=env_trial_cs_prod&path=/')
    expect(list.statusCode).toBe(200)
    expect(list.json().read_only).toBe(true)

    const stat = await call('GET', '/api/v1/files:stat?project_id=prj_trial_ai_cs&path=/report-2026-11.pdf')
    expect(stat.statusCode).toBe(200)
    expect(stat.json().name).toBe('report-2026-11.pdf')

    const dl = await call('GET', '/api/v1/files:download?project_id=prj_trial_ai_cs&path=/report-2026-11.pdf')
    expect(dl.statusCode).toBe(200)
    expect(String(dl.headers['content-disposition'])).toContain('attachment')

    const bad = await call('GET', '/api/v1/files?project_id=prj_trial_ai_cs&env_id=env_trial_cs_prod&path=/../etc/passwd')
    expect(bad.statusCode).toBe(400)
    expect(bad.json().errorCode).toBe('file.path_invalid')
    await app.close()
  })
})

/**
 * 本轮开发自检修复（QA-DEF-05/07/08/09/10/11/12/13）。
 * 说明：QA-DEF-05 在新旧清单里含义不同（旧 fix-plan = 项目组计数，本轮 = 模板/空白回退），
 * 因此这里按「菜单 + 触发行为」命名用例，不靠编号断言。
 */
describe('开发自检修复：模板 / 下载 / 清理 / 角色模型 / 用量 / 审计日志', () => {
  it('模板列表只返回已发布版本，空白模板可回退创建（QA-DEF-05）', async () => {
    const { app, call } = await client()
    const list = await call('GET', '/api/v1/templates')
    expect(list.status).toBe(200)
    const items = list.body.items as { id: string; status: string; has_demo: boolean; build_preset: string; version: string }[]
    expect(items.every((t) => t.status === 'active')).toBe(true)
    const blank = items.find((t) => t.id === 'tpl_blank')
    expect(blank).toBeTruthy()
    expect(typeof blank!.build_preset).toBe('string')
    expect(typeof blank!.version).toBe('string')

    // 模板库不可用（试跑故障注入）：列表请求失败而不是返回空数组，页面才有真实回退入口
    const down = await call('GET', '/api/v1/templates?scenario=template_down')
    expect(down.status).toBe(422)
    expect(down.body.errorCode).toBe('project.template_unavailable')

    // 模板下线后：向导列表不再出现，直接创建被拒（不能静默换成别的模板）
    const off = await call('POST', '/api/v1/sys/templates/tpl_ai_chat:deprecate', {}, { 'idempotency-key': 'tpl-off-1' }, 'usr_trial_zheng')
    expect(off.status).toBe(200)
    const after = await call('GET', '/api/v1/templates')
    expect((after.body.items as { id: string }[]).some((t) => t.id === 'tpl_ai_chat')).toBe(false)
    const denied = await call('POST', '/api/v1/projects', { name: '下线模板项目', template_id: 'tpl_ai_chat', database: 'none' }, { 'idempotency-key': 'p-off-1' })
    expect(denied.status).toBe(422)
    expect(denied.body.errorCode).toBe('project.template_unavailable')

    // 空白模板回退仍可创建（不建空仓库的语义由模板内容保证）
    const ok = await call('POST', '/api/v1/projects', { name: '空白模板项目', template_id: 'tpl_blank', database: 'none' }, { 'idempotency-key': 'p-blank-1' })
    expect(ok.status).toBe(201)
    await app.close()
  })

  it('文件下载返回真实字节与 attachment 头，且拒绝越界路径（QA-DEF-07）', async () => {
    const { app, call } = await client()
    const dl = await app.inject({ method: 'GET', url: '/api/v1/files:download?project_id=prj_trial_ai_cs&env_id=env_trial_cs_prod&path=/report-2026-11.pdf', headers: { cookie: COOKIE } })
    expect(dl.statusCode).toBe(200)
    expect(String(dl.headers['content-type'])).toContain('application/octet-stream')
    expect(String(dl.headers['content-disposition'])).toContain('attachment')
    expect(dl.rawPayload.length).toBeGreaterThan(0)
    const bad = await call('GET', '/api/v1/files:download?project_id=prj_trial_ai_cs&path=/../../etc/passwd')
    expect(bad.status).toBe(400)
    expect(bad.body.errorCode).toBe('file.path_invalid')
    await app.close()
  })

  it('异常预览清理：契约 payload + 逐项结果 + 正常预览不可删（QA-DEF-08）', async () => {
    const { app, call } = await client()
    const cand = await call('GET', '/api/v1/admin/previews/cleanup-candidates', undefined, {}, 'usr_trial_zheng')
    expect(cand.status).toBe(200)
    const items = cand.body.items as { env_id: string; reason: string; size_bytes: number }[]
    expect(items.length).toBe(3)
    expect(items.map((i) => i.reason).sort()).toEqual(['not_removable_by_user', 'owner_disabled', 'project_deleted'])
    expect(items.every((i) => typeof i.env_id === 'string' && i.size_bytes > 0)).toBe(true)

    // 旧 payload（ids）按契约被拒
    const legacy = await call('POST', '/api/v1/admin/previews:cleanup', { ids: [items[0]!.env_id] }, { 'idempotency-key': 'cl-0' }, 'usr_trial_zheng')
    expect(legacy.status).toBe(400)
    expect(legacy.body.errorCode).toBe('request.param_invalid')

    // 正常预览不在范围
    const normal = await call('POST', '/api/v1/admin/previews:cleanup', { items: [{ env_id: 'env_trial_cs_prev3', reason: 'owner_disabled' }], confirm: true, confirm_text: '清理 1 个异常预览' }, { 'idempotency-key': 'cl-1' }, 'usr_trial_zheng')
    expect(normal.status).toBe(409)
    expect(normal.body.errorCode).toBe('cleanup.scope_invalid')

    // 未二次确认 → 拒绝
    const noConfirm = await call('POST', '/api/v1/admin/previews:cleanup', { items: [{ env_id: items[0]!.env_id, reason: items[0]!.reason }] }, { 'idempotency-key': 'cl-2' }, 'usr_trial_zheng')
    expect(noConfirm.status).toBe(422)
    expect(noConfirm.body.errorCode).toBe('cleanup.confirm_required')

    const ok = await call('POST', '/api/v1/admin/previews:cleanup', {
      items: [{ env_id: items[0]!.env_id, reason: items[0]!.reason }, { env_id: items[1]!.env_id, reason: items[1]!.reason }],
      confirm: true,
      confirm_text: '清理 2 个异常预览',
    }, { 'idempotency-key': 'cl-3' }, 'usr_trial_zheng')
    expect(ok.status).toBe(200)
    expect(ok.body.requested).toBe(2)
    expect(ok.body.succeeded.length).toBe(2)
    expect(ok.body.failed.length).toBe(0)
    expect(ok.body.audit_ids.length).toBe(2)
    const left = await call('GET', '/api/v1/admin/previews/cleanup-candidates', undefined, {}, 'usr_trial_zheng')
    expect((left.body.items as unknown[]).length).toBe(1)
    await app.close()
  })

  it('角色模型矩阵可读可存，回读为保存后的状态（QA-DEF-09）', async () => {
    const { app, call } = await client()
    const got = await call('GET', '/api/v1/sys/roles', undefined, {}, 'usr_trial_zheng')
    expect(got.status).toBe(200)
    const roles = got.body.roles as { role: string; label: string; modules: { module: string; ops: { code: string; label: string; enabled: boolean }[] }[] }[]
    expect(roles.map((r) => r.role)).toEqual(['user', 'admin', 'sysadmin'])
    expect(roles.every((r) => r.modules.length > 0 && r.modules.every((m) => m.ops.every((o) => typeof o.code === 'string' && typeof o.label === 'string' && typeof o.enabled === 'boolean')))).toBe(true)

    const target = roles.find((r) => r.role === 'user')!
    const op = target.modules.flatMap((m) => m.ops).find((o) => o.code === 'deploy:create')!
    op.enabled = false
    const put = await call('PUT', '/api/v1/sys/roles', { roles }, {}, 'usr_trial_zheng')
    expect(put.status).toBe(200)
    expect(typeof put.body.version).toBe('string')
    expect(put.body.affected.user).toBe(2)

    const back = await call('GET', '/api/v1/sys/roles', undefined, {}, 'usr_trial_zheng')
    expect(back.body.version).toBe(put.body.version)
    const userOps = (back.body.roles as typeof roles).find((r) => r.role === 'user')!.modules.flatMap((m) => m.ops)
    expect(userOps.find((o) => o.code === 'deploy:create')!.enabled).toBe(false)
    // 模型内不存在的权限码不能被新增
    const bad = await call('PUT', '/api/v1/sys/roles', { roles: roles.map((r) => ({ ...r, modules: r.modules.map((m) => ({ ...m, ops: [...m.ops, { code: 'sys:invented', label: 'x', enabled: true }] })) })) }, {}, 'usr_trial_zheng')
    expect(bad.status).toBe(400)
    await app.close()
  })

  it('用量与 Dashboard 配额同口径：used/limit/ratio 与分项合计一致（QA-DEF-10）', async () => {
    const { app, call } = await client()
    const card = await call('GET', '/api/v1/projects/prj_trial_ai_cs')
    const usage = await call('GET', '/api/v1/projects/prj_trial_ai_cs/usage')
    expect(usage.status).toBe(200)
    expect(usage.body.used_bytes).toBe(card.body.quota.used_bytes)
    expect(usage.body.limit_bytes).toBe(card.body.quota.limit_bytes)
    expect(usage.body.ratio).toBeCloseTo(card.body.quota.ratio, 4)
    expect(usage.body.period_minutes).toBe(15)
    expect(usage.body.threshold).toEqual({ warning: 0.8, action: 'hard_reject', exceeded: false })
    const parts = usage.body.parts as { kind: string; bytes: number }[]
    expect(parts.map((p) => p.kind).sort()).toEqual(['db', 'files', 'logs', 'volumes'])
    expect(parts.reduce((n, p) => n + p.bytes, 0)).toBe(usage.body.used_bytes)
    await app.close()
  })

  it('模板管理用真实状态：下线后从新建列表消失，再发布后恢复（QA-DEF-11）', async () => {
    const { app, call } = await client()
    const adminList = await call('GET', '/api/v1/sys/templates', undefined, {}, 'usr_trial_zheng')
    expect(adminList.status).toBe(200)
    const rows = adminList.body.items as { id: string; status: string; version: string; projects_used: number }[]
    expect(rows.every((t) => typeof t.version === 'string' && typeof t.projects_used === 'number')).toBe(true)

    const off = await call('POST', '/api/v1/sys/templates/tpl_ai_report:deprecate', {}, { 'idempotency-key': 'sys-tpl-1' }, 'usr_trial_zheng')
    expect(off.status).toBe(200)
    expect(off.body.template.status).toBe('deprecated')
    const adminAfter = await call('GET', '/api/v1/sys/templates', undefined, {}, 'usr_trial_zheng')
    expect((adminAfter.body.items as typeof rows).find((t) => t.id === 'tpl_ai_report')!.status).toBe('deprecated')
    const userList = await call('GET', '/api/v1/templates')
    expect((userList.body.items as { id: string }[]).some((t) => t.id === 'tpl_ai_report')).toBe(false)

    const on = await call('POST', '/api/v1/sys/templates/tpl_ai_report:publish', {}, { 'idempotency-key': 'sys-tpl-2' }, 'usr_trial_zheng')
    expect(on.status).toBe(200)
    expect(on.body.template.status).toBe('active')
    const restored = await call('GET', '/api/v1/templates')
    expect((restored.body.items as { id: string }[]).some((t) => t.id === 'tpl_ai_report')).toBe(true)
    await app.close()
  })

  it('日志与审计的消费字段齐全（text/seq 与 actor/target/ip）（QA-DEF-12）', async () => {
    const { app, call } = await client()
    const logs = await call('GET', '/api/v1/projects/prj_trial_ai_cs/logs?source=runtime')
    expect(logs.status).toBe(200)
    const lines = logs.body.items as { seq: number; at: string; level: string; text: string }[]
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => typeof l.seq === 'number' && typeof l.text === 'string' && l.text.length > 0)).toBe(true)
    const archived = await call('GET', '/api/v1/projects/prj_trial_ai_cs/logs?source=archive')
    expect(archived.body.source).toBe('history')

    await call('POST', '/api/v1/environments/env_trial_cs_prev1:deploy', {}, { 'idempotency-key': 'log-aud-1' })
    const audit = await call('GET', '/api/v1/audit', undefined, {}, 'usr_trial_zhou')
    expect(audit.status).toBe(200)
    expect(audit.body.csv_columns).toBe(12)
    expect(audit.body.csv_columns_confirmed).toBe(false)
    const row = (audit.body.items as { actor_name: string; action: string; target_kind: string; target_id: string; ip: string; detail: string }[])[0]!
    expect(row.action).toBe('deploy.start')
    expect(row.actor_name).toBe('林小满')
    expect(row.target_id).toBe('env_trial_cs_prev1')
    expect(row.ip).toBeTruthy()
    await app.close()
  })

  it('角色模型与人员操作位真正生效：撤销即拒、恢复即通（QA-DEF-13）', async () => {
    const { app, call } = await client()
    const deploy = (key: string, user = 'usr_trial_lin') => call('POST', '/api/v1/environments/env_trial_cs_prev1:deploy', {}, { 'idempotency-key': key }, user)

    const before = await deploy('rb-0')
    expect(before.status).toBe(202)

    const model = (await call('GET', '/api/v1/sys/roles', undefined, {}, 'usr_trial_zheng')).body.roles as {
      role: string
      modules: { module: string; ops: { code: string; label: string; enabled: boolean }[] }[]
    }[]
    const disable = (m: typeof model) => {
      const userRole = m.find((r) => r.role === 'user')!
      userRole.modules.flatMap((x) => x.ops).find((o) => o.code === 'deploy:create')!.enabled = false
      return m
    }
    const enable = (m: typeof model) => {
      const userRole = m.find((r) => r.role === 'user')!
      userRole.modules.flatMap((x) => x.ops).find((o) => o.code === 'deploy:create')!.enabled = true
      return m
    }
    const put1 = await call('PUT', '/api/v1/sys/roles', { roles: disable(structuredClone(model)) }, {}, 'usr_trial_zheng')
    expect(put1.status).toBe(200)
    const denied = await deploy('rb-1')
    expect(denied.status).toBe(403)
    expect(denied.body.errorCode).toBe('authz.forbidden')
    expect(denied.body.details.required).toBe('deploy:create')
    // /me 的操作位同步收缩（前端入口隐藏与服务端一致）
    const me = await call('GET', '/api/v1/me')
    expect((me.body.operations as string[]).includes('deploy:create')).toBe(false)

    await call('PUT', '/api/v1/sys/roles', { roles: enable(structuredClone(model)) }, {}, 'usr_trial_zheng')
    expect((await deploy('rb-2')).status).toBe(202)

    // 人员操作位回收 / 恢复（管理员 P-14）
    const opsNow = (await call('GET', '/api/v1/me')).body.operations as string[]
    const patchOff = await call('PATCH', '/api/v1/admin/users/usr_trial_lin', { operations: opsNow.filter((o) => o !== 'deploy:create') }, {}, 'usr_trial_zhou')
    expect(patchOff.status).toBe(200)
    const deniedByUser = await deploy('rb-3')
    expect(deniedByUser.status).toBe(403)
    expect(deniedByUser.body.details.required).toBe('deploy:create')

    const patchOn = await call('PATCH', '/api/v1/admin/users/usr_trial_lin', { operations: opsNow }, {}, 'usr_trial_zhou')
    expect(patchOn.status).toBe(200)
    expect((await deploy('rb-4')).status).toBe(202)

    // 两次变更都写审计（角色模型 + 人员权限）
    const audit = await call('GET', '/api/v1/audit', undefined, {}, 'usr_trial_zhou')
    const actions = (audit.body.items as { action: string; actor_name: string }[]).map((a) => a.action)
    expect(actions.filter((a) => a === 'sys.roles.update').length).toBeGreaterThanOrEqual(2)
    expect(actions.filter((a) => a === 'admin.user.update').length).toBeGreaterThanOrEqual(2)
    await app.close()
  })

  it('系统管理员看项目不再显示“无权访问”，但也不被当成拥有者/被授权人（Q-ADMIN-READ 待确认）', async () => {
    const { app, call } = await client()
    const asSys = await call('GET', '/api/v1/projects/prj_trial_ai_cs', undefined, {}, 'usr_trial_zheng')
    expect(asSys.status).toBe(200)
    expect(asSys.body.relation).toBe('none')
    expect(asSys.body.relation_label).not.toContain('无权访问')
    expect(asSys.body.relation_label).toContain('待')
    // 关系没变：系统管理员仍不代发（api-spec §7.2）
    const deploy = await call('POST', '/api/v1/environments/env_trial_cs_prev1:deploy', {}, { 'idempotency-key': 'sys-deploy-1' }, 'usr_trial_zheng')
    expect(deploy.status).toBe(403)
    await app.close()
  })

  it('人员权限页随列表拿到可分配项，不用去调只有系统管理员能读的 /sys/roles（P-14）', async () => {
    const { app, call } = await client()
    const list = await call('GET', '/api/v1/admin/users', undefined, {}, 'usr_trial_zhou')
    expect(list.status).toBe(200)
    const byRole = list.body.assignable_by_role as Record<string, { code: string; label: string; enabled: boolean }[]>
    expect(Object.keys(byRole).sort()).toEqual(['admin', 'sysadmin', 'user'])
    const people = byRole.admin!.find((o) => o.code === 'admin:people')!
    expect(people.label.length).toBeGreaterThan(0)
    expect(people.enabled).toBe(true)
    expect(byRole.user!.every((o) => typeof o.enabled === 'boolean')).toBe(true)
    // P-14 列表要显示飞书账号（不是凭据）
    const first = (list.body.items as { display_name: string; feishu_account?: string }[])[0]!
    expect(first.feishu_account).toBeTruthy()
    expect(first.feishu_account).not.toContain('secret')
    // 管理员调用 /sys/roles 仍 403（P-18 矩阵只给系统管理员），页面不得依赖它
    expect((await call('GET', '/api/v1/sys/roles', undefined, {}, 'usr_trial_zhou')).status).toBe(403)
    await app.close()
  })

  it('人员操作位只能从角色模型内挑（P-14：系统管理员不分配人员权限）', async () => {
    const { app, call } = await client()
    // P-14：系统管理员不直接分配人员权限
    const bySysadmin = await call('PATCH', '/api/v1/admin/users/usr_trial_lin', { operations: ['project:read'] }, {}, 'usr_trial_zheng')
    expect(bySysadmin.status).toBe(403)

    // 模型外/非本角色的码 → 400，不静默丢弃
    const invent = await call('PATCH', '/api/v1/admin/users/usr_trial_lin', { operations: ['grant:manage'] }, {}, 'usr_trial_zhou')
    expect(invent.status).toBe(400)
    expect(invent.body.errorCode).toBe('request.param_invalid')
    expect(invent.body.details.unknown).toContain('grant:manage')

    // 模型内但被关闭的码 → 403（不能靠人员权限绕过模型）
    const model = (await call('GET', '/api/v1/sys/roles', undefined, {}, 'usr_trial_zheng')).body.roles as {
      role: string
      modules: { module: string; ops: { code: string; label: string; enabled: boolean }[] }[]
    }[]
    const adminRole = model.find((r) => r.role === 'admin')!
    adminRole.modules.flatMap((x) => x.ops).find((o) => o.code === 'admin:audit')!.enabled = false
    expect((await call('PUT', '/api/v1/sys/roles', { roles: model }, {}, 'usr_trial_zheng')).status).toBe(200)
    const disabled = await call('PATCH', '/api/v1/admin/users/usr_trial_zhou', { operations: ['admin:audit'] }, {}, 'usr_trial_zhou')
    expect(disabled.status).toBe(403)
    expect(disabled.body.details.disabled).toContain('admin:audit')

    adminRole.modules.flatMap((x) => x.ops).find((o) => o.code === 'admin:audit')!.enabled = true
    expect((await call('PUT', '/api/v1/sys/roles', { roles: model }, {}, 'usr_trial_zheng')).status).toBe(200)
    await app.close()
  })
})

describe('开发自检修复：审计导出路径与候选列（DEF-12 / api-spec §10.4）', () => {
  it('GET /audit/export 是规范路径，直接返回 text/csv（12 列候选，未确认用响应头标注）', async () => {
    const { app } = await client()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/export?format=csv',
      headers: { cookie: 'trial_user=usr_trial_zheng; trial_csrf=csrf_test', 'x-csrf-token': 'csrf_test' },
    })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/csv')
    expect(String(res.headers['content-disposition'])).toContain('attachment; filename="audit-')
    expect(res.headers['x-audit-columns']).toBe('12')
    expect(res.headers['x-audit-columns-provisional']).toBe('true')
    const lines = res.body.trim().split('\r\n')
    expect(lines[0]!.split(',')).toHaveLength(12)
    expect(lines.length).toBeGreaterThan(1)
    // 导出内容不得夹带凭据/令牌
    expect(res.body.toLowerCase()).not.toMatch(/password|bearer |mcp_[a-z0-9]{8}/)
    await app.close()
  })

  it('非法 format 明确 400，不静默当成 csv', async () => {
    const { app, call } = await client()
    const r = await call('GET', '/api/v1/audit/export?format=zip', undefined, {}, 'usr_trial_zheng')
    expect(r.status).toBe(400)
    expect(r.body.errorCode).toBe('request.param_invalid')
    await app.close()
  })
})
