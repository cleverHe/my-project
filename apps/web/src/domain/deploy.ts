/**
 * 发布、回滚与暂停闸门（domain，纯函数）。
 * 依据：api-spec §7、PRD P-06、GAP-06、T-08（解除机制原文未定，本层不发明规则）。
 */
import type { BackupPoint, GateState, MainHead, Task } from '@/api/types'
import { COPY } from './text'

export const DEPLOY = {
  /** 队列上限（README Q27） */
  queueLimit: 10,
  /** 并发构建数（README Q27） */
  buildConcurrency: 3,
  /** 单次发布超时 30 分钟，不可取消，不自动重试 */
  timeoutMs: 30 * 60 * 1000,
  /** 轮询间隔（规范：3 秒） */
  pollIntervalMs: 3000,
  /** 预览唤醒超时 60 秒 */
  wakeTimeoutMs: 60 * 1000,
  /** 预览闲置缩容：7 天 */
  idleSleepDays: 7,
  /** 预览上限 3 */
  previewLimit: 3,
  /** 回滚后连续冒烟次数 */
  smokePasses: 2,
  autoRetry: false,
  cancellable: false,
} as const

export type DeployPhase = 'queued' | 'building' | 'healthcheck' | 'backup' | 'switching' | 'done' | 'failed'

export const PHASE_LABEL: Record<DeployPhase, string> = {
  queued: '排队',
  building: '构建',
  healthcheck: '健康检查',
  backup: '发布前备份',
  switching: '切换流量',
  done: '完成',
  failed: '失败',
}

/** 顺序固定：构建成功 → 备份 → 切流；未勾选备份则不出现该步 */
export function deployStages(withBackup: boolean): DeployPhase[] {
  return withBackup ? ['queued', 'building', 'healthcheck', 'backup', 'switching', 'done'] : ['queued', 'building', 'healthcheck', 'switching', 'done']
}

export function phaseProgress(phase: DeployPhase, withBackup: boolean): { index: number; total: number; label: string; percent: number } {
  const stages = deployStages(withBackup)
  const total = stages.length
  const idx = stages.indexOf(phase)
  if (phase === 'failed') return { index: 0, total, label: '失败', percent: 100 }
  return { index: idx < 0 ? 0 : idx, total, label: PHASE_LABEL[phase], percent: Math.round(((idx < 0 ? 0 : idx + 1) / total) * 100) }
}

export interface DeployGuardInput {
  gate: GateState
  /** 同一环境是否已有发布/回滚进行中（互斥） */
  envBusy: boolean
  /** 当前排队数（含自己） */
  queueLength: number
  /** 是否已有 main HEAD 可发布 */
  mainSha: string | null
  versionLabel: string
  existingLabels: string[]
  hasBuildPermission: boolean
}

export type DeployGuard =
  | { ok: true }
  | { ok: false; errorCode: string; reason: string; nextStep: string }

/** 发布前置闸门（服务端仍会再校验一次；此处只做前置提示） */
export function guardDeploy(input: DeployGuardInput): DeployGuard {
  if (!input.hasBuildPermission) {
    return { ok: false, errorCode: 'authz.forbidden', reason: '发布需本人在项目内具备发布操作权限。', nextStep: '联系项目拥有者或管理员分配操作权限。' }
  }
  if (input.gate.paused) {
    const reason = input.gate.reason === 'offsite_sync_failed' ? '异地同步失败 1 次' : '每日全量备份任务内重试 3 次仍失败'
    return { ok: false, errorCode: 'deploy.backup_paused', reason: `已暂停新发布：${reason}。`, nextStep: COPY.gateImpact + COPY.gateNext }
  }
  if (input.envBusy) {
    return { ok: false, errorCode: 'deploy.busy', reason: '已有发布或回滚进行中。', nextStep: '等待当前任务完成；同一环境发布与回滚互斥。' }
  }
  if (input.queueLength > DEPLOY.queueLimit) {
    return { ok: false, errorCode: 'deploy.queue_full', reason: `队列已满（上限 ${DEPLOY.queueLimit}）。`, nextStep: '稍后重试；不要重复提交。' }
  }
  if (!input.mainSha) {
    return { ok: false, errorCode: 'deploy.no_main', reason: '暂时读不到 main 最新提交。', nextStep: '刷新页面；仍失败请联系系统管理员检查 GitLab 连接。' }
  }
  if (!/^v\d+\.\d+\.\d+$/.test(input.versionLabel)) {
    return { ok: false, errorCode: 'deploy.version_invalid', reason: '版本标签格式应为 v1.2.0。', nextStep: '按 vX.Y.Z 格式填写后重试。' }
  }
  if (input.existingLabels.includes(input.versionLabel)) {
    return { ok: false, errorCode: 'deploy.version_duplicate', reason: `版本标签「${input.versionLabel}」已存在。`, nextStep: '换一个未使用过的版本标签。' }
  }
  return { ok: true }
}

