import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { createMemoryHistory } from 'vue-router';
import App from './App.vue';
import { createAdminRouter } from './router';
import { localPaymentChannelApplication } from './platform/payment-channels/composition';
import { PaymentMethod, PaymentProviderType } from '@gameing/contracts/payment-channel';
import { SocialContentStatus, SocialModerationCaseStatus } from '@gameing/contracts/social';
import { openAdminDevelopmentDatabase } from './platform/browser-development-database';
import { adminSelectLabel, chooseAdminOption } from './test-utils/select-option';

describe('Admin workspace shell', () => {
  let host: HTMLDivElement;
  let app: VueApp | undefined;
  let router: ReturnType<typeof createAdminRouter>;

  async function waitForConfigRows(): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (host.querySelectorAll('.system-config-row').length === 9) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('System configuration rows did not load from IndexedDB');
  }

  async function waitForAgentDownlines(): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (host.querySelectorAll('.agent-downline-table tbody tr').length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Agent downline demo data did not load');
  }

  async function waitForAgentDownlineDetail(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (document.querySelector('.agent-downline-drawer')?.textContent?.includes('海盐汽水')) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Agent downline detail read did not finish');
  }

  async function waitForSupportQueue(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (host.querySelectorAll('.support-queue-table tbody tr').length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Support desk demo queue did not load');
  }

  async function waitForSupportDetail(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (host.querySelector('.support-message-list .support-message')) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Support desk conversation did not load');
  }

  async function waitForModerationCases(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (host.querySelectorAll('.moderation-case-card').length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Social moderation demo queue did not load');
  }

  async function waitForAgentAuditRows(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (host.querySelectorAll('.agent-audit-table tbody tr').length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Agent audit history did not load the downline read event');
  }

  async function waitForAgentDomainPreview(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (host.querySelector('.agent-domain-empty')?.textContent?.includes('暂无本机演练记录')) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Agent domain preview did not finish loading');
  }

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable in component tests')));
    host = document.createElement('div');
    document.body.append(host);
    router = createAdminRouter(createMemoryHistory());
    await router.push('/admin/overview');
    await router.isReady();
    app = createApp(App);
    app.use(router);
    app.mount(host);
    await nextTick();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    app?.unmount();
    app = undefined;
    host.remove();
  });

  it('keeps shell guidance on demand without fabricated operational metrics', async () => {
    expect(host.textContent).toContain('暂无运营事项');
    expect(host.textContent).not.toContain('Admin API 未接入');
    expect(host.querySelector('.sidebar-footnote')).toBeNull();
    host.querySelector<HTMLButtonElement>('.topbar-right .page-help-trigger')!.click();
    await nextTick();
    expect(document.body.querySelector('.page-help-dialog')?.textContent).toContain('正式数据与命令由服务端');
    document.body.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
    expect(host.querySelectorAll('.workspace-card')).toHaveLength(7);
    expect(host.querySelector('.el-tag')).not.toBeNull();
    expect(host.textContent).not.toMatch(/提现待审\s*\d|可提现余额\s*\d|在线人数\s*\d/);
  });

  it('renders Agent in a separate workspace shell with no invented domain metrics', async () => {
    await router.push('/agent/overview');
    await nextTick();

    expect(host.querySelector('.agent-overview-page h1')?.textContent).toBe('代理域总览');
    expect(host.querySelector('.agent-sidebar')).not.toBeNull();
    expect(host.querySelector('.sidebar')).toBeNull();
    expect(host.textContent).toContain('AGENT_GAME_CONFIG_READ');
    expect(host.textContent).not.toMatch(/下线人数\s*\d|域内流水\s*[¥￥]?\s*\d|代理域 ID\s*\d/);
    expect(host.querySelector('.agent-scope-note')).toBeNull();
    expect(host.querySelector('.agent-sidebar-footnote')).toBeNull();
    expect(host.textContent).not.toContain('Agent API 未接入');
    expect(host.textContent).not.toContain('结构预览 / API 待接入');
    host.querySelector<HTMLButtonElement>('.agent-desktop-topbar .page-help-trigger')!.click();
    await nextTick();
    expect(document.body.querySelector('.page-help-dialog')?.textContent).toContain('客户端不能自行指定 agent_domain_id');
    document.body.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.agent-overview-heading .page-help-trigger')!.click();
    await nextTick();
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('页面不会接受客户端传入的 agent_domain_id');
    document.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
  });

  it('renders Agent domain pages through their own shell and enforces the designed capability boundaries', async () => {
    const pages = [
      ['/agent/downlines', '下线管理', '开发预览'],
      ['/agent/games', '域级游戏配置', '十三张'],
      ['/agent/games/shisanshui/difficulties/practice/expectation', '域级期望计算器', 'RTP 不适用'],
      ['/agent/announcements', '域内广播', 'AGENT_ANNOUNCEMENT_MANAGE'],
      ['/agent/social', '社区与私聊', 'AGENT_SOCIAL_READ_PRIVATE_MESSAGES'],
      ['/agent/audit', '代理操作记录', 'Admin 对代理的授权记录仍属于 Admin 审计'],
    ] as const;
    for (const [path, title, expectedText] of pages) {
      await router.push(path);
      await nextTick();
      expect(host.querySelector('.agent-shell')).not.toBeNull();
      expect(host.querySelector('.agent-sidebar')).not.toBeNull();
      expect(host.querySelector('.sidebar')).toBeNull();
      expect(host.querySelector('.agent-operations-page h1')?.textContent).toBe(title);
      expect(host.textContent).toContain(expectedText);
      expect(host.textContent).not.toContain('仅空态预览');
      expect(host.querySelector('.agent-operations-banner')).toBeNull();
      expect(host.querySelector('.agent-operations-note, .agent-config-rules-grid')).toBeNull();
    }
    await router.push('/agent/downlines');
    await nextTick();
    await waitForAgentDownlines();
    expect(host.querySelectorAll('.agent-downline-filters :disabled')).toHaveLength(0);
    expect(host.querySelectorAll('.agent-downline-table tbody tr')).toHaveLength(3);
    host.querySelector<HTMLButtonElement>('.agent-downline-table tbody tr button')!.click();
    await nextTick();
    expect(document.querySelector('.agent-downline-purpose-dialog')?.textContent).toContain('本次读取会写入代理操作审计');
    document.querySelector<HTMLButtonElement>('.agent-downline-purpose-cancel')!.click();
    await nextTick();
    expect(document.querySelector('.agent-downline-purpose-dialog')).toBeNull();
    expect(document.activeElement?.textContent).toContain('查看明细');
    host.querySelector<HTMLButtonElement>('.agent-downline-table tbody tr button')!.click();
    await nextTick();
    await chooseAdminOption(document, '.agent-downline-purpose-dialog .el-select', '资产异常跟进');
    document.querySelector<HTMLButtonElement>('.agent-downline-purpose-submit')!.click();
    await waitForAgentDownlineDetail();
    expect(document.querySelector('.agent-downline-drawer')?.textContent).toContain('海盐汽水');
    expect(document.querySelector('.agent-downline-drawer')?.textContent).toContain('邀请上级链');
    expect(document.querySelector('.agent-downline-drawer')?.textContent).not.toMatch(/TOTP密钥|恢复码.*[A-Z0-9]{8}/);
    document.querySelector<HTMLButtonElement>('.agent-downline-drawer header button')!.click();
    await nextTick();
    await router.push('/agent/downlines');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.agent-operations-panel-tools .page-help-trigger')!.click();
    await nextTick();
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('密码、TOTP 秘钥、恢复码');
    document.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();

    await router.push('/agent/audit');
    await nextTick();
    await waitForAgentAuditRows();
    expect(host.querySelector('.agent-audit-table tbody')?.textContent).toContain('DOWNLINE_DETAIL_READ');
    expect(host.querySelector('.agent-audit-table tbody')?.textContent).toContain('资产异常跟进');

    await router.push('/agent/games/shisanshui/difficulties/practice/expectation');
    await nextTick();
    expect(host.textContent).toContain('固定策略期望计算器');
    expect(host.textContent).toContain('RTP 不适用');
    host.querySelector<HTMLButtonElement>('.agent-operations-panel-heading .page-help-trigger')!.click();
    await nextTick();
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('模拟权限不等于发布权限');
    document.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();

    await router.push('/agent/announcements');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.agent-operations-panel-tools .page-help-trigger')!.click();
    await nextTick();
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('不能选择平台全局范围');
    document.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();

    await router.push('/agent/social');
    await nextTick();
    host.querySelector<HTMLButtonElement>('.agent-operations-panel-tools .page-help-trigger')!.click();
    await nextTick();
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('客服 IM 始终属于独立 support 权限');
    document.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
    expect(host.textContent).toContain('AGENT_SOCIAL_READ_PRIVATE_MESSAGES');
  }, 30_000);

  it('completes the Agent game-config flow through simulation, local publish, audit, and reload', async () => {
    await router.push('/agent/games');
    await nextTick();
    expect(host.querySelector('.agent-config-game-card')?.textContent).toContain('十三张');
    expect(host.textContent).toContain('数学模型 / 配置边界未登记');
    for (const game of ['跳高高', '夺宝奇侠', '麻将胡了', '麻将胡了2', '捕鱼', '赏金女王', '3快']) expect(host.textContent).toContain(game);

    host.querySelector<HTMLAnchorElement>('.agent-config-game-card')!.click();
    await vi.waitFor(() => expect(host.querySelector('.agent-config-editor')).not.toBeNull());
    expect(host.textContent).toContain('LOCAL_DEMO');
    const payout = host.querySelector<HTMLInputElement>('.agent-config-editor input[type="number"]')!;
    payout.value = '5'; payout.dispatchEvent(new Event('input', { bubbles: true })); payout.dispatchEvent(new Event('change', { bubbles: true })); await nextTick();
    expect(host.querySelector('.agent-config-diff')?.textContent).toContain('3 → 5');
    host.querySelector<HTMLAnchorElement>('.agent-config-actions .agent-config-primary')!.click();
    await vi.waitFor(() => expect(host.querySelector('.agent-simulation-controls')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('.agent-simulation-controls button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.agent-simulation-report')).not.toBeNull(), { timeout: 25_000 });
    expect(host.querySelector('.agent-simulation-report')?.textContent).toContain('净水分布');
    expect(host.textContent).toContain('RTP 不适用');
    host.querySelector<HTMLButtonElement>('.agent-config-actions .agent-config-primary')!.click();
    await nextTick();
    const reason = document.querySelector<HTMLInputElement>('.agent-config-publish-summary + label input');
    expect(reason).not.toBeNull();
    reason!.value = '验证本机域级配置发布'; reason!.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    document.querySelector<HTMLButtonElement>('.agent-downline-purpose-submit')!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('本机演练发布成功'));

    await router.push('/agent/audit');
    await vi.waitFor(() => expect(host.querySelector('.agent-audit-table tbody')?.textContent).toContain('CONFIG_PUBLISH'));
    await router.push('/agent/games/shisanshui/difficulties/practice/config');
    await vi.waitFor(() => expect(host.querySelector('.agent-config-effective')?.textContent).toContain('域配置已发布'));
    expect(host.querySelector<HTMLInputElement>('.agent-config-editor input[type="number"]')?.value).toBe('5');
  }, 30_000);

  it('completes Agent announcement create, preview, schedule, retract, and audit offline', async () => {
    const database = await openAdminDevelopmentDatabase();
    await database.clear('agent_announcements');
    await database.clear('agent_audit_events');
    database.close();
    await router.push('/agent/announcements');
    await nextTick();
    expect(host.textContent).toContain('LOCAL_DEMO');
    const createButton = [...host.querySelectorAll<HTMLButtonElement>('.agent-operations-panel-tools button')].find((button) => button.textContent?.includes('新建公告'))!;
    createButton.click();
    await nextTick();
    const fields = host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.agent-announcement-dialog input, .agent-announcement-dialog textarea');
    fields[0]!.value = '十三张规则提醒'; fields[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    fields[1]!.value = '进入游戏前请查看本档位的牌型和结算规则。'; fields[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    fields[2]!.value = '整理大厅规则说明'; fields[2]!.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('.agent-announcement-live-preview')?.textContent).toContain('十三张规则提醒');
    host.querySelector<HTMLButtonElement>('.agent-announcement-dialog .agent-downline-purpose-submit')!.click();
    await vi.waitFor(() => expect(host.querySelector('.agent-announcement-card h3')?.textContent).toBe('十三张规则提醒'));
    expect(host.querySelector('.agent-announcement-status')?.textContent).toBe('草稿');

    host.querySelector<HTMLButtonElement>('.agent-announcement-card footer button')!.click();
    await nextTick();
    expect(host.querySelector('.agent-announcement-live-preview')?.textContent).toContain('进入游戏前请查看本档位');
    await chooseAdminOption(host, '.agent-announcement-dialog label:nth-of-type(1) .el-select', '1 小时后展示');
    await chooseAdminOption(host, '.agent-announcement-dialog label:nth-of-type(2) .el-select', '6 小时');
    const publishReason = host.querySelector<HTMLTextAreaElement>('.agent-announcement-dialog textarea')!;
    publishReason.value = '安排一小时后开始展示'; publishReason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('.agent-announcement-dialog .agent-downline-purpose-submit')!.click();
    await vi.waitFor(() => expect(host.querySelector('.agent-announcement-status')?.textContent).toBe('定时中'));

    host.querySelector<HTMLButtonElement>('.agent-announcement-card .agent-announcement-retract')!.click();
    await nextTick();
    const retractReason = host.querySelector<HTMLTextAreaElement>('.agent-announcement-dialog textarea')!;
    retractReason.value = '演练撤回流程'; retractReason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('.agent-announcement-dialog .agent-downline-purpose-submit')!.click();
    await vi.waitFor(() => expect(host.querySelector('.agent-announcement-status')?.textContent).toBe('已撤回'));
    expect(host.textContent).toContain('未投递到玩家大厅');

    await router.push('/agent/audit');
    await nextTick();
    await vi.waitFor(() => expect(host.textContent).toContain('ANNOUNCEMENT_CREATE'));
    expect(host.querySelector('.agent-audit-table')?.textContent).toContain('ANNOUNCEMENT_PUBLISH');
    expect(host.querySelector('.agent-audit-table')?.textContent).toContain('ANNOUNCEMENT_RETRACT');
  }, 20_000);

  it('reads a scoped Agent private conversation and audits the access without copying message text', async () => {
    const database = await openAdminDevelopmentDatabase();
    await database.clear('agent_audit_events');
    database.close();
    await router.push('/agent/social');
    await vi.waitFor(() => expect(host.querySelectorAll('.agent-social-conversation-card')).toHaveLength(2));
    expect(host.textContent).toContain('LOCAL_DEMO');
    expect(host.textContent).toContain('合成样例');
    await vi.waitFor(() => expect(host.querySelectorAll('.agent-social-moderation-card')).toHaveLength(1));
    expect(host.querySelector('.agent-social-moderation-card')?.textContent).toContain('夜航船');
    host.querySelector<HTMLButtonElement>('.agent-social-moderation-card footer button')!.click();
    await nextTick();
    const moderationReason = document.body.querySelector<HTMLTextAreaElement>('.agent-social-purpose-dialog textarea')!;
    moderationReason.value = '举报内容确认违反社区规范'; moderationReason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('.agent-social-purpose-dialog button[type="submit"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('.agent-social-case-status')?.textContent).toBe('已处理'));
    host.querySelector<HTMLButtonElement>('.agent-social-conversation-card button')!.click();
    await nextTick();
    expect(document.body.querySelector('.agent-social-purpose-dialog')?.textContent).toContain('写入不可变代理审计');
    const reason = document.body.querySelector<HTMLTextAreaElement>('.agent-social-purpose-dialog textarea')!;
    reason.value = '处理用户申诉工单'; reason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('.agent-social-purpose-dialog .agent-downline-purpose-submit')!.click();
    await vi.waitFor(() => expect(document.body.querySelector('.agent-social-message-list')?.textContent).toContain('我想确认一下这周的活动时间'));
    const persisted = await openAdminDevelopmentDatabase();
    const audits = await persisted.getAll('agent_audit_events');
    expect(audits).toHaveLength(2);
    expect(audits.find((audit) => audit.actionCode === 'PRIVATE_MESSAGE_READ')).toMatchObject({ resourceType: 'SOCIAL_CONVERSATION', resourceKey: '93001', purpose: '处理用户申诉工单', snapshot: { messageCount: 3 } });
    expect(audits.find((audit) => audit.actionCode === 'SOCIAL_MODERATION_DECISION')).toMatchObject({ resourceType: 'SOCIAL_MODERATION_CASE', resourceKey: '97002' });
    expect(JSON.stringify(audits)).not.toContain('确认一下这周的活动时间');
    persisted.close();
    document.body.querySelector<HTMLButtonElement>('.agent-social-conversation-drawer footer button')!.click();
    await router.push('/agent/audit');
    await vi.waitFor(() => expect(host.querySelector('.agent-audit-table')?.textContent).toContain('PRIVATE_MESSAGE_READ'));
    expect(host.querySelector('.agent-audit-table')?.textContent).toContain('SOCIAL_MODERATION_DECISION');
    const fixtureDatabase = await openAdminDevelopmentDatabase();
    const moderatedCase = await fixtureDatabase.get('social_moderation_cases', '97002');
    if (moderatedCase) await fixtureDatabase.put('social_moderation_cases', { ...moderatedCase, contentStatus: SocialContentStatus.PUBLISHED, caseStatus: SocialModerationCaseStatus.OPEN });
    fixtureDatabase.close();
  }, 20_000);

  it('shows the login design but does not collect or submit credentials before the auth API exists', async () => {
    await router.push('/admin/login');
    await nextTick();

    expect(host.querySelector('.login-card h2')?.textContent).toBe('管理员登录');
    host.querySelector<HTMLButtonElement>('.login-card-heading .page-help-trigger')!.click();
    await nextTick();
    expect(document.body.querySelector('.page-help-dialog')?.textContent).toContain('不会发送或保存输入凭证');
    document.body.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('#admin-account')?.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('#admin-password')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.login-submit')?.disabled).toBe(true);
    expect(host.querySelector('.login-preview-link')).not.toBeNull();
  });

  it('routes the Admin application root to the namespaced login path', async () => {
    await router.push('/');
    await nextTick();

    expect(router.currentRoute.value.path).toBe('/admin/login');
    expect(host.querySelector('.login-card h2')?.textContent).toBe('管理员登录');
  });

  it('opens a domain route and explicitly keeps its domain API pending', async () => {
    await router.push('/admin/rooms');
    await vi.waitFor(() => expect(host.querySelectorAll('.ops-monitor-table-wrap tbody tr')).toHaveLength(2));

    expect(host.querySelector('.ops-monitor-heading h1')?.textContent).toBe('房间观察');
    expect(host.textContent).not.toContain('API 尚未接入');
    expect(host.querySelector('.ops-monitor-service')).toBeNull();
    expect(host.textContent).toContain('LOCAL_DEMO');
  });

  it('renders payment channel methods and links to the isolated local Mock console', async () => {
    await router.push('/admin/payments/channels');
    await nextTick();

    expect(host.querySelector('.payment-channels-page h1')?.textContent).toBe('支付渠道');
    expect(host.textContent).toContain('本机渠道配置');
    expect(host.textContent).toContain('USDT · TRON / TRC-20');
    expect(host.querySelector('.payment-channel-demo-banner')?.textContent).toContain('LOCAL_DEMO');
    expect(host.querySelector('.payment-channel-filters button.payment-add-button')).not.toBeNull();
    expect(host.querySelector<HTMLAnchorElement>('.mock-console-link')?.getAttribute('href')).toBe('/admin/payments/mock');
    expect(host.querySelectorAll('.mock-console-panel button')).toHaveLength(0);
  });

  it('runs isolated Mock payment scenarios through a local application and never claims a real payment', async () => {
    const createdChannel = await localPaymentChannelApplication.create({ requestKey: crypto.randomUUID(), providerCode: 'test-mock', providerName: '本机支付演练', providerType: PaymentProviderType.AGGREGATOR, paymentMethod: PaymentMethod.WECHAT, sortOrder: 1, reason: '验证渠道关联流程' });
    if (!createdChannel.ok) throw new Error('expected an active local channel');
    await router.push('/admin/payments/channels');
    await nextTick();
    await vi.waitFor(() => expect(host.querySelector('.payment-channel-mock-link')?.getAttribute('href')).toContain(`channelId=${createdChannel.value.channelId}`));
    await router.push({ path: '/admin/payments/mock', query: { orderId: '314159', channelId: createdChannel.value.channelId } });
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector('.mock-payment-page h1')?.textContent).toBe('Mock 支付控制台');
    expect(host.querySelector('.mock-local-pill')?.textContent).toBe('本机测试');
    expect(host.textContent).toContain('链接中的订单不属于当前本机测试会话');
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('.mock-create-order')?.disabled).toBe(false));
    await chooseAdminOption(host, '.mock-order-query .el-select', '本机支付演练 · 微信');
    host.querySelector<HTMLButtonElement>('.mock-page-heading .page-help-trigger')!.click();
    await nextTick();
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('不访问支付服务商、订单 API、钱包');
    document.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
    expect(host.querySelectorAll('.mock-page-scenario')).toHaveLength(5);
    expect(host.querySelectorAll('.mock-page-scenario button:disabled')).toHaveLength(5);
    const amount = host.querySelector<HTMLInputElement>('.mock-order-query input')!;
    amount.value = '200.00';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('.mock-order-query button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector('.mock-selected-order')?.textContent).toContain('¥200.00');
    expect(host.querySelector('.mock-selected-order')?.textContent).toContain('本机支付演练');
    const scenarioButtons = host.querySelectorAll<HTMLButtonElement>('.mock-page-scenario button');
    expect(scenarioButtons[0]?.disabled).toBe(false);
    expect(scenarioButtons[3]?.disabled).toBe(true);
    scenarioButtons[0]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector('.mock-selected-order')?.textContent).toContain('模拟成功');
    expect(host.querySelectorAll('.mock-event-row')).toHaveLength(1);
    expect(host.querySelectorAll('.mock-page-scenario button:disabled')).toHaveLength(4);
    host.querySelectorAll<HTMLButtonElement>('.mock-page-scenario button')[3]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelectorAll('.mock-event-row')).toHaveLength(2);
    expect(host.querySelector('.mock-event-list')?.textContent).toContain('重复事件已忽略');
    expect(host.textContent).toContain('没有调用支付渠道或钱包');
    expect(host.textContent).not.toContain('真实支付成功');
    const originalOrderId = host.querySelector('.mock-selected-order dd')!.textContent!.trim();
    amount.value = '201.00';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('.mock-order-query button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector('.mock-selected-order dd')?.textContent?.trim()).not.toBe(originalOrderId);
    await router.push(`/admin/payments/mock?orderId=${originalOrderId}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector('.mock-selected-order dd')?.textContent?.trim()).toBe(originalOrderId);
  });

  it('renders recharge order evidence requirements without sample orders or manual settlement actions', async () => {
    await router.push('/admin/payments/orders');
    await nextTick();

    expect(host.querySelector('.payment-orders-page h1')?.textContent).toBe('充值订单');
    expect(host.textContent).not.toContain('充值订单 API 尚未接入');
    expect(host.querySelector('.order-service-notice')).toBeNull();
    expect(host.textContent).toContain('不能直接伪造“已支付”');
    expect(host.querySelectorAll('.order-query-grid :disabled')).toHaveLength(6);
    expect(host.querySelectorAll('.order-evidence-panel li')).toHaveLength(3);
    expect(host.querySelector('.order-table-wrap tbody')?.textContent).not.toMatch(/ORD-|订单号\s*\d|¥\s*\d/);
  });

  it('renders generic product management without sample products or direct fulfillment actions', async () => {
    await router.push('/admin/products');
    await nextTick();

    expect(host.querySelector('.product-management-page h1')?.textContent).toBe('商品管理');
    expect(host.textContent).toContain('不限定为金币商品');
    expect(host.textContent).toContain('已付款订单按创建时商品和履约快照处理');
    expect(host.querySelectorAll('.product-filter-grid :disabled')).toHaveLength(5);
    expect(host.querySelectorAll('.product-action-row button:disabled')).toHaveLength(3);
    expect(host.textContent).toContain('Admin 不提供手工“支付成功”或直接发资产入口');
    expect(host.textContent).not.toMatch(/商品\s*\d{2,}|¥\s*\d|金币\s*\d{3,}/);
  });

  it('renders Asset catalog, AI generation ledger, and release checks without exposing keys or fake files', async () => {
    await router.push('/admin/assets');
    await nextTick();
    expect(host.querySelector('.asset-management-page h1')?.textContent).toBe('Asset 目录');
    expect(host.querySelectorAll('.asset-query-grid :disabled')).toHaveLength(5);
    expect(host.textContent).toContain('逐块先验 MAC 再解密');
    expect(host.textContent).not.toMatch(/asset_id\s*\d|https?:\/\/|对象密钥\s*[:：]/);

    await router.push('/admin/ai-generation');
    await nextTick();
    expect(host.querySelector('.asset-management-page h1')?.textContent).toBe('AI 生成台账');
    expect(host.textContent).toContain('GPT-6 系列主模型代码');
    expect(host.textContent).toContain('浏览器永远没有 API Token');
    expect(host.querySelectorAll('.asset-action-row button:disabled')).toHaveLength(3);
    expect(host.textContent).not.toMatch(/sk-[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}/);

    await router.push('/admin/asset-releases');
    await nextTick();
    expect(host.querySelector('.asset-management-page h1')?.textContent).toBe('资源发布');
    expect(host.querySelectorAll('.asset-release-checks li')).toHaveLength(5);
    expect(host.textContent).toContain('Shell');
    expect(host.textContent).toContain('解密后的明文不写入 Cache Storage 或 IndexedDB');
    expect(host.querySelectorAll('.asset-action-row button:disabled')).toHaveLength(2);
    expect(host.textContent).not.toMatch(/release_[a-z0-9]+|manifest hash\s*[a-f0-9]{20,}/i);
  });

  it('renders system configuration, Admin permissions, immutable audit, jobs, and unknown health states', async () => {
    await router.push('/admin/system-config');
    await waitForConfigRows();
    expect(host.querySelectorAll('.system-config-row')).toHaveLength(9);
    expect(host.querySelector('.system-operations-page h1')?.textContent).toBe('系统配置');
    expect(host.textContent).toContain('需求参考值');
    expect(host.textContent).toContain('本机持久化草稿');
    expect(host.querySelectorAll('.system-config-row')).toHaveLength(9);
    expect(host.querySelector('.system-guidance-grid')).toBeNull();
    const configHelpTrigger = host.querySelector<HTMLButtonElement>('.system-operations-page .page-help-trigger')!;
    configHelpTrigger.click();
    await nextTick();
    expect(document.body.querySelector('.page-help-dialog')?.textContent).toContain('配置类型');
    expect(document.activeElement).toBe(document.body.querySelector('.page-help-close'));
    const helpDialog = document.body.querySelector<HTMLElement>('.page-help-dialog')!;
    helpDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(document.body.querySelector('.page-help-confirm'));
    helpDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(document.body.querySelector('.page-help-close'));
    document.body.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
    expect(document.body.querySelector('.page-help-dialog')).toBeNull();
    expect(document.activeElement).toBe(configHelpTrigger);

    await router.push('/admin/admin-users');
    await nextTick();
    await vi.waitFor(() => expect(host.querySelectorAll('.admin-permission-user').length).toBeGreaterThan(0));
    expect(host.querySelector('.system-operations-page h1')?.textContent).toBe('Admin 权限');
    expect(host.textContent).toContain('不创建独立 admin_user');
    expect(host.textContent).toContain('权限从登记目录选择');
    expect(host.querySelectorAll('.admin-permission-path-row')).toHaveLength(10);
    const operatorUser = [...host.querySelectorAll<HTMLButtonElement>('.admin-permission-user')].find((button) => button.textContent?.includes('运营演练管理员'))!;
    operatorUser.click();
    await nextTick();
    const permissionCheckbox = host.querySelector<HTMLInputElement>('.admin-permission-path-row input:not(:disabled)')!;
    permissionCheckbox.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.admin-permission-detail .system-primary-action')!.click();
    await nextTick();
    expect(document.body.querySelector('.admin-permission-confirm')).not.toBeNull();
    const permissionReason = document.body.querySelector<HTMLInputElement>('.admin-permission-confirm input')!;
    permissionReason.value = '测试权限变更闭环';
    permissionReason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('.admin-permission-confirm button[type="submit"]')!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('auth_version 更新为'));
    expect(host.querySelectorAll('.admin-permission-audit article').length).toBeGreaterThan(0);

    await router.push('/admin/audit');
    await nextTick();
    expect(host.querySelector('.system-operations-page h1')?.textContent).toBe('操作审计');
    await vi.waitFor(() => expect(host.querySelectorAll('.admin-audit-table tbody tr').length).toBeGreaterThan(0));
    expect(host.textContent).toContain('不编辑、删除或覆盖原始记录');
    expect(host.querySelectorAll('.active-audit-filters :disabled')).toHaveLength(0);
    host.querySelector<HTMLButtonElement>('.admin-audit-table tbody button')!.click();
    await nextTick();
    expect(document.body.querySelector('.admin-audit-detail')?.textContent).toContain('测试权限变更闭环');
    document.body.querySelector<HTMLButtonElement>('.admin-audit-detail .system-primary-action')!.click();
    await nextTick();

    await router.push('/admin/jobs');
    await nextTick();
    expect(host.querySelector('.system-operations-page h1')?.textContent).toBe('Worker / Outbox');
    expect(host.textContent).toContain('重试保持 event key 幂等');
    expect(host.textContent).toContain('不能推测队列正常或积压为零');

    await router.push('/admin/health');
    await nextTick();
    await vi.waitFor(() => expect(host.textContent).toContain('不可达'));
    expect(host.querySelector('.system-operations-page h1')?.textContent).toBe('服务健康');
    expect(host.querySelectorAll('.system-health-grid article')).toHaveLength(5);
    expect(host.querySelectorAll('.system-health-grid small')).toHaveLength(5);
    expect(host.textContent).toContain('当前 Health API 不提供此依赖的探测数据');
    expect(host.textContent).toContain('不会据此推断数据库或其他依赖状态');
    expect(host.textContent).not.toMatch(/健康\s*100%|在线\s*\d+|延迟\s*\d+ms/);
  });

  it('shows the shared liveness response and measured request latency without promoting it to dependency health', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      requestId: 'req-health-1', code: 'OK', message: 'ok',
      data: { status: 'live', service: 'gameing-hall-api' },
      serverNow: '2026-10-13T10:11:12.123Z',
    }), { status: 200 })));
    await router.push('/admin/health');
    await vi.waitFor(() => expect(host.textContent).toContain('存活'));
    expect(host.textContent).toContain('服务时间：');
    expect(host.textContent).toContain('请求耗时：');
    expect(host.textContent).toContain('MySQL');
    expect(host.textContent).toContain('未知');
  });

  it('keeps community, moderation, and support scopes separate and gates attachment decryption', async () => {
    await router.push('/admin/community/topics');
    await nextTick();
    expect(host.querySelector('.social-support-page h1')?.textContent).toBe('社区话题');
    expect(host.querySelectorAll('.social-support-tabs a')).toHaveLength(3);
    expect(host.querySelectorAll('.social-support-filter-grid :disabled')).toHaveLength(4);

    await router.push('/admin/community/moderation');
    await nextTick();
    await waitForModerationCases();
    expect(host.querySelector('.social-support-page h1')?.textContent).toBe('内容审核');
    expect(host.textContent).toContain('普通私聊与客服会话不出现在此队列');
    expect(host.textContent).toContain('封禁不在此执行');
    expect(host.querySelectorAll('.moderation-case-card')).toHaveLength(4);
    host.querySelector<HTMLButtonElement>('.moderation-case-card')!.click();
    await nextTick();
    const moderationReason = host.querySelector<HTMLTextAreaElement>('.moderation-decision-form textarea')!;
    moderationReason.value = '内容符合规范，完成复核后发布。';
    moderationReason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('.moderation-decision-form button[type="submit"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('.moderation-audit-history article')?.textContent).toContain('审核通过'));
    expect(host.querySelector('.moderation-audit-history article')?.textContent).toContain('完成复核后发布');

    await router.push('/admin/support/conversations');
    await nextTick();
    await waitForSupportQueue();
    expect(host.querySelector('.social-support-page h1')?.textContent).toBe('客服队列');
    expect(host.textContent).toContain('仅显示当前本机演练数据');
    expect(host.querySelectorAll('.support-queue-table tbody tr')).toHaveLength(3);
    expect(host.textContent).toContain('后台不得直接重置用户 TOTP');

    await router.push('/admin/support/conversations/93001');
    await nextTick();
    await waitForSupportDetail();
    expect(host.querySelector('.social-support-page h1')?.textContent).toBe('客服会话');
    host.querySelector<HTMLButtonElement>('.social-support-heading .page-help-trigger')!.click();
    await nextTick();
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('不因 URL 中的 ID 推断存在或授权');
    expect(document.querySelector('.page-help-dialog')?.textContent).toContain('每次附件查看都需检查客服权限');
    document.querySelector<HTMLButtonElement>('.page-help-close')!.click();
    await nextTick();
    expect(host.textContent).toContain('附件上传、授权解密和逐次审计尚未接入');
    expect(host.querySelector('.support-reply-box button:disabled')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.support-conversation-actions button')!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('当前客服负责'));
    const reply = host.querySelector<HTMLTextAreaElement>('#support-reply')!;
    reply.value = '请从账号入口使用恢复凭证，不要发送验证码。';
    reply.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('.support-reply-box button[type="submit"]')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.support-message-list .support-message')).toHaveLength(2));
    expect(host.textContent).toContain('等待用户');
    expect(host.textContent).not.toMatch(/手机号\s*1\d{10}|解密密钥\s*[:：]/);
  });

  it('renders withdrawal policy and review stages without fabricated requests or enabled decisions', async () => {
    await router.push('/admin/withdrawals');
    await nextTick();

    expect(host.querySelector('.withdrawal-review-page h1')?.textContent).toBe('提现审核');
    expect(host.textContent).toContain('暂无提现申请');
    expect(host.textContent).toContain('客损模式');
    expect(host.textContent).toContain('申请满 72 小时后');
    expect(host.querySelectorAll('.withdrawal-query-grid :disabled')).toHaveLength(5);
    expect(host.querySelectorAll('.withdrawal-process-panel li')).toHaveLength(4);
    expect(host.querySelector('.withdrawal-table-wrap tbody')?.textContent).not.toMatch(/¥\s*\d|测试用户|收款账号/);
  });

  it('renders TRON matching rules without fake chain events or private key controls', async () => {
    await router.push('/admin/chain-deposits');
    await nextTick();

    expect(host.querySelector('.chain-deposits-page h1')?.textContent).toBe('链上充值监控');
    expect(host.textContent).toContain('订单绑定唯一收款地址');
    expect(host.textContent).toContain('14.910 → 14.911 → 14.912 USDT');
    expect(host.querySelectorAll('.chain-filter-grid :disabled')).toHaveLength(6);
    expect(host.querySelectorAll('.chain-matching-panel li')).toHaveLength(4);
    expect(host.querySelector('.chain-events-table-wrap tbody')?.textContent).not.toMatch(/T[A-Za-z0-9]{33}|0x[a-fA-F0-9]{40}|txHash/);
    expect(host.textContent).toContain('不得显示或读取转账私钥');
  });

  it('renders external settlement handler rules without fake accounting facts or mutable history', async () => {
    await router.push('/admin/payments/settlements');
    await nextTick();

    expect(host.querySelector('.external-settlements-page h1')?.textContent).toBe('通道结算流水');
    expect(host.textContent).toContain('暂无外部结算流水');
    expect(host.querySelectorAll('.settlement-query-grid :disabled')).toHaveLength(6);
    expect(host.querySelectorAll('.settlement-flow-grid article')).toHaveLength(4);
    expect(host.textContent).toContain('不增加 REFUND flow type');
    expect(host.textContent).toContain('增加手续费时 fee 为正、net 为负');
    expect(host.querySelector('.settlement-table-wrap tbody')?.textContent).not.toMatch(/测试结算|Mock-Settlement|¥\s*\d/);
  });

  it('renders reconciliation evidence layers and keeps case actions unavailable without the API', async () => {
    await router.push('/admin/reconciliation');
    await nextTick();

    expect(host.querySelector('.reconciliation-page h1')?.textContent).toBe('对账异常');
    expect(host.textContent).toContain('暂无对账异常');
    expect(host.querySelectorAll('.reconciliation-filter-grid :disabled')).toHaveLength(5);
    expect(host.querySelectorAll('.reconciliation-workflow-panel li')).toHaveLength(4);
    expect(host.textContent).toContain('payment_event');
    expect(host.textContent).toContain('external_settlement');
    expect(host.textContent).toContain('asset_operation / asset_entry');
    expect(host.textContent).toContain('不可覆盖');
  });

  it('closes the local event rule → instance → safe announcement preview workflow', async () => {
    await router.push('/admin/events/rules');
    await nextTick();
    expect(host.querySelector('.event-operations-page h1')?.textContent).toBe('事件规则');
    expect(host.querySelectorAll('.event-section-tabs a')).toHaveLength(4);
    expect(host.textContent).toContain('本机闭环仅产生广播预览');
    expect(host.querySelectorAll('.event-filter-grid :disabled')).toHaveLength(0);
    await vi.waitFor(() => expect(host.querySelector('.event-empty-state:not([role="status"])')?.textContent).toContain('还没有事件规则'));
    expect(host.textContent).not.toMatch(/活动实例\s*\d|奖池余额\s*[¥￥]?\s*\d/);
    expect(host.querySelector('.event-guidance-grid')).toBeNull();
    host.querySelector<HTMLButtonElement>('.event-operations-page .page-help-trigger')!.click();
    await nextTick();
    expect(document.body.querySelector('.page-help-dialog')?.textContent).toContain('纯播报必须明确标记');
    document.body.querySelector<HTMLButtonElement>('.page-help-confirm')!.click();
    await nextTick();
    expect(document.body.querySelector('.page-help-dialog')).toBeNull();

    host.querySelector<HTMLButtonElement>('.event-empty-state button')!.click();
    await nextTick();
    expect(document.querySelector('.event-local-dialog')?.textContent).toContain('新建事件规则');
    const ruleForm = document.querySelector('.event-local-dialog .event-template-form')!;
    await chooseAdminOption(ruleForm, 'label:nth-of-type(7) .el-select', '保存并启用本机规则');
    const ruleInputs = ruleForm.querySelectorAll<HTMLInputElement>('input:not([role="combobox"])');
    ruleInputs[ruleInputs.length - 1]!.value = '前端事件闭环测试';
    ruleInputs[ruleInputs.length - 1]!.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.event-local-dialog .event-dialog-actions button:last-child')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.event-rule-card')).toHaveLength(1));
    expect(host.textContent).toContain('仅广播');
    expect(host.textContent).toContain('运行中');

    const triggerRuleButton = host.querySelector<HTMLButtonElement>('.event-rule-card-actions button:last-child')!;
    expect(triggerRuleButton.disabled).toBe(false);
    triggerRuleButton.click();
    await vi.waitFor(() => expect(document.querySelector('.event-local-dialog')).not.toBeNull());
    const triggerForm = document.querySelector('.event-local-dialog .event-template-form')!;
    await chooseAdminOption(triggerForm, 'label:nth-of-type(3) .el-select', 'USER');
    await chooseAdminOption(triggerForm, 'label:nth-of-type(4) .el-select', '陈先生');
    const triggerInputs = triggerForm.querySelectorAll<HTMLInputElement>('input:not([role="combobox"])');
    triggerInputs[0]!.value = '500';
    triggerInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    triggerInputs[1]!.checked = true;
    triggerInputs[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    const triggerReason = triggerInputs[triggerInputs.length - 1]!;
    triggerReason.value = '端到端本地触发验证';
    triggerReason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.event-local-dialog .event-dialog-actions button:last-child')!.click();
    await vi.waitFor(() => expect(document.querySelector('.event-local-dialog') === null || host.querySelector('[role="alert"]') !== null).toBe(true));
    expect(host.querySelector('[role="alert"]')?.textContent).toBeUndefined();
    await vi.waitFor(() => expect(host.querySelector('.event-operations-page h1')?.textContent).toBe('活动实例'));
    await vi.waitFor(() => expect(host.querySelectorAll('.event-instance-card')).toHaveLength(1));
    expect(host.textContent).toContain('LOCAL_DEMO');
    host.querySelector<HTMLButtonElement>('.event-instance-actions button:first-child')!.click();
    await vi.waitFor(() => expect(document.querySelector('.event-local-dialog')).not.toBeNull());
    const deliveryReason = document.querySelector<HTMLInputElement>('.event-local-dialog .event-template-form input[placeholder="至少 3 个字"]')!;
    deliveryReason.value = '检查本地安全文案';
    deliveryReason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.event-local-dialog .event-dialog-actions button:last-child')!.click();
    await vi.waitFor(() => expect(host.querySelector('.event-operations-page h1')?.textContent).toBe('广播投递'));
    await vi.waitFor(() => expect(host.querySelectorAll('.event-delivery-card')).toHaveLength(1));
    expect(host.textContent).toContain('PREVIEW_ONLY');
    expect(host.textContent).toContain('不含活动概率或真实派奖');

    await router.push('/admin/events/instances');
    await nextTick();
    expect(host.querySelector('.event-operations-page h1')?.textContent).toBe('活动实例');
    await vi.waitFor(() => expect(host.querySelectorAll('.event-instance-card')).toHaveLength(1));

    await router.push('/admin/announcements');
    await nextTick();
    expect(host.querySelector('.event-operations-page h1')?.textContent).toBe('公告模板');
    expect(host.textContent).toContain('不执行 HTML 或脚本');
    await vi.waitFor(() => expect(host.querySelector('.event-empty-state[role="status"]')).toBeNull());
    host.querySelector<HTMLButtonElement>('.event-query-panel > .event-panel-heading > button')!.click();
    await nextTick();
    expect(host.textContent).toContain('不对玩家发布');
    const templateInputs = host.querySelectorAll<HTMLInputElement>('.event-template-form input:not([role="combobox"])');
    const titleInput = templateInputs[0]!;
    titleInput.value = '{{actorLabel}}在{{gameName}}完成挑战';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    const templateMessage = host.querySelector<HTMLTextAreaElement>('.event-template-form textarea')!;
    templateMessage.value = '{{difficultyName}}的效果已开启';
    templateMessage.dispatchEvent(new Event('input', { bubbles: true }));
    templateInputs[1]!.value = '调整活动文案。';
    templateInputs[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(host.querySelector('.event-template-preview')?.textContent).toContain('陈先生在跳高高完成挑战');
    host.querySelector<HTMLButtonElement>('.event-template-save')!.click();
    await vi.waitFor(() => expect(host.querySelector('.event-template-feedback.success')?.textContent).toContain('尚未发布或投递'));
    expect(host.querySelectorAll('.event-template-history article')).toHaveLength(1);
    await router.push('/admin/events/rules');
    await vi.waitFor(() => expect(host.querySelectorAll('.event-rule-card')).toHaveLength(1));
    await router.push('/admin/announcements');
    await nextTick();
    await vi.waitFor(() => expect(host.querySelectorAll('.event-template-card').length).toBeGreaterThan(0));

    await router.push('/admin/announcements/delivery');
    await nextTick();
    expect(host.querySelector('.event-operations-page h1')?.textContent).toBe('广播投递');
    await vi.waitFor(() => expect(host.querySelectorAll('.event-delivery-card')).toHaveLength(1));
  });

  it('renders the local game catalog separately from game configuration and keeps publication server-owned', async () => {
    await router.push('/admin/games');
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await nextTick();

    expect(host.querySelector('.game-catalog-page h1')?.textContent).toBe('游戏目录');
    expect(host.textContent).toContain('LOCAL_DEMO 游戏目录');
    expect(host.textContent).toContain('本机 IndexedDB 演练');
    expect(host.querySelector('.game-catalog-filters button[type="submit"]')).not.toBeNull();
  });

  it('gates unknown game models and runs the Shisanshui math preview through shared DTOs', async () => {
    await router.push('/admin/games/slot5/difficulties/easy/config');
    await nextTick();
    expect(host.querySelector('.game-config-operations-page h1')?.textContent).toBe('游戏 / 难度配置');
    expect(host.textContent).toContain('数学模型尚未登记');
    expect(host.querySelector('.game-config-service-banner')).toBeNull();
    expect(host.querySelector('.game-config-heading .page-help-trigger')).not.toBeNull();
    expect(host.querySelector('.model-not-ready a')).not.toBeNull();
    expect(host.textContent).not.toMatch(/RTP\s*\d|赔率\s*\d|配置版本\s*\d/);

    await router.push('/admin/games/slot5/difficulties/easy/expectation');
    await nextTick();
    expect(host.querySelector('.game-config-operations-page h1')?.textContent).toBe('期望计算器');
    expect(host.textContent).toContain('数学模型尚未登记');
    expect(host.querySelector('.simulation-control-grid')).toBeNull();
    expect(host.textContent).not.toMatch(/模拟实际 RTP\s*\d|轮空率\s*\d|大奖率\s*\d/);

    await router.push('/admin/games/shisanshui/difficulties/bronze/expectation');
    await nextTick();
    expect(host.textContent).toContain('rank_sorted_partition_v1');
    const simulateButton = host.querySelector<HTMLButtonElement>('.simulation-control-grid button');
    expect(simulateButton?.disabled).toBe(false);
    simulateButton?.click();
    await vi.waitFor(() => expect(host.textContent).toContain('局完成。结果仅对当前策略'));
    expect(host.querySelector('.simulation-metric-grid article')?.textContent).toContain('策略胜率');
    expect(host.textContent).toContain('Wilson 区间');
    expect(host.querySelectorAll('.simulation-distribution-row').length).toBeGreaterThan(0);
  });

  it('runs the user query page against clearly labeled local demo summaries', async () => {
    await router.push('/admin/users');
    await vi.waitFor(() => expect(host.querySelectorAll('.user-table-wrap tbody tr')).toHaveLength(5));

    expect(host.querySelector('.user-list-page h1')?.textContent).toBe('用户列表');
    expect(host.textContent).toContain('本机演练数据');
    expect(host.querySelectorAll('.user-filter-field input:disabled')).toHaveLength(0);
    expect(host.querySelectorAll('.user-filter-field .el-select__wrapper.is-disabled')).toHaveLength(0);
    expect(host.querySelector('.user-table-wrap tbody')?.textContent).toContain('LOCAL_DEMO');
    expect(host.querySelector('.user-table-wrap tbody')?.textContent).toContain('91001');
    await chooseAdminOption(host, '.user-filter-field:nth-child(3) .el-select', '玩家 / 代理');
    host.querySelector<HTMLButtonElement>('.user-search-button')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.user-table-wrap tbody tr')).toHaveLength(2));
    expect(host.querySelector('.user-table-wrap tbody')?.textContent).toContain('演练代理');
  });

  it('loads user detail sections independently and rejects unknown route IDs', async () => {
    await router.push('/admin/users/91001');
    await vi.waitFor(() => expect(host.querySelector('.user-detail-sections')).not.toBeNull());

    expect(host.querySelector('.user-detail-heading h1')?.textContent).toBe('用户详情');
    expect(host.querySelector<HTMLAnchorElement>('.sidebar .nav-link[href="/admin/users"]')?.classList.contains('active')).toBe(true);
    expect(host.querySelector('.unverified-user-id')?.textContent).toContain('91001');
    expect(host.textContent).not.toContain('用户详情 API 尚未接入');
    expect(host.querySelectorAll('.user-detail-sections button')).toHaveLength(6);
    expect(host.textContent).toContain('LOCAL_DEMO');
    host.querySelector<HTMLButtonElement>('.user-detail-sections button:nth-child(4)')!.click();
    await vi.waitFor(() => expect(host.textContent).toContain('12650'));
    expect(host.querySelector('.user-detail-table-wrap tbody')?.textContent).toContain('12650');
    await router.push('/admin/users/918273645012345678');
    await vi.waitFor(() => expect(host.querySelector('.user-detail-empty')?.textContent).toContain('演练目录中没有此用户'));
  });

  it('renders the local agent-domain review workflow without fabricated production records', async () => {
    await router.push('/admin/agent-domains');
    await nextTick();
    await waitForAgentDomainPreview();

    expect(host.querySelector('.agent-domain-page h1')?.textContent).toBe('代理域');
    expect(host.textContent).toContain('本机审核演练');
    expect(host.textContent).toContain('暂无本机演练记录');
    expect(host.querySelector<HTMLButtonElement>('.agent-domain-demo-button')?.disabled).toBe(false);
    expect(host.textContent).toContain('密码、TOTP 秘钥、恢复码和设备认证秘密永不开放给代理');
    expect(host.querySelector('.agent-domain-empty')?.textContent).not.toMatch(/示例代理|测试代理|10001/);
  });

  it('renders the asset ledger semantics without sample balances or editable postings', async () => {
    await router.push('/admin/assets/operations');
    await nextTick();

    expect(host.querySelector('.asset-operations-page h1')?.textContent).toBe('资产操作');
    expect(host.textContent).not.toContain('账本 API 尚未接入');
    expect(host.querySelector('.asset-ledger-banner')).toBeNull();
    expect(host.textContent).toContain('冻结是占用/hold 状态');
    expect(host.querySelectorAll('.asset-filter-grid :disabled')).toHaveLength(6);
    expect(host.querySelector('.asset-empty-state')?.textContent).not.toMatch(/可用余额\s*[0-9]|冻结金额\s*[0-9]|账户余额\s*[0-9]/);
    expect(host.querySelector('.asset-operation-results table')).toBeNull();
  });

  it('renders room, round, and referral workspaces from their SDD with safe empty states', async () => {
    await router.push('/admin/rooms');
    await vi.waitFor(() => expect(host.querySelectorAll('.ops-monitor-table-wrap tbody tr')).toHaveLength(2));
    expect(host.querySelector('.ops-monitor-heading h1')?.textContent).toBe('房间观察');
    expect(host.textContent).toContain('LOCAL_DEMO');
    expect(host.querySelectorAll('.ops-monitor-filters :disabled')).toHaveLength(0);
    await chooseAdminOption(host, '.ops-monitor-filters label:nth-child(4) .el-select', '进行中');
    host.querySelector<HTMLButtonElement>('.ops-monitor-filters button[type="submit"]')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.ops-monitor-table-wrap tbody tr')).toHaveLength(2));
    expect(host.textContent).toContain('DEMO-13-001');
    host.querySelector<HTMLButtonElement>('.ops-monitor-table-wrap tbody tr button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ops-monitor-detail')?.textContent ?? '').toContain('成员与座位'));
    expect(host.querySelector('.ops-monitor-detail')?.textContent).toContain('断线');
    host.querySelector<HTMLButtonElement>('.ops-monitor-detail .ops-monitor-modal-close')!.click();

    host.querySelector<HTMLButtonElement>('.ops-monitor-guide-trigger')?.click();
    await nextTick();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Redis');
    host.querySelector<HTMLButtonElement>('.ops-monitor-modal-close')?.click();
    await nextTick();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.ops-monitor-guide-trigger'));

    await router.push('/admin/rounds');
    await vi.waitFor(() => expect(host.querySelectorAll('.ops-monitor-table-wrap tbody tr')).toHaveLength(2));
    expect(host.querySelector('.ops-monitor-heading h1')?.textContent).toBe('战绩 / 回放');
    expect(host.querySelectorAll('.ops-monitor-filters :disabled')).toHaveLength(0);
    host.querySelector<HTMLButtonElement>('.ops-monitor-pagination button')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.ops-monitor-table-wrap tbody tr')).toHaveLength(3));
    host.querySelector<HTMLButtonElement>('.ops-monitor-table-wrap tbody tr button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ops-monitor-detail')?.textContent ?? '').toContain('handler 原始 JSON'));
    expect(host.querySelector('.ops-monitor-detail')?.textContent).toContain('asset_operation 83001');
    host.querySelector<HTMLButtonElement>('.ops-monitor-detail .ops-monitor-modal-close')!.click();
    host.querySelector<HTMLButtonElement>('.ops-monitor-guide-trigger')?.click();
    await nextTick();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('未知 handler 版本');
    host.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(host.querySelector('[role="dialog"]')).toBeNull();

    await router.push('/admin/referrals');
    await nextTick();
    expect(host.querySelector('.ops-monitor-heading h1')?.textContent).toBe('邀请关系');
    await vi.waitFor(() => expect(host.querySelectorAll('.ops-monitor-table-wrap tbody tr')).toHaveLength(10));
    expect(host.textContent).toContain('LOCAL_DEMO');
    expect(host.textContent).toContain('演练用户·目标');
    host.querySelector<HTMLButtonElement>('.ops-monitor-table-wrap tbody tr button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ops-monitor-detail')?.textContent).toContain('历史返点分配（不可变）'));
    const newParent = host.querySelector<HTMLInputElement>('.ops-referral-rebind input')!;
    newParent.value = '94100'; newParent.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    host.querySelector<HTMLButtonElement>('.ops-referral-rebind button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ops-referral-preview')?.textContent).toContain('4 个关系行受影响'));
    const reason = host.querySelector<HTMLTextAreaElement>('.ops-referral-preview textarea')!;
    reason.value = '审核身份后进行换绑演练'; reason.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    const totp = host.querySelector<HTMLInputElement>('.ops-referral-preview input')!;
    totp.value = '000000'; totp.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    host.querySelector<HTMLButtonElement>('.ops-referral-preview > button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ops-monitor-detail .user-query-error')?.textContent).toContain('TOTP 不正确'));
    totp.value = '246810'; totp.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    host.querySelector<HTMLButtonElement>('.ops-referral-preview > button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ops-monitor-detail')?.textContent).toContain('审核身份后进行换绑演练'));
    expect(host.querySelector('.ops-monitor-detail')?.textContent).toContain('94002 → 94100');
    expect(host.querySelector('.ops-monitor-detail')?.textContent).toContain('1200 分 · 已发放');
    await vi.waitFor(() => expect(host.querySelector('.ops-referral-tasks')?.textContent).toContain('待处理'));
    host.querySelector<HTMLButtonElement>('.ops-referral-tasks button')!.click();
    await vi.waitFor(() => expect(host.querySelector('.ops-referral-tasks')?.textContent).toContain('已完成'));
    host.querySelector<HTMLButtonElement>('.ops-monitor-guide-trigger')?.click();
    await nextTick();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('parent_1_user_id 至 parent_4_user_id');
  });

  it('rejects malformed user IDs locally without exposing or sending them', async () => {
    await router.push('/admin/users/0');
    await nextTick();

    expect(host.textContent).toContain('用户 ID 格式无效');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('不超过 BIGINT UNSIGNED 最大值');
    expect(host.querySelector('.user-detail-sections')).toBeNull();
  });

  it('opens the mobile navigation with an announced expanded state', async () => {
    const menu = host.querySelector<HTMLButtonElement>('.mobile-header button');
    expect(menu?.getAttribute('aria-expanded')).toBe('false');
    menu?.click();
    await nextTick();

    expect(menu?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.sidebar')?.classList.contains('sidebar-open')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).toBe(host.querySelector('.sidebar .nav-link'));

    host.querySelector('.admin-app')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(menu?.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.style.overflow).toBe('');
  });
});
