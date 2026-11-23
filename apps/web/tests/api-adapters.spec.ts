/**
 * 响应适配层自检（QA-DEF-05/08/10/11/12）：
 * 页面只认一套模型，服务端契约字段与试跑旧字段都必须在 adapter 收敛。
 * 这些用例走进程内 Mock 派发器，证明「请求形状 + 页面模型」两端都对得上。
 */
import { describe, expect, it } from 'vitest'
import { api } from '@/api/client'
import { authContext } from '@/api/http'
import { abnormalPreviews } from '@/api/mock/db'

authContext.userId = 'usr_trial_lin'
authContext.csrfToken = 'csrf_test'

describe('模板（创建向导 / 模板库）', () => {
  it('向导只拿到已发布模板，空白模板固定可用', async () => {
    const res = await api.templates()
    expect(res.data.items.length).toBeGreaterThan(0)
    expect(res.data.items.every((t) => t.status === 'published')).toBe(true)
    const blank = res.data.items.find((t) => t.id === 'tpl_blank')
    expect(blank).toBeTruthy()
    expect(blank!.build_preset.length).toBeGreaterThan(0)
  })

  it('管理页能看到已下线历史版本（真实状态，不是写死）', async () => {
    const all = await api.sysTemplates()
    const legacy = all.data.items.find((t) => t.id === 'tpl_legacy_api')
    expect(legacy?.status).toBe('offline')
  })

  it('下线后向导列表立即消失，再发布后恢复', async () => {
    await api.templateAction('tpl_api', 'offline')
    const afterOff = await api.templates()
    expect(afterOff.data.items.some((t) => t.id === 'tpl_api')).toBe(false)
    const adminAfter = await api.sysTemplates()
    expect(adminAfter.data.items.find((t) => t.id === 'tpl_api')?.status).toBe('offline')
    await api.templateAction('tpl_api', 'publish')
    const afterOn = await api.templates()
    expect(afterOn.data.items.some((t) => t.id === 'tpl_api')).toBe(true)
  })
})

describe('用量（与 Dashboard 卡片同口径）', () => {
  it('分项合计 = used_bytes，ratio 与卡片一致', async () => {
    const usage = (await api.usage('prj_trial_ai_cs')).data
    const card = (await api.project('prj_trial_ai_cs')).data
    expect(usage.used_bytes).toBe(card.quota.used_bytes)
    expect(usage.limit_bytes).toBe(card.quota.limit_bytes)
    expect(usage.ratio).toBeCloseTo(card.quota.ratio, 4)
    expect(usage.parts.reduce((n, p) => n + p.bytes, 0)).toBe(usage.used_bytes)
    expect(usage.parts.map((p) => p.kind).sort()).toEqual(['db', 'files', 'logs', 'volumes'])
    expect(usage.threshold.action).toBe('hard_reject')
  })
})

describe('异常预览清理（契约 payload + 逐条结果）', () => {
  it('候选映射为页面模型；正常预览不在候选里', async () => {
    const res = await api.abnormalPreviews()
    expect(res.data.items.length).toBe(3)
    expect(res.data.items.every((i) => ['disabled_owner', 'deleted_project', 'undeletable'].includes(i.case))).toBe(true)
    expect(res.data.items.map((i) => i.id)).not.toContain('env_trial_cs_prev1')
  })

  it('提交 items/confirm_text，返回 succeeded/failed 逐条结果', async () => {
    const items = (await api.abnormalPreviews()).data.items
    const target = items.find((i) => i.case === 'disabled_owner')!
    const res = await api.cleanupPreviews([{ env_id: target.id, reason: '账号停用后清理' }], `清理 1 个异常预览`)
    expect(res.data.requested).toBe(1)
    expect(res.data.succeeded).toHaveLength(1)
    expect(res.data.succeeded[0]!.env_id).toBe(target.id)
    expect(res.data.succeeded[0]!.freed_bytes).toBeGreaterThan(0)
    expect(abnormalPreviews.some((a) => a.id === target.id)).toBe(false)
  })
})

describe('日志与审计消费字段', () => {
  it('日志有 seq/at/level/text', async () => {
    const res = await api.logs('prj_trial_ai_cs', 'runtime')
    expect(res.data.items.length).toBeGreaterThan(0)
    expect(res.data.items.every((l) => typeof l.text === 'string' && typeof l.seq === 'number')).toBe(true)
  })

  it('审计行有操作人/对象/来源 IP（不是空白列）', async () => {
    const res = await api.audit()
    expect(res.data.csv_columns).toBe(12)
    expect(res.data.csv_columns_confirmed).toBe(false)
    const row = res.data.items[0]!
    expect(row.actor).not.toBe('')
    expect(row.object).not.toBe('')
    expect(row.source_ip).not.toBe('')
  })
})
