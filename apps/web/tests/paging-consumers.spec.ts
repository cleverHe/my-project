/**
 * 分页消费方自检（paging-consumer-review / api-spec v1.2 §1.4）
 *
 * 三件事：
 * 1. `useServerPagedList` 不本地切片，页码/条数变化重新取数，越界回第 1 页；
 * 2. 页面实际发出的请求带 page/page_size（含 >200 数据分页可达）；
 * 3. Mock 与 BFF 同契约：非白名单 page_size / 未知参数都报错，不静默忽略。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { api } from '@/api/client'
import { authContext } from '@/api/http'
import { useServerPagedList, type ServerPage } from '@/composables/useServerPagedList'
import AuditPage from '@/pages/AuditPage.vue'
import AdminPeoplePage from '@/pages/AdminPeoplePage.vue'

authContext.userId = 'usr_trial_zhou'
authContext.csrfToken = 'csrf_test'

/** 造 250 条服务端数据，用于验证「不本地切片、能翻到最后一页」 */
function fakeServer(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i, name: `row-${i}` }))
  const calls: { page: number; page_size: number }[] = []
  const fetcher = async (p: { page: number; page_size: number }): Promise<ServerPage<{ id: number; name: string }>> => {
    calls.push(p)
    const start = (p.page - 1) * p.page_size
    return {
      items: rows.slice(start, start + p.page_size),
      total: rows.length,
      page: p.page,
      page_size: p.page_size,
      has_next: p.page * p.page_size < rows.length,
    }
  }
  return { calls, fetcher }
}

describe('useServerPagedList（服务端分页，不在前端切片）', () => {
  it('首次只取一页，条数由服务端返回的 page_size 决定', async () => {
    const { calls, fetcher } = fakeServer(250)
    const list = useServerPagedList(fetcher, 10)
    await list.load()
    expect(calls).toEqual([{ page: 1, page_size: 10 }])
    expect(list.rows.value).toHaveLength(10)
    expect(list.total.value).toBe(250)
    expect(list.hasNext.value).toBe(true)
  })

  it('翻页/切条数都重新请求，切条数回第 1 页', async () => {
    const { calls, fetcher } = fakeServer(250)
    const list = useServerPagedList(fetcher, 10)
    await list.load()
    list.goto(3)
    await nextTick()
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ page: 3, page_size: 10 }))
    expect(list.rows.value[0]!.id).toBe(20)
    list.setSize(200)
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ page: 1, page_size: 200 }))
    expect(list.rows.value).toHaveLength(200)
    list.goto(2)
    await vi.waitFor(() => expect(calls.at(-1)).toEqual({ page: 2, page_size: 200 }))
    expect(list.rows.value).toHaveLength(50)
    expect(list.hasNext.value).toBe(false)
  })

  it('页码越界（过滤后变少）自动回第 1 页重查，不停在假空表', async () => {
    const calls: { page: number; page_size: number }[] = []
    const fetcher = async (p: { page: number; page_size: number }): Promise<ServerPage<{ id: number }>> => {
      calls.push(p)
      const total = 40
      const start = (p.page - 1) * p.page_size
      return { items: Array.from({ length: Math.max(0, Math.min(p.page_size, total - start)) }, (_, i) => ({ id: start + i })), total, page: p.page, page_size: p.page_size, has_next: p.page * p.page_size < total }
    }
    const list = useServerPagedList(fetcher, 10)
    await list.load()
    list.goto(99)
    await vi.waitFor(() => expect(list.page.value).toBe(1))
    await vi.waitFor(() => expect(list.rows.value).toHaveLength(10))
    expect(calls.at(-1)).toEqual({ page: 1, page_size: 10 })
  })

  it('慢响应不覆盖新条件的结果（只认最后一次请求）', async () => {
    let release: (() => void) | null = null
    const fetcher = (p: { page: number; page_size: number }) =>
      new Promise<ServerPage<{ id: number }>>((resolve) => {
        const finish = () => resolve({ items: [{ id: p.page }], total: 1, page: p.page, page_size: p.page_size, has_next: false })
        if (p.page === 1) release = finish
        else finish()
      })
    const list = useServerPagedList(fetcher, 10)
    const slow = list.load()
    list.goto(2)
    await vi.waitFor(() => expect(list.rows.value[0]?.id).toBe(2))
    release!()
    await slow
    expect(list.rows.value[0]?.id).toBe(2)
  })

  it('空列表保留第 1 页与共 0 条', async () => {
    const list = useServerPagedList(async (p) => ({ items: [], total: 0, page: p.page, page_size: p.page_size, has_next: false }), 10)
    await list.load()
    expect(list.page.value).toBe(1)
    expect(list.total.value).toBe(0)
    expect(list.rows.value).toEqual([])
  })
})

