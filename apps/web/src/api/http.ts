import type { ApiErrorBody } from './types'

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api/v1'
/** 试跑：默认走进程内 Mock；接通 BFF 时设 VITE_USE_MOCK=false */
export const USE_MOCK: boolean = (import.meta.env.VITE_USE_MOCK as string | undefined) !== 'false'

/** 统一错误对象：页面只按 errorCode 展示，不按 HTTP 状态自造文案（api-spec §1.2 硬规则 3） */
export class ApiError extends Error {
  readonly errorCode: string
  readonly nextStep: string
  readonly traceId: string
  readonly details: Record<string, unknown>
  readonly httpStatus: number

  constructor(body: ApiErrorBody, httpStatus = 400) {
    super(body.message)
    this.name = 'ApiError'
    this.errorCode = body.errorCode
    this.nextStep = body.nextStep
    this.traceId = body.traceId
    this.details = body.details ?? {}
    this.httpStatus = httpStatus
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

/** 只读请求允许 1 次退避重试（仅 429/502/503/504），业务错误不重试（api-spec §1.5） */
const RETRYABLE = new Set([429, 502, 503, 504])

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  idempotencyKey?: string
  /** 故障注入（只在 Mock 模式生效，用于演示失败分支；真实 BFF 忽略未知参数会 400） */
  scenario?: string
  signal?: AbortSignal
  retryReadOnly?: boolean
}

export interface ApiResponse<T> {
  data: T
  traceId: string
  mock: boolean
  status: number
}

/** 由 session store 注入，避免 api 层依赖 Vue 状态 */
export interface AuthContext {
  csrfToken: string | null
  userId: string | null
}
export const authContext: AuthContext = { csrfToken: null, userId: null }

/** 真实 BFF：CSRF 是双提交 Cookie（服务端另存一份比对），前端只需读出来回填头 */
export function readCsrfCookie(): string | null {
  try {
    const m = /(?:^|;\s*)trial_csrf=([^;]+)/.exec(globalThis.document?.cookie ?? '')
    return m ? decodeURIComponent(m[1]!) : null
  } catch {
    return null
  }
}

let seq = 0
export function ulid(prefix = 'id'): string {
  seq += 1
  const t = Date.now().toString(36).toUpperCase().padStart(9, '0')
  const r = Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, '0')
  return `${prefix}_${t}${r}${String(seq).padStart(3, '0')}`
}

type MockHandler = typeof import('./mock/handlers')

let mockModule: MockHandler | null = null
async function mock(): Promise<MockHandler> {
  if (!mockModule) mockModule = await import('./mock/handlers')
  return mockModule
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function buildQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return ''
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

function traceId(): string {
  return ulid('trc')
}

/**
 * 唯一请求出口：页面与 flows 只能经此函数访问 BFF。
 * - 前端不持有任何服务凭据（api-spec §1.3：会话 Cookie + 双提交 CSRF）
 * - Mock 返回与真实 BFF 相同的响应形状，并带 `X-Mock: true`
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const method = opts.method ?? 'GET'
  const isRead = method === 'GET'
  const attempts = isRead && opts.retryReadOnly !== false ? 2 : 1
  let lastError: unknown

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await once<T>(path, { ...opts, method })
    } catch (e) {
      lastError = e
      const status = isApiError(e) ? e.httpStatus : 0
      if (i + 1 < attempts && RETRYABLE.has(status)) {
        await sleep(150 * (i + 1))
        continue
      }
      throw e
    }
  }
  throw lastError
}

async function once<T>(path: string, opts: RequestOptions & { method: string }): Promise<ApiResponse<T>> {
  const tid = traceId()

  if (USE_MOCK) {
    const mod = await mock()
    await sleep(mod.mockLatency(opts.scenario))
    const result = mod.dispatch({
      method: opts.method,
      path,
      body: opts.body,
      query: opts.query,
      scenario: opts.scenario,
      idempotencyKey: opts.idempotencyKey,
      auth: authContext,
      traceId: tid,
    })
    if (!result.ok) throw new ApiError(result.error, result.status)
    return { data: result.data as T, traceId: tid, mock: true, status: result.status }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-Id': tid,
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const csrf = authContext.csrfToken ?? readCsrfCookie()
  if (!isGet(opts.method) && csrf) headers['X-CSRF-Token'] = csrf
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  const res = await fetch(`${API_BASE}${path}${buildQuery(opts.query)}`, {
    method: opts.method,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  })

  const text = await res.text()
  const parsed: unknown = text ? JSON.parse(text) : null
  if (!res.ok) {
    const body = parsed as ApiErrorBody | null
    if (body && typeof body.errorCode === 'string') {
      throw new ApiError(body, res.status)
    }
    throw new ApiError(
      { errorCode: 'request.unknown', message: '请求未被服务端正常处理。', nextStep: '重试一次；仍失败请把 traceId 给管理员。', traceId: res.headers.get('X-Trace-Id') ?? tid },
      res.status,
    )
  }
  return {
    data: parsed as T,
    traceId: res.headers.get('X-Trace-Id') ?? tid,
    mock: res.headers.get('X-Mock') === 'true',
    status: res.status,
  }
}

function isGet(method: string): boolean {
  return method === 'GET'
}
