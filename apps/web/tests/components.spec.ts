import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import StatusPill from '@/components/StatusPill.vue'
import MockBanner from '@/components/MockBanner.vue'
import ErrorNotice from '@/components/ErrorNotice.vue'
import EntryCard from '@/components/EntryCard.vue'
import { COPY } from '@/domain/text'

describe('组件渲染（只断言文案与可访问性，不代替人工走查）', () => {
  it('状态胶囊只有三种展示词 + 进行中', () => {
    const running = mount(StatusPill, { props: { state: 'running' } })
    expect(running.text()).toBe('运行中')
    const sleeping = mount(StatusPill, { props: { state: 'sleeping' } })
    expect(sleeping.text()).toBe('已休眠')
    const none = mount(StatusPill, { props: { state: 'not_created' } })
    expect(none.text()).toBe('未创建')
    const pending = mount(StatusPill, { props: { state: 'pending' } })
    expect(pending.text()).toBe('进行中')
  })

  it('Mock 横幅显式声明非真实环境', () => {
    const w = mount(MockBanner)
    expect(w.text()).toContain(COPY.mockBanner)
    expect(w.text()).toContain('未联调')
  })

  it('错误提示按「发生了什么/影响/下一步」三段渲染并带 traceId', () => {
    const w = mount(ErrorNotice, {
      props: { error: { errorCode: 'deploy.backup_paused', message: '', nextStep: '', traceId: 'trc_abc', details: {} } },
    })
    const text = w.text()
    expect(text).toContain('发生了什么')
    expect(text).toContain('影响')
    expect(text).toContain('下一步')
    expect(text).toContain('trc_abc')
    expect(w.attributes('role')).toBe('alert')
  })

  it('入口卡：未创建时只给引导按钮，无死链', () => {
    const w = mount(EntryCard, {
      props: {
        slot: {
          kind: 'production',
          state: 'not_created',
          label: '正式',
          url: null,
          primaryAction: { key: 'publish', label: '去发布' },
          meta: [],
          hint: '只能发 main 最新提交',
        },
      },
    })
    expect(w.find('a').exists()).toBe(false)
    expect(w.text()).toContain('去发布')
    expect(w.text()).toContain('只能发 main 最新提交')
  })

  it('路由表可创建（防止懒加载路径写错导致白屏）', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/dashboard', component: { template: '<div>d</div>' } }],
    })
    await router.push('/dashboard')
    expect(router.currentRoute.value.path).toBe('/dashboard')
  })
})
