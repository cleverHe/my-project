<script setup lang="ts">
/** 二次确认对话框：删预览 / 清理异常预览 / 恢复备份 等破坏性操作统一用它 */
withDefaults(defineProps<{ open: boolean; title: string; confirmText?: string; danger?: boolean; disabled?: boolean; inputLabel?: string; inputPlaceholder?: string }>(), {
  confirmText: '确认',
  danger: true,
  disabled: false,
  inputLabel: '',
  inputPlaceholder: '',
})
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
const model = defineModel<string>({ default: '' })
</script>

<template>
  <div v-if="open" class="mask" role="dialog" aria-modal="true">
    <div class="box">
      <h3>{{ title }}</h3>
      <slot />
      <label v-if="inputLabel" class="field">
        <span>{{ inputLabel }}</span>
        <input v-model="model" :placeholder="inputPlaceholder" />
      </label>
      <footer>
        <button type="button" class="ghost" @click="emit('cancel')">取消</button>
        <button type="button" :class="danger ? 'danger' : 'primary'" :disabled="disabled" @click="emit('confirm')">{{ confirmText }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 16px;
}
.box {
  background: #fff;
  border-radius: 12px;
  padding: 18px;
  width: min(520px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h3 {
  margin: 0;
  font-size: 15px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #4b5563;
}
input {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
button {
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}
.ghost {
  border: 1px solid #d1d5db;
  background: #fff;
}
.primary {
  border: 1px solid #1d4ed8;
  background: #1d4ed8;
  color: #fff;
}
.danger {
  border: 1px solid #dc2626;
  background: #dc2626;
  color: #fff;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
