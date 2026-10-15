import { createRouter, createWebHistory, type RouterHistory } from 'vue-router';
import OverviewPage from './pages/OverviewPage.vue';
import DomainUnavailablePage from './pages/DomainUnavailablePage.vue';
import UserListPage from './pages/UserListPage.vue';
import UserDetailPage from './pages/UserDetailPage.vue';
import AgentDomainListPage from './pages/AgentDomainListPage.vue';
import AssetOperationsPage from './pages/AssetOperationsPage.vue';
import AssetManagementPage from './pages/AssetManagementPage.vue';
import SystemOperationsPage from './pages/SystemOperationsPage.vue';
import AgentWorkspacePage from './pages/AgentWorkspacePage.vue';
import GameCatalogPage from './pages/GameCatalogPage.vue';
import PaymentChannelsPage from './pages/PaymentChannelsPage.vue';
import PaymentOrdersPage from './pages/PaymentOrdersPage.vue';
import WithdrawalReviewPage from './pages/WithdrawalReviewPage.vue';
import ChainDepositsPage from './pages/ChainDepositsPage.vue';
import ExternalSettlementsPage from './pages/ExternalSettlementsPage.vue';
import ReconciliationPage from './pages/ReconciliationPage.vue';
import AgentOverviewPage from './pages/AgentOverviewPage.vue';
import EventOperationsPage from './pages/EventOperationsPage.vue';
import GameConfigOperationsPage from './pages/GameConfigOperationsPage.vue';
import ProductManagementPage from './pages/ProductManagementPage.vue';
import SocialSupportPage from './pages/SocialSupportPage.vue';
import GameOperationsMonitoringPage from './pages/GameOperationsMonitoringPage.vue';

const domainRoutes = [
  { path: '/admin/users', title: '用户与代理', group: '用户与代理' },
  { path: '/admin/agent-domains', title: '代理域', group: '用户与代理' },
  { path: '/admin/assets/operations', title: '资产操作', group: '用户与代理' },
  { path: '/admin/games', title: '游戏目录', group: '游戏运营' },
  { path: '/admin/payments/channels', title: '支付渠道', group: '支付与商品' },
  { path: '/admin/payments/orders', title: '充值订单', group: '支付与商品' },
  { path: '/admin/withdrawals', title: '提现审核', group: '支付与商品' },
  { path: '/admin/chain-deposits', title: 'TRON 充值监控', group: '支付与商品' },
  { path: '/admin/payments/settlements', title: '通道结算流水', group: '支付与商品' },
  { path: '/admin/reconciliation', title: '对账异常', group: '支付与商品' },
] as const;

