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
import { createMemoryHistory, createRouter } from 'vue-router'
import { nextTick } from 'vue'
import { api } from '@/api/client'
import { ApiError, authContext } from '@/api/http'
import type { ProjectCard } from '@/api/types'
import { useServerPagedList, type ServerPage } from '@/composables/useServerPagedList'
import AuditPage from '@/pages/AuditPage.vue'
import AdminPeoplePage from '@/pages/AdminPeoplePage.vue'
import DashboardPage from '@/pages/DashboardPage.vue'
import ListShell from '@/components/ListShell.vue'

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

describe('ListShell 分页区（总数在左、控件在右、页码有窗口）', () => {
  it('页数很多时页码不铺满：保留首页/尾页/当前附近，中间用省略号', () => {
    const w = mount(ListShell, { props: { total: 206, page: 1, size: 10 }, slots: { default: '<div>rows</div>' } })
    const labels = w.findAll('.pagebtn').map((b) => b.text())
    // 上一页 + 窗口页码 + 下一页
    expect(labels[0]).toBe('上一页')
    expect(labels).toContain('1')
    expect(labels).toContain('21')
    expect(labels.filter((t) => /^\d+$/.test(t)).length).toBeLessThanOrEqual(9)
    expect(w.findAll('.pagegap').length).toBeGreaterThan(0)
    w.unmount()
  })

  it('页码少（≤9 页）时全部展示，不出现省略号；空列表保留第 1 页与共 0 条', () => {
    const many = mount(ListShell, { props: { total: 50, page: 2, size: 10 }, slots: { default: '<div>rows</div>' } })
    expect(many.findAll('.pagegap')).toHaveLength(0)
    expect(many.findAll('.pagebtn').map((b) => b.text())).toEqual(['上一页', '1', '2', '3', '4', '5', '下一页'])
    many.unmount()

    const empty = mount(ListShell, { props: { total: 0, page: 1, size: 10 }, slots: { default: '<div class="empty">没有数据</div>' } })
    expect(empty.find('.pager-total').text()).toBe('共 0 条')
    expect(empty.findAll('.pagebtn').map((b) => b.text())).toEqual(['上一页', '1', '下一页'])
    empty.unmount()
  })
})

