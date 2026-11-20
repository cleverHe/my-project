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
  /**
   * 故障注入。Mock 模式在派发器内生效；接试跑 BFF 时作为 `?scenario=` 传给服务端，
   * 只有 BFF 侧 `TRIAL_SCENARIO=1` 时才被采纳（生产 BFF 丢弃该参数，不报错）。
   */
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

export interface TextResponse {
  text: string
  filename: string | null
  traceId: string
  status: number
}

/**
 * 导出类接口（text/csv）：不能走 JSON 解析。
 * 仍然唯一出口，错误同样转 ApiError；不重试（导出有频率限制）。
 */
export async function requestText(path: string, opts: RequestOptions = {}): Promise<TextResponse> {
  const tid = traceId()
  if (USE_MOCK) {
    const mod = await mock()
    await sleep(mod.mockLatency(opts.scenario))
    const result = mod.dispatch({
      method: 'GET',
      path,
      query: opts.query,
      scenario: opts.scenario,
      auth: authContext,
      traceId: tid,
    })
    if (!result.ok) throw new ApiError(result.error, result.status)
    return { text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data), filename: null, traceId: tid, status: result.status }
  }
  const res = await fetch(`${API_BASE}${path}${buildQuery({ ...opts.query, scenario: opts.scenario })}`, {
    method: 'GET',
    headers: { Accept: 'text/csv, application/json', 'X-Request-Id': tid },
    credentials: 'same-origin',
  })
  const text = await res.text()
  if (!res.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = text ? (JSON.parse(text) as ApiErrorBody) : null
    } catch {
      body = null
    }
    if (body && typeof body.errorCode === 'string') throw new ApiError(body, res.status)
    throw new ApiError(
      { errorCode: 'request.unknown', message: '导出未被服务端正常处理。', nextStep: '重试一次；仍失败请把 traceId 给管理员。', traceId: res.headers.get('X-Trace-Id') ?? tid },
      res.status,
    )
  }
  const cd = res.headers.get('content-disposition') ?? ''
  const m = /filename="?([^";]+)"?/.exec(cd)
  return { text, filename: m ? m[1]! : null, traceId: res.headers.get('X-Trace-Id') ?? tid, status: res.status }
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

  const res = await fetch(`${API_BASE}${path}${buildQuery({ ...opts.query, scenario: opts.scenario })}`, {
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

/**
 * 文件下载专用出口（GET 只读）。返回真实字节流，不把二进制当 JSON 解析。
 * Mock 模式下由派发器返回 `{ filename, text }`，包装为 Blob 以保持页面同一代码路径。
 */
export async function requestBlob(
  path: string,
  opts: RequestOptions = {},
): Promise<{ blob: Blob; filename: string; bytes: number; traceId: string; mock: boolean }> {
  const tid = traceId()
  if (USE_MOCK) {
    const mod = await mock()
    const result = mod.dispatch({
      method: 'GET',
      path,
      body: opts.body,
      query: opts.query,
      scenario: opts.scenario,
      idempotencyKey: opts.idempotencyKey,
      auth: authContext,
      traceId: tid,
    })
    if (!result.ok) throw new ApiError(result.error, result.status)
    const d = result.data as { filename?: string; text?: string }
    const text = d.text ?? ''
    return { blob: new Blob([text], { type: 'application/octet-stream' }), filename: d.filename ?? 'download.bin', bytes: new Blob([text]).size, traceId: tid, mock: true }
  }
  const res = await fetch(`${API_BASE}${path}${buildQuery({ ...opts.query, scenario: opts.scenario })}`, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream' },
    credentials: 'same-origin',
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text()
    let body: ApiErrorBody | null = null
    try {
      body = text ? (JSON.parse(text) as ApiErrorBody) : null
    } catch {
      body = null
    }
    if (body && typeof body.errorCode === 'string') throw new ApiError(body, res.status)
    throw new ApiError(
      { errorCode: 'request.unknown', message: '下载未被服务端正常处理。', nextStep: '重试一次；仍失败请把 traceId 给管理员。', traceId: res.headers.get('X-Trace-Id') ?? tid },
      res.status,
    )
  }
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const m = /filename="?([^";]+)"?/.exec(disposition)
  return { blob, filename: m?.[1] ?? 'download.bin', bytes: blob.size, traceId: res.headers.get('X-Trace-Id') ?? tid, mock: res.headers.get('X-Mock') === 'true' }
}