export const adminRoutes = [
  { path: '/', redirect: '/admin/login' },
  { path: '/admin/login', component: () => import('./pages/AdminLoginPage.vue'), meta: { title: '管理员登录', layout: 'auth' } },
  ...(import.meta.env.DEV ? [{ path: '/admin/payments/mock', component: () => import('./pages/MockPaymentConsolePage.vue'), meta: { title: 'Mock 支付控制台', developmentOnly: true } }] : []),
  { path: '/admin/overview', component: OverviewPage, meta: { title: '运营总览' } },
  { path: '/admin/events', component: EventOperationsPage, meta: { title: '事件规则' } },
  { path: '/admin/events/rules', component: EventOperationsPage, meta: { title: '事件规则' } },
  { path: '/admin/events/instances', component: EventOperationsPage, meta: { title: '活动实例' } },
  { path: '/admin/announcements', component: EventOperationsPage, meta: { title: '公告模板' } },
  { path: '/admin/announcements/delivery', component: EventOperationsPage, meta: { title: '广播投递' } },
  { path: '/admin/games/:gameKey/difficulties/:difficultyKey/config', component: GameConfigOperationsPage, meta: { title: '游戏配置' } },
  { path: '/admin/games/:gameKey/difficulties/:difficultyKey/expectation', component: GameConfigOperationsPage, meta: { title: '期望计算器', gameConfigPage: 'expectation' } },
  { path: '/admin/products', component: ProductManagementPage, meta: { title: '商品管理' } },
  { path: '/admin/community', component: SocialSupportPage, meta: { title: '社区话题' } },
  { path: '/admin/community/topics', component: SocialSupportPage, meta: { title: '社区话题' } },
  { path: '/admin/community/moderation', component: SocialSupportPage, meta: { title: '内容审核' } },
  { path: '/admin/support/conversations', component: SocialSupportPage, meta: { title: '客服队列' } },
  { path: '/admin/support/conversations/:conversationId', component: SocialSupportPage, meta: { title: '客服会话', socialSupportPage: 'conversation' } },
  { path: '/admin/assets', component: AssetManagementPage, meta: { title: 'Asset 目录' } },
  { path: '/admin/ai-generation', component: AssetManagementPage, meta: { title: 'AI 生成任务' } },
  { path: '/admin/asset-releases', component: AssetManagementPage, meta: { title: '资源发布' } },
  { path: '/admin/system', component: SystemOperationsPage, meta: { title: '系统配置' } },
  { path: '/admin/system-config', component: SystemOperationsPage, meta: { title: '系统配置' } },
  { path: '/admin/admin-users', component: SystemOperationsPage, meta: { title: 'Admin 权限' } },
  { path: '/admin/audit', component: SystemOperationsPage, meta: { title: '操作审计' } },
  { path: '/admin/jobs', component: SystemOperationsPage, meta: { title: 'Worker / Outbox' } },
  { path: '/admin/health', component: SystemOperationsPage, meta: { title: '服务健康' } },
  { path: '/admin/rooms', component: GameOperationsMonitoringPage, meta: { title: '房间观察' } },
  { path: '/admin/rounds', component: GameOperationsMonitoringPage, meta: { title: '战绩 / 回放' } },
  { path: '/admin/referrals', component: GameOperationsMonitoringPage, meta: { title: '邀请关系' } },
  { path: '/agent/overview', component: AgentOverviewPage, meta: { title: '代理域总览', layout: 'agent' } },
  { path: '/agent/downlines', component: AgentWorkspacePage, meta: { title: '下线管理', layout: 'agent' } },
  { path: '/agent/games', component: AgentWorkspacePage, meta: { title: '域级游戏配置', layout: 'agent' } },
  { path: '/agent/games/:gameKey/difficulties/:difficultyKey/config', component: AgentWorkspacePage, meta: { title: '域级游戏配置', layout: 'agent', agentPage: 'config' } },
  { path: '/agent/games/:gameKey/difficulties/:difficultyKey/expectation', component: AgentWorkspacePage, meta: { title: '域级期望计算器', layout: 'agent', agentPage: 'expectation' } },
  { path: '/agent/announcements', component: AgentWorkspacePage, meta: { title: '域内广播', layout: 'agent' } },
  { path: '/agent/social', component: AgentWorkspacePage, meta: { title: '社区与私聊', layout: 'agent' } },
  { path: '/agent/audit', component: AgentWorkspacePage, meta: { title: '代理操作记录', layout: 'agent' } },
  ...domainRoutes.map((entry) => {
    const domain: { path: string; title: string; group: string } = entry;
    return domain.path === '/admin/users'
    ? { path: domain.path, component: UserListPage, meta: { title: '用户列表' } }
    : domain.path === '/admin/agent-domains'
      ? { path: domain.path, component: AgentDomainListPage, meta: { title: '代理域' } }
      : domain.path === '/admin/assets/operations'
        ? { path: domain.path, component: AssetOperationsPage, meta: { title: '资产操作' } }
      : domain.path === '/admin/games'
          ? { path: domain.path, component: GameCatalogPage, meta: { title: '游戏目录' } }
          : domain.path === '/admin/payments/channels'
            ? { path: domain.path, component: PaymentChannelsPage, meta: { title: '支付渠道' } }
            : domain.path === '/admin/payments/orders'
              ? { path: domain.path, component: PaymentOrdersPage, meta: { title: '充值订单' } }
              : domain.path === '/admin/withdrawals'
                ? { path: domain.path, component: WithdrawalReviewPage, meta: { title: '提现审核' } }
                : domain.path === '/admin/chain-deposits'
                  ? { path: domain.path, component: ChainDepositsPage, meta: { title: 'TRON 充值监控' } }
                  : domain.path === '/admin/payments/settlements'
                    ? { path: domain.path, component: ExternalSettlementsPage, meta: { title: '通道结算流水' } }
                    : domain.path === '/admin/reconciliation'
                      ? { path: domain.path, component: ReconciliationPage, meta: { title: '对账异常' } }
    : {
      path: domain.path,
      component: DomainUnavailablePage,
      props: { title: domain.title, group: domain.group },
      meta: { title: domain.title },
    };
  }),
  { path: '/admin/users/:id', component: UserDetailPage, meta: { title: '用户详情' } },
  { path: '/:pathMatch(.*)*', redirect: '/admin/login' },
];

export function createAdminRouter(history: RouterHistory = createWebHistory()) {
  const router = createRouter({ history, routes: adminRoutes });
  router.beforeEach((to) => {
    if (to.meta.developmentOnly && !import.meta.env.DEV) return '/admin/login';
    if (!import.meta.env.DEV && to.meta.layout !== 'auth') return '/admin/login';
  });
  return router;
}
