<script setup lang="ts">
import { nextTick, ref } from 'vue';

defineProps<{
  title: string;
  triggerLabel: string;
  sections: readonly { heading: string; body: string }[];
}>();

const open = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);

async function show(): Promise<void> {
  open.value = true;
  await nextTick();
  closeButton.value?.focus();
}

async function hide(): Promise<void> {
  open.value = false;
  await nextTick();
  trigger.value?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    void hide();
  } else if (event.key === 'Tab') {
    event.preventDefault();
    if (event.shiftKey) (document.activeElement === closeButton.value ? confirmButton.value : closeButton.value)?.focus();
    else (document.activeElement === confirmButton.value ? closeButton.value : confirmButton.value)?.focus();
  }
}
</script>

<template>
  <button ref="trigger" class="page-help-trigger" type="button" :aria-label="triggerLabel" aria-haspopup="dialog" @click="show">?</button>
  <Teleport to="body">
    <div v-if="open" class="page-help-backdrop" @click.self="hide">
      <section class="page-help-dialog" role="dialog" aria-modal="true" :aria-label="title" @keydown="onKeydown">
        <button ref="closeButton" class="page-help-close" type="button" aria-label="关闭说明" @click="hide">×</button>
        <p class="eyebrow">操作说明</p>
        <h2>{{ title }}</h2>
        <article v-for="section in sections" :key="section.heading">
          <strong>{{ section.heading }}</strong>
          <p>{{ section.body }}</p>
        </article>
        <button ref="confirmButton" class="page-help-confirm" type="button" @click="hide">知道了</button>
      </section>
    </div>
  </Teleport>
</template>
