<script setup lang="ts">
/** P-01 登录：只走飞书；无账号密码；六类失败都有真实原因与下一步 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/client'
import { USE_MOCK, isApiError } from '@/api/http'
import { useSession } from '@/stores/session'
import ErrorNotice from '@/components/ErrorNotice.vue'
import { COPY } from '@/domain/text'

const router = useRouter()
/** 试跑形态声明：Mock 与试跑 BFF 不能混写 */
const banner = USE_MOCK ? COPY.mockBanner : COPY.trialBannerBff
const session = useSession()
const busy = ref(false)
const error = ref<unknown>(null)

const failCases = [
  { key: 'feishu_denied', label: '用户拒绝授权', detail: '不建立会话，停在登录页；可重试。' },
  { key: 'state_mismatch', label: 'state 校验失败', detail: '拒绝本次回调，防止 CSRF；不建立会话。' },
  { key: 'account_disabled', label: '账号已停用', detail: '403：你的飞书账号已停用，不能进入平台。联系管理员。' },
  { key: 'not_member', label: '不是项目成员', detail: '403：无该项目数据权限。可申请授权，或让拥有者分享链接（仍需权限）。' },
  { key: 'feishu_down', label: '飞书接口异常/超时', detail: '登录失败，不降级为“免登录”；稍后重试。' },
  { key: 'session_expired', label: '会话过期', detail: '401：跳回登录页，登录后回到原页面。' },
]

async function enter() {
  busy.value = true
  error.value = null
  try {
    if (USE_MOCK) {
      // 试跑：不跳真实飞书，直接建立 Mock 会话（真实环境走 loginStart 的 OAuth 跳转）
      const me = await api.trialLogin()
      session.adopt(me.data)
      await router.push('/dashboard')
    } else {
      // 接真实 BFF 时：飞书 OAuth 未接通（ENV 未完成），先用 BFF 的试跑会话端点；
      // 端点不存在说明已是正式环境，退回真实 OAuth 跳转。
      try {
        const me = await api.trialLogin()
        session.adopt(me.data)
        await router.push('/dashboard')
      } catch {
        const start = await api.loginStart('/dashboard')
        window.location.assign(start.data.redirect_url)
      }
    }
  } catch (e) {
    error.value = e
  } finally {
    busy.value = false
  }
}

function simulateFail(code: string) {
  if (code === 'account_disabled') {
    error.value = { errorCode: 'auth.forbidden', message: '你的飞书账号已停用。', nextStep: '联系管理员恢复账号；停用期间不能进入任何项目。', traceId: 'trc_trial_disabled' }
  } else if (code === 'not_member') {
    error.value = { errorCode: 'authz.forbidden', message: '你没有该项目的访问权限。', nextStep: '联系项目拥有者或管理员申请授权；拿到链接也需要权限。', traceId: 'trc_trial_403' }
  } else if (code === 'feishu_down') {
    error.value = { errorCode: 'auth.provider_unavailable', message: '飞书授权接口超时。', nextStep: '稍后重试；平台不会降级为免登录。', traceId: 'trc_trial_down' }
  } else if (code === 'session_expired') {
    error.value = { errorCode: 'auth.session_expired', message: '登录状态已失效。', nextStep: '重新登录后会回到原页面。', traceId: 'trc_trial_401' }
  } else if (code === 'state_mismatch') {
    error.value = { errorCode: 'auth.state_mismatch', message: '登录回调的 state 校验失败。', nextStep: '重新发起登录；不要复用旧回调链接。', traceId: 'trc_trial_state' }
  } else {
    error.value = { errorCode: 'auth.denied', message: '授权未完成（用户取消）。', nextStep: '重新点击登录并同意授权。', traceId: 'trc_trial_denied' }
  }
}
</script>

<template>
  <div class="login">
    <div class="card">
      <h1>AI 成果自助部署平台</h1>
      <p class="sub">用飞书账号登录；平台不设账号密码，也不允许匿名访问。</p>
      <button class="btn primary big" :disabled="busy" @click="enter">{{ busy ? '登录中…' : '使用飞书登录' }}</button>
      <p class="hint">登录后按项目拥有者 / 被授权人 / 项目组三种数据关系决定你能看到哪些项目。{{ COPY.linkNeedsPermission }}</p>
      <ErrorNotice v-if="error" :error="error" />
      <details class="cases">
        <summary>试跑用：登录失败分支（Mock）</summary>
        <ul>
          <li v-for="c in failCases" :key="c.key">
            <button class="linkbtn" @click="simulateFail(c.key)">{{ c.label }}</button>
            <span>{{ c.detail }}</span>
          </li>
        </ul>
      </details>
      <p class="mock">{{ banner }} · 不会跳转真实飞书</p>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.card {
  width: min(560px, 100%);
  background: #fff;
  border: 1px solid var(--c-line);
  border-radius: var(--console-radius-panel);
  padding: 26px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sub {
  margin: 0;
  color: var(--c-sub);
}
.big {
  padding: 9px 14px;
  font-size: 14px;
  justify-content: center;
}
.cases {
  font-size: 12px;
  color: var(--c-sub);
}
.cases ul {
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.linkbtn {
  border: none;
  background: none;
  color: var(--c-primary);
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  margin-right: 6px;
}
.mock {
  margin: 0;
  font-size: 11px;
  color: #9ca3af;
}
</style>
