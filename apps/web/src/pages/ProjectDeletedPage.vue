<script setup lang="ts">
/** P-21 已删除项目：只给名称与恢复提示，不展示任何内容 */
import { useRoute } from 'vue-router'
import { deletedProjectView } from '@/domain/status'
import { useUi } from '@/stores/ui'

const route = useRoute()
const ui = useUi()
const view = deletedProjectView(String(route.query.name ?? '该项目'), String(route.query.deleted_at ?? '2026-11-10T02:00:00.000Z'), new Date('2026-11-20T09:20:00.000Z'))

function askRestore() {
  ui.push('info', '恢复需管理员操作', ['30 天内可由管理员在「已删除项目」入口恢复；恢复后数据以最近一次备份为准。'])
}
</script>

<template>
  <div class="page">
    <section class="panel center-note">
      <h1>{{ view.name }}</h1>
      <p>{{ view.text }}</p>
      <p class="hint">此处不展示项目内容（环境、日志、文件、成员等），也不会因为恢复链接而授予权限。</p>
      <div class="row" style="justify-content: center">
        <button class="btn" @click="askRestore">如何恢复？</button>
        <RouterLink class="btn primary" to="/dashboard">返回项目列表</RouterLink>
      </div>
    </section>
  </div>
</template>
