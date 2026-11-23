/**
 * 试跑 Mock 路由（进程内）。仅用于本仓库前端在没有 BFF 时可运行与自测。
 * 契约形状对齐 api-spec.md v1.0；**不代表任何真实联调**。
 */
import type { ApiErrorBody, DeploymentRecord, Environment, FileEntry, GrantItem, PreviewItem, ShareItem, Task, TaskStep } from '../types'
import { abnormalPreviews, audit, alerts, cardOf, groups, me, mcpKey, platform, projects, roleModel, roleOperations, settings, state, templates, T0, redis } from './db'

export interface MockRequest {
  method: string
  path: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  scenario?: string
  idempotencyKey?: string
  auth: { csrfToken: string | null; userId: string | null }
  traceId: string
}

export type MockResult = { ok: true; status: number; data: unknown } | { ok: false; status: number; error: ApiErrorBody }

export function mockLatency(_scenario?: string): number {
  return 40 + Math.floor(Math.random() * 120)
}

function fail(traceId: string, errorCode: string, message: string, nextStep: string, status = 400, details?: Record<string, unknown>): MockResult {
  return { ok: false, status, error: { errorCode, message, nextStep, traceId, details } }
}

function ok(data: unknown, status = 200): MockResult {
  return { ok: true, status, data }
}

/** 服务端 page_size 白名单（api-spec v1.2 §1.4）；Mock 与 BFF 同契约，不做「静默忽略」 */
const PAGE_SIZE_ALLOWED = [10, 20, 50, 100, 200] as const

type Paging = { page: number; page_size: number }
type PagingError = { errorCode: string; details: Record<string, unknown> }

/**
 * Mock 的分页参数校验：与 apps/api/src/domain/list-query.ts 保持同一行为，
 * 用于在没有 BFF 时也能验证页面确实按服务端契约传参并消费 total/has_next。
 */
function readPaging(q: Record<string, string | undefined>, allowed: string[]): Paging | PagingError {
  const unknown = Object.keys(q).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) return { errorCode: 'request.param_unknown', details: { unknown, allowed } }
  const page = Number(q.page ?? 1)
  const size = Number(q.page_size ?? 20)
  if (!Number.isInteger(page) || page < 1) return { errorCode: 'request.param_invalid', details: { field: 'page', value: q.page } }
  if (!(PAGE_SIZE_ALLOWED as readonly number[]).includes(size)) {
    return { errorCode: 'request.param_invalid', details: { field: 'page_size', value: q.page_size, allowed: [...PAGE_SIZE_ALLOWED] } }
  }
  return { page, page_size: size }
}

function isPagingError(v: Paging | PagingError): v is PagingError {
  return (v as PagingError).errorCode !== undefined
}

/** 过滤后的真实切片：total 取过滤后长度，has_next 由服务端算 */
function sliceOf<T>(items: T[], p: Paging) {
  const start = (p.page - 1) * p.page_size
  return {
    items: items.slice(start, start + p.page_size),
    total: items.length,
    page: p.page,
    page_size: p.page_size,
    has_next: p.page * p.page_size < items.length,
  }
}

/** 查询串统一成字符串（mock 的 q 可能收到数字/布尔） */
function asQuery(q: Record<string, string | number | boolean | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v === undefined ? undefined : String(v)]))
}

const project = (id: string) => projects.find((p) => p.id === id)
const token = (path: string) => path.split('/').filter(Boolean)

