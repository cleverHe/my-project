/** 会话与角色（试跑用：可切换三种应用角色做界面核对；真实环境角色来自服务端） */
import { computed, reactive, readonly } from 'vue'
import type { Me, Role } from '@/api/types'
import { authContext, readCsrfCookie } from '@/api/http'
import { roleOperations } from '@/domain/permissions'

interface SessionState {
  me: Me | null
  loading: boolean
  /** 试跑角色切换：仅前端演示，服务端仍按真实身份校验 */
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
  const ops = computed<string[]>(() => (state.trialRole ? roleOperations(state.trialRole) : state.me?.operations ?? []))

  function adopt(me: Me) {
    state.me = me
    authContext.userId = me.user_id
    authContext.csrfToken = readCsrfCookie() ?? 'trial-csrf-token'
    writeTrial(state)
  }

  function switchTrialRole(next: Role) {
    state.trialRole = next
    writeTrial(state)
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
