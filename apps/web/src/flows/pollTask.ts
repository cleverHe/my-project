/**
 * 任务轮询（flows）：3 秒一次；发布 30 分钟超时按失败、不自动重试、不可取消。
 * 依赖注入 clock/sleep 便于测试，不依赖真实计时器。
 */
import type { Task } from '@/api/types'
import { api } from '@/api/client'
import { DEPLOY, isDeployTimeout } from '@/domain/deploy'

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  fetchTask?: (id: string) => Promise<Task>
  maxPolls?: number
}

export interface PollResult {
  task: Task
  timedOut: boolean
  polls: number
}

export async function pollTask(taskId: string, opts: PollOptions = {}): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? DEPLOY.pollIntervalMs
  const timeoutMs = opts.timeoutMs ?? DEPLOY.timeoutMs
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fetchTask = opts.fetchTask ?? ((id: string) => api.task(id).then((r) => r.data))
  const startedAt = now().toISOString()
  let polls = 0

  for (;;) {
    const task = await fetchTask(taskId)
    polls += 1
    if (task.status === 'succeeded' || task.status === 'failed') {
      return { task, timedOut: false, polls }
    }
    if (isDeployTimeout(startedAt, now())) {
      return {
        task: {
          ...task,
          status: 'failed',
          phase: 'failed',
          finished_at: now().toISOString(),
          error: { errorCode: 'deploy.timeout', message: '发布超时（30 分钟），按失败处理，未自动重试。', nextStep: '联系系统管理员排查后重新发起。' },
        },
        timedOut: true,
        polls,
      }
    }
    if (opts.maxPolls && polls >= opts.maxPolls) {
      return { task, timedOut: false, polls }
    }
    await sleep(intervalMs)
  }
}
