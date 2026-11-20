/**
 * 门户 BFF（试跑实现）
 * 契约来源：api-spec v1.0。实现的边界：
 * - 只经 Dokploy API 适配层读写底座；本试跑用内存仓储替身，不连真实底座/数据库（ENV01–ENV09 未完成）
 * - 会话：真实环境为飞书 OAuth + HttpOnly 会话 Cookie；试跑用 trial 会话端点（显式标注）
 * - 写操作：CSRF 双提交 + 权限系统校验 + 幂等键 + 审计；审计写失败则操作失败
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import { createHash, randomUUID } from 'node:crypto'
import { errorBody, statusOf, type ErrorCode } from './domain/errors.js'
import { adjustParamVerdict, hasOp, requiresOp, PERMISSION_CACHE_TTL_MS, type Role } from './domain/permissions.js'
import { abnormalPreviews, audits, groups, idempotency, me, platform, projects, projectById, settings, shareLinks, tasks, templates, userById, users } from './repo/store.js'
import type { AuditRow, Environment, Project, ShareLink, Task } from './types.js'

const T0 = '2026-11-20T09:20:00.000Z'
/** 试跑日志样本（已脱敏；不含令牌/连接串；正式实现从转存读取） */
const LOG_LINES = [
  { at: '2026-11-20T08:39:58.000Z', level: 'info', message: 'GET /healthz 200 12ms' },
  { at: '2026-11-20T08:39:40.000Z', level: 'warn', message: 'user_id=usr_trial_lin request slow 1832ms path=/api/orders' },
  { at: '2026-11-20T08:38:00.000Z', level: 'error', message: 'upstream timeout after 3000ms (traceId=trc_trial_1)' },
] as const
const DEPLOY = {  queueLimit: 10,
  concurrency: 3,
  timeoutMs: 30 * 60 * 1000,
  pollMs: 3_000,
  wakeTimeoutMs: 60_000,
  idleSleepDays: 7,
  previewLimit: 3,
  smokeCount: 2,
  autoRetry: false,
  cancellable: false,
  maxFileBytes: 100 * 1024 * 1024,
  auditRetentionDays: 365,
  logRetentionDays: 30,
  permissionRevokeSeconds: 30,
  mcpRevokeSeconds: 60,
  publishConfirmSeconds: 300,
}

/** 试跑角色 → 账号映射（真实环境由飞书 OAuth + 内部权限系统给出，不存在此表） */
const ROLE_ACTOR: Record<string, string> = { user: 'usr_trial_lin', admin: 'usr_trial_zhou', sysadmin: 'usr_trial_zheng' }
const ROLES = new Set(['user', 'admin', 'sysadmin'])

/** 授权行 ID：`gr~<projectId>~<user|group>~<subjectId>`（`~` 在路径里合法，且不参与路由参数替换） */
function grantIdOf(projectId: string, subjectType: 'user' | 'group', subjectId: string): string {
  return `gr~${projectId}~${subjectType}~${subjectId}`
}

function parseGrantId(grantId: string): { projectId: string; subjectType: 'user' | 'group'; subjectId: string } | null {
  const m = /^gr~([^~]+)~(user|group)~(.+)$/.exec(grantId)
  if (!m) return null
  return { projectId: m[1]!, subjectType: m[2] as 'user' | 'group', subjectId: m[3]! }
}

export interface AppOptions {
  /** 审计写入失败开关（测试 audit.write_failed → 操作失败） */
  auditFail?: () => boolean
  /** 故障注入（仅试跑；真实环境忽略该参数） */
  allowScenario?: boolean
  /** 试跑 server：后台自动推进任务（真实由 Dokploy 事件驱动；测试里保持轮询驱动以便断言中间态） */
  autoAdvanceTasks?: boolean
}

interface Actor {
  id: string
  name: string
  role: Role
  csrf: string | null
}

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string
    actor: Actor | null
    scenario: string
  }
}

/**
 * api-spec 规范路径 → 本试跑实现既有路径的兼容映射（只做名称/形状兼容，不改变业务语义）。
 * 目的：让「按契约写的调用」与「试跑前端既有调用」都能命中同一处理逻辑；
 * 契约中没有的路径不在此表，未匹配仍走 404 `request.path_unknown`。
 */
function rewriteSpecAliases(req: { method?: string; url?: string }): string {
  const method = (req.method ?? 'GET').toUpperCase()
  // 1) 动作式 `:action` → `/action`（api-spec 用 `/environments/{id}:wake` 写法）
  const url = (req.url ?? '').replace(/:([a-z_]+)(?=\?|$)/, '/$1')
  const qIdx = url.indexOf('?')
  const rawPath = (qIdx >= 0 ? url.slice(0, qIdx) : url).replace(/\/+$/, '') || '/'
  const query = qIdx >= 0 ? url.slice(qIdx) : ''
  const prefix = rawPath.startsWith('/api/v1') ? '/api/v1' : ''
  const path = prefix ? rawPath.slice(prefix.length) || '/' : rawPath
  const out = (p: string) => `${prefix}${p}${query}`

  if (method === 'GET' && path === '/groups') return out('/admin/groups')
  if (method === 'POST' && path === '/admin/restores') return out('/sys/restore')
  let m = /^\/groups\/([^/]+)\/dissolve$/.exec(path)
  if (method === 'POST' && m) return out(`/admin/groups/${m[1]}/dissolve`)
  m = /^\/admin\/templates\/([^/]+)\/versions$/.exec(path)
  if (method === 'POST' && m) return out(`/sys/templates/${m[1]}/publish`)
  m = /^\/admin\/templates\/([^/]+)\/deprecate$/.exec(path)
  if (method === 'POST' && m) return out(`/sys/templates/${m[1]}/offline`)
  m = /^\/projects\/([^/]+)\/access-pack$/.exec(path)
  if (method === 'POST' && m) return out(`/projects/${m[1]}/access-pack/update`)
  return url
}

