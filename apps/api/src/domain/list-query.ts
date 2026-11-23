/**
 * 列表查询契约（api-spec v1.2 §1.4 唯一实现点）
 *
 * 只做三件事：参数解析/白名单、排序、分页切片。
 * 业务过滤（可见性、状态、关键词、时段）留在各端点的查询层，保证
 * `total` 与 `items` 用同一套过滤条件（禁止「当前页截断 + total 全量」）。
 */

/** 服务端 page_size 白名单（api-spec §1.4，200 为上限） */
export const PAGE_SIZE_ALLOWED = [10, 20, 50, 100, 200] as const

/** 服务端缺省 page_size；UI 缺省 10 由前端显式传参（前端未实现前不假装已支持） */
export const DEFAULT_PAGE_SIZE = 20
export const DEFAULT_PAGE = 1

export type RawQuery = Record<string, string | undefined>

export interface Paging {
  page: number
  page_size: number
}

export interface SortSpec {
  field: string
  dir: 1 | -1
}

export type QueryError =
  | { code: 'request.param_unknown'; details: { unknown: string[]; allowed: string[] } }
  | { code: 'request.param_invalid'; details: { field: string; value?: unknown; allowed?: readonly number[]; note?: string } }
  | { code: 'request.sort_invalid'; details: { field: 'sort'; value: string; allowed: string[] } }
  | { code: 'request.range_invalid'; details: { field: 'from' | 'to'; from: string; to: string; note: string } }

export type QueryResult<T> = { ok: true; value: T } | { ok: false; error: QueryError }

export interface ListQuery {
  paging: Paging
  sort: SortSpec | null
  /** 已校验的过滤参数（端点自行按需读取，这里只做未知参数拦截） */
  filters: RawQuery
}

const INTEGER = /^\d+$/

function badField(field: string, value: string | undefined, extra: Record<string, unknown> = {}): QueryResult<never> {
  return { ok: false, error: { code: 'request.param_invalid', details: { field, value, ...extra } } }
}

export function parsePaging(q: RawQuery): QueryResult<Paging> {
  let page = DEFAULT_PAGE
  if (q.page !== undefined) {
    if (!INTEGER.test(q.page)) return badField('page', q.page, { note: 'page 必须是 ≥1 的整数' })
    page = Number(q.page)
    if (!Number.isSafeInteger(page) || page < 1) return badField('page', q.page, { note: 'page 必须是 ≥1 的整数' })
  }
  let page_size: number = DEFAULT_PAGE_SIZE
  if (q.page_size !== undefined) {
    if (!INTEGER.test(q.page_size)) return badField('page_size', q.page_size, { allowed: PAGE_SIZE_ALLOWED })
    page_size = Number(q.page_size)
    if (!(PAGE_SIZE_ALLOWED as readonly number[]).includes(page_size)) {
      return badField('page_size', q.page_size, { allowed: PAGE_SIZE_ALLOWED, note: 'page_size 只接受白名单值' })
    }
  }
  return { ok: true, value: { page, page_size } }
}

/** `-updated_at` = 倒序；白名单外返回 request.sort_invalid（不是 param_invalid） */
export function parseSort(raw: string | undefined, allowed: readonly string[], fallback = `-${allowed[0]}`): QueryResult<SortSpec> {
  const text = raw ?? fallback
  const dir: 1 | -1 = text.startsWith('-') ? -1 : 1
  const field = text.startsWith('-') ? text.slice(1) : text
  if (!allowed.includes(field) || field === '') {
    return { ok: false, error: { code: 'request.sort_invalid', details: { field: 'sort', value: text, allowed: allowed.map((f) => f) } } }
  }
  return { ok: true, value: { field, dir } }
}

/**
 * 解析列表查询：未知参数 → param_unknown；page/page_size 白名单；可选 sort。
 * @param allowedKeys 该端点声明的查询参数全集（含 page/page_size/sort）
 */
export function parseListQuery(q: RawQuery, allowedKeys: readonly string[], sortable?: readonly string[]): QueryResult<ListQuery> {
  const unknown = Object.keys(q).filter((k) => !allowedKeys.includes(k))
  if (unknown.length > 0) return { ok: false, error: { code: 'request.param_unknown', details: { unknown, allowed: [...allowedKeys] } } }

  const paging = parsePaging(q)
  if (!paging.ok) return { ok: false, error: paging.error }
  if (!sortable) return { ok: true, value: { paging: paging.value, sort: null, filters: q } }
  const sort = parseSort(q.sort, sortable)
  if (!sort.ok) return { ok: false, error: sort.error }
  return { ok: true, value: { paging: paging.value, sort: sort.value, filters: q } }
}

/** 稳定排序：ISO 时间串按字典序即是时间序；同值时保留原顺序 */
export function sortBy<T>(items: readonly T[], sort: SortSpec | null, keys: Record<string, (t: T) => string>): T[] {
  if (!sort) return [...items]
  const key = keys[sort.field]
  if (!key) return [...items]
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ka = key(a.item)
      const kb = key(b.item)
      const diff = ka < kb ? -1 : ka > kb ? 1 : 0
      return diff === 0 ? a.index - b.index : diff * sort.dir
    })
    .map((x) => x.item)
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  has_next: boolean
}

/** 分页切片：total 取过滤后全量长度，has_next 服务端算，空页保留请求页码 */
export function paginate<T>(items: readonly T[], paging: Paging): Page<T> {
  const start = (paging.page - 1) * paging.page_size
  return {
    items: items.slice(start, start + paging.page_size),
    total: items.length,
    page: paging.page,
    page_size: paging.page_size,
    has_next: paging.page * paging.page_size < items.length,
  }
}

/**
 * 时间范围解析（左闭右开，api-spec §1.4）。
 * 返回毫秒边界；未给出的一侧为 ±Infinity。
 */
export function parseRange(from: string | undefined, to: string | undefined): QueryResult<{ fromMs: number; toMs: number }> {
  const fromMs = from === undefined ? -Infinity : Date.parse(from)
  const toMs = to === undefined ? Infinity : Date.parse(to)
  if (Number.isNaN(fromMs)) return badField('from', from, { note: 'from 必须是可解析的时间' })
  if (Number.isNaN(toMs)) return badField('to', to, { note: 'to 必须是可解析的时间' })
  if (fromMs > toMs) return { ok: false, error: { code: 'request.range_invalid', details: { field: 'from', from: from ?? '', to: to ?? '', note: 'from 必须早于或等于 to' } } }
  return { ok: true, value: { fromMs, toMs } }
}
