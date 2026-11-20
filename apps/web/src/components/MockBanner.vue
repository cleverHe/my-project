<script setup lang="ts">
import { COPY } from '@/domain/text'
import { USE_MOCK } from '@/api/http'

/** 两种试跑形态必须分清：进程内 Mock（纯前端） / 真实 BFF（内存仓储，仍未接底座） */
const label = USE_MOCK ? COPY.mockBanner : COPY.trialBannerBff
const mode = USE_MOCK ? COPY.mockCapability : '试跑 BFF · 内存数据 / 未接通真实底座（ENV01–ENV09 未完成）'
</script>

<template>
  <div class="mock-banner" role="status">
    <span class="dot" aria-hidden="true"></span>
    <strong>{{ label }}</strong>
    <span class="sep">·</span>
    <span>{{ mode }}</span>
    <span class="sep">·</span>
    <span>数据非真实、未联调、未经业务验收</span>
  </div>
</template>

<style scoped>
.mock-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: #fff7e6;
  border-bottom: 1px solid #ffd591;
  color: #874d00;
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fa8c16;
}
.sep {
  color: #d4a373;
}
</style>