export function dispatch(req: MockRequest): MockResult {
  let seg = token(req.path)
  // `POST /environments/{id}:wake` 形式：把动作从最后一段拆出来
  let action: string | null = null
  const last = seg.length - 1
  if (last >= 0 && seg[last]!.includes(':')) {
    const [id, act] = seg[last]!.split(':')
    seg[last] = id!
    action = act ?? null
  }
  const trace = req.traceId
  let method = req.method
  const body = (req.body ?? {}) as Record<string, unknown>

  // api-spec 规范路径 → Mock 内部路径（与 BFF `rewriteSpecAliases` 对齐）。
  // Mock 只是试跑替身：这里同样保留旧路径，避免页面与契约任一写法都可运行。
  if (method === 'DELETE' && seg[0] === 'shares' && seg[1]) {
    method = 'POST'
    action = 'revoke'
  }
  if (method === 'DELETE' && seg[0] === 'projects' && seg[1] && seg.length === 2) {
    method = 'POST'
    seg.push('delete')
  }
  if (seg[0] === 'groups') seg[0] = 'admin' // /groups → /admin/groups
  if (seg[0] === 'audit') seg = ['admin', 'audit', ...seg.slice(1)] // /audit、/audit/export → /admin/audit…
  else if (seg[0] === 'mcp-keys') seg = ['mcp', 'key']
  else if (seg[0] === 'files') seg = ['projects', String(req.query?.project_id ?? ''), 'files']
  else if (seg[0] === 'admin' && seg[1] === 'previews' && seg[2] === 'cleanup-candidates') seg = ['sys', 'previews', 'abnormal']
  else if (seg[0] === 'admin' && seg[1] === 'previews' && (seg[2] === 'cleanup' || action === 'cleanup')) seg = ['sys', 'previews', 'cleanup']
  else if (seg[0] === 'admin' && seg[1] === 'restores') {
    seg = ['sys', 'restore']
    if (body.confirm !== undefined) body.confirm_word = body.confirm
  } else if (seg[0] === 'admin' && seg[1] === 'templates' && seg[3] === 'versions') seg = ['sys', 'templates', seg[2]!, 'publish']
  else if (seg[0] === 'admin' && seg[1] === 'templates' && seg[3] === 'deprecate') seg = ['sys', 'templates', seg[2]!, 'offline']
  else if (seg[0] === 'admin' && seg[1] === 'settings' && seg[2] && method === 'PATCH') {
    body.key = seg[2]
    seg = ['admin', 'settings']
  }
  const scenario = req.scenario ?? ''
  const q = req.query ?? {}

  // 会话：Mock 里未登录（无 userId）只能拿到 401，登录页用它演示
  if (seg[0] !== 'auth' && !req.auth.userId) {
    return fail(trace, 'auth.session_expired', '登录状态已失效。', '重新登录后会回到原页面。', 401)
  }

  // 统一故障注入：权限系统不可用时写操作一律拒绝（fail-closed，ACC-19）
  const isWrite = method !== 'GET'
  if (isWrite && (scenario === 'authz_down' || !platform.authz_ok)) {
    return fail(trace, 'authz.unavailable', '权限系统当前不可用，写操作已全部拒绝。', '稍后重试；不要重复提交，若持续请把 traceId 给系统管理员。', 503)
  }

  // ---------- 认证 ----------
  if (seg[0] === 'me' && method === 'GET') return ok(me)
  if (seg[0] === 'setup' && seg[1] === 'status') return ok({ bootstrap_done: true, admin_open_id_configured: false, note: '首个管理员 open_id 为占位（T-02 待提供）' })
  // 试跑专用：模拟飞书授权成功后的会话建立（真实环境走 OAuth 回调，不走这个端点）
  if (seg[0] === 'auth' && seg[1] === 'trial-login' && method === 'POST') return ok({ ...me, trial_only: true })
  if (seg[0] === 'auth' && seg[1] === 'feishu' && seg[2] === 'start') return ok({ redirect_url: 'mock://feishu/authorize', state: 'trial-state' })
  if (seg[0] === 'auth' && seg[1] === 'logout') return ok({ ok: true })

  // ---------- 项目 ----------
  if (seg[0] === 'projects' && seg.length === 1 && method === 'GET') {
    const page = readPaging(asQuery(q), ['status', 'q', 'page', 'page_size', 'sort'])
    if (isPagingError(page)) return fail(trace, page.errorCode, '请求参数不合法。', '按页面提供的入口重试（page_size 只接受 10/20/50/100/200）。', 400, page.details)
    const keyword = String(q.q ?? '').trim().toLowerCase()
    const sortRaw = String(q.sort ?? '-updated_at')
    const sortDir = sortRaw.startsWith('-') ? -1 : 1
    const sortField = sortRaw.replace(/^-/, '')
    if (!['updated_at', 'name', 'created_at'].includes(sortField)) {
      return fail(trace, 'request.sort_invalid', '排序字段不在白名单内。', '用页面提供的排序，或清空排序用默认排序。', 400, { field: 'sort', value: sortRaw, allowed: ['updated_at', 'name', 'created_at'] })
    }
    const visible = projects
      .filter((p) => p.relation !== 'none' || me.role === 'sysadmin')
      .filter((p) => (q.status === 'soft_deleted' ? p.status === 'soft_deleted' : q.status === 'all' ? true : p.status === 'active'))
      .filter((p) => (keyword ? p.name.toLowerCase().includes(keyword) || p.slug.toLowerCase().includes(keyword) : true))
      .slice()
      .sort((a, b) => {
        const ka = sortField === 'name' ? a.name : sortField === 'created_at' ? a.created_at : a.updated_at
        const kb = sortField === 'name' ? b.name : sortField === 'created_at' ? b.created_at : b.updated_at
        return ka < kb ? -sortDir : ka > kb ? sortDir : 0
      })
    // 服务端分页：先切片再映射卡片，total 与 items 同源（DEF-V01）
    const slice = sliceOf(visible, page)
    return ok({ ...slice, items: slice.items.map(cardOf) })
  }
  if (seg[0] === 'projects' && method === 'POST' && seg.length === 1) {
    if (scenario === 'template_down') {
      return fail(trace, 'project.template_unavailable', '模板库暂不可用，所选模板无法加载。', '可改用空白模板，或联系系统管理员；系统不会静默改用空仓库。', 422)
    }
    if (scenario === 'quota_full') {
      return fail(trace, 'project.quota_exceeded', '磁盘水位已达阈值，无法开通新项目。', '联系系统管理员处理容量；已运行项目不受影响。', 429)
    }
    const name = String(body.name ?? '').trim()
    if (!name) return fail(trace, 'project.name_required', '项目名称必填。', '填写项目名称后重试。', 422)
    if (projects.some((p) => p.name === name)) return fail(trace, 'project.name_conflict', `项目名「${name}」已被使用。`, '换一个名称，或联系该项目拥有者。', 409)
    if (String(body.database ?? 'none') === 'none' && !body.template_id) {
      return fail(trace, 'project.template_required', '必须显式选择模板。', '回到第 2 步选择模板。', 422)
    }
    const id = `prj_trial_${projects.length + 1}`
    const slug = String(body.slug ?? name.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
    const steps: TaskStep[] = [
      { key: 'db', label: '创建数据库', status: 'pending' },
      { key: 'repo', label: '创建代码仓库', status: 'pending' },
      { key: 'template', label: '注入模板与规范', status: 'pending' },
      { key: 'resources', label: '开通资源（数据库卷 / 桶 / 共享 Redis 分片挂载）', status: 'pending' },
      { key: 'envs', label: '创建预览与正式环境', status: 'pending' },
      { key: 'webhook', label: '安装预览 Webhook（正式环境不装）', status: 'pending' },
    ]
    const task: Task = { id: `task_trial_create_${projects.length + 1}`, type: 'project.create', status: 'running', phase: null, attempt: 1, max_attempts: 1, steps, sha: null, version_label: null, created_at: T0, finished_at: null }
    state.tasks.set(task.id, task)
    const created = cardOf({ ...projects[0]!, id, name, slug, status: 'creating', owner: me, relation: 'owner', created_at: T0, updated_at: T0 })
    return ok({ project: created, task: { id: task.id, type: 'project.create', poll_after_ms: 1000 } }, 202)
  }
  if (seg[0] === 'projects' && seg[1] && seg.length === 2 && method === 'GET') {
    const p = project(seg[1])
    if (!p) return fail(trace, 'authz.forbidden', '你没有该项目的访问权限。', '联系项目拥有者或管理员申请授权。', 403)
    if (p.status === 'soft_deleted') return ok({ ...cardOf(p), deleted: true })
    return ok(cardOf(p))
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'main') {
    const p = project(seg[1])!
    return ok({ branch: 'main', sha: p.main.sha, short_sha: p.main.sha.slice(0, 7), committed_at: p.main.committed_at, author: p.main.author, version_labels: p.deployments.filter((d) => d.env_kind === 'production').map((d) => d.version_label) })
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'usage') {
    const p = project(seg[1])!
    const total = p.quota.used_bytes
    const db = Math.round(total * 0.4)
    const volumes = Math.round(total * 0.28)
    const files = Math.round(total * 0.18)
    const logs = total - db - volumes - files
    const ratio = Number((total / p.quota.limit_bytes).toFixed(4))
    return ok({
      project_id: p.id,
      used_bytes: total,
      limit_bytes: p.quota.limit_bytes,
      ratio,
      period_minutes: 15,
      parts: [
        { kind: 'db', label: '数据库卷', bytes: db },
        { kind: 'volumes', label: '持久卷与运行层', bytes: volumes },
        { kind: 'files', label: '文件存储', bytes: files },
        { kind: 'logs', label: '日志（30 天，计入配额）', bytes: logs },
      ],
      threshold: { warning: 0.8, action: 'hard_reject', exceeded: ratio >= 0.8 },
      collected_at: '2026-11-20T09:15:00.000Z',
      stale: scenario === 'collect_fail',
      stale_note: scenario === 'collect_fail' ? '用量采集失败，数字可能滞后；按每 15 分钟采集一次，最新一次未成功。' : null,
    })
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'files') {
    if (scenario === 'storage_down') return fail(trace, 'platform.unavailable', '文件存储暂不可用。', '重试；持续失败请联系系统管理员。', 503)
    const p = project(seg[1])!
    const path = String(q.path ?? '/')
    if (/\.\.|^\/\/|^[a-zA-Z]:/.test(path)) return fail(trace, 'file.path_invalid', '路径不合法。', '只能浏览项目环境内的文件。', 400)
    // api-spec §8.1：下载/属性走同一只读边界
    if (action === 'download') {
      const name = path.split('/').pop() || 'download.bin'
      return ok({ filename: name, text: '试跑替身文件内容（非真实应用文件，未接对象存储 ENV 未完成）\n' })
    }
    if (action === 'stat') {
      const name = path.split('/').pop() || ''
      const hit = p.files.find((f) => f.name === name)
      if (!hit) return fail(trace, 'file.not_found', '文件不存在。', '刷新目录后再试。', 404)
      return ok({ name: hit.name, type: hit.type, size: hit.size_bytes, modified_at: hit.modified_at })
    }
    const env = q.env_id ? p.environments.find((e) => e.id === String(q.env_id)) : p.environments.find((e) => e.kind === String(q.kind ?? 'production'))
    if (!env) return fail(trace, 'file.env_not_found', '该环境还没有创建。', '先创建环境后再浏览文件。', 404)
    return ok({
      entries: (env.kind === 'preview' ? p.files.slice(0, 2) : p.files).map((f) => ({ name: f.name, type: f.type, size: f.size_bytes, modified_at: f.modified_at })),
      path,
      read_only: true,
      note: '平台不提供 S3 / 对象存储 API',
    } satisfies Record<string, unknown>)
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'logs' && seg.length === 3) {
    const p = project(seg[1])!
    const source = String(q.source ?? 'runtime')
    if (source === 'archive' && scenario === 'archive_fail') {
      return fail(trace, 'log.archive_failed', '历史日志转存失败，当前仅能显示实时日志。', '重试转存；不静默丢弃日志。', 503)
    }
    return ok({ items: p.logs, source, retention_days: 30, redacted: true, ai_enabled: false })
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'logs' && seg[3] === 'ai') {
    if (scenario === 'ai_timeout') return fail(trace, 'log.ai_unavailable', 'AI 分析暂不可用（内部网关超时）。', '已回退规则高亮；不重复扣费，稍后再试。', 503)
    return ok({ enabled: true, hint: 'AI 建议，以原始日志为准：疑似数据库连接池耗尽（规则命中 E-1042）。', sent_bytes: 812, redacted: true, audit_recorded: true })
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'grants') {
    const p = project(seg[1])!
    if (method === 'GET') return ok({ items: p.grants, level_options: ['visible'], limits: { people: 50, groups: 10, group_members: 200 } })
    if (method === 'POST') {
      const subjects = (body.subjects ?? []) as { type: 'user' | 'group'; name: string }[]
      const results = subjects.map((s) => {
        if (s.name === '不存在账号') return { name: s.name, ok: false, errorCode: 'grant.subject_not_found', reason: '账号不存在或已停用' }
        if (p.grants.some((g) => g.subject_name === s.name)) return { name: s.name, ok: false, errorCode: 'grant.exists', reason: '已存在同一授权（只有「可见」一档）' }
        const item: GrantItem = { id: `grt_${Date.now()}_${p.grants.length}`, subject_type: s.type, subject_name: s.name, subject_status: 'active', level: 'visible', source: 'owner', created_at: '2026-11-20T09:20:00.000Z' }
        p.grants.push(item)
        return { name: s.name, ok: true }
      })
      return ok({ results, applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }, 207)
    }
  }
  if (seg[0] === 'grants' && seg[1] && method === 'DELETE') {
    for (const p of projects) {
      const idx = p.grants.findIndex((g) => g.id === seg[1])
      if (idx >= 0) {
        p.grants.splice(idx, 1)
        return ok({ revoked: true, effective_within_seconds: 30, note: '入口与 GitLab 权限同步失效；撤销分享与回收授权是不同操作' })
      }
    }
    return fail(trace, 'grant.not_found', '该授权已不存在。', '刷新页面确认当前授权列表。', 404)
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'shares') {
    const p = project(seg[1])!
    if (method === 'GET') return ok({ items: p.shares, note: '分享只生成链接；对方仍需登录并有该项目数据权限' })
    if (method === 'POST') {
      const envKind = (body.env_kind ?? 'production') as 'preview' | 'production'
      const branch = (body.branch ?? null) as string | null
      const env = p.environments.find((e) => e.kind === envKind && (envKind === 'production' || e.branch === branch))
      if (!env) return fail(trace, 'share.env_not_found', '该环境不存在，无法生成分享链接。', '先创建对应环境。', 404)
      const item: ShareItem = { id: `shr_${Date.now()}`, env_kind: envKind, branch, url: env.url, created_by: me.display_name, created_at: '2026-11-20T09:20:00.000Z', status: 'active', revoked_at: null }
      p.shares.push(item)
      return ok(item, 201)
    }
  }
  if (seg[0] === 'shares' && seg[1] && action === 'revoke') {
    for (const p of projects) {
      const s = p.shares.find((x) => x.id === seg[1])
      if (s) {
        s.status = 'revoked'
        s.revoked_at = '2026-11-20T09:20:00.000Z'
        return ok({ revoked: true, effective_within_seconds: 30, note: '只使这一条链接失效；不授予也不回收任何项目授权' })
      }
    }
    return fail(trace, 'share.not_found', '该分享链接不存在。', '刷新列表后重试。', 404)
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'backups') {
    const p = project(seg[1])!
    if (method === 'GET') return ok({ items: p.backups, retention_days: 30 })
    if (method === 'POST') {
      if (scenario === 'backup_fail') return fail(trace, 'backup.failed', '手动备份失败：目标存储连接超时。', '重试；持续失败联系系统管理员。', 500)
      const item = { id: `bkp_${Date.now()}`, kind: 'manual' as const, created_at: '2026-11-20T09:20:00.000Z', scope: `${p.name} · 全部环境（含预览）`, result: 'success' as const, expires_at: '2026-12-20T09:20:00.000Z', attempts: 1, max_attempts: 3, note: '手动备份；保留 30 天' }
      p.backups.unshift(item)
      return ok(item, 202)
    }
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'access-pack') {
    const p = project(seg[1])!
    if (seg[3] === 'update') {
      return ok({ changes: { added: 0, updated: 2, kept_user_edits: 3, conflicts: [{ file: 'AGENTS.md', rule: '发布确认', why: '平台硬约束：发布/回滚需本人 5 分钟内确认', action: '需对齐后才能继续' }] }, note: '只保留用户自定义改动；与平台硬约束冲突会要求对齐，不静默覆盖' })
    }
    return ok({ files: p.files.length ? ['AGENTS.md', 'CLAUDE.md', 'docs/PLATFORM.md', '.deploy/mcp.json', 'skills/'] : ['AGENTS.md'], update_note: '后续模板更新不会自动改动你的项目' })
  }
  if (seg[0] === 'mcp' && seg[1] === 'key') {
    if (method === 'GET') return ok({ fingerprint: mcpKey.fingerprint, status: mcpKey.status, created_at: mcpKey.created_at, last_used_at: mcpKey.last_used_at })
    if (method === 'POST') {
      mcpKey.status = 'active'
      return ok({ plaintext_once: 'mcp_TRIAL_ONLY_xxxxxxxxxxxxxxxxxxxx', fingerprint: 'mcp_9d21****', note: '明文只显示这一次；之后只展示指纹前缀' }, 201)
    }
    if (method === 'DELETE') {
      mcpKey.status = 'revoked'
      return ok({ revoked: true, effective_within_seconds: 60, note: '撤销后 ≤1 分钟所有调用失败' })
    }
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'transfer' && method === 'POST') {
    return ok({ pending_confirmation: true, note: '受让方需在站内确认；已有授权保留；超时作废' })
  }
  if (seg[0] === 'projects' && seg[1] && (seg[2] === 'delete' || seg[2] === 'restore') && method === 'POST') {
    const p = project(seg[1])!
    if (seg[2] === 'delete') {
      if (body.confirm_name !== p.name) return fail(trace, 'project.confirm_mismatch', '确认项目名不一致。', '按提示输入完整项目名。', 422)
      p.status = 'soft_deleted'
      return ok({ status: 'soft_deleted', restore_within_days: 30 })
    }
    p.status = 'active'
    return ok({ status: 'active' })
  }
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'spec' && method === 'PATCH') {
    // GAP-01：只有系统管理员
    if (me.role !== 'sysadmin') {
      return fail(trace, 'authz.forbidden', '项目资源规格与资源上限仅系统管理员可调整。', '联系系统管理员在「系统设置」中调整。', 403, { required_permission: 'project:spec' })
    }
    const p = project(seg[1])!
    p.spec = { ...p.spec, ...(body as Partial<typeof p.spec>) }
    return ok({ spec: p.spec, effective_at: '扩容需重启生效；缩减立即限制' })
  }

  // ---------- 环境 / 发布 ----------
  if (seg[0] === 'projects' && seg[1] && seg[2] === 'environments' && seg.length === 3) {
    const p = project(seg[1])!
    if (method === 'GET') {
      const list = p.environments.filter((e) => (q.kind ? e.kind === q.kind : true))
      // GAP-03/GAP-05：按未删除记录计数；残留与分支删除的记录仍占名额
      const previewCount = p.environments.filter((e) => e.kind === 'preview').length
      return ok({ items: list, preview_count: previewCount, preview_limit: p.spec.preview_limit, gate: p.gate })
    }
    if (method === 'POST') {
      const branch = String(body.branch ?? '').trim()
      if (!branch) return fail(trace, 'preview.branch_required', '请选择要部署的分支。', '选择一个非 main 分支后重试。', 422)
      if (branch === 'main') return fail(trace, 'preview.main_not_allowed', 'main 分支只能发布正式环境。', '选择非 main 分支创建预览。', 422)
      const previews = p.environments.filter((e) => e.kind === 'preview')
      if (previews.length >= p.spec.preview_limit) {
        return fail(trace, 'preview.limit_reached', `已有 ${p.spec.preview_limit} 个预览，未释放名额。`, '先删除不再需要的预览；停止/休眠不释放名额，系统不会自动淘汰。', 429)
      }
      if (previews.some((e) => e.branch === branch)) return fail(trace, 'preview.branch_exists', '该分支已有预览。', '打开已有预览或先删除。', 409)
      const slug = `${p.slug}-${branch.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      const env = {
        id: `env_${Date.now()}`,
        project_id: p.id,
        kind: 'preview' as const,
        branch,
        slug,
        url: `https://${slug}.deploy.internal`,
        state: 'running' as const,
        display_state: 'running' as const,
        replicas: 1,
        last_access_at: null,
        sleep_at: null,
        current: { version_label: 'preview', sha: null, built_at: null },
        retention: { state: 'retained' as const, note: '预览长期保留；正式发布不会删除预览，分支删除只休眠不删除' },
        created_at: '2026-11-20T09:20:00.000Z',
        updated_at: '2026-11-20T09:20:00.000Z',
      }
      p.environments.push(env)
      if (scenario === 'deploy_fail') {
        const t = makeDeployTask(p.id, '', 'preview', false, 'deploy_build_fail', branch)
        return ok({ environment: env, task: { id: t.id, type: 'deploy.preview', poll_after_ms: 3000 } }, 202)
      }
      return ok({ environment: env, task: { id: makeDeployTask(p.id, '', 'preview', false, scenario, branch).id, poll_after_ms: 3000 } }, 202)
    }
  }
  if (seg[0] === 'environments' && seg[1] && seg.length === 2 && method === 'GET') {
    const found = findEnv(seg[1])
    if (!found) return fail(trace, 'preview.not_found', '环境不存在。', '返回部署页刷新列表。', 404)
    return ok(found.env)
  }
  if (seg[0] === 'environments' && seg[1] && action === 'wake' && method === 'POST') {
    const found = findEnv(seg[1])
    if (!found) return fail(trace, 'preview.not_found', '环境不存在。', '刷新后重试。', 404)
    if (found.env.state !== 'sleeping') return fail(trace, 'preview.not_sleeping', '该预览不在休眠状态，无需唤醒。', '直接打开预览地址。', 409)
    if (scenario === 'wake_timeout') return fail(trace, 'preview.wake_timeout', '唤醒超时（已等待 60 秒）。', '重试唤醒，或查看运行日志确认应用是否启动成功。', 504)
    found.env.state = 'running'
    found.env.display_state = 'running'
    found.env.replicas = 1
    found.env.updated_at = '2026-11-20T09:20:00.000Z'
    return ok({ id: found.env.id, display_state: 'running', took_seconds: 18 })
  }
  if (seg[0] === 'environments' && seg[1] && seg[2] === 'deployments' && method === 'GET') {
    const found = findEnv(seg[1])
    if (!found) return fail(trace, 'preview.not_found', '环境不存在。', '刷新后重试。', 404)
    return ok({ items: found.project.deployments.filter((d) => d.env_kind === found.env.kind && (found.env.kind === 'production' || d.branch === found.env.branch)) })
  }
  if (seg[0] === 'environments' && seg[1] && action === 'deploy' && method === 'POST') {
    const found = findEnv(seg[1])
    if (!found) return fail(trace, 'preview.not_found', '环境不存在。', '刷新后重试。', 404)
    const p = found.project
    if (found.env.kind === 'production') {
      if (p.gate.paused) {
        return fail(trace, 'deploy.backup_paused', '已暂停新发布：每日全量备份/异地同步失败。', '已运行环境继续服务；等系统管理员按流程处理并解除暂停后再发布。', 409, { paused_since: p.gate.paused_since })
      }
      const version = String(body.version_label ?? '').trim()
      if (!/^v\d+\.\d+\.\d+$/.test(version)) return fail(trace, 'deploy.version_invalid', '版本标签格式不正确。', '按 v1.2.0 格式填写。', 422)
      if (p.deployments.some((d) => d.version_label === version)) return fail(trace, 'deploy.version_duplicate', `版本标签「${version}」已存在。`, '换一个新的版本标签。', 409)
      if (state.tasks.size > 0 && [...state.tasks.values()].some((t) => t.status === 'running' && t.type.startsWith('deploy.'))) {
        return fail(trace, 'deploy.busy', '该环境已有发布进行中。', '等待当前发布完成；同一环境发布与回滚互斥。', 409)
      }
    }
    const task = makeDeployTask(p.id, String(body.sha ?? p.main.sha), found.env.kind, Boolean(body.backup), scenario, found.env.branch, found.env.id, String(body.version_label ?? ''))
    return ok({ task: { id: task.id, type: task.type, poll_after_ms: 3000 }, accepted: true }, 202)
  }
  if (seg[0] === 'environments' && seg[1] && action === 'rollback' && method === 'POST') {
    const found = findEnv(seg[1])
    if (!found) return fail(trace, 'preview.not_found', '环境不存在。', '刷新后重试。', 404)
    const dep = found.project.deployments.find((d) => d.id === body.deployment_id)
    if (!dep) return fail(trace, 'deploy.record_not_found', '找不到该部署记录。', '刷新记录列表。', 404)
    if (!dep.rollbackable) return fail(trace, 'deploy.record_missing', '该版本的记录/镜像已被底座回收，无法回退。', '选择一条「可回退」的记录。', 409)
    const isOlder = found.project.deployments.filter((d) => d.result === 'success').indexOf(dep) > 0
    if (isOlder && !String(body.reason ?? '').trim()) return fail(trace, 'deploy.reason_required', '回退到更早版本必须填写原因。', '填写原因后重试。', 422)
    if (scenario === 'rollback_smoke_fail') return fail(trace, 'deploy.smoke_failed', '回滚后业务冒烟未连续 2 次通过。', '已保留现场并通知系统管理员，不会自动再次回滚。', 500)
    return ok({ task_id: `task_trial_rollback_${Date.now()}`, target_version: dep.version_label, smoke: '2/2', note: '回滚不会回滚数据库' }, 202)
  }
  if (seg[0] === 'environments' && seg[1] && method === 'DELETE') {
    const found = findEnv(seg[1])
    if (!found) return fail(trace, 'preview.not_found', '环境不存在。', '刷新后重试。', 404)
    if (found.env.kind !== 'preview') return fail(trace, 'preview.cannot_delete_production', '正式环境不能在这里删除。', '正式环境随项目下线处理。', 409)
    if (body.confirm_branch !== found.env.branch) return fail(trace, 'preview.confirm_mismatch', '确认分支名不一致。', '按提示输入分支名。', 422)
    if (scenario === 'delete_residual') {
      found.env.residual = true
      return fail(trace, 'preview.delete_failed', '删除未完成：残留的持久卷无法释放。', '已标记「残留」并告警；请联系系统管理员清理。', 500)
    }
    found.project.environments = found.project.environments.filter((e) => e.id !== found.env.id)
    return ok({ deleted: true, released_slot: true, note: '预览数据（库/桶/持久卷）一并删除，不可恢复' }, 202)
  }
  if (seg[0] === 'tasks' && seg[1] && method === 'GET') {
    const task = state.tasks.get(seg[1])
    if (!task) return fail(trace, 'request.not_found', '任务不存在或已过期。', '刷新页面重新发起。', 404)
    advance(task)
    return ok(task)
  }

  // ---------- 后台：管理员 ----------
  if (seg[0] === 'admin' && seg[1] === 'users') {
    if (method === 'GET') {
      const page = readPaging(asQuery(q), ['q', 'role', 'status', 'page', 'page_size'])
      if (isPagingError(page)) return fail(trace, page.errorCode, '请求参数不合法。', '按页面提供的入口重试（page_size 只接受 10/20/50/100/200）。', 400, page.details)
      // P-14：可分配项随人员列表下发（管理员无权读 /sys/roles）
      const assignable = Object.fromEntries(roleModel.roles.map((r) => [r.role, r.modules.flatMap((m) => m.ops.map((o) => ({ code: o.code, label: o.label, enabled: o.enabled })))]))
      const keyword = String(q.q ?? '').trim().toLowerCase()
      const matched = adminUsersSeed()
        .filter((u) => (q.role ? u.role === String(q.role) : true))
        .filter((u) => (q.status ? u.status === String(q.status) : true))
        .filter((u) => (keyword ? `${u.display_name}${u.feishu_account}`.toLowerCase().includes(keyword) : true))
      return ok({ ...sliceOf(matched, page), assignable_by_role: assignable })
    }
    if (method === 'PATCH' && seg[2]) {
      return ok({ updated: true, effective_within_seconds: 30, audit_recorded: true })
    }
  }
  if (seg[0] === 'admin' && seg[1] === 'groups') {
    if (method === 'GET') return ok({ items: groups, member_limit: 200 })
    if (method === 'POST' && action === 'dissolve') return ok({ dissolved: true, note: '解散后这些授权对成员失效；不删除项目' })
  }
  if (seg[0] === 'admin' && seg[1] === 'platform' && method === 'GET') {
    return ok({ ...platform, params: { build_concurrency: settings.build_concurrency, queue_limit: settings.queue_limit, max_build_concurrency: settings.max_build_concurrency, max_queue_limit: settings.max_queue_limit }, redis, paused: state.paused, gate_projects: projects.filter((p) => p.gate.paused).map((p) => ({ name: p.name, reason: p.gate.reason, since: p.gate.paused_since })) })
  }
  if (seg[0] === 'admin' && seg[1] === 'settings' && method === 'PATCH') {
    // GAP-04：管理员只能调这两项，且压测后只下调
    const key = String(body.key ?? '')
    const value = Number(body.value ?? 0)
    if (key !== 'build_concurrency' && key !== 'queue_limit') {
      return fail(trace, 'authz.forbidden', '该参数仅系统管理员可调整。', '管理员只能调整并发构建数与排队上限这两项。', 403, { required_permission: 'sys:setting' })
    }
    const current = key === 'build_concurrency' ? settings.build_concurrency : settings.queue_limit
    const max = key === 'build_concurrency' ? settings.max_build_concurrency : settings.max_queue_limit
    if (value > current) {
      return fail(trace, 'system.param_raise_forbidden', '按既定规则，压测后并发与队列只可下调、不可上调。', '如需上调，另行变更需求并由系统管理员评估。', 422)
    }
    if (!Number.isInteger(value) || value < 1 || value > max) return fail(trace, 'system.param_out_of_range', '参数超出允许范围。', `填写 1–${max} 之间的整数。`, 422)
    settings[key] = value
    return ok({ key, value, effective_for: 'new_tasks_only', audit_recorded: true })
  }
  if (seg[0] === 'admin' && seg[1] === 'audit' && seg[2] === 'export') {
    const format = String(q.format ?? body.format ?? 'csv')
    if (format === 'csv') {
      // Mock 与 BFF 同契约：返回真实 CSV 文本（12 列候选，T-01 未确认）
      const columns = ['时间', '操作人', '角色', '动作', '对象类型', '对象ID', '项目', '结果', '原因/错误码', '来源IP', 'traceId', '变更摘要']
      const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const lines = [columns.join(',')]
      for (const a of audit) {
        const change = a.before && a.after ? `${a.before} → ${a.after}` : ''
        lines.push([a.at, a.actor, '', a.action, '', a.object, '', a.result, '', a.source_ip, '', change].map(cell).join(','))
      }
      return ok(lines.join('\r\n'))
    }
    return ok({ format: 'json', rows: audit.length, items: audit, columns_confirmed: false, provisional: true })
  }
  if (seg[0] === 'admin' && seg[1] === 'audit' && method === 'GET') {
    const page = readPaging(asQuery(q), ['from', 'to', 'actor', 'action', 'project_id', 'result', 'page', 'page_size'])
    if (isPagingError(page)) return fail(trace, page.errorCode, '请求参数不合法。', '按页面提供的入口重试（page_size 只接受 10/20/50/100/200）。', 400, page.details)
    const action = String(q.action ?? '').trim().toLowerCase()
    const actor = String(q.actor ?? '').trim()
    const result = q.result === undefined ? undefined : String(q.result)
    if (result !== undefined && !['success', 'failed'].includes(result)) {
      return fail(trace, 'request.param_invalid', '结果筛选只接受 success / failed。', '改用页面提供的筛选。', 400, { field: 'result', allowed: ['success', 'failed'] })
    }
    const from = q.from === undefined ? -Infinity : Date.parse(String(q.from))
    const to = q.to === undefined ? Infinity : Date.parse(String(q.to))
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) {
      return fail(trace, 'request.range_invalid', '时间范围不合法。', '把开始时间调到结束时间之前再查。', 400, { field: 'from', from: String(q.from ?? ''), to: String(q.to ?? '') })
    }
    // total 为同过滤条件下的总数（DEF-V02）：不再返回未过滤的 audit.length
    const matched = audit
      .filter((a) => (action ? a.action.toLowerCase().includes(action) : true))
      .filter((a) => (actor ? a.actor.includes(actor) : true))
      .filter((a) => (q.project_id ? a.object.includes(String(q.project_id)) : true))
      .filter((a) => (result ? a.result === result : true))
      .filter((a) => {
        const at = Date.parse(a.at)
        return at >= from && at < to
      })
    return ok({ ...sliceOf(matched, page), csv_columns: 12, csv_columns_confirmed: false, provisional: true, append_only: true, retention_days: 365, note: 'CSV 固定 12 列；具体列名待业务确认（T-01）。total 为同过滤条件下总数。' })
  }

  if (seg[0] === 'admin' && seg[1] === 'alerts') {
    return ok({ items: alerts, levels: ['warning', 'critical'] })
  }

  // ---------- 后台：系统管理员 ----------
  if (seg[0] === 'sys' && seg[1] === 'roles') {
    if (method === 'GET') return ok(roleModel)
    if (method === 'PUT') return ok({ version: 'model-8', effective_within_seconds: 30, audit_recorded: true, affected: { user: 214, admin: 6, sysadmin: 2 } })
  }
  if (seg[0] === 'templates' && method === 'GET') {
    // api-spec §5.6：门户模板库（普通用户可读）
    if (!seg[1]) return ok({ items: templates.filter((t) => t.status !== 'offline'), note: '更新规范不覆盖用户已修改文件' })
    if (seg[2] === 'versions') {
      const t = templates.find((x) => x.id === seg[1])
      if (!t) return fail(trace, 'project.template_unavailable', '模板库暂不可用，所选模板无法加载。', '可回退空白模板继续；不会静默替换已选模板。', 422)
      return ok({ items: [{ version: 'v1.0.0', status: 'active', published_at: '2026-11-10T02:00:00.000Z', semantic: '首版：最小可运行 demo + 规范 + 4 个门户 MCP Skill' }] })
    }
  }
  if (seg[0] === 'environments' && seg[2] === 'logs' && method === 'GET') {
    // api-spec §8.2：按环境取日志（source ∈ build/runtime/history）
    const source = String(q.source ?? 'runtime')
    if (source === 'history' && scenario === 'archive_fail') {
      return fail(trace, 'log.archive_failed', '历史日志转存失败，当前仅能显示实时日志。', '重试转存；不静默丢弃日志。', 503)
    }
    return ok({
      source,
      lines: [
        { at: '2026-11-20T08:39:58.000Z', level: 'info', text: 'GET /healthz 200 12ms' },
        { at: '2026-11-20T08:39:40.000Z', level: 'warn', text: 'user_id=usr_trial_lin request slow 1832ms' },
      ],
      next_cursor: null,
      truncated: false,
      ai_hint: { available: false, reason: 'ai_disabled_by_default' },
      retention_days: 30,
      redacted: true,
    })
  }
  if (seg[0] === 'sys' && seg[1] === 'templates') {
    if (method === 'GET') return ok({ items: templates })
    if (method === 'POST' && seg[3]) {
      const t = templates.find((x) => x.id === seg[2])
      if (!t) return fail(trace, 'system.not_found', '模板不存在。', '刷新模板库。', 404)
      if (seg[3] === 'publish') t.status = 'published'
      if (seg[3] === 'offline') t.status = 'offline'
      return ok({ template: t, note: '下线后不可用于新建项目，已建项目不受影响' })
    }
  }
  if (seg[0] === 'sys' && seg[1] === 'settings' && method === 'GET') {
    return ok({ settings, backups: platform.backups, sync: platform.sync, security: platform.security, paused: state.paused })
  }
  if (seg[0] === 'sys' && seg[1] === 'previews' && seg[2] === 'abnormal' && method === 'GET') {
    return ok({ items: abnormalPreviews, scope_note: '仅三种异常情形；正常预览不进入列表' })
  }
  if (seg[0] === 'sys' && seg[1] === 'previews' && seg[2] === 'cleanup' && method === 'POST') {
    // api-spec §10.6：{ items:[{env_id,reason}], confirm, confirm_text } → 逐条 succeeded/failed
    const items = (body.items ?? []) as { env_id: string; reason: string }[]
    if (!Array.isArray(items) || items.length === 0) return fail(trace, 'cleanup.param_invalid', '未选择要清理的预览。', '至少勾选一项。', 400)
    const expected = `清理 ${items.length} 个异常预览`
    if (body.confirm !== true || body.confirm_text !== expected) {
      return fail(trace, 'cleanup.confirm_required', '缺少第二次确认或确认文案与数量不一致。', `需要二次确认，确认文案为「${expected}」。`, 422, { expected_confirm_text: expected })
    }
    const outside = items.filter((i) => !abnormalPreviews.some((a) => a.id === i.env_id))
    if (outside.length > 0) return fail(trace, 'cleanup.scope_invalid', '选择的预览不在异常范围内。', '只能清理三种异常情形。', 422, { items: outside.map((i) => i.env_id) })
    const succeeded: { env_id: string; branch: string; reason: string; freed_bytes: number }[] = []
    const failed: { env_id: string; errorCode: string; message: string; nextStep: string }[] = []
    for (const i of items) {
      const a = abnormalPreviews.find((x) => x.id === i.env_id)!
      const stuck = a.case === 'undeletable' || scenario === 'cleanup_partial'
      if (stuck) {
        failed.push({ env_id: a.id, errorCode: 'cleanup.per_item_failed', message: '持久卷释放失败，资源仍残留。', nextStep: '重试；仍失败由系统管理员按运维流程处理持久卷。' })
        continue
      }
      succeeded.push({ env_id: a.id, branch: a.branch, reason: i.reason, freed_bytes: a.size_bytes })
      const idx = abnormalPreviews.findIndex((x) => x.id === a.id)
      if (idx >= 0) abnormalPreviews.splice(idx, 1)
    }
    state.cleanupReports.unshift({ at: '2026-11-20T09:20:00.000Z', operator: me.display_name, rows: succeeded.map((r) => ({ id: r.env_id, result: 'deleted' })) })
    return ok({ requested: items.length, succeeded, failed, audit_ids: items.map((_, n) => `aud_cleanup_${Date.now()}_${n}`) })
  }
  if (seg[0] === 'sys' && seg[1] === 'restore' && method === 'POST') {
    if (body.confirm_word !== 'RESTORE') return fail(trace, 'system.confirm_mismatch', '确认词不正确。', '输入 RESTORE 后重试。', 422)
    return ok({ task_id: `task_restore_${Date.now()}`, stages: ['停止写入', '恢复数据库', '恢复文件', '恢复门户授权/模板', '恢复底座记录', '逐项校验'], note: '中断可重试，不留半可用状态；恢复后需逐项校验' }, 202)
  }
  if (seg[0] === 'sys' && seg[1] === 'backup-status') {
    return ok({
      daily: { retry_in_task: 3, failure_counts: 1, pause_on_failure: true, note: '每日全量备份：任务内自动重试 3 次，仍失败计 1 次失败并暂停新发布' },
      sync: { retry_in_task: 0, failure_counts: 1, pause_on_failure: true, note: '异地同步：失败 1 次立即暂停新发布，不先重试 3 次' },
      escalate_after_consecutive: 2,
      paused: state.paused,
      resume_mechanism: 'T-08 原文未定：页面只显示「需系统管理员处理」，不提供自动恢复开关',
    })
  }

  return fail(trace, 'request.not_found', `Mock 未实现该接口：${method} ${req.path}`, '检查路径是否与 api-spec 一致；本 Mock 只覆盖试跑用到的端点。', 404)
}

