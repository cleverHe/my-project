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
          <button type="button" class="btn ghost signout" @click="signOut">退出</button>
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
        <div class="content">
          <RouterView />
        </div>
      </main>
    </div>
    <div class="toasts" aria-live="polite">
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
  background: var(--color-bg-1);
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
aside {
  width: var(--console-sider-w);
  flex: 0 0 var(--console-sider-w);
  border-right: 1px solid var(--color-border-2);
  background: var(--color-bg-1);
  display: flex;
  flex-direction: column;
  padding: 0 8px 24px;
  gap: 4px;
}
.brand {
  display: flex;
  align-items: center;
  height: var(--console-topbar-h);
  padding: 0 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--color-border-2);
  font-weight: 700;
  font-size: 15px;
  color: var(--color-text-1);
}
nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
}
nav a {
  display: flex;
  align-items: center;
  height: var(--console-control-h);
  padding: 0 10px;
  border-radius: var(--console-radius-control);
  color: var(--color-text-1);
  font-size: 14px;
}
nav a:hover {
  background: var(--color-fill-2);
}
nav a.active {
  background: var(--primary-1);
  color: var(--primary-7);
  font-weight: 600;
}
.who {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 10px 0;
  border-top: 1px solid var(--color-border-2);
  font-size: 13px;
  color: var(--color-text-2);
}
.name {
  color: var(--color-text-1);
  font-weight: 600;
}
.switch {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--color-text-2);
}
.switch select {
  width: 100%;
}
.signout {
  align-self: flex-start;
}
main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: var(--console-topbar-h);
  padding: 0 var(--console-content-pad);
  border-bottom: 1px solid var(--color-border-2);
  background: var(--color-bg-1);
  position: sticky;
  top: 0;
  z-index: 20;
}
.crumb {
  font-size: 13px;
  color: var(--color-text-2);
}
.scenario {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-2);
}
.scenario select {
  height: 28px;
  font-size: 12px;
  padding: 0 8px;
}
/* 内容页：左右 26、上 16、下 28、最大宽 1200（--console-*） */
.content {
  padding: var(--console-page-pad-top) var(--console-content-pad) var(--console-page-pad-bottom);
  max-width: var(--console-content-max);
  width: 100%;
}
.toasts {
  position: fixed;
  left: 0;
  top: 0;
  /* 100vw/100dvh 覆盖滚动条占位，保证按真实窗口中心对齐（inset:0 只到布局视口） */
  width: 100vw;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--console-space-2);
  z-index: 60;
  pointer-events: none;
  padding: 16px;
}
.toast {
  pointer-events: auto;
  min-width: 240px;
  max-width: 420px;
  border-radius: var(--console-radius-control);
  padding: 12px 16px;
  font-size: 14px;
  border: 1px solid var(--color-border-2);
  background: var(--color-bg-2);
  color: var(--color-text-1);
  box-shadow: var(--console-popup-shadow);
}
.toast.success {
  border-color: var(--success-6);
  background: var(--success-1);
}
.toast.error {
  border-color: var(--danger-6);
  background: var(--danger-1);
}
.toast.warn {
  border-color: var(--warning-6);
  background: var(--warning-1);
}
.t-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.toast ul {
  margin: 0;
  padding-left: 16px;
  color: var(--color-text-1);
  font-size: 13px;
}
.toast button {
  margin-top: 6px;
  border: none;
  background: transparent;
  color: var(--primary-6);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.foot {
  border-top: 1px solid var(--color-border-2);
  padding: 6px 16px;
  font-size: 12px;
  color: var(--color-text-3);
}
</style>
