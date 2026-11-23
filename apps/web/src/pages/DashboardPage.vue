<script setup lang="ts">
/** P-02 Dashboard：一个项目一张卡片；两个入口槽位；三种状态；多预览用「查看全部 N 个」 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api/client'
import type { ProjectCard } from '@/api/types'
import ErrorNotice from '@/components/ErrorNotice.vue'
import EntryCard from '@/components/EntryCard.vue'
import StatusPill from '@/components/StatusPill.vue'
import { formatBytes, formatPercent, formatTimeDual } from '@/domain/format'
import { multiPreview, previewQuotaText, previewSlotView, productionSlotView, projectStatusLabel } from '@/domain/status'
import { quotaMessage } from '@/domain/quota'
import { COPY } from '@/domain/text'
import { useSession } from '@/stores/session'
import { useUi } from '@/stores/ui'

const route = useRoute()
const router = useRouter()
const session = useSession()
const ui = useUi()
const items = ref<ProjectCard[]>([])
const error = ref<unknown>(null)
const loading = ref(false)
/** 已取回的卡片数（逐批加载时给用户真实进度，不是假动画） */
const progress = ref(0)
/** 取回数量与服务端 total 不一致，或分页中途失败时的如实说明（不再把残缺列表当完整） */
const incomplete = ref<string | null>(null)
const showDeleted = ref(false)
const expanded = ref<Record<string, boolean>>({})
const now = new Date('2026-11-20T09:20:00.000Z')

/** 路由守卫挡回时说明原因，避免「点了没反应」 */
function explainDenied() {
  const denied = route.query.denied
  if (typeof denied === 'string' && denied.startsWith('/sys')) {
    ui.push('warn', '该页面需要系统管理员', ['你的当前角色看不到也无法调用系统级能力（如项目规格、异常预览清理）。', '需要时联系系统管理员处理；本页面不会代你提权。'])
  } else if (typeof denied === 'string' && denied.startsWith('/admin')) {
    ui.push('warn', '该页面需要管理员', ['你的当前角色只能查看自己的项目。', '如需项目组或人员权限能力，联系管理员。'])
  }
}

/** 列表接口单次响应上限（api-spec §1.4 白名单）；它是「每页最多多少」，不是用户项目总数上限 */
const PAGE_SIZE = 200

/**
 * 项目列表按服务端分页逐批取回（VIS-13）。
 *
 * 服务端 page_size=200 只是单次响应上限：超过 200 个项目时，旧的「只取第 1 页 + 提示去搜索」
 * 会让第 201 个及之后的项目在 Dashboard 上不可达（页面既没有搜索，也没有翻页）。
 * 这里按 page/has_next 依次取回剩余分页，合成完整集合后一次性渲染；
 * 任何一页失败都保留已取回部分并明确报错，不把残缺列表当成加载完成。
 */
async function load() {
  loading.value = true
  error.value = null
  incomplete.value = null
  progress.value = 0
  const collected: ProjectCard[] = []
  const seen = new Set<string>()
  let total = 0
  try {
    for (let page = 1; ; page += 1) {
      const res = await api.projects({
        page,
        page_size: PAGE_SIZE,
        ...(showDeleted.value ? { status: 'soft_deleted' } : {}),
      })
      total = res.data.total
      for (const item of res.data.items) {
        // 同一次加载内按 id 去重：分页期间数据变化时不重复渲染同一张卡片
        if (seen.has(item.id)) continue
        seen.add(item.id)
        collected.push(item)
      }
      progress.value = collected.length
      if (!res.data.has_next || res.data.items.length === 0) break
      // 兜底：服务端 has_next 异常为真时不在本页死循环（按 total 推算出应有页数）
      if (page > Math.ceil(Math.max(total, collected.length) / PAGE_SIZE)) break
    }
    items.value = collected
    if (collected.length !== total) {
      incomplete.value = `服务端共 ${total} 个项目，本次取回 ${collected.length} 个（加载期间列表有变化），请刷新重试。`
    }
  } catch (e) {
    error.value = e
    items.value = collected
    if (collected.length) {
      incomplete.value = `分页加载中断：已取回 ${collected.length} 个${total ? ` / 共 ${total} 个` : ''}，其余项目未显示。请重试。`
    }
  } finally {
    loading.value = false
  }
}

function openPreview(p: ProjectCard) {
  const recent = p.preview.items[0]
  if (!recent) {
    void router.push(`/projects/${p.id}/deploy`)
    return
  }
  if (recent.display_state === 'sleeping') {
    void router.push(`/projects/${p.id}/deploy`)
    ui.push('info', '预览已休眠', ['在部署页点「唤醒」；7 天闲置缩 0 副本，唤醒最长 60 秒。'])
    return
  }
  window.open(recent.url, '_blank', 'noopener')
}

function openProduction(p: ProjectCard) {
  if (p.production.state === 'not_created' || !p.production.url) {
    void router.push(`/projects/${p.id}/deploy`)
    return
  }
  window.open(p.production.url, '_blank', 'noopener')
}