function adminUsersSeed() {
  return [
    { user_id: 'usr_trial_lin', display_name: '林小满', feishu_account: 'lin.xiaoman', role: 'user', status: 'active', operations: roleOperations.user },
    { user_id: 'usr_trial_zhou', display_name: '周敏', feishu_account: 'zhou.min', role: 'admin', status: 'active', operations: roleOperations.admin },
    { user_id: 'usr_trial_zheng', display_name: '郑巍', feishu_account: 'zheng.wei', role: 'sysadmin', status: 'active', operations: roleOperations.sysadmin },
    { user_id: 'usr_trial_chen', display_name: '陈可', feishu_account: 'chen.ke', role: 'user', status: 'active', operations: roleOperations.user },
    { user_id: 'usr_trial_leave', display_name: '离职同事', feishu_account: 'left.user', role: 'user', status: 'disabled', operations: [] },
  ]
}

function findEnv(id: string): { env: Environment; project: (typeof projects)[number] } | null {
  for (const p of projects) {
    const env = p.environments.find((e) => e.id === id)
    if (env) return { env, project: p }
  }
  return null
}

function makeDeployTask(projectId: string, sha: string, kind: 'preview' | 'production', backup: boolean, scenario: string, branch: string | null, envId?: string, versionLabel?: string): Task {
  const steps: TaskStep[] = [
    { key: 'queued', label: '排队', status: 'pending' },
    { key: 'build', label: '构建（记录实际构建 SHA）', status: 'pending' },
    { key: 'health', label: '健康检查（/healthz → / → TCP）', status: 'pending' },
    ...(backup && kind === 'production' ? [{ key: 'backup', label: '发布前备份（构建成功 → 备份 → 切流）', status: 'pending' as const }] : []),
    { key: 'switch', label: '切换流量', status: 'pending' },
  ]
  const task: Task = {
    id: `task_trial_deploy_${Date.now()}`,
    type: kind === 'production' ? 'deploy.production' : 'deploy.preview',
    status: 'queued',
    phase: 'queued',
    attempt: 1,
    max_attempts: 1,
    steps,
    sha: sha || null,
    version_label: versionLabel ? versionLabel : null,
    created_at: '2026-11-20T09:20:00.000Z',
    finished_at: null,
  }
  state.tasks.set(task.id, task)
  // 场景记录在任务上（Mock 内部字段，真实 BFF 无此字段）
  ;(task as Task & { _scenario?: string; _project?: string; _kind?: string; _branch?: string; _env?: string; _backup?: boolean })._scenario = scenario
  ;(task as Task & { _scenario?: string; _project?: string; _kind?: string; _branch?: string; _env?: string; _backup?: boolean })._project = projectId
  ;(task as Task & { _scenario?: string; _project?: string; _kind?: string; _branch?: string; _env?: string; _backup?: boolean })._kind = kind
  ;(task as Task & { _scenario?: string; _project?: string; _kind?: string; _branch?: string; _env?: string; _backup?: boolean })._branch = branch ?? undefined
  ;(task as Task & { _scenario?: string; _project?: string; _kind?: string; _branch?: string; _env?: string; _backup?: boolean })._env = envId
  ;(task as Task & { _scenario?: string; _project?: string; _kind?: string; _branch?: string; _env?: string; _backup?: boolean })._backup = backup
  return task
}