describe('Mock 与 BFF 同契约（分页参数校验）', () => {
  it('审计：非白名单 page_size 与未知参数都报错，不静默截断', async () => {
    await expect(api.audit({ page_size: 500 })).rejects.toMatchObject({ errorCode: 'request.param_invalid' })
    await expect(api.audit({ page_size: 37 })).rejects.toMatchObject({ errorCode: 'request.param_invalid' })
    await expect(api.audit({ owner: 'usr_1' })).rejects.toMatchObject({ errorCode: 'request.param_unknown' })
    await expect(api.audit({ from: '2026-11-21T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' })).rejects.toMatchObject({ errorCode: 'request.range_invalid' })
  })

  it('审计：分页字段齐全，过滤后 total 与 items 同源', async () => {
    const all = await api.audit({ page: 1, page_size: 10 })
    expect(all.data).toMatchObject({ page: 1, page_size: 10 })
    expect(typeof all.data.total).toBe('number')
    expect(typeof all.data.has_next).toBe('boolean')
    const filtered = await api.audit({ action: 'deploy.publish' })
    expect(filtered.data.total).toBe(filtered.data.items.length)
    expect(filtered.data.items.every((r) => (r.action ?? '').includes('deploy.publish'))).toBe(true)
  })

  it('人员：分页 + q 过滤在服务端，返回真实 total', async () => {
    const all = await api.adminUsers({ page_size: 10 })
    expect(all.data.items).toHaveLength(all.data.total)
    expect(all.data.items).toHaveLength(5)
    const one = await api.adminUsers({ q: 'zhou.min' })
    expect(one.data.total).toBe(1)
    expect(one.data.items[0]?.feishu_account).toBe('zhou.min')
    const none = await api.adminUsers({ q: 'not-exist' })
    expect(none.data.total).toBe(0)
    expect(none.data.items).toEqual([])
  })

  it('项目：page_size=200 是上限，超出报错；q 过滤 total 同源', async () => {
    const r = await api.projects({ page_size: 200 })
    expect(r.data.total).toBe(r.data.items.length)
    await expect(api.projects({ page_size: 500 })).rejects.toMatchObject({ errorCode: 'request.param_invalid' })
    await expect(api.projects({ sort: 'owner_name' })).rejects.toMatchObject({ errorCode: 'request.sort_invalid' })
  })
})

describe('页面消费方（真实组件 + Mock 同名契约）', () => {
  it('审计页渲染服务端返回的这一页，分页总数用 total', async () => {
    const w = mount(AuditPage)
    await vi.waitFor(() => expect(w.text()).toContain('共 10 条'))
    const rows = w.findAll('tbody tr')
    expect(rows).toHaveLength(10)
    expect(w.text()).toContain('deploy.publish')
    // 搜索框按操作过滤走后端：输入后 300ms 回第 1 页
    await w.find('input[type="search"]').setValue('deploy.publish')
    await vi.waitFor(() => expect(w.text()).toContain('共 2 条'))
    expect(w.findAll('tbody tr')).toHaveLength(2)
    w.unmount()
  })

  it('人员页渲染服务端分页数据，并在无匹配时给「没有找到该账号」', async () => {
    const w = mount(AdminPeoplePage)
    await vi.waitFor(() => expect(w.text()).toContain('共 5 条'))
    expect(w.findAll('tbody tr')).toHaveLength(5)
    await w.find('input[type="search"]').setValue('not-exist-person')
    await vi.waitFor(() => expect(w.text()).toContain('没有找到该账号'))
    expect(w.text()).toContain('共 0 条')
    w.unmount()
  })
})
