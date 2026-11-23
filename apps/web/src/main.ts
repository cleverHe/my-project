import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import './styles.css'
import { COPY } from './domain/text'
import { USE_MOCK } from './api/http'

document.title = USE_MOCK ? 'AI 成果自助部署平台 · 门户（试跑 Mock）' : 'AI 成果自助部署平台 · 门户（试跑 BFF）'

const app = createApp(App)
app.use(router)

async function boot() {
  if (!USE_MOCK) {
    const { api } = await import('./api/client')
    const { bootstrapSession } = await import('./stores/session')
    await bootstrapSession(() => api.me())
  }
  app.mount('#app')
}

void boot()

// 试跑：显式声明当前数据来源，避免被误认为真实环境
console.info(
  USE_MOCK
    ? `[trial] ${COPY.mockBanner} · USE_MOCK=true · 进程内 Mock，未接通 BFF`
    : `[trial] ${COPY.mockBanner} · USE_MOCK=false · 已接 apps/api（内存仓储，未接真实底座/Dokploy）`,
)
