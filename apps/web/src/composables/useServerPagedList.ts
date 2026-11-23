/**
 * 服务端分页列表状态（api-spec v1.2 §1.4 / paging-consumer-review）
 *
 * 与 `usePagedList` 的区别：这里**不在前端切片**，page/page_size 交给服务端，
 * 总数与是否还有下一页只认服务端返回的 `total`/`has_next`。
 * 适用于契约里声明了分页参数的端点（/projects、/admin/users、/audit）；
 * 明确定义为「完整数组」的端点继续用 `usePagedList`（见各页面注释与台账）。
 *
 * 规则（visual-baseline §2.4）：默认每页 10；切换条数回第 1 页；
 * 空列表保留第 1 页与「共 0 条」；超出末页时自动回第 1 页重查，不展示假空表。
 */
import { ref, watch, type Ref } from 'vue'

export interface ServerPage<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  has_next: boolean
}

export type ServerPageFetcher<T> = (p: { page: number; page_size: number }) => Promise<ServerPage<T>>

export function useServerPagedList<T>(fetcher: ServerPageFetcher<T>, initialSize = 10) {
  const page = ref(1)
  const size = ref(initialSize)
  const rows = ref([]) as Ref<T[]>
  const total = ref(0)
  const hasNext = ref(false)
  const loading = ref(false)
  const error = ref<unknown>(null)
  /** 只认最后一次请求，避免慢响应覆盖新条件的结果 */
  let seq = 0

  async function load(): Promise<void> {
    const mine = ++seq
    loading.value = true
    error.value = null
    try {
      const res = await fetcher({ page: page.value, page_size: size.value })
      if (mine !== seq) return
      rows.value = res.items
      total.value = res.total
      hasNext.value = res.has_next
      // 页码越界（过滤/删除后）：回第 1 页重查，而不是停在一张假的空表上
      if (res.items.length === 0 && res.total > 0 && res.page > 1) {
        page.value = 1
      }
    } catch (e) {
      if (mine === seq) {
        rows.value = []
        total.value = 0
        hasNext.value = false
        error.value = e
      }
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  // page/size 变化都重新取数（同一 tick 内的多次修改只发一次请求）
  watch([page, size], () => void load())

  function goto(next: number) {
    const p = Math.max(1, Math.trunc(next))
    if (p === page.value) return
    page.value = p
  }

  function setSize(next: number) {
    size.value = next
    page.value = 1
  }

  /** 查询条件变化：回第 1 页再查（已在第 1 页时也要重查，例如删除后刷新） */
  function reset() {
    if (page.value === 1) void load()
    else page.value = 1
  }

  return { page, size, rows, total, hasNext, loading, error, load, goto, setSize, reset }
}