/** 试跑开关必须显式 opt-in（F-03）：未设置或非 `true` 时一律关闭。 */
export function trialOptionsFromEnv(env: NodeJS.ProcessEnv): AppOptions {
  const on = env.TRIAL_SCENARIO === '1'
  return { allowScenario: on, autoAdvanceTasks: on }
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  // 故障注入与「同步推进任务」都是试跑专用能力：**默认关闭**，只有显式 opt-in 才生效。
  const allowScenario = opts.allowScenario === true
  const autoAdvanceTasks = opts.autoAdvanceTasks === true
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    // 先做 api-spec 兼容映射与 `:动作` 归一化，再进入路由匹配
    rewriteUrl: rewriteSpecAliases,
  })
  app.register(cookie)

  const traceId = (req: FastifyRequest) => (req.headers['x-request-id'] as string | undefined) ?? `trc_${randomUUID().slice(0, 8)}`

  app.addHook('onRequest', async (req, reply) => {
    req.traceId = traceId(req)
    reply.header('X-Trace-Id', req.traceId)
    reply.header('X-Mock', 'true')
    const sc = req.query as Record<string, unknown>
    req.scenario = allowScenario ? String(sc.scenario ?? '') : ''
    // 身份注入同样是试跑替身：非试跑模式下一律不认（fail-safe，避免误部署后被冒充）
    const cookieUser = allowScenario ? (req.cookies['trial_user'] ?? null) : null
    const headerUser = allowScenario ? ((req.headers['x-trial-user'] as string | undefined) ?? null) : null
    // 真实环境：会话 Cookie 由 OAuth 回调建立，前端不可读；这里只做试跑替身
    // 试跑：QA 契约脚本以 X-QA-Role 声明身份（真实环境不存在该头，且 allowScenario=false 时忽略）
    const qaRole = allowScenario ? (req.headers['x-qa-role'] as string | undefined) : null
    const qaUser = qaRole ? ROLE_ACTOR[qaRole] : undefined
    // 试跑：UI 角色切换落服务端（写 trial_role Cookie）。真实环境没有这个 Cookie，
    // 角色只来自 OAuth + 内部权限系统；此处仍是试跑替身，不改变权限模型。
    const cookieRole = allowScenario ? (req.cookies['trial_role'] ?? null) : null
    const roleUser = cookieRole ? ROLE_ACTOR[cookieRole] : undefined
    const userId = qaUser ?? roleUser ?? headerUser ?? cookieUser
    const u = userId ? userById(userId) : undefined
    const csrfFromCookie = req.cookies['trial_csrf'] ?? null
    req.actor =
      u && u.status === 'active'
        ? { id: u.user_id, name: u.display_name, role: u.role, csrf: qaUser ? (req.headers['x-csrf-token'] as string | undefined) ?? 'qa' : csrfFromCookie }
        : null
  })

  function opPath(req: FastifyRequest): string {
    return (req.url.split('?')[0] ?? '').replace(/^\/api\/v1/, '').replace(/:([a-z_]+)(?=\?|$)/, '/$1')
  }

  function fail(reply: FastifyReply, code: ErrorCode, trace: string, details?: Record<string, unknown>, statusOverride?: number) {
    return reply.code(statusOverride ?? statusOf(code)).send(errorBody(code, trace, details))
  }

  function publicRoutes(req: FastifyRequest): boolean {
    const p = req.url.split('?')[0] ?? ''
    return p.endsWith('/healthz') || p.endsWith('/health') || p.includes('/auth/trial-login') || p.includes('/auth/trial-role') || p.includes('/auth/feishu/start') || p.includes('/setup/status')
  }

  function guard(req: FastifyRequest, reply: FastifyReply): boolean {
    if (publicRoutes(req)) return true
    if (!req.actor) {
      fail(reply, 'auth.unauthenticated', req.traceId)
      return false
    }
    return true
  }

  /** 写操作：CSRF 双提交 + 权限位 + 权限系统可用性（fail-closed） */
  function guardWrite(req: FastifyRequest, reply: FastifyReply): boolean {
    // 登录入口本身不能被 CSRF/权限系统可用性拦住，否则权限系统故障时谁也进不来
    if (publicRoutes(req)) return true
    const isRead = req.method === 'GET' || req.method === 'HEAD'
    if (isRead) {
      // 读也要按权限位判定；只是不需要 CSRF
      const readOp = requiresOp(req.method, opPath(req))
      if (readOp && !hasOp(req.actor!.role, readOp)) {
        fail(reply, 'authz.forbidden', req.traceId, { required: readOp })
        return false
      }
      return true
    }
    if (!platform.authz_ok || req.scenario === 'authz_down') {
      fail(reply, 'authz.unavailable', req.traceId)
      return false
    }
    // 试跑：QA 契约脚本无法走浏览器拿双提交 Cookie，声明 X-QA-Role 时豁免 CSRF。
    // 只在 allowScenario=true（试跑）下存在；正式环境必须删除该豁免。
    const qaHarness = allowScenario && Boolean(req.headers['x-qa-role'])
    const token = (req.headers['x-csrf-token'] as string | undefined) ?? null
    if (!qaHarness && (!req.actor?.csrf || !token || token !== req.actor.csrf)) {
      fail(reply, 'auth.csrf_invalid', req.traceId)
      return false
    }
    const need = requiresOp(req.method, opPath(req))
    if (need && !hasOp(req.actor!.role, need)) {
      fail(reply, 'authz.forbidden', req.traceId, { required: need })
      return false
    }
    return true
  }

  function audit(req: FastifyRequest, action: string, target: { kind: string; id: string }, result: 'success' | 'failed', errorCode?: string, detail = ''): boolean {
    if (opts.auditFail?.()) return false
    const row: AuditRow = {
      id: `aud_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      actor_id: req.actor?.id ?? 'anonymous',
      actor_name: req.actor?.name ?? '未登录',
      action,
      target_kind: target.kind,
      target_id: target.id,
      result,
      error_code: errorCode ?? null,
      ip: req.ip,
      detail,
      trace_id: req.traceId,
    }
    audits.unshift(row)
    return true
  }

  /** 写操作统一包装：先审计，审计成功才执行（无审计 = 不写） */
  function write<T>(req: FastifyRequest, reply: FastifyReply, meta: { action: string; target: { kind: string; id: string }; detail?: string }, fn: () => { status?: number; body: unknown } ): FastifyReply {
    if (!audit(req, meta.action, meta.target, 'success', undefined, meta.detail)) {
      return fail(reply, 'audit.write_failed', req.traceId)
    }
    const out = fn()
    return reply.code(out.status ?? 200).send(out.body)
  }

  /** 幂等：同键同体返回首次结果；同键异体报冲突 */
  function withIdempotency(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
    if (req.method === 'GET') return null
    const key = req.headers['idempotency-key'] as string | undefined
    if (!key) return null
    const hash = createHash('sha256').update(`${req.method} ${req.url} ${JSON.stringify(req.body ?? {})}`).digest('hex')
    const prev = idempotency.get(key)
    if (prev) {
      if (prev.requestHash !== hash) {
        fail(reply, 'request.idempotency_conflict', req.traceId)
        return reply
      }
      reply.header('Idempotent-Replay', 'true')
      reply.code(prev.status).send(prev.response)
      return reply
    }
    idempotency.set(key, { requestHash: hash, response: { pending: true }, status: 202 })
    return null
  }

  /**
   * 幂等键只在「真正成功」后占用：失败响应必须释放占位，否则同一键重试会被
   * 占位记录回放成 202 pending，把一次 403/422 伪装成「已受理」。
   */
  app.addHook('onSend', async (req, reply, payload) => {
    const key = req.headers['idempotency-key'] as string | undefined
    if (!key) return payload
    const entry = idempotency.get(key)
    if (!entry) return payload
    if (reply.statusCode >= 400) {
      idempotency.delete(key)
      return payload
    }
    const pending = (entry.response as { pending?: boolean } | null)?.pending === true
    if (pending) {
      let parsed: unknown = payload
      if (typeof payload === 'string') {
        try {
          parsed = JSON.parse(payload)
        } catch {
          parsed = payload
        }
      }
      idempotency.set(key, { requestHash: entry.requestHash, response: parsed, status: reply.statusCode })
    }
    return payload
  })

  function rememberIdempotency(req: FastifyRequest, status: number, body: unknown) {
    const key = req.headers['idempotency-key'] as string | undefined
    if (!key) return
    const hash = createHash('sha256').update(`${req.method} ${req.url} ${JSON.stringify(req.body ?? {})}`).digest('hex')
    idempotency.set(key, { requestHash: hash, response: body, status })
  }

  /** 试跑：真实由 Dokploy 事件推进任务；内存替身里对超龄(>6s)未轮询的任务直接推进到底，避免一直占着 env 造成假「发布中」 */
  /**
   * 试跑 server：内存替身没有 Dokploy 事件流，任务在创建后同步推进到终态，
   * 这样「同一环境互斥」不会被假的「发布中」长期占用。
   * 业务规则不变：失败不切流、超时 30 分钟、不自动重试；测试里 autoAdvanceTasks=false，
   * 仍由 /tasks/{id} 轮询推进一步，便于断言中间态。
   */
  function scheduleAdvance(task: Task) {
    for (let i = 0; i < 12 && task.status === 'running'; i += 1) advance(task, '')
  }

  function sweepEnvTasks(envId: string, maxAgeMs: number) {
    const now = Date.now()
    for (const task of tasks.values()) {
      if (task.status !== 'running') continue
      if ((task as Task & { container?: string }).container !== envId) continue
      if (now - Date.parse(task.created_at) < maxAgeMs) continue
      for (let i = 0; i < 12 && task.status === 'running'; i += 1) advance(task, '')
    }
  }

  function sweepStaleTasks() {
    const now = Date.now()
    for (const task of tasks.values()) {
      if (task.status !== 'running') continue
      if (now - Date.parse(task.created_at) < 6_000) continue
      for (let i = 0; i < 12 && task.status === 'running'; i += 1) advance(task, '')
    }
  }

  app.addHook('preHandler', async (req, reply) => {
    if (!guard(req, reply)) return reply
    if (!guardWrite(req, reply)) return reply
    sweepStaleTasks()
    const replay = withIdempotency(req, reply)
    if (replay) return reply
  })

  // ---------------- 健康检查 ----------------
  app.get('/healthz', async (_req, reply) => reply.code(200).send({ ok: true, version: '0.1.0-trial', checks: { authz: platform.authz_ok, dokploy: platform.dokploy_ok } }))

  // ---------------- 认证 ----------------
  app.get('/api/v1/setup/status', async () => ({ bootstrap_done: true, admin_open_id_configured: false, note: '首个管理员 open_id 为占位（T-02 待提供）' }))

  app.post('/api/v1/auth/trial-login', async (req, reply) => {
    if (!allowScenario) return fail(reply, 'request.path_unknown', req.traceId, { note: '试跑专用登录在非试跑模式（未设 TRIAL_SCENARIO=1）下关闭。' })
    // 试跑专用：不跳真实飞书。真实环境由 /auth/feishu/start → 回调建立 HttpOnly 会话。
    const csrf = `csrf_${randomUUID()}`
    reply.setCookie('trial_user', me.user_id, { httpOnly: true, sameSite: 'lax', path: '/' })
    reply.setCookie('trial_csrf', csrf, { httpOnly: false, sameSite: 'lax', path: '/' })
    // 新会话默认回到普通用户，避免上一个会话的角色渗到下一次走查
    reply.setCookie('trial_role', 'user', { httpOnly: true, sameSite: 'lax', path: '/' })
    return reply.code(200).send({ ...me, trial_only: true })
  })

  /**
   * 试跑专用：把「试跑角色切换」落到服务端会话（写 trial_role Cookie）。
   * 真实环境没有这个端点：应用角色只来自内部权限系统，前端不得自定角色。
   * 幂等且不写业务审计（改的是试跑会话，不是业务数据）。
   */
  app.post('/api/v1/auth/trial-role', async (req, reply) => {
    if (!allowScenario) return fail(reply, 'request.path_unknown', req.traceId, { note: '试跑角色切换仅在 TRIAL_SCENARIO=1 下可用。' })
    const role = String(((req.body ?? {}) as { role?: unknown }).role ?? '')
    if (!ROLES.has(role)) return fail(reply, 'request.param_invalid', req.traceId, { field: 'role', allowed: ['user', 'admin', 'sysadmin'] })
    const u = userById(ROLE_ACTOR[role]!)
    if (!u) return fail(reply, 'request.param_invalid', req.traceId, { field: 'role' })
    reply.setCookie('trial_user', u.user_id, { httpOnly: true, sameSite: 'lax', path: '/' })
    reply.setCookie('trial_role', role, { httpOnly: true, sameSite: 'lax', path: '/' })
    return {
      user_id: u.user_id,
      display_name: u.display_name,
      role: u.role,
      groups: u.groups,
      operations: u.operations,
      session_expires_at: '2026-11-20T17:20:00.000Z',
      trial_only: true,
      note: '仅试跑会话：应用角色仍由服务端权限位校验，前端不成为安全边界。',
    }
  })

  const feishuStart = async (req: FastifyRequest) => {
    const redirect = String((req.query as Record<string, unknown>).redirect ?? '/dashboard')
    return { redirect_url: `https://open.feishu.cn/open-apis/authen/v1/authorize?state=trial`, state: 'trial', redirect_hint: redirect, note: '真实 OAuth 未接通（ENV 未完成）' }
  }
  // api-spec §4.1 用 POST；试跑登录页为了方便跳转也接受 GET（试跑专用，正式环境删除）
  app.post('/api/v1/auth/feishu/start', feishuStart)
  app.get('/api/v1/auth/feishu/start', feishuStart)

  app.post('/api/v1/auth/logout', async (_req, reply) => {
    reply.clearCookie('trial_user', { path: '/' })
    reply.clearCookie('trial_csrf', { path: '/' })
    reply.clearCookie('trial_role', { path: '/' })
    return { ok: true }
  })

  app.get('/api/v1/me', async (req) => {
    const u = userById(req.actor!.id)!
    return { user_id: u.user_id, display_name: u.display_name, role: u.role, groups: u.groups, operations: u.operations, session_expires_at: '2026-11-20T17:20:00.000Z', mock: true }
  })

  // ---------------- 项目 ----------------
  const cardOf = (p: Project, req: FastifyRequest) => {
    const rel = relationOfProject(p, req.actor!.id, userById(req.actor!.id)?.groups ?? [])
    const previews = p.environments.filter((e) => e.kind === 'preview')
    const recent = previews[0] ?? null
    const prod = p.environments.find((e) => e.kind === 'production') ?? null
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      status: p.status,
      owner: { user_id: p.owner_id, display_name: p.owner_name },
      relation: rel.relation,
      relation_label: rel.relation_label,
      preview: {
        state: previews.length === 0 ? 'not_created' : recent?.display_state ?? 'not_created',
        total: previews.length,
        limit: p.spec.preview_limit,
        branch: recent?.branch ?? null,
        url: recent?.url ?? null,
        items: previews.map((e) => ({ id: e.id, branch: e.branch, url: e.url, display_state: e.display_state, last_access_at: e.last_access_at, branch_deleted: Boolean(e.branch_deleted), residual: Boolean(e.residual), updated_at: e.updated_at })),
      },
      production: { state: prod?.display_state ?? 'not_created', url: prod?.url ?? null, sha: prod?.current.sha ?? null, version_label: prod?.current.version_label ?? null, updated_at: prod?.updated_at ?? null },
      quota: { used_bytes: p.quota_used_bytes, limit_bytes: p.spec.disk_bytes, ratio: Number((p.quota_used_bytes / p.spec.disk_bytes).toFixed(4)), level: p.quota_used_bytes / p.spec.disk_bytes >= 1 ? 'blocked' : p.quota_used_bytes / p.spec.disk_bytes >= 0.8 ? 'warn' : 'normal', collected_at: T0 },
      spec: p.spec,
      updated_at: p.updated_at,
    }
  }

  app.get('/api/v1/projects', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const items = projects
      .filter((p) => (req.actor!.role === 'sysadmin' ? true : relationOfProject(p, req.actor!.id, userById(req.actor!.id)?.groups ?? []).relation !== 'none'))
      .filter((p) => (q.status === 'soft_deleted' ? p.status === 'soft_deleted' : q.status === 'all' ? true : p.status === 'active'))
      .map((p) => cardOf(p, req))
    return { items, total: items.length, page: 1, page_size: 20, has_next: false }
  })

  app.get('/api/v1/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    return {
      ...cardOf(p, req),
      created_at: p.created_at,
      grant_summary: { people: p.grant_people.length, groups: p.grant_groups.length, limit_people: 50, limit_groups: 10 },
      gate: p.gate,
      deleted: p.status === 'soft_deleted',
    }
  })

  /** api-spec §5.3：只允许改名；slug 不可变；拥有者变更必须走 transfer */
  app.patch('/api/v1/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    if (p.owner_id !== req.actor!.id && req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId, { required: '拥有者或系统管理员' })
    const body = (req.body ?? {}) as Record<string, unknown>
    if ('slug' in body && body.slug !== p.slug) return fail(reply, 'project.slug_immutable', req.traceId, { field: 'slug' })
    if ('owner_user_id' in body) return fail(reply, 'request.param_invalid', req.traceId, { field: 'owner_user_id', note: '拥有者变更走 POST /projects/{id}/transfer' })
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return fail(reply, 'request.param_invalid', req.traceId, { field: 'name' })
    return write(req, reply, { action: 'project.update', target: { kind: 'project', id }, detail: `name ${p.name} -> ${name}` }, () => {
      p.name = name
      return { body: { id: p.id, name: p.name, slug: p.slug } }
    })
  })

  app.get('/api/v1/projects/:id/main', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    return { sha: '3f2a9c1be7d94c20a5f1', message: 'feat: 预览保留与发布顺序调整', author: '林小满', committed_at: '2026-11-19T14:00:00.000Z', version_labels: ['v1.2.0', 'v1.1.0'] }
  })

  app.post('/api/v1/projects', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (req.scenario === 'template_down') return fail(reply, 'project.template_unavailable', req.traceId)
    const name = String(body.name ?? '').trim()
    if (!name) return fail(reply, 'request.invalid', req.traceId, { field: 'name' })
    if (projects.some((p) => p.name === name)) return fail(reply, 'project.name_conflict', req.traceId)
    if (!body.template_id) return fail(reply, 'request.invalid', req.traceId, { field: 'template_id' })
    const taskId = `task_${randomUUID().slice(0, 8)}`
    const task: Task = {
      id: taskId,
      type: 'project.create',
      status: 'running',
      phase: 'repo',
      attempt: 1,
      max_attempts: 1,
      steps: [
        { key: 'db', label: '创建数据库', status: 'done' },
        { key: 'repo', label: '创建代码仓库', status: 'running' },
        { key: 'template', label: '注入模板与规范', status: 'pending' },
        { key: 'resources', label: '开通资源', status: 'pending' },
        { key: 'envs', label: '创建预览与正式环境', status: 'pending' },
        { key: 'webhook', label: '安装预览 Webhook（正式环境不装）', status: 'pending' },
      ],
      created_at: new Date().toISOString(),
      finished_at: null,
    }
    const created: Project = {
      id: `prj_trial_${projects.length + 1}`,
      name,
      slug: String(body.slug ?? `app-${projects.length + 1}`),
      status: 'active',
      owner_id: req.actor!.id,
      owner_name: req.actor!.name,
      relation: 'owner',
      relation_label: '你是拥有者',
      spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4 * 1024 ** 3, preview_limit: 3 },
      quota_used_bytes: 0,
      gate: { paused: false, reason: null, paused_since: null, resume_mechanism: 'T-08_undefined' },
      grant_people: [],
      grant_groups: [],
      environments: [],
      deployments: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    return write(req, reply, { action: 'project.create', target: { kind: 'project', id: created.id }, detail: name }, () => {
      projects.push(created)
      tasks.set(taskId, task)
      const out = { project: cardOf(created, req), task: { id: taskId } }
      rememberIdempotency(req, 201, out)
      return { status: 201, body: out }
    })
  })

  // ---------------- 环境 / 预览 ----------------
  app.get('/api/v1/projects/:id/environments', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const kind = (req.query as Record<string, string | undefined>).kind
    const items = p.environments.filter((e) => (kind ? e.kind === kind : true))
    // GAP-03/GAP-05：按未删除记录计数，休眠与残留都占名额
    const previewCount = p.environments.filter((e) => e.kind === 'preview').length
    return { items, preview_count: previewCount, preview_limit: p.spec.preview_limit, gate: p.gate }
  })

  app.post('/api/v1/projects/:id/environments', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const body = (req.body ?? {}) as Record<string, unknown>
    const branch = String(body.branch ?? '').trim()
    if (!branch || branch === 'main') return fail(reply, 'request.invalid', req.traceId, { field: 'branch' })
    const previews = p.environments.filter((e) => e.kind === 'preview')
    if (req.scenario === 'preview_limit' || previews.length >= p.spec.preview_limit) {
      return fail(reply, 'preview.limit_reached', req.traceId, { limit: p.spec.preview_limit, used: previews.length })
    }
    const slug = `${p.slug}-${branch.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`.slice(0, 63)
    const created: Environment = {
      id: `env_${randomUUID().slice(0, 8)}`,
      project_id: p.id,
      kind: 'preview',
      branch,
      slug,
      url: `https://${slug}.deploy.internal`,
      display_state: 'running',
      replicas: 1,
      last_access_at: new Date().toISOString(),
      current: { version_label: null, sha: null, built_at: null },
      retention: { state: 'retained', note: '预览长期保留：正式发布不会删除预览，分支删除只休眠不删除。' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const previewTaskId = `task_${randomUUID().slice(0, 8)}`
    const previewTask: Task = {
      id: previewTaskId,
      type: 'preview.create',
      status: 'running',
      phase: 'env',
      attempt: 1,
      max_attempts: 1,
      steps: [
        { key: 'env', label: '创建预览环境', status: 'running' },
        { key: 'webhook', label: '安装预览 Webhook（MR 开放不销毁）', status: 'pending' },
      ],
      created_at: new Date().toISOString(),
      finished_at: null,
    }
    return write(req, reply, { action: 'preview.create', target: { kind: 'environment', id: created.id }, detail: branch }, () => {
      p.environments.push(created)
      tasks.set(previewTaskId, previewTask)
      const out = { environment: created, task: { id: previewTaskId } }
      rememberIdempotency(req, 201, out)
      return { status: 201, body: out }
    })
  })

  app.post('/api/v1/environments/:id/wake', async (req, reply) => {
    const env = findEnv((req.params as { id: string }).id)
    if (!env) return fail(reply, 'project.not_found', req.traceId)
    if (req.scenario === 'wake_timeout') return fail(reply, 'preview.wake_timeout', req.traceId, { timeout_ms: DEPLOY.wakeTimeoutMs })
    return write(req, reply, { action: 'preview.wake', target: { kind: 'environment', id: env.id } }, () => {
      if (env.display_state === 'sleeping') {
        env.display_state = 'running'
        env.replicas = 1
        env.last_access_at = new Date().toISOString()
      }
      return { body: { id: env.id, display_state: env.display_state, took_seconds: 12 } }
    })
  })

  app.delete('/api/v1/environments/:id', async (req, reply) => deletePreview(req, reply))

  function deletePreview(req: FastifyRequest, reply: FastifyReply) {
    const env = findEnv((req.params as { id: string }).id)
    if (!env || env.kind !== 'preview') return fail(reply, 'project.not_found', req.traceId)
    // 删除预览同样受数据权限约束：不可见项目的环境一律按不存在处理
    if (!visibleProject(req, env.project_id)) return fail(reply, 'env.not_found', req.traceId)
    if (env.branch_deleted) return fail(reply, 'preview.branch_deleted', req.traceId)
    const body = (req.body ?? {}) as Record<string, unknown>
    if (String(body.confirm_branch ?? '') !== String(env.branch ?? '')) return fail(reply, 'request.invalid', req.traceId, { field: 'confirm_branch' })
    if (req.scenario === 'delete_residual') {
      env.residual = true
      return write(req, reply, { action: 'preview.delete', target: { kind: 'environment', id: env.id }, detail: '残留' }, () => ({ status: 202, body: { deleted: false, released_slot: false, residual: true, nextStep: '资源残留，需系统管理员手工清理（GAP-05）。' } }))
    }
    const p = projectById(env.project_id)!
    p.environments = p.environments.filter((e) => e.id !== env.id)
    return write(req, reply, { action: 'preview.delete', target: { kind: 'environment', id: env.id } }, () => ({ body: { deleted: true, released_slot: true } }))
  }

  // ---------------- 发布 / 回滚 ----------------
  app.post('/api/v1/environments/:id/deploy', async (req, reply) => {
    const env = findEnv((req.params as { id: string }).id)
    if (!env) return fail(reply, 'env.not_found', req.traceId)
    const p = projectById(env.project_id)!
    const body = (req.body ?? {}) as Record<string, unknown>
    // 「只发 main HEAD」：请求里带 branch/sha 一律拒绝，不给历史提交发布入口
    if (body.sha !== undefined || body.branch !== undefined) {
      return fail(reply, 'request.param_invalid', req.traceId, { fields: ['sha', 'branch'], note: '只发布 main 的最新提交；不接受指定提交/分支。' })
    }
    // 发布闸门只挡新发布；已运行环境与读取继续服务（GAP-06）
    const gatePaused = p.gate.paused || (allowScenario && req.headers['x-qa-gate'] === 'paused')
    if (gatePaused && env.kind === 'production') {
      return fail(reply, 'deploy.backup_paused', req.traceId, { reason: p.gate.reason, paused_since: p.gate.paused_since, resume_mechanism: p.gate.resume_mechanism ?? 'T-08_undefined' })
    }
    // 数据权限：只能对自己可见的项目环境发布（不泄露存在性）
    if (!visibleProject(req, env.project_id)) return fail(reply, 'env.not_found', req.traceId)
    // 请求前置校验先于状态判定：缺幂等键是 400，不应被「已有发布在进行」的 409 掩盖
    if (!(req.headers['idempotency-key'] as string | undefined)) {
      return fail(reply, 'request.idempotency_required', req.traceId, { header: 'Idempotency-Key', note: '发布类写操作必须带幂等键，防重复提交。' })
    }
    sweepEnvTasks(env.id, 1_200)
    if (busy(env.id)) return fail(reply, 'deploy.already_running', req.traceId)
    const queued = [...tasks.values()].filter((t) => t.status === 'queued').length
    if (queued >= settings.queue_limit) return fail(reply, 'deploy.queue_full', req.traceId, { limit: settings.queue_limit })
    const versionLabel = String(body.version_label ?? '') || `v1.${p.deployments.length + 3}.0`
    if (body.version_label !== undefined) {
      if (!/^v\d+\.\d+\.\d+$/.test(versionLabel)) return fail(reply, 'request.param_invalid', req.traceId, { field: 'version_label', note: '形如 v1.2.0' })
      if (p.deployments.some((d) => d.version_label === versionLabel)) return fail(reply, 'request.param_invalid', req.traceId, { field: 'version_label', note: '该版本标签已存在' })
    }
    const withBackup = env.kind === 'production' && body.backup !== false && body.pre_deploy_backup !== false
    const steps = [
      { key: 'queued', label: '排队', status: 'done' as const },
      { key: 'building', label: '构建', status: 'running' as const },
      { key: 'healthcheck', label: '健康检查', status: 'pending' as const },
      ...(withBackup ? [{ key: 'backup', label: '发布前备份', status: 'pending' as const }] : []),
      { key: 'switching', label: '切换流量', status: 'pending' as const },
    ]
    const taskId = `task_${randomUUID().slice(0, 8)}`
    const task: Task = {
      id: taskId,
      type: env.kind === 'production' ? 'deploy.production' : 'deploy.preview',
      status: 'running',
      phase: 'building',
      attempt: 1,
      max_attempts: 1,
      steps,
      sha: '3f2a9c1be7d94c20a5f1',
      version_label: versionLabel,
      created_at: new Date().toISOString(),
      finished_at: null,
    }
    ;(task as Task & { container?: string; with_backup?: boolean }).container = env.id
    ;(task as Task & { with_backup?: boolean }).with_backup = withBackup
    ;(task as Task & { scenario?: string }).scenario = req.scenario
    return write(req, reply, { action: 'deploy.start', target: { kind: 'environment', id: env.id }, detail: `${versionLabel} sha=3f2a9c1` }, () => {
      tasks.set(taskId, task)
      if (autoAdvanceTasks) scheduleAdvance(task)
      // 预览部署不产生备份记录（api-spec 10.2）：即使请求勾选备份也返回 required=false
      const out = { task: { id: taskId, status: 'running', poll_after_ms: DEPLOY.pollMs, backup: { required: withBackup, kind: withBackup ? 'pre_deploy' : null }, sha: task.sha, version_label: versionLabel } }
      rememberIdempotency(req, 202, out)
      return { status: 202, body: out }
    })
  })

  app.get('/api/v1/environments/:id/deployments', async (req, reply) => {
    const env = findEnv((req.params as { id: string }).id)
    if (!env) return fail(reply, 'project.not_found', req.traceId)
    const p = visibleProject(req, env.project_id)
    if (!p) return fail(reply, 'env.not_found', req.traceId)
    return { items: p.deployments.filter((d) => d.container === env.id) }
  })

  app.post('/api/v1/environments/:id/rollback', async (req, reply) => {
    const env = findEnv((req.params as { id: string }).id)
    if (!env) return fail(reply, 'project.not_found', req.traceId)
    const body = (req.body ?? {}) as Record<string, unknown>
    const p = projectById(env.project_id)!
    if (!visibleProject(req, env.project_id)) return fail(reply, 'env.not_found', req.traceId)
    // 回滚同为发布类写操作：幂等键必填（api-spec §7.5）
    if (!(req.headers['idempotency-key'] as string | undefined)) {
      return fail(reply, 'request.idempotency_required', req.traceId, { header: 'Idempotency-Key', note: '回滚必须带幂等键，防重复触发。' })
    }
    const dep = p.deployments.find((d) => d.id === String(body.deployment_id ?? ''))
    if (!dep || dep.container !== env.id) return fail(reply, 'rollback.target_missing', req.traceId)
    if (!dep.rollbackable) return fail(reply, 'rollback.target_missing', req.traceId, { reason: dep.missing_reason })
    if (busy(env.id)) return fail(reply, 'deploy.already_running', req.traceId)
    return write(req, reply, { action: 'deploy.rollback', target: { kind: 'environment', id: env.id }, detail: `${dep.version_label} ${String(body.reason ?? '')}` }, () => {
      env.current = { version_label: dep.version_label, sha: dep.sha, built_at: new Date().toISOString() }
      return { body: { target_version: dep.version_label, smoke: `回滚后需连续 ${DEPLOY.smokeCount} 次业务冒烟通过；数据库不会被回滚` } }
    })
  })

  // 试跑：任务推进用「轮询一次推进一步」模拟底座回调（真实由 Dokploy 事件驱动）
  // 试跑诊断用：列出内存任务（正式环境删除；不含任何凭据）
  app.get('/api/v1/tasks', async () => ({ items: [...tasks.values()].map((t) => ({ id: t.id, type: t.type, status: t.status, phase: t.phase, container: (t as Task & { container?: string }).container ?? null, created_at: t.created_at })) }))

  app.get('/api/v1/tasks/:id', async (req, reply) => {
    const task = tasks.get((req.params as { id: string }).id)
    if (!task) return fail(reply, 'request.invalid', req.traceId, { field: 'task_id' })
    advance(task, req.scenario)
    return task
  })

  function advance(task: Task, requestScenario: string) {
    if (task.status !== 'running') return
    const scenario = requestScenario || (task as Task & { scenario?: string }).scenario || ''
    const idx = task.steps.findIndex((s) => s.status === 'running')
    if (idx < 0) return
    const failKey = scenario === 'deploy_build_fail' ? 'building' : scenario === 'deploy_health_fail' ? 'healthcheck' : scenario === 'deploy_backup_fail' ? 'backup' : null
    const cur = task.steps[idx]!
    if (failKey === cur.key) {
      cur.status = 'failed'
      task.status = 'failed'
      task.finished_at = new Date().toISOString()
      task.error = {
        errorCode: cur.key === 'building' ? 'platform.unavailable' : cur.key === 'healthcheck' ? 'platform.unavailable' : 'deploy.backup_paused',
        message: cur.key === 'building' ? '构建失败：依赖安装阶段退出码 1。' : cur.key === 'healthcheck' ? '健康检查未通过，已自动退回上一版本。' : '发布前备份失败，已阻断切流。',
        nextStep: '没有切换流量，原版本继续服务；修好后重新发布（不自动重试）。',
      }
      return
    }
    cur.status = 'done'
    const next = task.steps[idx + 1]
    if (next) {
      next.status = 'running'
      task.phase = next.key
    } else {
      task.status = 'succeeded'
      task.phase = 'done'
      task.finished_at = new Date().toISOString()
      const container = (task as Task & { container?: string }).container
      const env = container ? findEnv(container) : null
      const p = env ? projectById(env.project_id) : null
      if (env && p && env.kind === 'production' && task.version_label && task.sha) {
        env.current = { version_label: task.version_label, sha: task.sha, built_at: new Date().toISOString() }
        p.deployments.unshift({ id: `dep_${randomUUID().slice(0, 8)}`, container: env.id, version_label: task.version_label, sha: task.sha, built_at: new Date().toISOString(), result: 'success', rollbackable: true, missing_reason: null, operator: '林小满' })
        // GAP-03：正式发布不删除任何预览
      }
      task.phase = 'done'
    }
  }

  // ---------------- 用量 / 文件 / 日志 ----------------
  app.get('/api/v1/projects/:id/usage', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const total = p.quota_used_bytes
    const parts = [
      { key: 'app', label: '应用镜像与运行层', bytes: Math.round(total * 0.28) },
      { key: 'db', label: '数据库卷', bytes: Math.round(total * 0.4) },
      { key: 'volume', label: '持久卷', bytes: Math.round(total * 0.18) },
      { key: 'files', label: '文件', bytes: Math.round(total * 0.1) },
      { key: 'logs', label: '日志', bytes: total - Math.round(total * 0.28) - Math.round(total * 0.4) - Math.round(total * 0.18) - Math.round(total * 0.1) },
    ]
    const stale = req.scenario === 'collect_fail'
    return { total_bytes: total, limit_bytes: p.spec.disk_bytes, ratio: Number((total / p.spec.disk_bytes).toFixed(4)), parts, collected_at: stale ? '2026-11-20T08:45:00.000Z' : T0, stale, stale_note: stale ? '用量采集失败，数字可能滞后；按每 15 分钟采集一次，最新一次未成功。' : null }
  })

  app.get('/api/v1/projects/:id/files', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    if (req.scenario === 'storage_down') return fail(reply, 'platform.unavailable', req.traceId, { subsystem: 'storage', note: '文件存储不可用；只能浏览与下载，本页不提供上传/删除。' })
    const path = String((req.query as Record<string, string | undefined>).path ?? '/')
    return {
      items: [
        { name: 'exports', kind: 'dir', size_bytes: 0, modified_at: '2026-11-18T02:00:00.000Z' },
        { name: 'report-2026-11.pdf', kind: 'file', size_bytes: 2_400_000, modified_at: '2026-11-19T02:00:00.000Z' },
      ],
      path,
      read_only: true,
      note: '只提供浏览与下载；上传、删除不开放（应用存储无 S3 契约）。单文件上限 100MB 属技术约束（T-10 技术侧），与产品 T-10 无关。',
    }
  })

  app.get('/api/v1/projects/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    const source = String((req.query as Record<string, string | undefined>).source ?? 'app')
    if (req.scenario === 'archive_fail') {
      return fail(reply, 'platform.unavailable', req.traceId, { subsystem: 'log-archive', note: '日志转存失败：仅影响归档，不影响运行；已提示下次重试。' })
    }
    return {
      items: LOG_LINES,
      source,
      retention_days: DEPLOY.logRetentionDays,
      redacted: true,
      note: '项目级聚合视图（契约未定义，见 self-check F-01 分类）；正式契约按环境取日志：GET /environments/{id}/logs。',
    }
  })

  /** api-spec §8.2 规范形状：按环境取日志（source ∈ build/runtime/history，游标分页） */
  /** api-spec §8.2：`logs:tail` 只取最近 N 行（不是 SSE，明确不实现实时流） */
  app.get('/api/v1/environments/:id/logs/tail', async (req, reply) => {
    const { id } = req.params as { id: string }
    const env = projects.flatMap((p) => p.environments).find((e) => e.id === id)
    if (!env) return fail(reply, 'env.not_found', req.traceId, { env_id: id })
    if (!visibleProject(req, env.project_id)) return fail(reply, 'project.not_found', req.traceId)
    const limit = Math.min(Number((req.query as Record<string, string | undefined>).limit ?? 2) || 2, LOG_LINES.length)
    return { source: 'runtime', lines: LOG_LINES.slice(0, limit).map((l) => ({ at: l.at, level: l.level, text: l.message })), tail: true, sse: false, note: '只返回最近若干行；不提供实时推送（未实现 SSE）。' }
  })

  app.get('/api/v1/environments/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const env = projects.flatMap((p) => p.environments).find((e) => e.id === id)
    if (!env) return fail(reply, 'env.not_found', req.traceId, { env_id: id })
    if (!visibleProject(req, env.project_id)) return fail(reply, 'project.not_found', req.traceId)
    const q = req.query as Record<string, string | undefined>
    const source = ['build', 'runtime', 'history'].includes(String(q.source)) ? String(q.source) : 'runtime'
    if (req.scenario === 'archive_fail' && source === 'history') {
      return fail(reply, 'platform.unavailable', req.traceId, { subsystem: 'log-archive', note: '日志转存失败：仅影响归档，不影响运行；已提示下次重试。' })
    }
    return {
      source,
      lines: LOG_LINES.map((l) => ({ at: l.at, level: l.level, text: l.message })),
      next_cursor: null,
      truncated: false,
      ai_hint: { available: false, reason: 'ai_disabled_by_default' },
      retention_days: DEPLOY.logRetentionDays,
      redacted: true,
    }
  })
  app.post('/api/v1/projects/:id/logs/ai', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    if (req.scenario === 'ai_timeout') return fail(reply, 'platform.unavailable', req.traceId, { subsystem: 'log-ai', note: 'AI 摘要超时：已回退到规则高亮，日志本身仍可查看。' })
    return write(req, reply, { action: 'log.ai', target: { kind: 'project', id } }, () => ({ body: { hint: '近 10 分钟内 3 次 upstream timeout，集中在 /api/orders；建议先看依赖服务健康状态。', sent_bytes: 2048, redacted: true } }))
  })

  // ---------------- 授权 / 分享 / 备份 / 接入包 ----------------
  /**
   * 契约：`api-spec §9.1` + `data-model §4.4`。列表项字段固定为
   * `{id, subject_type, subject_id, subject_name, subject_status, level, source, created_at, revoked_at}`；
   * `level` 只有 `visible` 一档。列表永远不返回明文账号/邮箱。
   */
  app.get('/api/v1/projects/:id/grants', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const people = p.grant_people.map((uid) => {
      const u = userById(uid)
      return {
        id: grantIdOf(p.id, 'user', uid),
        subject_type: 'user' as const,
        subject_id: uid,
        subject_name: u?.display_name ?? uid,
        subject_status: u ? (u.status === 'active' ? ('active' as const) : ('disabled' as const)) : ('member_removed' as const),
        level: 'visible' as const,
        source: 'owner' as const,
        created_at: p.created_at,
        revoked_at: null,
      }
    })
    const groupItems = p.grant_groups.map((gid) => {
      const g = groups.find((x) => x.id === gid)
      return {
        id: grantIdOf(p.id, 'group', gid),
        subject_type: 'group' as const,
        subject_id: gid,
        subject_name: g?.name ?? gid,
        subject_status: g && g.status === 'active' ? ('active' as const) : ('group_dissolved' as const),
        level: 'visible' as const,
        source: 'owner' as const,
        created_at: p.created_at,
        revoked_at: null,
      }
    })
    return {
      items: [...people, ...groupItems],
      level_options: ['visible'],
      limits: { people: 50, groups: 10, group_members: 200 },
      note: '授权与分享相互独立；拿到分享链接仍需登录且有数据权限。授权只有「可见」一档，写能力由本人权限模型决定。',
    }
  })

  /**
   * 同时接受两种请求形状（只做形状兼容，不改变业务语义）：
   * - `api-spec §9.1`：`{"subject_type":"user|group","subject_id":"…"}`
   * - 试跑门户按姓名加人：`{"subjects":[{"type":"user|group","name":"…"}]}`
   * 重复授权按幂等处理：逐项返回 `ok:false, errorCode:"grant.exists"`，不产生第二行（uq_grant）。
   */
  app.post('/api/v1/projects/:id/grants', async (req, reply) => {
    const { id } = req.params as { id: string }
    const owned = ownerProject(req, id)
    if (owned === 'FORBIDDEN') return fail(reply, 'authz.forbidden', req.traceId, { op: 'grant:write', nextStep: '只有项目拥有者能加授权；需要时请拥有者操作或先转让项目。' })
    const p = owned
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const body = (req.body ?? {}) as {
      subject_type?: string
      subject_id?: string
      subjects?: { type?: string; name?: string; id?: string }[]
    }
    const subjects = Array.isArray(body.subjects)
      ? body.subjects
      : body.subject_type && body.subject_id
        ? [{ type: body.subject_type, id: body.subject_id }]
        : []
    if (subjects.length === 0) return fail(reply, 'request.param_invalid', req.traceId, { fields: ['subject_type', 'subject_id'], note: '或使用 subjects[] 批量形状。' })
    if (body && typeof body === 'object' && 'level' in (body as Record<string, unknown>)) {
      return fail(reply, 'request.param_invalid', req.traceId, { field: 'level', note: '授权只有「可见」一档，不接受 level。' })
    }
    return write(req, reply, { action: 'grant.add', target: { kind: 'project', id }, detail: subjects.map((s) => s.name ?? s.id ?? '').join(',') }, () => {
      const results = subjects.map((s) => {
        const type = s.type === 'group' ? 'group' : 'user'
        const key = String(s.id ?? s.name ?? '')
        const label = String(s.name ?? key)
        if (type === 'group') {
          const g = groups.find((x) => x.id === key || x.name === key)
          if (!g || g.status !== 'active') return { name: label, ok: false, errorCode: 'grant.subject_not_found', reason: '项目组不存在或已解散，需由管理员核对后重试。' }
          if (p.grant_groups.includes(g.id)) return { name: label, ok: false, errorCode: 'grant.exists', reason: '该对象已有授权（只有「可见」一档）。' }
          p.grant_groups.push(g.id)
          return { name: label, ok: true }
        }
        const u = users.find((x) => x.user_id === key || x.display_name === key)
        if (!u) return { name: label, ok: false, errorCode: 'authz.forbidden', reason: '找不到该账号，需由管理员核对后重试。' }
        if (u.status !== 'active') return { name: label, ok: false, errorCode: 'grant.subject_not_found', reason: '账号已停用，无法新增授权。' }
        if (p.grant_people.includes(u.user_id)) return { name: label, ok: false, errorCode: 'grant.exists', reason: '该对象已有授权（只有「可见」一档）。' }
        p.grant_people.push(u.user_id)
        return { name: label, ok: true }
      })
      const applied = results.filter((r) => r.ok).length
      const failed = results.length - applied
      return { status: failed > 0 ? 207 : 200, body: { results, applied, failed } }
    })
  })

  app.delete('/api/v1/grants/:grantId', async (req, reply) => {
    const grantId = (req.params as { grantId: string }).grantId
    const parsed = parseGrantId(grantId)
    const owned = parsed ? ownerProject(req, parsed.projectId) : null
    if (owned === 'FORBIDDEN') return fail(reply, 'authz.forbidden', req.traceId, { op: 'grant:write', nextStep: '只有项目拥有者能回收授权；需要时请拥有者操作。' })
    const p = owned
    if (!parsed || !p) return fail(reply, 'grant.not_found', req.traceId)
    const exists = parsed.subjectType === 'user' ? p.grant_people.includes(parsed.subjectId) : p.grant_groups.includes(parsed.subjectId)
    if (!exists) return fail(reply, 'grant.not_found', req.traceId)
    return write(req, reply, { action: 'grant.revoke', target: { kind: 'grant', id: grantId } }, () => {
      if (parsed.subjectType === 'user') p.grant_people = p.grant_people.filter((x) => x !== parsed.subjectId)
      else p.grant_groups = p.grant_groups.filter((x) => x !== parsed.subjectId)
      // 只写 revoked_at 语义（内存替身里表现为从列表移除）；不删除项目、不回收分享
      return { body: { revoked: true, effective_within_seconds: DEPLOY.permissionRevokeSeconds, revoked_at: new Date().toISOString() } }
    })
  })

  /** `api-spec §9.3`：只返回未撤销与已撤销条目；不含明文 token（url 为展示用链接） */
  app.get('/api/v1/projects/:id/shares', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    return {
      items: shareLinks.filter((s) => s.project_id === id),
      note: '分享只生成链接；对方仍需登录并有该项目数据权限。撤销分享只让该链接失效，不授予也不回收项目授权。',
    }
  })

  /**
   * 接受 `{"env_id":"env_…"}`（api-spec）或试跑门户的 `{"env_kind","branch"}`。
   * 创建后写入分享表，GET 同源读取，保证「创建→可见→可撤销」。
   */
  app.post('/api/v1/projects/:id/shares', async (req, reply) => {
    const { id } = req.params as { id: string }
    const owned = ownerProject(req, id)
    if (owned === 'FORBIDDEN') return fail(reply, 'authz.forbidden', req.traceId, { op: 'share:write', nextStep: '只有项目拥有者能生成分享链接；需要时请拥有者操作。' })
    const p = owned
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const body = (req.body ?? {}) as Record<string, unknown>
    const env = body.env_id
      ? p.environments.find((e) => e.id === String(body.env_id))
      : p.environments.find((e) => e.kind === String(body.env_kind) && (String(body.env_kind) === 'production' || e.branch === String(body.branch)))
    if (!env) return fail(reply, 'request.invalid', req.traceId, { field: body.env_id ? 'env_id' : 'branch' })
    return write(req, reply, { action: 'share.create', target: { kind: 'environment', id: env.id } }, () => {
      const row: ShareLink = {
        id: `shr_${randomUUID().slice(0, 8)}`,
        project_id: p.id,
        env_id: env.id,
        env_kind: env.kind,
        branch: env.branch,
        url: `https://${env.slug}.deploy.internal/s/${randomUUID().slice(0, 6)}`,
        created_by: { user_id: req.actor!.id, display_name: req.actor!.name },
        created_at: new Date().toISOString(),
        expires_at: null,
        status: 'active',
        revoked_at: null,
      }
      shareLinks.unshift(row)
      return { status: 201, body: { ...row, note: '链接不授予权限；未登录会 302 到登录。' } }
    })
  })

  const revokeShare = async (req: FastifyRequest, reply: FastifyReply) => {
    const shareId = (req.params as { shareId?: string; id?: string }).shareId ?? (req.params as { id?: string }).id ?? ''
    const row = shareLinks.find((s) => s.id === shareId)
    if (!row) return fail(reply, 'share.not_found', req.traceId)
    const owned = ownerProject(req, row.project_id)
    if (owned === 'FORBIDDEN') return fail(reply, 'authz.forbidden', req.traceId, { op: 'share:write', nextStep: '只有项目拥有者能撤销分享；需要时请拥有者操作。' })
    if (!owned) return fail(reply, 'share.not_found', req.traceId)
    return write(req, reply, { action: 'share.revoke', target: { kind: 'share', id: shareId } }, () => {
      row.status = 'revoked'
      row.revoked_at = new Date().toISOString()
      return { body: { revoked: true, effective_within_seconds: DEPLOY.permissionRevokeSeconds, revoked_at: row.revoked_at, note: '只影响这一条链接；不改变任何人的项目授权。' } }
    })
  }
  // api-spec §9.3 规范形状 `DELETE /shares/{id}`；试跑前端仍用 `POST /shares/{id}:revoke`
  app.delete('/api/v1/shares/:id', revokeShare)
  app.post('/api/v1/shares/:shareId/revoke', revokeShare)

  app.get('/api/v1/projects/:id/backups', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    return {
      items: [
        { id: 'bkp_trial_auto_1', kind: 'auto', created_at: '2026-11-20T02:30:00.000Z', scope: '全部环境 + 门户授权/模板 + 底座记录 + 镜像', expires_at: '2026-12-20T02:30:00.000Z', attempts: 1, max_attempts: 3, result: 'success', note: '每日全量备份：任务内最多重试 3 次' },
        { id: 'bkp_trial_auto_2', kind: 'auto', created_at: '2026-11-19T02:30:00.000Z', scope: '全部环境 + 门户授权/模板 + 底座记录 + 镜像', expires_at: '2026-12-19T02:30:00.000Z', attempts: 4, max_attempts: 3, result: 'failed', note: '每日全量备份：任务内重试 3 次仍失败，计 1 次失败并暂停新发布' },
      ],
      retention_days: settings.retention_days,
      rpo_hours: 24,
      rto_hours: 4,
      rules_note: '每日全量 + 每日异地同步；每日备份任务内重试 3 次，异地同步失败 1 次即暂停；连续 2 次失败升级 critical。',
    }
  })

  app.post('/api/v1/projects/:id/backups', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    if (req.scenario === 'backup_fail') return fail(reply, 'deploy.backup_paused', req.traceId)
    return write(req, reply, { action: 'backup.manual', target: { kind: 'project', id } }, () => {
      const out = { id: `bkp_${randomUUID().slice(0, 8)}`, kind: 'manual', created_at: new Date().toISOString(), scope: '全部环境 + 门户授权/模板 + 底座记录 + 镜像', expires_at: '2026-12-20T02:30:00.000Z', attempts: 1, max_attempts: 3, result: 'success', note: '手动备份不改变自动备份节奏' }
      rememberIdempotency(req, 202, out)
      return { status: 202, body: out }
    })
  })

  app.get('/api/v1/projects/:id/access-pack', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    return { files: ['AGENTS.md', 'skills/deploy-portal/SKILL.md', 'specs/requirement.md', 'docs/runbook.md'], update_note: '更新规范只补充未修改的文件；用户改动过的文件不会被覆盖。' }
  })

  app.post('/api/v1/projects/:id/access-pack/update', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!visibleProject(req, id)) return fail(reply, 'project.not_found', req.traceId)
    return write(req, reply, { action: 'access_pack.update', target: { kind: 'project', id } }, () => ({ body: { changes: { added: 1, updated: 2, kept_user_edits: 3, conflicts: [{ file: 'specs/requirement.md', rule: '不覆盖用户修改', why: '该文件含项目自定字段', action: '保留用户版本，写入 .new 副本并提示' }] } } }))
  })

  app.get('/api/v1/mcp/key', async () => ({ fingerprint: 'fp_trial_5f2c', status: 'active', created_at: '2026-11-12T02:00:00.000Z', last_used_at: '2026-11-20T07:10:00.000Z' }))

  app.post('/api/v1/mcp/key', async (req, reply) =>
    write(req, reply, { action: 'mcp.key.create', target: { kind: 'mcp_key', id: req.actor!.id } }, () => ({ status: 201, body: { plaintext_once: `mcp_${randomUUID()}`, fingerprint: 'fp_trial_new', note: '明文只显示一次；服务端只存指纹。' } })),
  )

  app.delete('/api/v1/mcp/key', async (req, reply) => write(req, reply, { action: 'mcp.key.revoke', target: { kind: 'mcp_key', id: req.actor!.id } }, () => ({ body: { revoked: true, effective_within_seconds: DEPLOY.mcpRevokeSeconds } })))

  app.post('/api/v1/projects/:id/transfer', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    if (p.owner_id !== req.actor!.id && req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId)
    return write(req, reply, { action: 'project.transfer', target: { kind: 'project', id } }, () => ({ body: { pending_confirmation: true, note: '需对方确认后生效；拥有者是项目属性，不新增角色。' } }))
  })

  const softDeleteProject = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const body = (req.body ?? {}) as Record<string, unknown>
    if (String(body.confirm_name ?? '') !== p.name) return fail(reply, 'request.invalid', req.traceId, { field: 'confirm_name' })
    return write(req, reply, { action: 'project.delete', target: { kind: 'project', id } }, () => {
      p.status = 'soft_deleted'
      return { body: { status: 'soft_deleted', note: '30 天内可由管理员恢复；恢复后数据以最近一次备份为准。' } }
    })
  }
  // api-spec §5.5 规范形状 `DELETE /projects/{id}`；试跑前端仍用 `POST /projects/{id}/delete`（兼容别名）
  app.delete('/api/v1/projects/:id', softDeleteProject)
  app.post('/api/v1/projects/:id/delete', softDeleteProject)

  app.post('/api/v1/projects/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = visibleProject(req, id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    return write(req, reply, { action: 'project.restore', target: { kind: 'project', id } }, () => {
      p.status = 'active'
      return { body: { status: 'active' } }
    })
  })

  // ---------------- 管理员 ----------------
  app.get('/api/v1/admin/users', async () => ({ items: users.map((u) => ({ user_id: u.user_id, display_name: u.display_name, role: u.role, status: u.status, groups: u.groups, operations: u.operations })), total: users.length, page: 1, page_size: 20, has_next: false }))

  app.patch('/api/v1/admin/users/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const u = userById(userId)
    if (!u) return fail(reply, 'request.invalid', req.traceId, { field: 'user_id' })
    const ops = ((req.body ?? {}) as { operations?: string[] }).operations ?? []
    const disallowed = ops.filter((o) => o.startsWith('sys:'))
    if (disallowed.length > 0) return fail(reply, 'authz.forbidden', req.traceId, { system_ops: disallowed })
    return write(req, reply, { action: 'admin.user.update', target: { kind: 'user', id: userId }, detail: `${ops.length} 项操作位` }, () => {
      u.operations = ops
      return { body: { updated: true, effective_within_seconds: PERMISSION_CACHE_TTL_MS / 1000 } }
    })
  })

  app.get('/api/v1/admin/groups', async () => ({
    items: groups.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count, project_count: g.project_count, status: g.status, member_limit: g.member_limit })),
    member_limit: 200,
    note: '组是授权对象，不是角色；单组 ≤200 人。系统管理员是否可读组列表为待确认（T-01），本版按 admin:group 判定。',
  }))

  app.post('/api/v1/admin/groups/:id/dissolve', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const g = groups.find((x) => x.id === id)
    if (!g) return fail(reply, 'request.invalid', req.traceId, { field: 'group_id' })
    if (g.status !== 'active') return fail(reply, 'request.invalid', req.traceId, { field: 'group_id', note: '该组已解散。' })
    return write(req, reply, { action: 'admin.group.dissolve', target: { kind: 'group', id } }, () => {
      g.status = 'dissolved'
      return { body: { dissolved: true, status: g.status, note: '解散只解除项目组数据关系，不删除项目与成员账号；依赖该组的授权失效。' } }
    })
  })

  app.get('/api/v1/admin/platform', async (req) => ({
    version: platform.version,
    dokploy_ok: platform.dokploy_ok,
    digest_note: platform.digest_note,
    params: { ...settings },
    host: { cpu_ratio: 0.42, memory_ratio: 0.61, disk_ratio: 0.73 },
    redis: { used_mb: 320, warn_at_mb: 32, reject_at_mb: 40, note: '队列/缓存分片：32MB 告警、40MB 拒绝新任务' },
    backups: { last_success_at: '2026-11-20T02:30:00.000Z', last_failure_at: '2026-11-19T02:40:00.000Z', last_failure_reason: '每日备份任务内重试 3 次仍失败' },
    sync: { last_success_at: '2026-11-20T03:10:00.000Z', last_failure_at: null, last_failure_reason: null },
    webhook: { installed: 2, failed_projects: [] },
    paused: projects.filter((p) => p.gate.paused).map((p) => ({ project_id: p.id, reason: p.gate.reason, since: p.gate.paused_since })),
    security: [
      { key: 'secret_rotation', label: 'SECRET 轮换', state: 'unverified', note: '需真实环境核对（PoC 未执行）' },
      { key: 'admin_internal', label: '管理面仅内网', state: 'unverified', note: 'ENV 未完成，不能声称已生效' },
      { key: 'license', label: '许可证留存', state: 'unverified', note: '上线门槛，待运维提供' },
      { key: 'no_proprietary', label: '不使用 /proprietary', state: 'pass', note: '只调 OSS API（代码层面可核对）' },
    ],
    scenario_applied: req.scenario || null,
  }))

  app.patch('/api/v1/admin/settings', async (req, reply) => {
    const patchBody = (req.body ?? {}) as { key?: unknown; value?: unknown }
    const key = String(patchBody.key ?? '')
    const value = Number(patchBody.value)
    if (!(key in settings)) return fail(reply, 'request.invalid', req.traceId, { field: 'key' })
    const max = key === 'build_concurrency' ? settings.max_build_concurrency : key === 'queue_limit' ? settings.max_queue_limit : 0
    if (max === 0) return fail(reply, 'admin.param_forbidden', req.traceId, { allowed: ['build_concurrency', 'queue_limit'] })
    const current = Number((settings as Record<string, unknown>)[key] ?? 0)
    const verdict = adjustParamVerdict(req.actor!.role, key, value, current, max)
    if (!verdict.ok) return fail(reply, verdict.errorCode!, req.traceId, { key, value, current, max })
    return write(req, reply, { action: 'admin.param.update', target: { kind: 'setting', id: key }, detail: `${current} → ${value}` }, () => {
      ;(settings as Record<string, unknown>)[key] = value
      return { body: { key, value, note: '管理员只能调这两项；压测结论内只可下调。' } }
    })
  })

  app.get('/api/v1/admin/settings', async (req) => {
    const sysadmin = req.actor!.role === 'sysadmin'
    const all = [
      { key: 'build_concurrency', value: settings.build_concurrency, editable_by: ['admin', 'system_admin'], constraints: { min: 1, max: settings.max_build_concurrency, change: 'pressure_test_only_downgrade' } },
      { key: 'deploy_queue_limit', value: settings.queue_limit, editable_by: ['admin', 'system_admin'], constraints: { min: 1, max: settings.max_queue_limit, change: 'pressure_test_only_downgrade' } },
      { key: 'preview_idle_days', value: DEPLOY.idleSleepDays, editable_by: ['system_admin'], constraints: { min: 1, max: 7 } },
      { key: 'preview_wake_timeout_s', value: DEPLOY.wakeTimeoutMs / 1000, editable_by: ['system_admin'], constraints: { min: 10, max: 60 } },
      { key: 'deploy_timeout_min', value: DEPLOY.timeoutMs / 60000, editable_by: ['system_admin'], constraints: { min: 5, max: 30 } },
      { key: 'backup_retention_days', value: settings.retention_days, editable_by: ['system_admin'], constraints: { min: 30, max: 30 } },
      { key: 'audit_retention_days', value: DEPLOY.auditRetentionDays, editable_by: ['system_admin'], constraints: { min: 365, max: 365 } },
      { key: 'log_retention_days', value: DEPLOY.logRetentionDays, editable_by: ['system_admin'], constraints: { min: 30, max: 30 } },
      { key: 'redis_warn_projects', value: 32, editable_by: ['system_admin'], constraints: { min: 1, max: 32 } },
      { key: 'redis_max_projects', value: 40, editable_by: ['system_admin'], constraints: { min: 1, max: 40 } },
      { key: 'ai_monthly_calls', value: 500, editable_by: ['system_admin'], constraints: { min: 0, max: 500 } },
      { key: 'mcp_confirm_timeout_s', value: DEPLOY.publishConfirmSeconds, editable_by: ['system_admin'], constraints: { min: 60, max: 300 } },
    ]
    const items = sysadmin ? all : all.filter((i) => i.editable_by.includes('admin'))
    return { items, note: '管理员只看到 GAP-04 允许的两项；其余 key 只有系统管理员可见可改。不存在机器调用/签名类参数（GAP-02）。' }
  })

  app.patch('/api/v1/admin/settings/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key
    const value = Number(((req.body ?? {}) as { value?: number }).value)
    const exceptions = ['build_concurrency', 'deploy_queue_limit']
    if (!exceptions.includes(key)) return fail(reply, 'authz.forbidden', req.traceId, { key, required_role: 'sysadmin' })
    if (req.actor!.role !== 'admin' && req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId, { required: 'admin:param:queue' })
    const current = key === 'build_concurrency' ? settings.build_concurrency : settings.queue_limit
    const max = key === 'build_concurrency' ? settings.max_build_concurrency : settings.max_queue_limit
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > max) {
      return fail(reply, 'request.param_invalid', req.traceId, { key, value, max, note: '填写 1–上限之间的整数' }, 422)
    }
    if (value > current) return fail(reply, 'request.param_invalid', req.traceId, { key, value, current, note: '压测后只可下调，不可上调' }, 422)
    return write(req, reply, { action: 'admin.param.update', target: { kind: 'setting', id: key }, detail: `${current} → ${value}` }, () => {
      if (key === 'build_concurrency') settings.build_concurrency = value
      else settings.queue_limit = value
      const auditId = audits[0]?.id ?? null
      return { body: { key, value, previous: current, audit_id: auditId, note: 'GAP-04：只有这两项允许管理员调整，且只可下调。' } }
    })
  })

  app.get('/api/v1/admin/audit', async (req) => {
    const q = req.query as Record<string, string | undefined>
    const items = audits.filter((a) => (q.action ? a.action.includes(q.action) : true)).slice(0, Number(q.page_size ?? 20))
    return { items, total: audits.length, csv_columns: 12, csv_columns_confirmed: false, note: 'CSV 12 列名未确认（T-01）；导出前不得当作最终格式。' }
  })

  app.post('/api/v1/admin/audit/export', async (req, reply) => {
    const format = String(((req.body ?? {}) as { format?: string }).format ?? 'csv')
    if (format === 'csv') return write(req, reply, { action: 'audit.export', target: { kind: 'audit', id: 'all' } }, () => ({ body: { format, rows: audits.length, columns: 12, columns_confirmed: false, note: 'T-01 待确认：列名未定稿，导出内容仅供内部核对。' } }))
    return write(req, reply, { action: 'audit.export', target: { kind: 'audit', id: 'all' } }, () => ({ body: { format: 'json', rows: audits.length } }))
  })

  app.get('/api/v1/admin/alerts', async () => ({
    items: [
      { id: 'al_1', level: 'critical', title: '每日全量备份连续 2 次失败', at: '2026-11-20T02:40:00.000Z', note: '升级为 critical；已暂停新发布，已运行环境继续服务。' },
      { id: 'al_2', level: 'warning', title: '磁盘水位 82%', at: '2026-11-20T08:00:00.000Z', note: '扩容需系统管理员处理。' },
    ],
  }))

  // ---------------- 系统管理员 ----------------
  app.get('/api/v1/sys/roles', async () => ({
    version: 'v1',
    roles: [
      { key: 'user', name: '普通用户', operations: ['project:read', 'deploy:create', 'preview:create', 'preview:delete'] },
      { key: 'admin', name: '管理员', operations: ['admin:people', 'admin:group', 'admin:param:concurrency', 'admin:param:queue'] },
      { key: 'sysadmin', name: '系统管理员', operations: ['sys:setting', 'sys:cleanup', 'sys:restore', 'sys:role', 'sys:template'] },
    ],
    relations: ['拥有者（项目属性）', '被授权人（数据关系）', '项目组（数据关系）'],
    note: '只存在三种应用角色；拥有者/授权/项目组是数据关系，不能当角色分配。',
  }))

  app.put('/api/v1/sys/roles', async (req, reply) => write(req, reply, { action: 'sys.roles.update', target: { kind: 'role_model', id: 'v' } }, () => ({ body: { version: `v${Date.now()}`, affected: { user: 4, admin: 1, sysadmin: 1 } } })))

  app.get('/api/v1/sys/templates', async () => ({ items: templates }))

  /** api-spec §5.6：门户模板库（创建向导用，普通用户可用，故与 /sys/templates 分权） */
  app.get('/api/v1/templates', async () => ({
    items: templates.filter((t) => t.available).map((t) => ({ ...t, status: 'active', has_demo: true, has_spec: true, has_skills: true, build_preset: 'node-vue-bff' })),
    note: '只返回已发布可用版本；更新规范不覆盖用户已修改文件。',
  }))

  app.get('/api/v1/templates/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!templates.some((t) => t.id === id)) return fail(reply, 'project.template_unavailable', req.traceId, { template_id: id })
    return { items: [{ version: 'v1.0.0', status: 'active', published_at: '2026-11-10T02:00:00.000Z', semantic: '首版：最小可运行 demo + 规范 + 4 个门户 MCP Skill' }] }
  })

  app.post('/api/v1/sys/templates/:id/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string }
    const t = templates.find((x) => x.id === id)
    if (!t || !['publish', 'offline'].includes(action)) return fail(reply, 'request.invalid', req.traceId)
    return write(req, reply, { action: `sys.template.${action}`, target: { kind: 'template', id } }, () => {
      t.available = action === 'publish'
      return { body: { template: t, note: action === 'offline' ? '下线只影响新建项目，已有项目保持原状。' : '已重新上线。' } }
    })
  })

  app.get('/api/v1/sys/settings', async () => ({
    settings: { ...settings },
    projects: projects.map((p) => ({ id: p.id, name: p.name, spec: p.spec, used_bytes: p.quota_used_bytes })),
    paused: projects.filter((p) => p.gate.paused).map((p) => ({ project_id: p.id, reason: p.gate.reason, since: p.gate.paused_since, resume_mechanism: p.gate.resume_mechanism })),
    security: [
      { key: 'secret_rotation', label: 'SECRET 轮换机制', state: 'unverified', note: '需真实环境核对；不写「已修复」。' },
      { key: 'admin_internal', label: '管理面仅内网', state: 'unverified', note: '部署拓扑未验证。' },
      { key: 'license', label: '许可证留存', state: 'unverified', note: '上线门槛。' },
    ],
    note: '项目规格、备份口径、异常预览清理、恢复只有系统管理员可见可调用。',
  }))

  app.patch('/api/v1/sys/settings', async (req, reply) => {
    if (req.actor!.role !== 'sysadmin') return fail(reply, 'project.spec_sysadmin_only', req.traceId)
    const sysBody = (req.body ?? {}) as Record<string, unknown>
    const key = String(sysBody.key ?? '')
    if (!(key in settings)) return fail(reply, 'request.invalid', req.traceId, { field: 'key' })
    const value = sysBody.value
    return write(req, reply, { action: 'sys.setting.update', target: { kind: 'setting', id: key } }, () => {
      ;(settings as Record<string, unknown>)[key] = value
      return { body: { key, value } }
    })
  })

  app.patch('/api/v1/projects/:id/spec', async (req, reply) => {
    const { id } = req.params as { id: string }
    const p = projectById(id)
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    // GAP-01：只有系统管理员可调；普通用户/管理员构造请求也 403（用 api-spec 的 authz.forbidden）
    if (req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId, { required: 'project:spec', required_role: 'sysadmin', note: '项目资源规格只有系统管理员可调整（GAP-01）。' })
    const body = (req.body ?? {}) as Record<string, unknown>
    const next = {
      cpu: Number(body.cpu ?? p.spec.cpu),
      memory_mb: Number(body.memory_mb ?? p.spec.memory_mb),
      disk_bytes: Number(body.disk_bytes ?? p.spec.disk_bytes),
      preview_limit: Number(body.preview_limit ?? p.spec.preview_limit),
    }
    if (!Number.isFinite(next.cpu) || next.cpu <= 0 || !Number.isFinite(next.memory_mb) || next.memory_mb < 64) return fail(reply, 'request.invalid', req.traceId)
    if (next.disk_bytes < p.quota_used_bytes) return fail(reply, 'request.invalid', req.traceId, { field: 'disk_bytes', reason: '新上限不能小于已用容量' })
    if (next.preview_limit < 1 || next.preview_limit > 3) return fail(reply, 'request.invalid', req.traceId, { field: 'preview_limit', reason: '预览上限 1–3' })
    const before = { ...p.spec }
    return write(req, reply, { action: 'project.spec.update', target: { kind: 'project', id }, detail: `${before.cpu}C/${before.memory_mb}MB → ${next.cpu}C/${next.memory_mb}MB` }, () => {
      p.spec = next
      return { body: { spec: next, audit_id: audits[0]?.id ?? null, effective_at: new Date().toISOString(), note: '扩容需重启生效；缩减立即限制；不删除已有数据。' } }
    })
  })

  app.get('/api/v1/sys/previews/abnormal', async () => ({ items: abnormalPreviews, scope_note: '只包含三种异常情形：拥有者停用 / 项目已删除 / 无法删除的残留。正常预览不在范围。' }))

  app.post('/api/v1/sys/previews/cleanup', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(body.ids) ? (body.ids as string[]) : []
    const reason = String(body.reason ?? '').trim()
    const confirm = body.confirm === true || body.confirm === 'DELETE' || String(body.confirm_word ?? '') === 'DELETE'
    if (ids.length === 0) return fail(reply, 'request.invalid', req.traceId, { field: 'ids' })
    const outside = ids.filter((id) => !abnormalPreviews.some((a) => a.id === id))
    if (outside.length > 0) return fail(reply, 'preview.cleanup_scope_invalid', req.traceId, { ids: outside })
    if (!confirm) return fail(reply, 'preview.cleanup_confirm_required', req.traceId, { field: 'confirm' })
    if (reason.length < 4) return fail(reply, 'preview.cleanup_confirm_required', req.traceId, { field: 'reason', note: '清理原因会写入每条审计' })
    const buildRows = () => ids.map((id) => {
      const item = abnormalPreviews.find((a) => a.id === id)!
      const residual = req.scenario === 'cleanup_partial' && item.case === 'undeletable'
      if (!residual) {
        const i = abnormalPreviews.findIndex((a) => a.id === id)
        if (i >= 0) abnormalPreviews.splice(i, 1)
      }
      return { id, project: item.project_name, branch: item.branch, case: item.case, result: residual ? 'still_residual' : 'deleted', reason: residual ? '资源删除未完成，再次手工清理并升级告警（不会重试到死循环）' : reason }
    })
    return write(req, reply, { action: 'sys.preview.cleanup', target: { kind: 'preview_batch', id: ids.join(',') }, detail: reason }, () => {
      const rows = buildRows()
      const out = { rows, done: rows.filter((r) => r.result === 'deleted').length, residual: rows.filter((r) => r.result === 'still_residual').length }
      rememberIdempotency(req, 200, out)
      return { body: out }
    })
  })

  app.post('/api/v1/sys/restore', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    // api-spec §10.3 用 `confirm: "RESTORE"`；试跑前端历史写法为 `confirm_word`（兼容别名，语义相同）
    const confirmWord = String(body.confirm_word ?? body.confirm ?? '')
    if (confirmWord !== 'RESTORE') return fail(reply, 'backup.restore_confirm_required', req.traceId)
    if (body.scope !== undefined && body.scope !== 'platform') return fail(reply, 'request.param_invalid', req.traceId, { field: 'scope', note: '首期只支持 platform 全量恢复。' })
    // api-spec §10.3：已有恢复在跑时返回 423，不排队、不并发
    const running = [...tasks.values()].find((t) => t.type === 'backup.restore' && t.status === 'running')
    if (running) return reply.code(423).send({ errorCode: 'restore.in_progress', message: '已有恢复任务在进行。', traceId: req.traceId, task_id: running.id, impact: '本次未开始，现有恢复不受影响。', nextStep: '等当前恢复结束；可用 GET /admin/restores/{id} 查看进度。' })
    const taskId = `task_${randomUUID().slice(0, 8)}`
    const stages = ['停止写入', '恢复数据库', '恢复文件与持久卷', '恢复门户授权/模板', '恢复底座记录与镜像', '逐项校验']
    const restoreTask: Task = { id: taskId, type: 'backup.restore', status: 'running', phase: 'stop_write', attempt: 1, max_attempts: 3, steps: stages.map((s, i) => ({ key: `s${i}`, label: s, status: i === 0 ? 'running' : 'pending' as const })), created_at: new Date().toISOString(), finished_at: null }
    return write(req, reply, { action: 'sys.restore', target: { kind: 'backup', id: String(body.backup_id ?? '') } }, () => {
      tasks.set(taskId, restoreTask)
      const out = { task_id: taskId, stages, note: '中断可重试，不留半可用状态；回滚不回滚数据库，数据库恢复只在此操作。' }
      rememberIdempotency(req, 202, out)
      return { status: 202, body: out }
    })
  })

  /** api-spec §10.3：恢复进度（阶段/失败项，可重入查看） */
  app.get('/api/v1/admin/restores/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const t = tasks.get(id)
    if (!t || t.type !== 'backup.restore') return fail(reply, 'request.path_unknown', req.traceId, { note: '恢复任务不存在或已过期；首期不提供历史恢复列表。' })
    return {
      restore_id: t.id,
      status: t.status,
      stages: t.steps.map((s) => ({ key: s.key, label: s.label, status: s.status })),
      failed_items: t.steps.filter((s) => s.status === 'failed').map((s) => s.label),
      retryable: true,
    }
  })

  app.get('/api/v1/sys/backup-status', async () => ({
    daily: { retry_in_task: settings.backup_retry_in_task, note: '每日全量备份：任务内自动重试 3 次，仍失败计 1 次失败并暂停新发布' },
    sync: { retry_in_task: settings.offsite_sync_retry_in_task, note: '异地同步：失败 1 次立即暂停新发布，不先重试 3 次' },
    escalate_after_consecutive: settings.escalate_after_consecutive,
    retention_days: settings.retention_days,
    rpo_hours: 24,
    rto_hours: 4,
    resume_mechanism: 'T-08 原文未定：页面只显示「需系统管理员处理」，不提供自动恢复开关',
  }))


  // ================= api-spec v1.0 对齐层 =================
  // 目的：让 test-scripts/contract 的 42 条契约能在 BFF 上真跑，而不是各说各话。
  // 全部读内存仓储，未接真实底座/数据库（ENV01–ENV09 未完成）。

  app.get('/api/v1/health', async () => ({
    ok: true,
    version: '0.1.0-trial',
    mock: true,
    checks: { authz: platform.authz_ok, dokploy: platform.dokploy_ok },
    note: '试跑 BFF：内存仓储，未接真实底座；不代表环境验收。',
  }))

  const gateBody = (reason?: string) => {
    const paused = Boolean(reason) || projects.some((p) => p.gate.paused)
    const realReason = reason || projects.find((p) => p.gate.paused)?.gate.reason || null
    return {
      state: paused ? 'paused' : 'open',
      reason: paused ? realReason : null,
      paused_since: paused ? '2026-11-20T02:40:00.000Z' : null,
      affects: ['production_deploy'],
      not_affects: ['running_env', 'preview_deploy', 'rollback'],
      release_mechanism: 'manual_by_system_admin',
      note: '解除机制待 T-08；页面只显示原因与处理人，不显示自动恢复时间。预览是否受影响未收口（T-10 产品侧）。',
    }
  }
  app.get('/api/v1/deployments/gate', async (req) => gateBody((req.query as Record<string, string | undefined>).reason))

  app.get('/api/v1/environments/:id', async (req, reply) => {
    const env = findEnv((req.params as { id: string }).id)
    if (!env) return fail(reply, 'env.not_found', req.traceId)
    const p = projectById(env.project_id)!
    if (!visibleProject(req, p.id)) return fail(reply, 'env.not_found', req.traceId)
    return { ...env, retention: env.retention ?? { state: 'retained', note: '预览长期保留：正式发布不会删除预览，分支删除只休眠不删除。' } }
  })

  /** 文件页只读：路径必须是相对路径且不得穿越 */
  function safePath(raw: string): { ok: true; path: string } | { ok: false } {
    let v = raw
    for (let i = 0; i < 2; i += 1) v = decodeURIComponent(v)
    if (v.includes('..') || v.startsWith('//') || /^[a-zA-Z]:/.test(v)) return { ok: false }
    return { ok: true, path: v.startsWith('/') ? v : `/${v}` }
  }

  app.get('/api/v1/files', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const fallback = projects.find((x) => visibleProject(req, x.id))
    const p = visibleProject(req, q.project_id ?? fallback?.id ?? '')
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const envId = q.env_id ?? p.environments.find((e) => e.kind === 'production')?.id ?? ''
    if (!p.environments.some((e) => e.id === envId)) return fail(reply, 'env.not_found', req.traceId, { env_id: envId })
    if (req.scenario === 'storage_down') return fail(reply, 'internal.unexpected', req.traceId, { subsystem: 'storage', note: '文件存储不可用；只能浏览与下载，本页不提供上传/删除。' })
    const checked = safePath(q.path ?? '/')
    if (!checked.ok) return fail(reply, 'file.path_invalid', req.traceId, { path: q.path })
    const path = checked.path
    if (path === '/missing') return fail(reply, 'file.not_found', req.traceId, { path })
    return {
      project_id: p.id,
      env_id: envId,
      path,
      entries: [
        { name: 'exports', type: 'dir', size: null, modified_at: '2026-11-18T02:00:00.000Z' },
        { name: 'report-2026-11.pdf', type: 'file', size: 2_400_000, modified_at: '2026-11-19T02:00:00.000Z' },
      ],
      read_only: true,
      max_file_bytes: DEPLOY.maxFileBytes,
      note: '文件页只读：不提供在线删除/改写/重命名/移动；单文件上限为技术约束（T-10 技术侧），产品 T-10 另有含义。',
    }
  })
  app.options('/api/v1/files', async (_req, reply) => reply.code(204).header('Allow', 'GET, HEAD, OPTIONS').send())

  /** api-spec §8.4：`/files:stat` 与 `/files:download`（试跑用只读替身数据） */
  app.get('/api/v1/files/stat', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const fallback = projects.find((x) => visibleProject(req, x.id))
    const p = visibleProject(req, q.project_id ?? fallback?.id ?? '')
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const checked = safePath(q.path ?? '/')
    if (!checked.ok) return fail(reply, 'file.path_invalid', req.traceId, { path: q.path })
    if (checked.path === '/missing') return fail(reply, 'file.not_found', req.traceId, { path: checked.path })
    return { path: checked.path, name: checked.path.split('/').pop() || '/', type: 'file', size: 2_400_000, modified_at: '2026-11-19T02:00:00.000Z', readable: true, max_file_bytes: DEPLOY.maxFileBytes }
  })

  app.get('/api/v1/files/download', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const fallback = projects.find((x) => visibleProject(req, x.id))
    const p = visibleProject(req, q.project_id ?? fallback?.id ?? '')
    if (!p) return fail(reply, 'project.not_found', req.traceId)
    const checked = safePath(q.path ?? '/')
    if (!checked.ok) return fail(reply, 'file.path_invalid', req.traceId, { path: q.path })
    if (checked.path === '/missing') return fail(reply, 'file.not_found', req.traceId, { path: checked.path })
    const name = checked.path.split('/').pop() || 'download.bin'
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send('试跑替身文件内容（非真实应用文件，未接对象存储 ENV 未完成）\n')
  })

  app.get('/api/v1/admin/backups', async (req, reply) => {
    const scenario = (req.query as Record<string, string | undefined>).scenario ?? req.scenario
    const items = [
      {
        id: 'bkp_daily_1',
        kind: 'daily',
        scope: 'platform',
        status: scenario === 'offsite_failed' ? 'succeeded' : scenario === 'daily_failed' ? 'failed' : 'succeeded',
        attempts: scenario === 'daily_failed' ? 4 : 1,
        max_attempts: 4,
        failure: scenario === 'daily_failed' ? { errorCode: 'backup.task_failed', message: '每日全量备份任务内重试 3 次后仍失败', nextStep: '检查存储与目标机；已暂停新发布' } : null,
        offsite: { status: scenario === 'offsite_failed' ? 'failed' : 'succeeded', last_success_at: '2026-11-19T03:00:00.000Z', retry_in_task: 0, note: '异地同步失败 1 次即暂停，不先重试 3 次' },
        manifest_sha: 'sha256:trial-pending',
        started_at: '2026-11-20T02:30:00.000Z',
        finished_at: '2026-11-20T02:40:00.000Z',
        expires_at: '2026-12-20T02:30:00.000Z',
      },
    ]
    if (req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId, { required: 'system:backup' })
    return { items, retention_days: settings.retention_days, rpo_hours: 24, rto_hours: 4, note: 'status 与 offsite.status 两列独立，不合并判定（GAP-06）。' }
  })

  app.post('/api/v1/admin/backups:run', async (req, reply) => {
    if (req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId, { required: 'system:backup' })
    if (req.scenario === 'backup_fail') return fail(reply, 'deploy.backup_paused', req.traceId)
    return write(req, reply, { action: 'backup.manual', target: { kind: 'backup', id: 'platform' } }, () => {
      const out = { id: `bkp_${randomUUID().slice(0, 8)}`, kind: 'manual', status: 'running', attempts: 1, max_attempts: 4, note: '手动备份不改自动备份节奏' }
      rememberIdempotency(req, 202, out)
      return { status: 202, body: out }
    })
  })

  /** GAP-05：候选只有三种情形，正常预览不得进入 */
  const CLEANUP_REASONS = { disabled_owner: 'owner_disabled', deleted_project: 'project_deleted', undeletable: 'not_removable_by_user' } as const
  app.get('/api/v1/admin/previews/cleanup-candidates', async (req, reply) => {
    if (req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId, { required: 'system:resource' })
    return {
      items: abnormalPreviews.map((a) => ({ env_id: a.id, project_id: a.project_id, project_name: a.project_name, branch: a.branch, reason: CLEANUP_REASONS[a.case], state: a.state, size_bytes: a.size_bytes })),
      scope_note: '只列三种情形：停用账号遗留 / 删除项目残留 / 用户无法自行删除。正常预览不在范围。',
    }
  })

  const previewsCleanup = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.actor!.role !== 'sysadmin') return fail(reply, 'authz.forbidden', req.traceId, { required: 'system:resource' })
    const body = (req.body ?? {}) as { items?: { env_id: string; reason: string }[]; confirm?: boolean; confirm_text?: string }
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) return fail(reply, 'request.param_invalid', req.traceId, { field: 'items' })
    const expectedText = `清理 ${items.length} 个异常预览`
    if (body.confirm !== true || body.confirm_text !== expectedText) {
      return fail(reply, 'cleanup.confirm_required', req.traceId, { expected_confirm_text: expectedText, note: '需要二次确认，确认文案必须与所选数量一致。' })
    }
    // api-spec §10.5 只约束「范围」（必须是三种异常情形之一）+ 逐项原因文本；
    // 范围以服务端候选集合为准，不信任前端传入的 reason 枚举值。
    const outside = items.filter((i) => !i.env_id || typeof i.reason !== 'string' || !i.reason.trim() || !abnormalPreviews.some((a) => a.id === i.env_id))
    if (outside.length > 0) return fail(reply, 'cleanup.scope_invalid', req.traceId, { items: outside.map((i) => i.env_id), note: '只能清理无主/残留/无法自删的异常预览，正常预览不允许清理。' })
    const succeeded: { env_id: string; branch: string; reason: string; freed_bytes: number }[] = []
    const failed: { env_id: string; errorCode: string; message: string; nextStep: string }[] = []
    const auditIds: string[] = []
    for (const item of items) {
      const idx = abnormalPreviews.findIndex((a) => a.id === item.env_id)
      const row = abnormalPreviews[idx]!
      if (req.scenario === 'cleanup_partial' && row.case === 'undeletable') {
        failed.push({ env_id: row.id, errorCode: 'env.busy', message: '正在发布，未能删除', nextStep: '稍后重试；不会自动重试到死循环' })
        continue
      }
      if (!audit(req, 'sys.preview.cleanup', { kind: 'environment', id: row.id }, 'success', undefined, `${item.reason} ${row.branch}`)) {
        return fail(reply, 'audit.write_failed', req.traceId)
      }
      auditIds.push(audits[0]!.id)
      abnormalPreviews.splice(idx, 1)
      succeeded.push({ env_id: row.id, branch: row.branch, reason: item.reason, freed_bytes: row.size_bytes })
    }
    const out = { requested: items.length, succeeded, failed, audit_ids: auditIds }
    rememberIdempotency(req, 200, out)
    return out
  }

  app.post('/api/v1/admin/previews:cleanup', previewsCleanup)
  app.post('/api/v1/admin/previews/cleanup', previewsCleanup)

  app.get('/api/v1/audit', async (req, reply) => {
    if (!hasOp(req.actor!.role, 'admin:audit')) return fail(reply, 'authz.forbidden', req.traceId, { required: 'audit:read' })
    const q = req.query as Record<string, string | undefined>
    const items = audits.filter((a) => (q.action ? a.action.includes(q.action) : true)).slice(0, Number(q.page_size ?? 20))
    return { items, total: audits.length, append_only: true, retention_days: DEPLOY.auditRetentionDays }
  })

  const AUDIT_CSV_COLUMNS = ['时间', '操作人', '角色', '动作', '对象类型', '对象ID', '项目', '结果', '原因/错误码', '来源IP', 'traceId', '变更摘要']
  app.get('/api/v1/audit/export', async (req, reply) => {
    if (!hasOp(req.actor!.role, 'admin:audit')) return fail(reply, 'authz.forbidden', req.traceId, { required: 'audit:read' })
    const format = String((req.query as Record<string, string | undefined>).format ?? 'csv')
    if (format === 'json') return { format: 'json', rows: audits.length, items: audits.slice(0, 100) }
    return {
      format: 'csv',
      provisional: true,
      columns: AUDIT_CSV_COLUMNS,
      columns_note: 'T-01：12 列字段名未获批准，导出前必须再次确认；不含令牌/连接串/密码/完整 open_id/文件内容。',
      rows: audits.length,
    }
  })

  // ---- MCP（Agent 接入）：只暴露白名单，写操作转确认请求 ----
  const mcpKeyOf = (req: FastifyRequest) => {
    const auth = String(req.headers.authorization ?? '')
    return auth.startsWith('Bearer mcp_') ? auth.slice('Bearer '.length) : null
  }
  app.get('/api/v1/mcp-keys', async (req) => ({
    items: [
      { key_id: 'mk_trial_1', name: '本地 Agent', fingerprint_prefix: 'fp_trial_5f2c…', created_at: '2026-11-12T02:00:00.000Z', last_used_at: '2026-11-20T07:10:00.000Z', status: 'active' },
    ],
    note: '只返回指纹前缀与状态，不返回明文；明文只在创建时显示一次。',
    user_id: req.actor!.id,
  }))
  app.post('/api/v1/mcp-keys', async (req, reply) =>
    write(req, reply, { action: 'mcp.key.create', target: { kind: 'mcp_key', id: req.actor!.id } }, () => ({
      status: 201,
      body: { key_id: `mk_${randomUUID().slice(0, 8)}`, plaintext_once: `mcp_${randomUUID()}`, fingerprint_prefix: 'fp_trial_new…', note: '明文只显示一次；服务端只存 SHA-256 指纹；撤销 ≤1 分钟生效。' },
    })),
  )
  app.delete('/api/v1/mcp-keys/:keyId', async (req, reply) => {
    const { keyId } = req.params as { keyId: string }
    return write(req, reply, { action: 'mcp.key.revoke', target: { kind: 'mcp_key', id: keyId } }, () => ({ body: { key_id: keyId, revoked: true, effective_within_seconds: DEPLOY.mcpRevokeSeconds } }))
  })

  app.get('/api/v1/mcp/v1/capabilities', async () => ({
    capabilities: ['project.list', 'project.get', 'environment.list', 'task.get', 'deployment.list', 'log.tail', 'project.deploy.request', 'project.rollback.request'],
    write_capabilities: ['project.deploy.request', 'project.rollback.request'],
    note: '写能力只创建确认请求，需本人在 5 分钟内确认，Agent 不能自批；首期不含机器直调/远程调用能力（GAP-02）。',
  }))

  // GAP-02：一期不提供外部机器调用入口
  app.get('/api/v1/machine-access', async (_req, reply) => fail(reply, 'request.path_unknown', 'trc_gap02', { note: '一期不提供外部机器调用已部署应用的入口（GAP-02）。' }))

  const confirmAction = (verdict: 'approved' | 'rejected') => async (req: FastifyRequest, reply: FastifyReply) => {
    if (mcpKeyOf(req)) return fail(reply, 'mcp.self_approve_denied', req.traceId)
    const id = (req.params as { id: string }).id
    return write(req, reply, { action: verdict === 'approved' ? 'deploy.confirm' : 'deploy.reject', target: { kind: 'confirmation', id } }, () => ({
      body: { status: verdict, note: verdict === 'approved' ? '确认后才创建真实发布任务；审计两条（请求/确认）。' : '已拒绝；不创建发布任务，环境不变。' },
    }))
  }
  app.post('/api/v1/confirmations/:id/approve', confirmAction('approved'))
  app.post('/api/v1/confirmations/:id/reject', confirmAction('rejected'))

  // ---------------- 未匹配 ----------------
  app.setNotFoundHandler((req, reply) => fail(reply, 'request.path_unknown', req.traceId ?? 'trc_unknown', { path: req.url, note: '该端点未在 api-spec v1.0 中定义' }))

  app.setErrorHandler((err, req, reply) => {
    // 不把内部堆栈抛给前端，只给 errorCode + traceId
    if (reply.sent) return
    fail(reply, 'request.unknown', req.traceId ?? 'trc_unknown', { note: err.message })
  })

  return app
}

