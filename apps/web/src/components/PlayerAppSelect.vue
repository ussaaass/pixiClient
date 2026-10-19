<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

export interface PlayerSelectOption { value: string | number; label: string }
const props = defineProps<{ modelValue: string | number; options: PlayerSelectOption[]; label: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const open = ref(false);
const activeIndex = ref(0);
const menuStyle = ref<Record<string, string>>({});
const current = computed(() => props.options.find((option) => option.value === props.modelValue) ?? props.options[0]);
const menuId = `player-select-${Math.random().toString(36).slice(2)}`;

function positionMenu(): void {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  const maxHeight = Math.min(260, window.innerHeight - 24);
  const below = window.innerHeight - rect.bottom;
  const top = below >= Math.min(maxHeight, props.options.length * 42 + 10) || below >= rect.top ? rect.bottom + 5 : Math.max(12, rect.top - maxHeight - 5);
  menuStyle.value = { left: `${rect.left}px`, top: `${top}px`, width: `${rect.width}px`, maxHeight: `${maxHeight}px` };
}
function closeMenu(restoreFocus = false): void { open.value = false; if (restoreFocus) trigger.value?.focus(); }
async function showMenu(index = props.options.findIndex((option) => option.value === props.modelValue)): Promise<void> {
  if (props.disabled || !props.options.length) return;
  activeIndex.value = Math.max(0, index);
  open.value = true;
  await nextTick(); positionMenu();
  menu.value?.querySelectorAll<HTMLButtonElement>('button')[activeIndex.value]?.focus();
}
function choose(option: PlayerSelectOption): void { emit('update:modelValue', option.value); closeMenu(true); }
function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const currentIndex = props.options.findIndex((item) => item.value === props.modelValue);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? (direction === 1 ? 0 : props.options.length - 1)
      : (currentIndex + direction + props.options.length) % props.options.length;
    void showMenu(nextIndex);
  }
  else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open.value ? closeMenu() : void showMenu(); }
  else if (event.key === 'Escape' && open.value) { event.preventDefault(); closeMenu(true); }
}
function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); activeIndex.value = (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + props.options.length) % props.options.length; void focusActiveOption(); }
  else if (event.key === 'Home') { event.preventDefault(); activeIndex.value = 0; void focusActiveOption(); }
  else if (event.key === 'End') { event.preventDefault(); activeIndex.value = props.options.length - 1; void focusActiveOption(); }
  else if (event.key === 'Enter') { event.preventDefault(); const option = props.options[activeIndex.value]; if (option) choose(option); }
  else if (event.key === 'Escape' || event.key === 'Tab') closeMenu(event.key === 'Escape');
}
async function focusActiveOption(): Promise<void> { await nextTick(); menu.value?.querySelectorAll<HTMLButtonElement>('button')[activeIndex.value]?.focus(); }
function onOutside(event: PointerEvent): void { if (open.value && !root.value?.contains(event.target as Node) && !(event.target as Element | null)?.closest(`#${menuId}`)) closeMenu(); }
function syncPosition(): void { if (open.value) positionMenu(); }
document.addEventListener('pointerdown', onOutside);
window.addEventListener('resize', syncPosition);
window.addEventListener('scroll', syncPosition, true);
onBeforeUnmount(() => { document.removeEventListener('pointerdown', onOutside); window.removeEventListener('resize', syncPosition); window.removeEventListener('scroll', syncPosition, true); });
</script>

<template>
  <div ref="root" class="player-app-select">
    <button ref="trigger" class="player-app-select-trigger" type="button" :disabled="disabled" aria-haspopup="listbox" :aria-expanded="open" :aria-label="label" :aria-controls="menuId" @click="open ? closeMenu() : showMenu()" @keydown="onTriggerKeydown">
      <span>{{ current?.label ?? '请选择' }}</span><span class="player-app-select-chevron" aria-hidden="true">⌄</span>
    </button>
    <Teleport to="body">
      <Transition name="player-app-select-popover">
        <div v-if="open" :id="menuId" ref="menu" class="player-app-select-menu" role="listbox" :aria-label="label" :style="menuStyle" @keydown="onMenuKeydown">
          <button v-for="(option,index) in options" :key="String(option.value)" type="button" role="option" :aria-selected="option.value === modelValue" :class="{ active: index === activeIndex }" @mouseenter="activeIndex = index" @click="choose(option)">{{ option.label }}<span v-if="option.value === modelValue" aria-hidden="true">✓</span></button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.player-app-select { width:100%; min-width:0; }
.player-app-select-trigger { display:flex; width:100%; min-height:40px; align-items:center; justify-content:space-between; gap:10px; padding:0 11px; border:1px solid #d9bd7840; border-radius:8px; color:#eee7d6; background:linear-gradient(180deg,#12332b,#0b241f); font:inherit; font-size:12px; text-align:left; cursor:pointer; }
.player-app-select-trigger:focus-visible,.player-app-select-menu button:focus-visible { outline:2px solid #d9bd78; outline-offset:2px; }
.player-app-select-trigger:disabled { cursor:not-allowed; opacity:.55; }
.player-app-select-chevron { flex:0 0 auto; color:#d9bd78; font-size:16px; line-height:1; }
.player-app-select-menu { position:fixed; z-index:11000; display:grid; gap:3px; overflow:auto; padding:5px; border:1px solid #d9bd7866; border-radius:10px; color:#eee7d6; background:#0c241f; box-shadow:0 14px 36px #0009; overscroll-behavior:contain; }
.player-app-select-menu button { display:flex; min-height:40px; align-items:center; justify-content:space-between; gap:8px; border:0; border-radius:6px; padding:0 10px; color:#dedbce; background:transparent; font:inherit; font-size:12px; text-align:left; cursor:pointer; }
.player-app-select-menu button:hover,.player-app-select-menu button.active,.player-app-select-menu button[aria-selected="true"] { color:#f4dfaa; background:#d9bd7818; }
.player-app-select-menu button[aria-selected="true"] { font-weight:700; }
.player-app-select-popover-enter-active,.player-app-select-popover-leave-active { transition:opacity .12s ease,transform .12s ease; }
.player-app-select-popover-enter-from,.player-app-select-popover-leave-to { opacity:0; transform:translateY(-4px) scale(.985); }
</style>
