<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElTag } from 'element-plus';
import { useRoute } from 'vue-router';
import 'element-plus/theme-chalk/el-tag.css';
import AgentWorkspaceShell from './AgentWorkspaceShell.vue';
import PageHelpOverlay from './components/PageHelpOverlay.vue';

const route = useRoute();
const mobileNavigationOpen = ref(false);
const mobileNavigationTrigger = ref<HTMLButtonElement | null>(null);
let previousBodyOverflow = '';
const pageTitle = computed(() => String(route.meta.title ?? '管理后台'));
const environmentLabel = import.meta.env.DEV ? '开发环境' : '生产构建';
const adminShellHelp = [
  { heading: '当前环境', body: '此管理界面以访客预览方式运行。页面外观和导航不代表已取得 Admin 身份或具体操作权限。' },
  { heading: '权限边界', body: '正式数据与命令由服务端按当前 user、permission path 和操作范围逐次校验。不能通过修改浏览器状态获得权限。' },
];
const navigation = [
  { path: '/admin/overview', title: '运营总览', group: '工作台', icon: '▦' },
  { path: '/admin/users', title: '用户与代理', group: '用户与代理', icon: '♙' },
  { path: '/admin/agent-domains', title: '代理域', group: '用户与代理', icon: '◇' },
  { path: '/admin/assets/operations', title: '资产操作', group: '用户与代理', icon: '⇄' },
  { path: '/admin/games', title: '游戏目录', group: '游戏运营', icon: '♠' },
  { path: '/admin/events', title: '事件与广播', group: '活动与广播', icon: '◉' },
  { path: '/admin/community/topics', title: '社区与客服', group: '社区与客服', icon: '☏' },
  { path: '/admin/payments/channels', title: '支付渠道', group: '支付与商品', icon: '￥' },
  { path: '/admin/products', title: '商品管理', group: '支付与商品', icon: '▤' },
  { path: '/admin/payments/orders', title: '充值订单', group: '支付与商品', icon: '▤' },
  { path: '/admin/withdrawals', title: '提现审核', group: '支付与商品', icon: '⇧' },
  { path: '/admin/chain-deposits', title: 'TRON 充值监控', group: '支付与商品', icon: '⌁' },
  { path: '/admin/payments/settlements', title: '通道结算流水', group: '支付与商品', icon: '↔' },
  { path: '/admin/reconciliation', title: '对账异常', group: '支付与商品', icon: '≋' },
  { path: '/admin/assets', title: '素材与资源', group: '素材与资源', icon: '▧' },
  { path: '/admin/system', title: '系统配置与审计', group: '系统设置与审计', icon: '⚙' },
];
const groupedNavigation = computed(() => {
  const groups = new Map<string, typeof navigation[number][]>();
  for (const item of navigation) {
    const group = groups.get(item.group) ?? [];
    group.push(item);
    groups.set(item.group, group);
  }
  return [...groups.entries()];
});

watch(() => route.fullPath, () => { mobileNavigationOpen.value = false; });
watch(mobileNavigationOpen, (open) => {
  if (open) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.querySelector<HTMLElement>('.sidebar .nav-link')?.focus();
    return;
  }
  document.body.style.overflow = previousBodyOverflow;
  if (window.matchMedia('(max-width: 700px)').matches) mobileNavigationTrigger.value?.focus();
});

function closeMobileNavigation(): void {
  mobileNavigationOpen.value = false;
}

function isNavigationActive(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`);
}

onBeforeUnmount(() => {
  document.body.style.overflow = previousBodyOverflow;
});
</script>

<template>
  <AgentWorkspaceShell v-if="route.meta.layout === 'agent'" />
  <div v-else-if="route.meta.layout === 'auth'" class="auth-route"><RouterView /></div>
  <div v-else class="admin-app" @keydown.esc="closeMobileNavigation">
    <header class="mobile-header">
      <button ref="mobileNavigationTrigger" class="icon-button" type="button" aria-label="打开导航" :aria-expanded="mobileNavigationOpen" @click="mobileNavigationOpen = !mobileNavigationOpen">☰</button>
      <span class="mobile-brand">LG <span>管理后台</span></span>
      <PageHelpOverlay title="管理后台使用说明" trigger-label="查看管理后台使用说明" :sections="adminShellHelp" />
      <ElTag class="environment-chip" type="warning" effect="plain" size="small">{{ environmentLabel }}</ElTag>
    </header>

    <div v-if="mobileNavigationOpen" class="mobile-scrim" @click="mobileNavigationOpen = false"></div>
    <aside class="sidebar" :class="{ 'sidebar-open': mobileNavigationOpen }" aria-label="管理后台导航">
      <div class="brand-lockup"><span class="brand-mark">LG</span><span><strong>Lottery Game</strong><small>运营控制台</small></span></div>
      <div class="environment-banner"><span class="environment-dot"></span><span><strong>{{ environmentLabel }}</strong><small>操作数据由服务端授权</small></span></div>
      <nav>
        <div v-for="[group, items] in groupedNavigation" :key="group" class="nav-group">
          <p class="nav-heading">{{ group }}</p>
          <RouterLink v-for="item in items" :key="item.path" :to="item.path" class="nav-link" :class="{ active: isNavigationActive(item.path) }">
            <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span><span>{{ item.title }}</span>
          </RouterLink>
        </div>
      </nav>
    </aside>

    <main class="main-area">
      <div class="desktop-topbar">
        <div class="breadcrumbs"><span>Lottery Game</span><span class="crumb-separator">/</span><strong>{{ pageTitle }}</strong></div>
      <div class="topbar-right"><PageHelpOverlay title="管理后台使用说明" trigger-label="查看管理后台使用说明" :sections="adminShellHelp" /><ElTag type="info" effect="plain" size="small">访客预览</ElTag></div>
      </div>
      <div class="page-content"><RouterView /></div>
    </main>
  </div>
</template>