/** main 竞态：记录实际构建的 SHA，不自动重发 */
export function actualBuildSha(task: Pick<Task, 'sha'>, main: Pick<MainHead, 'sha'>): { sha: string; drifted: boolean } {
  const sha = task.sha ?? main.sha
  return { sha, drifted: sha !== main.sha }
}

export function isDeployTimeout(startedAt: string, now: Date): boolean {
  return now.getTime() - new Date(startedAt).getTime() > DEPLOY.timeoutMs
}

/** 回滚：不得承诺任意历史版本，不得回滚数据库 */
export function rollbackVerdict(record: { rollbackable: boolean; missing_reason: string | null; result: string }, reason: string, isOlderSuccess: boolean): { ok: boolean; errorCode?: string; reason?: string } {
  if (record.result !== 'success') return { ok: false, errorCode: 'deploy.record_not_success', reason: '只能回退到发布成功的记录。' }
  if (!record.rollbackable) return { ok: false, errorCode: 'deploy.record_missing', reason: record.missing_reason ?? '记录/镜像已被底座回收，无法回退。' }
  if (isOlderSuccess && !reason.trim()) return { ok: false, errorCode: 'deploy.reason_required', reason: '回退到更早版本必须填写原因。' }
  return { ok: true }
}

// ---------------------------------------------------------------
// GAP-06：每日全量备份 与 异地同步 是两套口径，禁止合并
// ---------------------------------------------------------------
export interface FailureRule {
  key: 'daily_backup' | 'offsite_sync'
  label: string
  retryInTask: number
  pauseOnFailure: boolean
  text: string
}

export const FAILURE_RULES: Record<'daily_backup' | 'offsite_sync', FailureRule> = {
  daily_backup: { key: 'daily_backup', label: '每日全量备份', retryInTask: 3, pauseOnFailure: true, text: COPY.dailyBackupRetry },
  offsite_sync: { key: 'offsite_sync', label: '异地同步', retryInTask: 0, pauseOnFailure: true, text: COPY.offsiteSyncOnce },
}

/** 备份点「本次为第 N 次尝试」：首次 + 任务内重试 3 次 = 最多 4 次 */
export function backupAttemptLabel(b: Pick<BackupPoint, 'attempts' | 'max_attempts' | 'result'>): string {
  const max = b.max_attempts + 1
  if (b.result === 'failed') return `已尝试 ${b.attempts} / ${max} 次（任务内重试 ${b.max_attempts} 次仍失败）`
  return `第 ${b.attempts} / ${max} 次尝试成功`
}

/** 两级告警：连续 2 次失败升级 critical */
export function escalateLevel(consecutiveFailures: number): 'warning' | 'critical' {
  return consecutiveFailures >= 2 ? 'critical' : 'warning'
}

/** T-08：原文未定，仅给「需系统管理员处理」，不提供自动恢复开关 */
export function resumeMechanismText(): string {
  return COPY.gateNext
}
