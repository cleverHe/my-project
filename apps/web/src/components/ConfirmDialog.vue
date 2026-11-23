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
  left: 0;
  top: 0;
  width: 100vw;
  height: 100dvh;
  background: rgb(29 33 41 / 45%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 16px;
}
.box {
  background: var(--color-bg-2);
  border-radius: var(--console-radius-panel);
  box-shadow: var(--console-popup-shadow);
  padding: var(--playdayy-size-5);
  width: min(520px, 100%);
  display: flex;
  flex-direction: column;
  gap: var(--playdayy-size-3);
}
h3 {
  font-size: 16px;
  line-height: 24px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--playdayy-size-1);
  font-size: 13px;
  color: var(--color-text-2);
}
input {
  height: var(--console-form-h);
  border: 1px solid var(--color-border-2);
  border-radius: var(--console-radius-control);
  padding: 0 11px;
  font: inherit;
  font-size: 14px;
}
input:focus {
  outline: none;
  border-color: var(--primary-6);
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--playdayy-size-2);
}
button {
  height: var(--console-control-h);
  border-radius: var(--console-radius-control);
  padding: 0 15px;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  border: 1px solid var(--color-border-2);
  background: var(--color-bg-1);
  color: var(--color-text-1);
}
.ghost:hover:not(:disabled) {
  background: var(--color-fill-2);
}
.primary {
  border-color: var(--primary-6);
  background: var(--primary-6);
  color: #fff;
}
.danger {
  border-color: var(--danger-6);
  background: var(--danger-6);
  color: #fff;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
