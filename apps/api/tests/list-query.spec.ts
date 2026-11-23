/**
 * api-spec v1.2 §1.4 列表契约的单元自检（DEF-V01/V02/V03 修复的底座）：
 * 只测纯函数（参数校验、排序、切片），端点级行为在 api.spec.ts 里用真实请求验证。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, PAGE_SIZE_ALLOWED, paginate, parseListQuery, parsePaging, parseRange, sortBy } from '../src/domain/list-query.js'

describe('page/page_size 白名单（DEF-V03）', () => {
  it('白名单内全部接受：10/20/50/100/200', () => {
    for (const size of [10, 20, 50, 100, 200]) {
      const r = parsePaging({ page_size: String(size) })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.page_size).toBe(size)
    }
  })

  it('缺省为 page=1 / page_size=20', () => {
    const r = parsePaging({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ page: DEFAULT_PAGE, page_size: DEFAULT_PAGE_SIZE })
    expect(DEFAULT_PAGE_SIZE).toBe(20)
  })

  it('非白名单 37 / 500 返回 400 request.param_invalid 并附 allowed', () => {
    for (const bad of ['37', '500', '0', '2.5', 'abc', '-10']) {
      const r = parsePaging({ page_size: bad })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe('request.param_invalid')
        expect(r.error.details).toMatchObject({ field: 'page_size' })
        expect((r.error.details as { allowed: readonly number[] }).allowed).toEqual(PAGE_SIZE_ALLOWED)
      }
    }
  })

  it('page 必须是 ≥1 的整数', () => {
    for (const bad of ['0', '-1', '1.5', 'x']) {
      const r = parsePaging({ page: bad })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('request.param_invalid')
    }
  })
})

describe('未知参数与排序（§1.4）', () => {
  it('未知参数 → request.param_unknown，并列出未知项与允许项', () => {
    const r = parseListQuery({ page: '1', owner: 'usr_1' }, ['page', 'page_size', 'status'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('request.param_unknown')
      expect(r.error.details).toMatchObject({ unknown: ['owner'] })
    }
  })

  it('sort 白名单外 → request.sort_invalid（不是 param_invalid）', () => {
    const r = parseListQuery({ sort: 'owner_name' }, ['page', 'page_size', 'sort'], ['updated_at', 'name', 'created_at'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('request.sort_invalid')
      expect((r.error.details as { allowed: string[] }).allowed).toEqual(['updated_at', 'name', 'created_at'])
    }
  })

  it('sort 缺省为 -第一字段；- 前缀为倒序', () => {
    const def = parseListQuery({}, ['page', 'page_size', 'sort'], ['updated_at', 'name'])
    expect(def.ok).toBe(true)
    if (def.ok) expect(def.value.sort).toEqual({ field: 'updated_at', dir: -1 })
    const asc = parseListQuery({ sort: 'name' }, ['page', 'page_size', 'sort'], ['updated_at', 'name'])
    expect(asc.ok).toBe(true)
    if (asc.ok) expect(asc.value.sort).toEqual({ field: 'name', dir: 1 })
  })

  it('时间范围：from > to → request.range_invalid；不可解析 → param_invalid', () => {
    const bad = parseRange('2026-11-21T00:00:00.000Z', '2026-11-20T00:00:00.000Z')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('request.range_invalid')
    const malformed = parseRange('yesterday', undefined)
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.error.code).toBe('request.param_invalid')
  })
})

describe('切片与总数（DEF-V01/V02）', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: i }))

  it('page_size=200 时 250 条可完整翻完，不丢第 201 条起的记录', () => {
    const first = paginate(rows, { page: 1, page_size: 200 })
    expect(first.items).toHaveLength(200)
    expect(first.total).toBe(250)
    expect(first.has_next).toBe(true)
    const second = paginate(rows, { page: 2, page_size: 200 })
    expect(second.items).toHaveLength(50)
    expect(second.items[0]).toEqual({ id: 200 })
    expect(second.total).toBe(250)
    expect(second.has_next).toBe(false)
    const ids = new Set([...first.items, ...second.items].map((r) => r.id))
    expect(ids.size).toBe(250)
  })

  it('超出末页：items 空、total 仍为真实总数、保留请求页码', () => {
    const out = paginate(rows, { page: 99, page_size: 20 })
    expect(out.items).toEqual([])
    expect(out.total).toBe(250)
    expect(out.page).toBe(99)
    expect(out.has_next).toBe(false)
  })

  it('空列表保留第 1 页与共 0 条', () => {
    const out = paginate([], { page: 1, page_size: 10 })
    expect(out).toEqual({ items: [], total: 0, page: 1, page_size: 10, has_next: false })
  })

  it('total 取过滤后长度（不是未过滤全量）', () => {
    const filtered = rows.filter((r) => r.id < 21)
    const out = paginate(filtered, { page: 1, page_size: 10 })
    expect(out.total).toBe(21)
    expect(out.items).toHaveLength(10)
    expect(out.has_next).toBe(true)
  })
})

describe('排序稳定性', () => {
  it('同值时保留原始顺序，倒序只反转键值比较', () => {
    const items = [
      { id: 'a', at: '2026-11-20T01:00:00.000Z' },
      { id: 'b', at: '2026-11-20T02:00:00.000Z' },
      { id: 'c', at: '2026-11-20T02:00:00.000Z' },
    ]
    const desc = sortBy(items, { field: 'at', dir: -1 }, { at: (i) => i.at })
    expect(desc.map((i) => i.id)).toEqual(['b', 'c', 'a'])
    const asc = sortBy(items, { field: 'at', dir: 1 }, { at: (i) => i.at })
    expect(asc.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(sortBy(items, null, { at: (i) => i.at })).toEqual(items)
  })
})