onMounted(() => {
  explainDenied()
  void load()
})
const who = computed(() => session.state.me?.display_name ?? '')
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>我的项目</h1>
        <p class="sub">{{ who }} · 卡片上的地址只是入口，不授予任何权限；{{ COPY.linkNeedsPermission }}</p>
      </div>
      <div class="row">
        <button class="btn" :class="{ primary: showDeleted }" @click="showDeleted = !showDeleted; load()">
          {{ showDeleted ? '返回项目列表' : '已删除项目（30 天内可恢复）' }}
        </button>
        <RouterLink class="btn primary" to="/wizard">创建项目</RouterLink>
      </div>
    </div>

    <ErrorNotice v-if="error" :error="error" />

    <div v-if="loading" class="center-note">
      加载中…<template v-if="progress > 0">（已取回 {{ progress }} 个项目）</template>
    </div>
    <div v-else-if="!error && items.length === 0" class="panel center-note">
      <p>{{ showDeleted ? '没有已删除的项目。' : '还没有项目。' }}</p>
      <p v-if="!showDeleted" class="hint">创建项目后会得到仓库、规范与 4 个门户 Skill；模板不可用时可回退空白模板，不会建空仓库。</p>
    </div>

    <p v-if="!loading && incomplete" class="warnbox">{{ incomplete }}</p>
    <div v-if="!loading && items.length" class="grid">
      <article v-for="p in items" :key="p.id" class="pcard">
        <header>
          <div class="title">
            <RouterLink :to="`/projects/${p.id}/deploy`">{{ p.name }}</RouterLink>
            <span v-if="p.status === 'soft_deleted'" class="badge">{{ projectStatusLabel('soft_deleted') }}</span>
          </div>
          <span class="relation">{{ p.relation === 'owner' ? '拥有者' : p.relation === 'granted' ? `被授权（${p.relation_label ?? '拥有者'}）` : p.relation === 'group' ? (p.relation_label ?? '项目组') : '—' }}</span>
        </header>

        <div v-if="p.status === 'soft_deleted'" class="deleted">
          <p>{{ p.name }} 已删除，30 天内可由管理员恢复。此处不展示任何项目内容。</p>
        </div>
        <template v-else>
          <div class="slots">
            <EntryCard :slot="previewSlotView(p.preview)" @action="openPreview(p)" />
            <EntryCard :slot="productionSlotView(p.production)" @action="openProduction(p)" />
          </div>

          <div class="row between">
            <button v-if="multiPreview(p.preview).visible" class="linkbtn" @click="expanded[p.id] = !expanded[p.id]">
              {{ expanded[p.id] ? '收起' : multiPreview(p.preview).label }}
            </button>
            <span v-else class="hint">{{ previewQuotaText(p.preview.total, p.preview.limit) }}</span>
            <span class="hint">更新于 {{ formatTimeDual(p.updated_at, now) }}</span>
          </div>

          <div v-if="expanded[p.id]" class="all-previews">
            <p class="hint">{{ COPY.previewRetention }}</p>
            <ul>
              <li v-for="(it, i) in p.preview.items" :key="it.id">
                <span class="mono">{{ it.branch }}</span>
                <StatusPill :state="it.display_state" />
                <span v-if="it.branch_deleted" class="badge">分支已删除 · 预览保留</span>
                <a :href="it.url" target="_blank" rel="noopener">打开</a>
              </li>
              <li v-if="p.preview.items.length < p.preview.total" class="hint">全部 {{ p.preview.total }} 个预览请到项目部署页查看。</li>
            </ul>
          </div>

          <div class="quota">
            <div class="bar"><i :style="{ width: `${Math.min(100, p.quota.ratio * 100)}%` }" :class="p.quota.warning ? 'warn' : ''"></i></div>
            <span class="hint">磁盘 {{ formatBytes(p.quota.used_bytes) }} / {{ formatBytes(p.quota.limit_bytes) }}（{{ formatPercent(p.quota.ratio) }}）</span>
          </div>
          <p v-if="p.quota.ratio >= 0.8" class="warnbox">{{ quotaMessage(p.quota.ratio, session.role.value).text }} {{ quotaMessage(p.quota.ratio, session.role.value).action }}</p>
        </template>
      </article>
    </div>
  </div>
</template>

<style scoped>
.pcard {
  background: var(--color-bg-2);
  border: 1px solid var(--color-neutral-3);
  border-radius: var(--console-radius-panel);
  padding: var(--playdayy-size-3);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.title {
  font-weight: 600;
  font-size: 14px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.title a {
  text-decoration: none;
  color: var(--c-text);
}
.relation {
  font-size: 12px;
  color: var(--color-text-2);
}
.slots {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.row.between {
  justify-content: space-between;
}
.linkbtn {
  border: none;
  background: none;
  color: var(--c-primary);
  cursor: pointer;
  padding: 0;
  font-size: 12px;
}
.all-previews ul {
  margin: 6px 0 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.all-previews li {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.quota {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bar {
  height: 6px;
  background: var(--color-fill-2);
  border-radius: var(--border-radius-medium);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--success-6);
}
.bar i.warn {
  background: var(--warning-6);
}
.deleted {
  font-size: 13px;
  color: var(--color-text-2);
  background: var(--color-fill-1);
  border-radius: var(--console-radius-control);
  padding: 10px;
}
</style>
