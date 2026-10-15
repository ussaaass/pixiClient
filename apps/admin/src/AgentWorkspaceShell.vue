<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import PageHelpOverlay from './components/PageHelpOverlay.vue';

const route = useRoute();
const menuOpen = ref(false);
const menuTrigger = ref<HTMLButtonElement | null>(null);
let previousBodyOverflow = '';
const title = computed(() => String(route.meta.title ?? '代理域总览'));
const environmentLabel = import.meta.env.DEV ? '开发预览' : '代理工作区';
const isDevelopmentPreview = import.meta.env.DEV;
const agentShellHelp = [
  { heading: '代理身份', body: 'Agent 仍是普通 user。代理工作区的菜单与 Admin 后台分离，普通 user 身份或可见页面本身不会授予代理权限。' },
  { heading: '代理域范围', body: '正式请求由服务端根据当前 user、邀请关系和 capability 解析可见代理域。客户端不能自行指定 agent_domain_id 扩大范围。' },
];
const previewNavigation = [
  { path: '/agent/downlines', label: '下线管理' },
  { path: '/agent/games', label: '域级游戏配置' },
  { path: '/agent/games/shisanshui/difficulties/practice/expectation', label: '域级期望计算器' },
  { path: '/agent/announcements', label: '域内广播' },
  { path: '/agent/social', label: '社区与私聊' },
  { path: '/agent/audit', label: '代理操作记录' },
];

watch(menuOpen, (open) => {
  if (open) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.querySelector<HTMLElement>('.agent-nav-link')?.focus();
    return;
  }
  document.body.style.overflow = previousBodyOverflow;
  if (window.matchMedia('(max-width: 700px)').matches) menuTrigger.value?.focus();
});

watch(() => route.fullPath, () => { menuOpen.value = false; });

function closeMenu(): void {
  menuOpen.value = false;
}

onBeforeUnmount(() => { document.body.style.overflow = previousBodyOverflow; });
</script>

<template>
  <div class="agent-shell" @keydown.esc="closeMenu">
    <header class="agent-mobile-header">
      <button ref="menuTrigger" type="button" class="agent-menu-trigger" aria-label="打开代理导航" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">☰</button>
      <span>LG <small>代理工作区</small></span>
      <PageHelpOverlay title="代理工作区使用说明" trigger-label="查看代理工作区使用说明" :sections="agentShellHelp" />
      <span class="agent-env-label">{{ environmentLabel }}</span>
    </header>
    <div v-if="menuOpen" class="agent-mobile-scrim" @click="menuOpen = false"></div>
    <aside class="agent-sidebar" :class="{ 'agent-sidebar-open': menuOpen }" aria-label="代理工作区导航">
      <div class="agent-brand"><span class="agent-brand-mark">LG</span><span><strong>Lottery Game</strong><small>代理域工作区</small></span></div>
      <nav aria-label="代理导航">
        <p class="agent-nav-heading">代理工作台</p>
        <RouterLink to="/agent/overview" class="agent-nav-link" active-class="active"><span aria-hidden="true">▦</span>域内总览</RouterLink>
        <template v-if="isDevelopmentPreview">
          <RouterLink v-for="item in previewNavigation" :key="item.path" :to="item.path" class="agent-nav-preview-link" active-class="active">{{ item.label }}</RouterLink>
        </template>
        <template v-else>
          <div class="agent-nav-unavailable">下线管理<span>等待 capability</span></div>
          <div class="agent-nav-unavailable">游戏配置与计算<span>等待 capability</span></div>
          <div class="agent-nav-unavailable">域内广播<span>等待 capability</span></div>
          <div class="agent-nav-unavailable">社区管理<span>等待 capability</span></div>
          <div class="agent-nav-unavailable">操作记录<span>等待 Agent API</span></div>
        </template>
      </nav>
    </aside>
    <main class="agent-main">
      <div class="agent-desktop-topbar"><div><span>Lottery Game</span><b>/</b><strong>{{ title }}</strong></div><PageHelpOverlay title="代理工作区使用说明" trigger-label="查看代理工作区使用说明" :sections="agentShellHelp" /></div>
      <div class="agent-page-content"><RouterView /></div>
    </main>
  </div>
</template>
