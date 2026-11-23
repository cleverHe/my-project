/**
 * 启动入口：读 PORT / HOST（默认 0.0.0.0），暴露 /healthz（2xx、无敏感内容），
 * 收到 SIGTERM/SIGINT 先停止接新请求再退出，避免半截写入。
 */
import { buildApp, trialOptionsFromEnv } from './app.js'

const port = Number(process.env.PORT ?? 8080)
const host = process.env.HOST ?? '0.0.0.0'
// 试跑专用能力（故障注入、任务同步推进、X-QA-* 豁免）必须显式 opt-in：
// 只有 TRIAL_SCENARIO 严格等于 "1" 才开；未设置/0/其他值均关闭（F-03 fail-safe）。
const trial = trialOptionsFromEnv(process.env)
const app = buildApp(trial)

let closing = false
async function shutdown(signal: string) {
  if (closing) return
  closing = true
  app.log.info?.(`收到 ${signal}，开始收尾`)
  try {
    await app.close()
    process.exit(0)
  } catch {
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (e) => {
  console.error('[api] unhandledRejection', e)
})

await app.listen({ port, host })
console.info(`[api] 试跑 BFF 已启动 http://${host}:${port} · 试跑开关=${trial.allowScenario ? 'ON(TRIAL_SCENARIO=1)' : 'OFF'} · 数据为内存替身，未接真实底座（ENV01–ENV09 未完成）`)
