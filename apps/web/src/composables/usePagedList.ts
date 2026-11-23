/**
 * 列表分页状态（与 ListShell 配套）
 * 规则来自 visual-baseline §2.4：默认每页 10；查询变化与切换条数都回到第 1 页；
 * 空列表保留第 1 页（页数下限为 1），总数照实显示 0。
 */
import { computed, ref, watch } from 'vue'

export function usePagedList<T>(rows: () => T[], initialSize = 10) {
  const page = ref(1)
  const size = ref(initialSize)
  const total = computed(() => rows().length)
  const pages = computed(() => Math.max(1, Math.ceil(total.value / size.value)))
  const paged = computed(() => rows().slice((page.value - 1) * size.value, page.value * size.value))

  watch([total, size], () => {
    if (page.value > pages.value) page.value = pages.value
    if (page.value < 1) page.value = 1
  })

  /** 查询条件变化后回到第 1 页 */
  function reset() {
    page.value = 1
  }
  /** 切换每页条数后回到第 1 页 */
  function setSize(next: number) {
    size.value = next
    page.value = 1
  }

  return { page, size, total, pages, paged, reset, setSize }
}

/** 简单的关键词包含匹配（大小写不敏感；空关键词视为不过滤） */
export function matchesKeyword(keyword: string, ...fields: (string | null | undefined)[]): boolean {
  const k = keyword.trim().toLowerCase()
  if (!k) return true
  return fields.some((f) => (f ?? '').toLowerCase().includes(k))
}
