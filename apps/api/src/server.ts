/**
 * 启动入口：读 PORT / HOST（默认 0.0.0.0），暴露 /healthz（2xx、无敏感内容），
 * 收到 SIGTERM/SIGINT 先停止接新请求再退出，避免半截写入。
 */
import { buildApp } from './app.js'

const port = Number(process.env.PORT ?? 8080)
const host = process.env.HOST ?? '0.0.0.0'
// 试跑专用故障注入：正式环境设 TRIAL_SCENARIO=0 关闭，避免被当成产品能力
const app = buildApp({ allowScenario: process.env.TRIAL_SCENARIO !== '0', autoAdvanceTasks: true })

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
console.info(`[api] 试跑 BFF 已启动 http://${host}:${port} · 数据为内存替身，未接真实底座（ENV01–ENV09 未完成）`)
