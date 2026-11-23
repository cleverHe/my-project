import { createRouter, createWebHistory } from 'vue-router'
import { useSession } from '@/stores/session'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/login', name: 'login', component: () => import('@/pages/LoginPage.vue'), meta: { title: '登录', public: true } },
    { path: '/dashboard', name: 'dashboard', component: () => import('@/pages/DashboardPage.vue'), meta: { title: '我的项目' } },
    { path: '/wizard', name: 'wizard', component: () => import('@/pages/WizardPage.vue'), meta: { title: '创建项目' } },
    {
      path: '/projects/:id',
      component: () => import('@/pages/ProjectLayout.vue'),
      children: [
        { path: '', redirect: (to) => `/projects/${String(to.params.id)}/deploy` },
        { path: 'deploy', name: 'deploy', component: () => import('@/pages/DeployPage.vue'), meta: { title: '部署' } },
        { path: 'resources', name: 'resources', component: () => import('@/pages/ResourcesPage.vue'), meta: { title: '资源与用量' } },
        { path: 'files', name: 'files', component: () => import('@/pages/FilesPage.vue'), meta: { title: '文件' } },
        { path: 'logs', name: 'logs', component: () => import('@/pages/LogsPage.vue'), meta: { title: '日志' } },
        { path: 'collaboration', name: 'collaboration', component: () => import('@/pages/CollaborationPage.vue'), meta: { title: '授权与分享' } },
        { path: 'access', name: 'access', component: () => import('@/pages/AccessPage.vue'), meta: { title: '接入与规范' } },
        { path: 'backups', name: 'backups', component: () => import('@/pages/BackupsPage.vue'), meta: { title: '备份' } },
      ],
    },
    { path: '/projects/:id/deleted', name: 'project-deleted', component: () => import('@/pages/ProjectDeletedPage.vue'), meta: { title: '已删除项目' } },
    { path: '/admin/people', name: 'admin-people', component: () => import('@/pages/AdminPeoplePage.vue'), meta: { title: '人员权限', role: 'admin' } },
    { path: '/admin/groups', name: 'admin-groups', component: () => import('@/pages/AdminGroupsPage.vue'), meta: { title: '项目组', role: 'admin' } },
    { path: '/admin/platform', name: 'admin-platform', component: () => import('@/pages/PlatformViewPage.vue'), meta: { title: '平台视图', role: 'admin' } },
    { path: '/admin/audit', name: 'admin-audit', component: () => import('@/pages/AuditPage.vue'), meta: { title: '审计', role: 'admin' } },
    { path: '/sys/roles', name: 'sys-roles', component: () => import('@/pages/SysRolesPage.vue'), meta: { title: '角色权限模型', role: 'sysadmin' } },
    { path: '/sys/templates', name: 'sys-templates', component: () => import('@/pages/SysTemplatesPage.vue'), meta: { title: '模板库', role: 'sysadmin' } },
    { path: '/sys/settings', name: 'sys-settings', component: () => import('@/pages/SysSettingsPage.vue'), meta: { title: '系统设置', role: 'sysadmin' } },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
  ],
})

/** 未登录跳登录页；角色不足给提示页而不是白屏（真正的 403 由服务端返回） */
router.beforeEach((to) => {
  const session = useSession()
  if (to.meta.public) return true
  if (!session.isSignedIn.value) return { name: 'login', query: { redirect: to.fullPath } }
  const need = to.meta.role as 'admin' | 'sysadmin' | undefined
  if (need) {
    const role = session.role.value
    const ok = need === 'admin' ? role === 'admin' || role === 'sysadmin' : role === 'sysadmin'
    if (!ok) return { name: 'dashboard', query: { denied: to.fullPath } }
  }
  return true
})

export default router
