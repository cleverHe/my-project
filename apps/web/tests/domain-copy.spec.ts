import { describe, expect, it } from 'vitest'
import { COPY, DISPLAY_STATE_LABEL, FORBIDDEN_TERMS } from '@/domain/text'
import { retentionView, previewSlotView, productionSlotView, multiPreview, canCreatePreview, displayStateLabel, projectStatusLabel } from '@/domain/status'

const REQUIRED = [
  COPY.linkNeedsPermission,
  COPY.previewRetention,
  COPY.rollbackNoDb,
  COPY.mainHeadOnly,
  COPY.specSysadminOnly,
  COPY.adminParamException,
  COPY.cleanupScope,
  COPY.dailyBackupRetry,
  COPY.offsiteSyncOnce,
  COPY.filesReadOnly,
  COPY.noS3Api,
  COPY.updateSpecHardRules,
]

describe('文案与状态词（PRD §6.1/§6.2）', () => {
  it('12 条关键文案逐字存在且没有重复定义', () => {
    expect(REQUIRED).toHaveLength(12)
    for (const s of REQUIRED) expect(s.length).toBeGreaterThan(12)
    expect(new Set(REQUIRED).size).toBe(12)
  })

  it('展示态只有三种，不出现「已缩容」', () => {
    expect(Object.keys(DISPLAY_STATE_LABEL).sort()).toEqual(['not_created', 'running', 'sleeping'])
    expect(displayStateLabel('sleeping')).toBe('已休眠')
    expect(FORBIDDEN_TERMS).toContain('已缩容')
  })

  it('禁止词不进入状态文案', () => {
    const all = [COPY.previewRetention, COPY.mainHeadOnly, displayStateLabel('running'), displayStateLabel('sleeping'), displayStateLabel('not_created')].join('|')
    for (const bad of ['已缩容', '发布后清理结果', '已清理预览', '分享授权', '任意历史版本']) {
      expect(all.includes(bad)).toBe(false)
    }
  })

  it('GAP-03：保留状态卡不承诺发布后清理，并说明备份关系', () => {
    const v = retentionView(2, 3)
    expect(v.retention).toContain('正式发布不会删除预览')
    expect(v.lastPublishImpact).toContain('未改动任何预览')
    expect(v.backup).toContain('预览数据纳入每日全量备份')
    expect(v.count).toBe('2 / 3')
  })

  it('多预览 ≥2 才出现「查看全部 N 个」', () => {
    expect(multiPreview({ slot: 'recent', total: 1, limit: 3, items: [] })).toEqual({ visible: false, label: '查看全部 1 个' })
    expect(multiPreview({ slot: 'recent', total: 3, limit: 3, items: [] }).visible).toBe(true)
  })
})

describe('入口槽位', () => {
  it('无预览时给引导而不是死链', () => {
    const v = previewSlotView({ slot: 'recent', total: 0, limit: 3, items: [] })
    expect(v.url).toBeNull()
    expect(v.primaryAction.key).toBe('create_preview')
    expect(v.state).toBe('not_created')
  })

  it('休眠预览只给唤醒，不给「打开」主按钮', () => {
    const v = previewSlotView({
      slot: 'recent',
      total: 1,
      limit: 3,
      items: [{ id: 'e1', branch: 'feat/a', url: 'https://x', display_state: 'sleeping', last_access_at: null, branch_deleted: false, residual: false, updated_at: '' }],
    })
    expect(v.primaryAction.key).toBe('wake')
    expect(v.hint).toContain('7 天')
  })

  it('正式未创建不给死链', () => {
    const v = productionSlotView({ state: 'not_created', url: null, sha: null, version_label: null, updated_at: null })
    expect(v.url).toBeNull()
    expect(v.primaryAction.key).toBe('publish')
  })

  it('预览计数：休眠不释放名额', () => {
    expect(canCreatePreview(3, 3).ok).toBe(false)
    expect(canCreatePreview(2, 3).ok).toBe(true)
    expect(canCreatePreview(3, 3).reason).toContain('停止/休眠不释放名额')
  })

  it('软删除只显示名称与恢复提示', () => {
    expect(projectStatusLabel('soft_deleted')).toContain('30 天内可恢复')
  })

  it('试跑形态声明：Mock 与试跑 BFF 不混写', () => {
    expect(COPY.mockBanner).toContain('Mock 数据')
    expect(COPY.trialBannerBff).toContain('试跑 BFF')
    expect(COPY.trialBannerBff).not.toContain('Mock 数据')
    expect(COPY.footNoticeMock).toContain('不会连真实环境')
    expect(COPY.footNoticeBff).toContain('只连试跑 BFF')
  })
})
