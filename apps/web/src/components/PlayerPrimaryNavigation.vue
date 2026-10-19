<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
export type PlayerPrimaryDestination = 'lobby' | 'wallet' | 'social' | 'messages' | 'profile';
const props = withDefaults(defineProps<{ active: PlayerPrimaryDestination; socialDisabled?: boolean; lobby?: boolean; pageOverlay?: boolean; guideTarget?: boolean; messageBadgeCount?: number; socialBadgeCount?: number }>(), { socialDisabled: false, lobby: false, pageOverlay: false, guideTarget: false, messageBadgeCount: 0, socialBadgeCount: 0 });
const emit = defineEmits<{ navigate: [destination: PlayerPrimaryDestination] }>();
const items: { key: PlayerPrimaryDestination; label: string; icon: string }[] = [
  { key: 'lobby', label: '游戏', icon: '⌂' },
  { key: 'wallet', label: '钱包', icon: '◈' },
  { key: 'social', label: '社区', icon: '◎' },
  { key: 'messages', label: '消息', icon: '✉' },
  { key: 'profile', label: '我的', icon: '●' },
];
const visibleItems = computed(() => props.socialDisabled ? items.filter((item) => item.key !== 'social') : items);
const navElement = ref<HTMLElement>();
const activeIndicator = ref({ left: 0, top: 0, width: 0, height: 0 });
const activeIndicatorReady = ref(false);
let navResizeObserver: ResizeObserver | undefined;
let activeIndicatorReadyFrame = 0;

async function updateActiveIndicator(): Promise<void> {
  await nextTick();
  const nav = navElement.value;
  const activeButton = nav?.querySelector<HTMLElement>(`[data-dock-key="${props.active}"]`);
  if (!nav || !activeButton) return;
  const navRect = nav.getBoundingClientRect();
  const buttonRect = activeButton.getBoundingClientRect();
  const style = getComputedStyle(nav);
  activeIndicator.value = {
    left: buttonRect.left - navRect.left - (Number.parseFloat(style.borderLeftWidth) || 0),
    top: buttonRect.top - navRect.top - (Number.parseFloat(style.borderTopWidth) || 0),
    width: buttonRect.width,
    height: buttonRect.height,
  };
  if (!activeIndicatorReady.value && !activeIndicatorReadyFrame) {
    activeIndicatorReadyFrame = window.requestAnimationFrame(() => {
      activeIndicatorReady.value = true;
      activeIndicatorReadyFrame = 0;
    });
  }
}

watch(() => [props.active, props.socialDisabled, props.lobby], () => { void updateActiveIndicator(); }, { flush: 'post' });
onMounted(() => {
  void updateActiveIndicator();
  if (typeof ResizeObserver !== 'undefined' && navElement.value) {
    navResizeObserver = new ResizeObserver(() => { void updateActiveIndicator(); });
    navResizeObserver.observe(navElement.value);
  }
  window.addEventListener('resize', updateActiveIndicator);
});
onBeforeUnmount(() => {
  navResizeObserver?.disconnect();
  if (activeIndicatorReadyFrame) window.cancelAnimationFrame(activeIndicatorReadyFrame);
  window.removeEventListener('resize', updateActiveIndicator);
});
</script>

<template>
  <nav ref="navElement" class="mobile-dock player-primary-nav" :class="{ 'social-disabled': socialDisabled, 'lobby-primary-nav': lobby, 'player-primary-page-nav': pageOverlay, 'guide-target': guideTarget, 'has-measured-indicator': activeIndicatorReady }" aria-label="快捷导航">
    <span class="dock-active-indicator" aria-hidden="true" :style="{ left: `${activeIndicator.left}px`, top: `${activeIndicator.top}px`, width: `${activeIndicator.width}px`, height: `${activeIndicator.height}px` }"></span>
    <button v-for="item in visibleItems" :key="item.key" :data-dock-key="item.key" class="dock-item" type="button" :class="{ active: active === item.key }" :aria-current="active === item.key ? 'page' : undefined" :aria-label="item.key === 'messages' && messageBadgeCount > 0 ? `消息，有 ${messageBadgeCount} 项待处理` : item.key === 'social' && socialBadgeCount > 0 ? `社区，有 ${socialBadgeCount} 条新帖子` : undefined" @click="emit('navigate', item.key)">
      <span class="dock-symbol-wrap"><svg v-if="item.key === 'messages'" class="dock-icon dock-icon-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg>
      <span v-else class="dock-icon" aria-hidden="true">{{ item.icon }}</span><span v-if="item.key === 'messages' && messageBadgeCount > 0" class="dock-message-badge" aria-hidden="true">{{ messageBadgeCount > 99 ? '99+' : messageBadgeCount }}</span><span v-if="item.key === 'social' && socialBadgeCount > 0" class="dock-social-badge" aria-hidden="true">{{ socialBadgeCount > 99 ? '99+' : socialBadgeCount }}</span></span><span>{{ item.label }}</span>
    </button>
  </nav>
</template>
