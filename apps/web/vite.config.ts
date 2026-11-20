import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 试跑 Mock：无 BFF 也能跑；接通 BFF 时把 /api 代理到 BFF（见 README）
    proxy: {
      '/api': { target: process.env.BFF_ORIGIN ?? 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.spec.ts'],
    reporters: 'default',
  },
})
