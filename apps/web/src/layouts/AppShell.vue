<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import type { Role } from '@/api/types'
import { useSession } from '@/stores/session'
import { SCENARIOS, useUi } from '@/stores/ui'
import { visibleNav } from '@/domain/permissions'
import { COPY } from '@/domain/text'
import MockBanner from '@/components/MockBanner.vue'

import { USE_MOCK } from '@/api/http'

const session = useSession()
const ui = useUi()
/** 试跑形态声明：Mock 与试跑 BFF 不能混写 */
const banner = USE_MOCK ? COPY.mockBanner : COPY.trialBannerBff
const notice = USE_MOCK ? COPY.footNoticeMock : COPY.footNoticeBff
const route = useRoute()
const router = useRouter()

const nav = computed(() => visibleNav(session.role.value, session.ops.value))
const roleLabel = computed(() => ({ user: '普通用户', admin: '管理员', sysadmin: '系统管理员' })[session.role.value])

function onRole(e: Event) {
  const role = (e.target as HTMLSelectElement).value as Role
  // 接 BFF 时把角色落到服务端会话，否则管理员/系统管理员页会 403（QA-DEF-06）
  void session
    .switchTrialRoleServer(role)
    .catch(() => ui.push('error', '试跑角色切换失败', ['仍按当前登录身份校验；刷新页面后重试。']))
    .finally(() => {
      void router.push('/dashboard')
    })
}
function onScenario(e: Event) {
  ui.setScenario((e.target as HTMLSelectElement).value)
}
function signOut() {
  session.signOut()
  void router.push('/login')
}
</script>

<template>
  <div class="shell">
    <MockBanner />
    <div class="body">
      <aside>
        <div class="brand">AI 成果自助部署</div>
        <nav>
          <RouterLink v-for="item in nav" :key="item.key" :to="item.to" :class="{ active: route.path.startsWith(item.to) }">{{ item.label }}</RouterLink>
        </nav>
        <div class="who">
          <div class="name">{{ session.state.me?.display_name ?? '未登录' }}</div>
          <div class="role">{{ roleLabel }}</div>
          <label class="switch">
            试跑角色
            <select :value="session.role.value" @change="onRole">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
              <option value="sysadmin">系统管理员</option>
            </select>
          </label>
          <button type="button" class="ghost" @click="signOut">退出</button>
        </div>
      </aside>
      <main>
        <header class="topbar">
          <div class="crumb">{{ route.meta.title ?? '' }}</div>
          <label class="scenario" :title="'试跑专用：用于走查失败分支。正式环境必须移除该入口（BFF 正式配置会忽略 scenario 参数）'">
            失败分支
            <select :value="ui.state.scenario" @change="onScenario">
              <option v-for="s in SCENARIOS" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </label>
        </header>
        <RouterView />
      </main>
    </div>
    <div class="toasts">
      <div v-for="t in ui.state.toasts" :key="t.id" class="toast" :class="t.kind" role="status">
        <div class="t-title">{{ t.title }}</div>
        <ul v-if="t.lines.length">
          <li v-for="l in t.lines" :key="l">{{ l }}</li>
        </ul>
        <button type="button" @click="ui.dismiss(t.id)">关闭</button>
      </div>
    </div>
    <footer class="foot">{{ banner }} · {{ notice }}</footer>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
aside {
  width: 216px;
  border-right: 1px solid #e5e7eb;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 12px;
}
.brand {
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.02em;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
nav a {
  text-decoration: none;
  color: #374151;
  font-size: 13px;
  padding: 6px 8px;
  border-radius: 6px;
}
nav a.active {
  background: #e8efff;
  color: #1d4ed8;
  font-weight: 600;
}
.who {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}
.name {
  color: #111827;
  font-weight: 600;
}
.switch {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
select {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 12px;
  background: #fff;
}
.ghost {
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}
main {
  flex: 1;
  min-width: 0;
  padding: 14px 18px 40px;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.crumb {
  font-size: 13px;
  color: #6b7280;
}
.scenario {
  font-size: 12px;
  color: #6b7280;
  display: flex;
  align-items: center;
  gap: 6px;
}
.toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 60;
  max-width: 380px;
}
.toast {
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  border: 1px solid #d1d5db;
  background: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}
.toast.success {
  border-color: #b7e4c7;
}
.toast.error {
  border-color: #fecaca;
  background: #fff7f7;
}
.toast.warn {
  border-color: #ffd8a8;
  background: #fffbf5;
}
.t-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.toast ul {
  margin: 0;
  padding-left: 16px;
  color: #4b5563;
}
.toast button {
  margin-top: 6px;
  border: none;
  background: transparent;
  color: #1d4ed8;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.foot {
  border-top: 1px solid #e5e7eb;
  padding: 6px 16px;
  font-size: 11px;
  color: #9ca3af;
}
</style>
