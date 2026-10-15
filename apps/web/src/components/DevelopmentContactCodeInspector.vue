<script setup lang="ts">
defineProps<{ code: string }>();
const emit = defineEmits<{ fill: [] }>();
</script>

<template>
  <section class="identity-dev-code" aria-label="开发环境验证码">
    <span>开发环境测试验证码</span>
    <code>{{ code }}</code>
    <button type="button" @click="emit('fill')">填入验证码</button>
  </section>
</template>
