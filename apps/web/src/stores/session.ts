/** 会话与角色（试跑用：可切换三种应用角色做界面核对；真实环境角色来自服务端） */
import { computed, reactive, readonly } from 'vue'
import type { Me, Role } from '@/api/types'
import { api } from '@/api/client'
import { USE_MOCK, authContext, readCsrfCookie, isApiError } from '@/api/http'
import { roleOperations } from '@/domain/permissions'

interface SessionState {
  me: Me | null
  loading: boolean
  /** 试跑角色切换：BFF 模式下会写服务端会话；Mock 下仅前端演示 */
  trialRole: Role | null
}

/**
 * 试跑：Mock 没有真实会话 Cookie，刷新会掉登录。这里用 sessionStorage 记住试跑会话，
 * 只为方便走查；真实环境用 HttpOnly 会话 Cookie，不存在这段逻辑。
 */
const TRIAL_KEY = 'trial.session.v1'

function readTrial(): SessionState {
  try {
    const raw = globalThis.sessionStorage?.getItem(TRIAL_KEY)
    if (!raw) return { me: null, loading: false, trialRole: null }
    const parsed = JSON.parse(raw) as { me: Me | null; trialRole: Role | null }
    if (parsed?.me) {
      authContext.userId = parsed.me.user_id
      authContext.csrfToken = 'trial-csrf-token'
    }
    return { me: parsed?.me ?? null, loading: false, trialRole: parsed?.trialRole ?? null }
  } catch {
    return { me: null, loading: false, trialRole: null }
  }
}

function writeTrial(s: SessionState) {
  try {
    globalThis.sessionStorage?.setItem(TRIAL_KEY, JSON.stringify({ me: s.me, trialRole: s.trialRole }))
  } catch {
    /* 隐私模式忽略 */
  }
}

const state = reactive<SessionState>(readTrial())

export function useSession() {
  const role = computed<Role>(() => state.trialRole ?? state.me?.role ?? 'user')
  // 服务端给了操作位就以服务端为准（模型 ∩ 人员操作位）；只有 Mock/无服务端会话时才用默认表
  const ops = computed<string[]>(() => (state.me?.operations?.length ? state.me.operations : state.trialRole ? roleOperations(state.trialRole) : []))

  function adopt(me: Me) {
    state.me = me
    // 登录/切换账号后角色以服务端会话为准，不沿用上一次会话残留的试跑角色
    state.trialRole = me.role
    authContext.userId = me.user_id
    authContext.csrfToken = readCsrfCookie() ?? 'trial-csrf-token'
    writeTrial(state)
  }

  function switchTrialRole(next: Role) {
    state.trialRole = next
    writeTrial(state)
  }

  /**
   * 试跑角色切换（接 BFF 时）：必须落服务端会话，否则页面显示管理员菜单但请求仍是普通用户身份（403）。
   * 仅试跑端点；真实环境无此接口，失败不改本体权限，只保留前端展示并返回错误供页面提示。
   */
  async function switchTrialRoleServer(next: Role): Promise<void> {
    state.trialRole = next
    writeTrial(state)
    if (USE_MOCK) return
    try {
      const res = await api.trialRole(next)
      state.me = res.data
      authContext.userId = res.data.user_id
      authContext.csrfToken = readCsrfCookie() ?? authContext.csrfToken
      writeTrial(state)
    } catch (e) {
      if (isApiError(e) && e.errorCode === 'request.path_unknown') {
        // 正式环境没有试跑端点：保持只演示，不冒充已切换
        return
      }
      throw e
    }
  }

  function signOut() {
    state.me = null
    state.trialRole = null
    authContext.userId = null
    authContext.csrfToken = null
    try {
      globalThis.sessionStorage?.removeItem(TRIAL_KEY)
    } catch {
      /* ignore */
    }
  }

  return {
    state: readonly(state),
    role,
    ops,
    adopt,
    switchTrialRole,
    switchTrialRoleServer,
    signOut,
    isSignedIn: computed(() => state.me !== null),
  }
}

/**
 * 接真实 BFF 时：会话在 HttpOnly Cookie 里，前端读不到也无需读，
 * 刷新后靠 GET /me 复原身份；CSRF 从双提交 Cookie 回填。
 */
export async function bootstrapSession(loader: () => Promise<{ data: Me }>): Promise<void> {
  try {
    const me = await loader()
    state.me = me.data
    state.trialRole = me.data.role
    authContext.userId = me.data.user_id
    authContext.csrfToken = readCsrfCookie()
  } catch {
    /* 未登录：交给路由守卫跳登录页 */
  }
}

/** 无 Vue 依赖的读取（flows/tests 用） */
export function currentRole(): Role {
  return state.trialRole ?? state.me?.role ?? 'user'
}