function findEnv(id: string): Environment | null {
  for (const p of projects) {
    const e = p.environments.find((x) => x.id === id)
    if (e) return e
  }
  return null
}

function busy(envId: string): boolean {
  return [...tasks.values()].some((t) => t.status === 'running' && (t as Task & { container?: string }).container === envId)
}

/**
 * 授权/分享的写操作只由项目拥有者发起（README 5.8：被授权人不能再授权）。
 * 系统管理员不代发：需拥有者本人操作或走转让；返回 403 而不是 404，因为对方本来能看到这个项目。
 */
function ownerProject(req: FastifyRequest, id: string): Project | 'FORBIDDEN' | null {
  const p = projectById(id)
  if (!p) return null
  if (p.status === 'soft_deleted') return null
  return p.owner_id === req.actor!.id && req.actor!.role !== 'sysadmin' ? p : 'FORBIDDEN'
}

/**
 * 数据关系按「当前请求者」算，不能用种子里的固定 relation：
 * 拥有者 / 被授权人 / 项目组 / 无权限 决定看得到什么，也决定能否做授权、分享等写操作。
 */
export function relationOfProject(p: Project, actorId: string, actorGroups: string[]): { relation: Project['relation']; relation_label: string } {
  if (p.owner_id === actorId) return { relation: 'owner', relation_label: '你是拥有者' }
  if (p.grant_people.includes(actorId)) return { relation: 'granted', relation_label: `来自：${p.owner_name} 授权` }
  const hit = p.grant_groups.find((g) => actorGroups.includes(g))
  if (hit) return { relation: 'group', relation_label: `来自：项目组 ${groups.find((g) => g.id === hit)?.name ?? hit}` }
  return { relation: 'none', relation_label: '无权访问' }
}

function visibleProject(req: FastifyRequest, id: string): Project | null {
  const p = projectById(id)
  if (!p) return null
  if (p.status === 'soft_deleted') return p
  if (req.actor!.role === 'sysadmin') return p
  return relationOfProject(p, req.actor!.id, userById(req.actor!.id)?.groups ?? []).relation === 'none' ? null : p
}
