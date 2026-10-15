<script setup lang="ts">
defineProps<{ title: string; group: string }>();
</script>

<template>
  <section class="domain-page">
    <RouterLink to="/admin/overview" class="back-link">← 返回运营总览</RouterLink>
    <div class="domain-heading"><p class="eyebrow">{{ group }}</p><h1>{{ title }}</h1></div>
    <div class="domain-state"><span class="domain-state-icon" aria-hidden="true">⌁</span><div><h2>暂无{{ title }}记录</h2></div></div>
  </section>
</template>