type InternalTask = Task & { _scenario?: string; _project?: string; _kind?: string; _branch?: string; _env?: string; _backup?: boolean }

/** 每次轮询推进一个阶段（Mock 用轮询次数代替真实时间） */
function advance(task: Task): void {
  if (task.status === 'succeeded' || task.status === 'failed') return
  const t = task as InternalTask
  const order = task.steps.map((s) => s.key)
  const currentIdx = task.steps.findIndex((s) => s.status === 'pending' || s.status === 'running')

  if (currentIdx === 0 && task.steps[0]!.status === 'pending') {
    task.status = 'running'
    task.steps[0]!.status = 'succeeded'
    task.steps[1]!.status = 'running'
    task.phase = 'building'
    return
  }
  if (currentIdx < 0) return

  const cur = task.steps[currentIdx]!
  const next = task.steps[currentIdx + 1]
  const failNow = (code: string, msg: string, nextStep: string) => {
    cur.status = 'failed'
    task.status = 'failed'
    task.phase = 'failed'
    task.finished_at = '2026-11-20T09:30:00.000Z'
    cur.error = { errorCode: code, message: msg, nextStep }
    task.error = cur.error
  }

  if (cur.key === 'build' && t._scenario === 'deploy_build_fail') {
    failNow('deploy.build_failed', '构建失败：npm run build 返回非 0（日志第 42 行：TS2345）。', '查看构建日志修复后重发；不会自动重试。')
    return
  }
  if (cur.key === 'health' && t._scenario === 'deploy_health_fail') {
    failNow('deploy.health_check_failed', '健康检查未通过：/healthz 返回 502，已自动退回上一健康版本。', '查看运行日志与健康检查端点后重发；数据库与数据未改动。')
    return
  }
  if (cur.key === 'backup' && t._scenario === 'deploy_backup_fail') {
    failNow('deploy.backup_failed', '发布前备份失败，已停止发布，仍在原版本，未创建版本标签。', '查看备份失败原因，或联系系统管理员后重发。')
    return
  }
  if (cur.key === 'switch' && t._scenario === 'deploy_timeout') {
    failNow('deploy.timeout', '发布超时（30 分钟），按失败处理，未自动重试。', '联系系统管理员排查；修复后重新发起发布。')
    return
  }

  cur.status = 'succeeded'
  if (!next) {
    task.status = 'succeeded'
    task.phase = 'done'
    task.finished_at = '2026-11-20T09:30:00.000Z'
    applyDeploySuccess(t)
    return
  }
  next.status = 'running'
  task.phase = (next.key === 'build' ? 'building' : next.key === 'health' ? 'healthcheck' : next.key === 'backup' ? 'backup' : next.key === 'switch' ? 'switching' : 'queued')
  if (cur.key === 'queued') {
    task.phase = 'building'
    task.steps[1]!.status = 'running'
  }
}

