<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router'
import { computed } from 'vue'
import AppShell from '@/layouts/AppShell.vue'

const route = useRoute()
/** 登录页不带侧栏（未登录时也没有导航权限） */
const bare = computed(() => route.meta.public === true)
</script>

<template>
  <RouterView v-if="bare" />
  <AppShell v-else />
</template>
