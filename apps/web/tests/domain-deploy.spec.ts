import { describe, expect, it } from 'vitest'
import { DEPLOY, FAILURE_RULES, actualBuildSha, backupAttemptLabel, deployStages, escalateLevel, guardDeploy, isDeployTimeout, phaseProgress, resumeMechanismText, rollbackVerdict } from '@/domain/deploy'
import { COPY } from '@/domain/text'

const openGate = { paused: false, reason: null, paused_since: null, resume_mechanism: 'T-08_undefined' as const }

describe('发布闸门', () => {
  it('暂停时不放行，并说明只阻止新发布', () => {
    const g = guardDeploy({ gate: { ...openGate, paused: true, reason: 'daily_backup_failed' }, envBusy: false, queueLength: 1, mainSha: 'a'.repeat(40), versionLabel: 'v1.0.0', existingLabels: [], hasBuildPermission: true })
    expect(g.ok).toBe(false)
    if (!g.ok) {
      expect(g.errorCode).toBe('deploy.backup_paused')
      expect(g.nextStep).toContain('已运行环境继续服务')
      expect(COPY.gateNext).toContain('T-08')
    }
  })

  it('同一环境互斥、队列上限 10、版本号格式与唯一', () => {
    const base = { gate: openGate, envBusy: false, queueLength: 1, mainSha: 'a'.repeat(40), versionLabel: 'v1.2.0', existingLabels: [], hasBuildPermission: true }
    expect(guardDeploy(base).ok).toBe(true)
    expect(guardDeploy({ ...base, envBusy: true })).toMatchObject({ ok: false, errorCode: 'deploy.busy' })
    expect(guardDeploy({ ...base, queueLength: 11 })).toMatchObject({ ok: false, errorCode: 'deploy.queue_full' })
    expect(guardDeploy({ ...base, versionLabel: '1.2' })).toMatchObject({ ok: false, errorCode: 'deploy.version_invalid' })
    expect(guardDeploy({ ...base, existingLabels: ['v1.2.0'] })).toMatchObject({ ok: false, errorCode: 'deploy.version_duplicate' })
    expect(guardDeploy({ ...base, hasBuildPermission: false })).toMatchObject({ ok: false, errorCode: 'authz.forbidden' })
  })

  it('main 竞态：记录实际构建 SHA 而不是最新 main', () => {
    const r = actualBuildSha({ sha: 'b'.repeat(40) }, { sha: 'c'.repeat(40) })
    expect(r.sha).toBe('b'.repeat(40))
    expect(r.drifted).toBe(true)
  })

  it('超时按失败，不自动重试', () => {
    expect(DEPLOY.autoRetry).toBe(false)
    expect(DEPLOY.cancellable).toBe(false)
    expect(DEPLOY.timeoutMs).toBe(30 * 60 * 1000)
    expect(isDeployTimeout('2026-11-20T08:00:00.000Z', new Date('2026-11-20T08:31:00.000Z'))).toBe(true)
    expect(isDeployTimeout('2026-11-20T08:00:00.000Z', new Date('2026-11-20T08:29:00.000Z'))).toBe(false)
  })

  it('阶段顺序：构建成功 → 备份 → 切流；不勾备份则不出现备份步', () => {
    expect(deployStages(true)).toEqual(['queued', 'building', 'healthcheck', 'backup', 'switching', 'done'])
    expect(deployStages(false)).toEqual(['queued', 'building', 'healthcheck', 'switching', 'done'])
    expect(phaseProgress('backup', true).label).toBe('发布前备份')
  })
})

describe('回滚边界', () => {
  it('不可回退记录给出原因；更早版本必须填原因', () => {
    expect(rollbackVerdict({ rollbackable: false, missing_reason: '镜像已被回收', result: 'success' }, '', false)).toMatchObject({ ok: false, errorCode: 'deploy.record_missing' })
    expect(rollbackVerdict({ rollbackable: true, missing_reason: null, result: 'success' }, '', true)).toMatchObject({ ok: false, errorCode: 'deploy.reason_required' })
    expect(rollbackVerdict({ rollbackable: true, missing_reason: null, result: 'success' }, '回退到稳定版', true).ok).toBe(true)
  })
})

describe('GAP-06 备份与同步是两套口径', () => {
  it('每日备份任务内重试 3 次；异地同步失败 1 次即暂停', () => {
    expect(FAILURE_RULES.daily_backup.retryInTask).toBe(3)
    expect(FAILURE_RULES.offsite_sync.retryInTask).toBe(0)
    expect(FAILURE_RULES.offsite_sync.text).toContain('失败 1 次')
    expect(COPY.dailyBackupRetry).not.toBe(COPY.offsiteSyncOnce)
  })

  it('尝试次数最多 4 次（首次 + 3 次重试），并显式区分失败', () => {
    const ok = backupAttemptLabel({ attempts: 2, max_attempts: 3, result: 'success' })
    expect(ok).toContain('第 2 / 4 次')
    const failed = backupAttemptLabel({ attempts: 4, max_attempts: 3, result: 'failed' })
    expect(failed).toContain('任务内重试 3 次仍失败')
  })

  it('连续 2 次失败升级 critical', () => {
    expect(escalateLevel(1)).toBe('warning')
    expect(escalateLevel(2)).toBe('critical')
  })

  it('T-08 未定：只提示需系统管理员处理，不给自动恢复开关', () => {
    const t = resumeMechanismText()
    expect(t).toContain('T-08')
    expect(t).toContain('不提供自动恢复开关')
    expect(t).toContain('需系统管理员')
  })
})