describe('Dashboard：项目超过单次响应上限（200）仍完整可达（VIS-13）', () => {
  function card(id: string, name: string, status: 'active' | 'soft_deleted' = 'active'): ProjectCard {
    return {
      id,
      name,
      slug: id,
      status,
      owner: { user_id: 'usr_trial_lin', display_name: '林小满' },
      relation: 'owner',
      preview: { slot: 'recent', total: 0, limit: 3, items: [] },
      production: { state: 'not_created', url: null, sha: null, version_label: null, updated_at: null },
      quota: { used_bytes: 0, limit_bytes: 4 * 1024 ** 3, ratio: 0, warning: false },
      spec: { cpu: 0.5, memory_mb: 256, disk_bytes: 4 * 1024 ** 3, preview_limit: 3 },
      updated_at: '2026-11-20T08:40:00.000Z',
    }
  }

  /** 服务端替身：与 BFF 同契约（page/page_size 白名单、total 与 items 同源、has_next） */
  function fakeServer(opts: { active: number; deleted: number; failPage?: number }) {
    const active = Array.from({ length: opts.active }, (_, i) => card(`prj_bulk_${i + 1}`, `批量项目 ${String(i + 1).padStart(3, '0')}`))
    const deleted = Array.from({ length: opts.deleted }, (_, i) => card(`prj_del_${i + 1}`, `已删除项目 ${String(i + 1).padStart(3, '0')}`, 'soft_deleted'))
    const calls: { page: number; page_size: number; status?: string }[] = []
    const spy = vi.spyOn(api, 'projects').mockImplementation(async (q = {}) => {
      const page = Number(q.page ?? 1)
      const page_size = Number(q.page_size ?? 20)
      const status = q.status === undefined ? undefined : String(q.status)
      calls.push({ page, page_size, status })
      if (opts.failPage && page === opts.failPage) {
        throw new ApiError({ errorCode: 'server.unavailable', message: '服务暂时不可用。', nextStep: '稍后重试。', traceId: 'trc_test' }, 503)
      }
      const rows = status === 'soft_deleted' ? deleted : active
      const start = (page - 1) * page_size
      const items = rows.slice(start, start + page_size)
      return {
        data: { items, total: rows.length, page, page_size, has_next: start + page_size < rows.length },
        traceId: 'trc_test',
        mock: false,
        status: 200,
      }
    })
    return { calls, spy, active, deleted }
  }

  async function mountDashboard() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/dashboard', component: { template: '<div />' } },
        { path: '/projects/:id/deploy', component: { template: '<div />' } },
        { path: '/wizard', component: { template: '<div />' } },
      ],
    })
    await router.push('/dashboard')
    await router.isReady()
    return mount(DashboardPage, { global: { plugins: [router] } })
  }

  it('212 个项目逐页取回：全部渲染、无重复无遗漏，第 201 个及之后的卡片可达；已删除列表同样完整', async () => {
    const { calls, spy, active, deleted } = fakeServer({ active: 212, deleted: 205 })
    try {
      const w = await mountDashboard()
      await vi.waitFor(() => expect(w.findAll('.pcard')).toHaveLength(212))

      // 请求序列：page_size 固定 200，按 page 依次取，直到 has_next=false
      expect(calls.filter((c) => c.status === undefined)).toEqual([
        { page: 1, page_size: 200, status: undefined },
        { page: 2, page_size: 200, status: undefined },
      ])
      // 无重复、无遗漏：卡片标题两两不同，且等于服务端 212 条
      const titles = w.findAll('.pcard .title a').map((a) => a.text())
      expect(new Set(titles).size).toBe(212)
      expect(titles).toEqual(active.map((p) => p.name))
      // 第 201 条之后的项目确实出现在页面上，并且仍指向详情路由
      expect(titles).toContain(active[200]!.name)
      expect(titles).toContain(active[211]!.name)
      const lastLink = w.findAll('.pcard .title a').at(-1)!
      expect(lastLink.attributes('href')).toContain(`/projects/${active[211]!.id}/deploy`)
      // 不再出现「本页最多显示 200 个，请用搜索」的不可达提示
      expect(w.find('.warnbox').exists()).toBe(false)

      // 已删除列表：同样逐页取回，不得只显示前 200 条
      await w.findAll('button').find((b) => b.text().includes('已删除项目'))!.trigger('click')
      await vi.waitFor(() => expect(w.findAll('.pcard')).toHaveLength(205))
      expect(calls.filter((c) => c.status === 'soft_deleted')).toEqual([
        { page: 1, page_size: 200, status: 'soft_deleted' },
        { page: 2, page_size: 200, status: 'soft_deleted' },
      ])
      expect(w.findAll('.pcard .title a').map((a) => a.text())).toEqual(deleted.map((p) => p.name))
      w.unmount()
    } finally {
      spy.mockRestore()
    }
  })

  it('次页失败：保留已取回部分并明确报错，不把 200 条当加载完成', async () => {
    const { spy } = fakeServer({ active: 212, deleted: 0, failPage: 2 })
    try {
      const w = await mountDashboard()
      await vi.waitFor(() => expect(w.find('.warnbox').exists()).toBe(true))
      expect(w.find('.warnbox').text()).toContain('分页加载中断')
      expect(w.find('.warnbox').text()).toContain('已取回 200 个 / 共 212 个')
      expect(w.find('[role="alert"]').exists()).toBe(true)
      expect(w.findAll('.pcard')).toHaveLength(200)
      // 有错误时不能显示「还没有项目」，也不能显示「加载完成」的假成功
      expect(w.text()).not.toContain('还没有项目')
      w.unmount()
    } finally {
      spy.mockRestore()
    }
  })

  it('空数据：显示空态且不带告警（0 条不是加载失败）', async () => {
    const { spy } = fakeServer({ active: 0, deleted: 0 })
    try {
      const w = await mountDashboard()
      await vi.waitFor(() => expect(w.text()).toContain('还没有项目'))
      expect(w.find('.warnbox').exists()).toBe(false)
      expect(w.find('[role="alert"]').exists()).toBe(false)
      expect(w.findAll('.pcard')).toHaveLength(0)
      w.unmount()
    } finally {
      spy.mockRestore()
    }
  })
})