export function applyDeploySuccess(t: InternalTask): void {
  const p = project(t._project ?? '')
  if (!p) return
  const rec: DeploymentRecord = {
    id: `dep_${Date.now()}`,
    version_label: t.version_label ?? (t._kind === 'production' ? 'v_new' : 'preview'),
    sha: t.sha ?? p.main.sha,
    built_at: '2026-11-20T09:28:00.000Z',
    result: 'success',
    operator: me.display_name,
    probe_level: 'healthz',
    backup_id: t._backup ? `bkp_${Date.now()}` : null,
    rollbackable: true,
    missing_reason: null,
    env_kind: t._kind === 'production' ? 'production' : 'preview',
    branch: t._kind === 'production' ? null : t._branch ?? null,
  }
  p.deployments.unshift(rec)
  p.updated_at = '2026-11-20T09:30:00.000Z'
  const env = p.environments.find((e) => (t._env ? e.id === t._env : e.kind === t._kind))
  if (env) {
    env.current = { version_label: rec.version_label, sha: rec.sha, built_at: rec.built_at }
    env.updated_at = '2026-11-20T09:30:00.000Z'
    if (env.kind === 'production') env.state = 'running'
  }
  if (t._backup) {
    p.backups.unshift({ id: rec.backup_id!, kind: 'pre_publish', created_at: '2026-11-20T09:26:00.000Z', scope: `${p.name} · 全部环境（含预览）`, result: 'success', expires_at: '2026-12-20T09:26:00.000Z', attempts: 1, max_attempts: 3, note: '发布前备份生成记录；预览部署与预览保留不触发备份' })
  }
}

export type { PreviewItem, FileEntry }
