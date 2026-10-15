import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, shallowRef } from 'vue';
import App from './App.vue';

const mocks = vi.hoisted(() => ({
  mountLocalGame: vi.fn(),
  getHealth: vi.fn().mockResolvedValue({}),
  getActivePlatformAnnouncements: vi.fn().mockResolvedValue([]),
  getPlatformAnnouncement: vi.fn(),
}));

vi.mock('@gameing/shisanshui-client', () => ({ mountLocalGame: mocks.mountLocalGame }));
vi.mock('./platform/health-api', () => ({ getHealth: mocks.getHealth }));
vi.mock('./platform/announcements-api', () => ({
  getActivePlatformAnnouncements: mocks.getActivePlatformAnnouncements,
  getPlatformAnnouncement: mocks.getPlatformAnnouncement,
}));

describe('H5 to Pixi game entry', () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp> | undefined;

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    localStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    mocks.mountLocalGame.mockImplementation(async (target: HTMLElement) => {
      if (!target.isConnected) throw new Error('game host is not mounted');
      target.dataset.gameMounted = 'true';
      return { dispose: vi.fn().mockResolvedValue(undefined) };
    });
  });

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host.remove();
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('waits until the practice page enters before mounting the Pixi game', async () => {
    app = createApp(App);
    app.mount(host);

    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    host.querySelector<HTMLButtonElement>('.subhall-shell .tier-card')!.click();
    await waitFor(() => host.querySelector('.room-flow-panel') !== null);
    host.querySelector<HTMLButtonElement>('.room-flow-practice')!.click();

    await waitFor(() => mocks.mountLocalGame.mock.calls.length === 1);
    expect(mocks.mountLocalGame.mock.calls[0]?.[0].isConnected).toBe(true);
    expect(host.querySelector('[data-game-mounted="true"]')).not.toBeNull();
  });

  it('returns to the mobile lobby after launching from an inline tier instead of opening the desktop subhall', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: '(min-width: 721px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);
    let exitGame: (() => void) | undefined;
    mocks.mountLocalGame.mockImplementationOnce(async (target: HTMLElement, options: unknown) => {
      if (!target.isConnected) throw new Error('game host is not mounted');
      target.dataset.gameMounted = 'true';
      exitGame = (options as { onExit: () => void }).onExit;
      return { dispose: vi.fn().mockResolvedValue(undefined) };
    });
    app = createApp(App);
    app.mount(host);

    host.querySelector<HTMLButtonElement>('.mobile-tier-option')!.click();
    await waitFor(() => host.querySelector('.practice-shell [data-game-mounted="true"]') !== null);
    exitGame!();
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);

    expect(host.querySelector('.subhall-shell')).toBeNull();
    expect(host.querySelector('.mobile-dock')).not.toBeNull();
    expect(host.querySelector('.mobile-tier-option')).not.toBeNull();
  });

  it('runs quick match, ready, start and return through the offline room flow', async () => {
    localStorage.setItem('gameing-hall.clientPreferences.v1', JSON.stringify({ soundEnabled: false, lowDataMode: false }));
    let exitGame: (() => void) | undefined;
    mocks.mountLocalGame.mockImplementationOnce(async (target: HTMLElement, options: unknown) => {
      if (!target.isConnected) throw new Error('game host is not mounted');
      target.dataset.gameMounted = 'true';
      exitGame = (options as { onExit: () => void }).onExit;
      return { dispose: vi.fn().mockResolvedValue(undefined) };
    });
    app = createApp(App);
    app.mount(host);
    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    expect(window.location.pathname).toBe('/games/shisanshui');
    host.querySelector<HTMLButtonElement>('.subhall-shell .tier-card')!.click();
    await waitFor(() => host.querySelector('.room-flow-panel') !== null);
    host.querySelector<HTMLButtonElement>('.room-flow-actions button:first-child')!.click();
    await waitFor(() => host.querySelectorAll('.room-flow-seats li.occupied').length === 4);
    const start = host.querySelector<HTMLButtonElement>('.room-flow-primary')!;
    expect(start.disabled).toBe(true);
    host.querySelector<HTMLButtonElement>('.room-flow-room-actions button:nth-child(2)')!.click();
    await waitFor(() => host.querySelector<HTMLButtonElement>('.room-flow-primary')?.disabled === false);
    host.querySelector<HTMLButtonElement>('.room-flow-primary')!.click();
    await waitFor(() => host.querySelector('.practice-shell [data-game-mounted="true"]') !== null);
    expect(mocks.mountLocalGame.mock.calls[0]?.[1]).toMatchObject({
      tierName: '新手练习',
      soundEnabled: false,
      roomCode: expect.stringMatching(/^LG\d{4}$/),
      opponentNames: ['练习机器人 2', '练习机器人 3', '练习机器人 4'],
    });
    expect(host.querySelector('.room-flow-panel')).toBeNull();
    exitGame!();
    await waitFor(() => host.querySelector('.subhall-shell') !== null);
  });

  it('returns direct links to unfinished matchmaking pages to the game hall', async () => {
    window.history.replaceState({}, '', '/games/shisanshui/rooms/preview');
    app = createApp(App);
    app.mount(host);

    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    expect(window.location.pathname).toBe('/games/shisanshui');
  });

  it('exposes settings and support from the lobby instead of hiding those planned actions', async () => {
    app = createApp(App);
    app.mount(host);

    expect(host.querySelector('.topbar .header-action')?.textContent).toContain('钱包');
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(5)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel') !== null);
    expect(host.querySelector('.lobby-panel h2')?.textContent).toBe('客服');
    expect(host.querySelector('.lobby-panel')?.textContent).toContain('登录后联系在线客服');
    expect(host.querySelector('.player-support-status')).toBeNull();

    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(6)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    const soundToggle = host.querySelector<HTMLInputElement>('.setting-row input')!;
    expect(host.querySelector('.setting-row')?.textContent).not.toContain('尚无音频资源');
    soundToggle.checked = false;
    soundToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => localStorage.getItem('gameing-hall.clientPreferences.v1') !== null);
    expect(JSON.parse(localStorage.getItem('gameing-hall.clientPreferences.v1') ?? '{}')).toMatchObject({ soundEnabled: false });
  });

  it('renders distinct player wallet, history, invitation, social, notification, and profile workspaces', async () => {
    app = createApp(App);
    app.mount(host);

    host.querySelector<HTMLButtonElement>('.topbar .header-action')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '钱包');
    expect(host.querySelectorAll('.player-wallet-assets article')).toHaveLength(2);
    expect(host.querySelector('.player-wallet-actions')).toBeNull();
    expect(host.querySelector('.player-wallet-assets')?.textContent).toContain('登录后查看');
    expect(host.querySelector('.player-wallet-assets')?.textContent).not.toMatch(/\d{2,}/);

    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(2)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '战绩');
    expect(host.querySelector('.player-panel-empty')?.textContent).toContain('登录后查看战绩');

    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '邀请与代理');
    expect(host.querySelector('.player-invite-workspace')?.textContent).toContain('登录后管理邀请与代理申请');

    host.querySelector<HTMLButtonElement>('.mobile-dock button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '社区与私信');
    expect(host.querySelectorAll('.player-social-tabs [role="tab"]')).toHaveLength(3);
    expect(host.querySelector('.player-social-composer')).toBeNull();
    expect(host.querySelector('.player-panel-empty')?.textContent).toContain('登录后参与话题');
    expect(host.querySelector('.social-composer')).toBeNull();
    const topicsTab = host.querySelector<HTMLButtonElement>('#social-tab-topics')!;
    topicsTab.focus();
    topicsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => host.querySelector('#social-panel-friends') !== null);
    expect(document.activeElement).toBe(host.querySelector('#social-tab-friends'));
    expect(host.querySelector('#social-panel-friends')?.textContent).toContain('登录后查看好友');
    host.querySelector<HTMLButtonElement>('#social-tab-messages')!.click();
    await waitFor(() => host.querySelector('#social-panel-messages') !== null);
    expect(host.querySelector('#social-panel-messages')?.textContent).toContain('登录后查看私信');
    host.querySelector<HTMLButtonElement>('#social-tab-topics')!.click();
    await waitFor(() => host.querySelector('#social-panel-topics') !== null);

    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    host.querySelector<HTMLButtonElement>('.mobile-dock button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '个人资料');
    host.querySelector<HTMLButtonElement>('.profile-shortcuts button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '消息');
    expect(host.querySelector('.player-message-categories')).toBeNull();
    expect(host.querySelector('.player-panel-empty')?.textContent).toContain('登录后查看消息');

    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    host.querySelector<HTMLButtonElement>('.mobile-dock button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '个人资料');
    expect(host.querySelector('.player-profile-card')?.textContent).toContain('游客');
    expect(host.querySelector('.player-profile-fields')?.textContent).toContain('登录后查看');
    expect(host.querySelector('.player-profile-card')?.textContent).not.toMatch(/陈先生|测试用户|\d{5,}/);
  });

  it('hides the community entry for a signed-in player whose direct parent uses customer-loss rewards', async () => {
    const session = shallowRef({
      accessToken: 'local-test-token', tokenType: 'Bearer' as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { userId: '51', displayName: '本地测试玩家', roleType: 1 }, device: { deviceId: '52', trusted: true },
    });
    let enabled = true;
    const checkSocialAccess = vi.fn(async () => ({ enabled }));
    app = createApp(App, { identitySessionState: session, checkSocialAccess });
    app.mount(host);

    await waitFor(() => [...host.querySelectorAll('.lobby-actions button')].some((button) => button.textContent?.includes('社区')));
    enabled = false;
    [...host.querySelectorAll<HTMLButtonElement>('.lobby-actions button')].find((button) => button.textContent?.includes('社区'))!.click();
    await waitFor(() => ![...host.querySelectorAll('nav button')].some((button) => button.textContent?.includes('社区')));
    expect(host.querySelector('.lobby-panel')).toBeNull();
    expect(checkSocialAccess).toHaveBeenCalledTimes(2);
    expect([...host.querySelectorAll('.lobby-actions button')].some((button) => button.textContent?.includes('社区'))).toBe(false);
    expect([...host.querySelectorAll('.mobile-dock button')].some((button) => button.textContent?.includes('社区'))).toBe(false);
  });

  it('logs out from the profile workspace and returns the entry control to its signed-out state', async () => {
    const session = shallowRef({
      accessToken: 'local-test-token', tokenType: 'Bearer' as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { userId: '41', displayName: '本地测试玩家', roleType: 1 }, device: { deviceId: '42', trusted: true },
    });
    const logout = vi.fn(async () => {
      session.value = undefined as never;
      return { ok: true as const, value: undefined };
    });
    app = createApp(App, {
      identitySessionState: session,
      playerEntryApplication: { logout } as never,
    });
    app.mount(host);

    host.querySelector<HTMLButtonElement>('[aria-label="个人菜单"]')!.click();
    await waitFor(() => host.querySelector('.player-profile-card') !== null);
    expect(host.querySelector('.player-profile-card')?.textContent).toContain('本地测试玩家');
    Array.from(host.querySelectorAll<HTMLButtonElement>('.lobby-panel button')).find((button) => button.textContent === '退出当前账号')!.click();
    await waitFor(() => logout.mock.calls.length === 1);
    await waitFor(() => host.querySelector('.lobby-panel') === null);

    expect(logout).toHaveBeenCalledTimes(1);
    expect(session.value).toBeUndefined();
    expect(host.querySelector('.player-entry-trigger')?.textContent).toBe('登录 / 恢复');
  });

  it('provides a three-mode player entry screen without exposing implementation status', async () => {
    app = createApp(App);
    app.mount(host);
    host.querySelector<HTMLButtonElement>('.mobile-dock button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '个人资料');
    host.querySelector<HTMLButtonElement>('.player-profile-card ~ .profile-shortcuts + .panel-primary')?.click();
    await waitFor(() => host.querySelector('.player-entry-page') !== null);
    expect(window.location.pathname).toBe('/entry');

    expect(host.querySelectorAll('.player-entry-modes [role="tab"]')).toHaveLength(3);
    expect(host.querySelector('.player-entry-content h2')?.textContent).toBe('在这台设备继续');
    expect(host.querySelector('.player-entry-device')?.textContent).toContain('当前浏览器');
    expect(host.querySelector('.player-entry-page')?.textContent).not.toMatch(/服务未接入|等待身份服务|本地预览/);
    expect(host.querySelector('.player-entry-content .panel-primary')?.hasAttribute('disabled')).toBe(false);

    const deviceTab = host.querySelector<HTMLButtonElement>('#entry-mode-device')!;
    deviceTab.focus();
    deviceTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => host.querySelector('.player-entry-content h2')?.textContent === '使用账号凭证');
    expect(document.activeElement).toBe(host.querySelector('#entry-mode-password'));
    host.querySelector<HTMLButtonElement>('#entry-mode-password')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await waitFor(() => host.querySelector('.player-entry-content h2')?.textContent === '在这台设备继续');

    host.querySelector<HTMLButtonElement>('.player-entry-modes button:nth-child(2)')!.click();
    await waitFor(() => host.querySelector('.player-entry-content h2')?.textContent === '使用账号凭证');
    expect(host.querySelectorAll<HTMLInputElement>('.player-entry-content input:disabled')).toHaveLength(0);
    expect(host.querySelector('.player-entry-content button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
    const identifier = host.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
    const password = host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
    identifier.value = 'player@example.test';
    identifier.dispatchEvent(new Event('input', { bubbles: true }));
    password.value = 'local-only-secret';
    password.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('.player-entry-content button[type="submit"]')!.click();
    await waitFor(() => host.querySelector('.player-entry-error') !== null);
    expect(host.querySelector('.player-entry-error')?.textContent).toContain('该账号凭证暂时无法用于登录');
    expect(password.value).toBe('');

    host.querySelector<HTMLButtonElement>('.player-entry-modes button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.player-entry-content h2')?.textContent === '使用恢复凭证');
    expect(host.querySelector('.player-entry-qr-picker')?.textContent).toContain('图片只在本机读取');
    expect(host.querySelector('.player-entry-content')?.textContent).toContain('恢复码文本');
    expect(host.querySelectorAll<HTMLInputElement>('.player-entry-content input:disabled')).toHaveLength(0);
    expect(host.querySelector('.player-entry-content')?.textContent).not.toMatch(/演示二维码|凭证尚未加载|身份服务/);
    expect(Array.from(host.querySelectorAll('.player-entry-content label')).some((label) => label.textContent?.includes('当前 TOTP'))).toBe(false);
    expect(host.querySelector('.player-entry-content')?.textContent).toContain('如果账号启用了 TOTP');
    const storedKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? '');
    expect(storedKeys.filter((key) => /token|credential|password|device/i.test(key))).toHaveLength(0);

    host.querySelector<HTMLButtonElement>('.player-entry-header .back-button')!.click();
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    expect(window.location.pathname).toBe('/');
  });

  it('renders the player entry on a direct URL and returns to the lobby on browser history navigation', async () => {
    window.history.replaceState({}, '', '/entry');
    app = createApp(App);
    app.mount(host);

    expect(host.querySelector('.player-entry-page')).not.toBeNull();
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    expect(host.querySelector('.player-entry-page')).toBeNull();
  });

  it('renders only server-provided activity effects and opens a direct-linkable detail page', async () => {
    const announcementId = '41a8a810-2233-4acd-8a11-a1b2c3d4e5f6';
    const announcement = {
      announcementId,
      stateVersion: 3,
      eventType: 'PLAYER_BURST',
      kind: 'EFFECT',
      titleKey: 'PLAYER_BURST',
      safeParams: { gameName: '<img src=x onerror=alert(1)>', difficultyName: '策略厅' },
      scope: [{ type: 'DIFFICULTY_HALL', gameKey: 'SHISANSHUI', difficultyKey: 'STRATEGY' }],
      publicActorLabel: '陈先生',
      startsAt: '2026-10-13T00:00:00.000Z',
      expiresAt: '2026-10-13T00:15:00.000Z',
      clickAction: { route: 'PLATFORM_ANNOUNCEMENT_DETAIL', params: { announcementId } },
    };
    const detail = {
      announcement,
      status: 'ACTIVE',
      kind: 'EFFECT',
      rulesVersion: 'rules-v7',
      effectTargets: [{
        scopeLabel: '十三张 · 策略厅',
        summary: '本活动概率和派奖参数已按配置调整。',
        probabilityDeltaPoints: 10,
        payoutDeltaPercent: 10,
        poolRemaining: '12500',
        poolUnit: '金币',
        seat: { occupied: 2, capacity: 15 },
      }],
    };
    mocks.getActivePlatformAnnouncements.mockResolvedValueOnce([announcement]);
    mocks.getPlatformAnnouncement.mockResolvedValueOnce(detail);
    app = createApp(App);
    app.mount(host);

    await waitFor(() => host.querySelector('.announcement-open') !== null);
    expect(host.querySelector('.announcement-kind')?.textContent).toContain('活动效果');
    host.querySelector<HTMLButtonElement>('.announcement-open')!.click();
    await waitFor(() => host.querySelector('.platform-announcement-detail') !== null && host.querySelector('.announcement-detail-card') !== null);

    expect(window.location.pathname).toBe(`/events/${announcementId}`);
    expect(host.querySelector('.announcement-detail-card h1')?.textContent).toContain('陈先生');
    expect(host.querySelector('.announcement-detail-card h1')?.textContent).toContain('<img');
    expect(host.querySelector('.announcement-detail-card img')).toBeNull();
    expect(host.querySelector('.announcement-effect-targets')?.textContent).toContain('+10 个百分点');
    expect(host.querySelector('.announcement-effect-targets')?.textContent).toContain('2 / 15');
    expect(host.querySelector('.announcement-detail-facts')?.textContent).toContain('rules-v7');

    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    expect(host.querySelector('.platform-announcement-detail')).toBeNull();
  });

  it('refreshes the announcement snapshot after network recovery or returning to the tab', async () => {
    app = createApp(App);
    app.mount(host);
    const initialRequests = mocks.getActivePlatformAnnouncements.mock.calls.length;

    window.dispatchEvent(new Event('online'));
    await waitFor(() => mocks.getActivePlatformAnnouncements.mock.calls.length > initialRequests);
    const recoveredRequests = mocks.getActivePlatformAnnouncements.mock.calls.length;

    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => mocks.getActivePlatformAnnouncements.mock.calls.length > recoveredRequests);
  });

  it('moves keyboard focus into a lobby dialog, traps Tab, and restores focus on Escape', async () => {
    localStorage.setItem('gameing-hall.hallGuide.v1', 'true');
    document.body.style.overflow = 'clip';
    document.documentElement.style.overflow = 'auto';
    app = createApp(App);
    app.mount(host);

    const trigger = host.querySelector<HTMLButtonElement>('.rules-trigger')!;
    trigger.focus();
    trigger.click();
    await waitFor(() => host.querySelector('.lobby-panel') !== null);

    expect(host.querySelector('.lobby-shell')?.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.position).toBe('fixed');
    const closeButton = host.querySelector<HTMLButtonElement>('.panel-close')!;
    expect(document.activeElement).toBe(closeButton);
    closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(closeButton);

    host.querySelector<HTMLElement>('.lobby-panel')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await waitFor(() => host.querySelector('.lobby-panel') === null);
    expect(host.querySelector('.lobby-shell')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe('clip');
    expect(document.documentElement.style.overflow).toBe('auto');
    expect(document.body.style.position).toBe('');
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';

    const settingsTrigger = host.querySelector<HTMLButtonElement>('.lobby-actions button:last-child')!;
    settingsTrigger.focus();
    settingsTrigger.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    const guideReplay = host.querySelector<HTMLButtonElement>('.guide-replay')!;
    guideReplay.focus();
    guideReplay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(host.querySelector('.panel-close'));
    host.querySelector<HTMLButtonElement>('.panel-close')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(guideReplay);
    host.querySelector<HTMLElement>('.lobby-panel')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await waitFor(() => host.querySelector('.lobby-panel') === null);
    expect(document.activeElement).toBe(settingsTrigger);
  });

  it('keeps mobile primary actions one tap away and groups secondary links under My', async () => {
    app = createApp(App);
    app.mount(host);

    const dock = host.querySelector('nav.mobile-dock');
    expect(dock?.querySelectorAll('button')).toHaveLength(5);
    dock?.querySelector<HTMLButtonElement>('button:last-child')?.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '个人资料');
    expect(host.querySelector('.profile-shortcuts')?.textContent).toContain('战绩');

    host.querySelector<HTMLButtonElement>('.profile-shortcuts button:last-child')?.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    expect(host.querySelector('.lobby-panel')?.textContent).toContain('低流量模式');
  });

  it('shows wallet and invitation guidance only in a dismissible overlay', async () => {
    localStorage.setItem('gameing-hall.hallGuide.v1', 'true');
    app = createApp(App);
    app.mount(host);

    const walletTrigger = host.querySelector<HTMLButtonElement>('.lobby-actions button:first-child')!;
    walletTrigger.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '钱包');
    expect(host.querySelector('.player-panel-guidance')).toBeNull();
    const walletHelpTrigger = host.querySelector<HTMLButtonElement>('.panel-help-trigger')!;
    walletHelpTrigger.click();
    await waitFor(() => host.querySelector('.player-help-dialog h2')?.textContent === '钱包规则');
    expect(host.querySelector('.player-help-dialog')?.textContent).toContain('手续费由发送方额外支付');
    expect(document.activeElement).toBe(host.querySelector('.player-help-dialog .panel-close'));
    const walletHelpDialog = host.querySelector<HTMLElement>('.player-help-dialog')!;
    walletHelpDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(host.querySelector('.player-help-dialog .panel-primary'));
    walletHelpDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(host.querySelector('.player-help-dialog .panel-close'));
    walletHelpDialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await waitFor(() => host.querySelector('.player-help-dialog') === null);
    expect(document.activeElement).toBe(walletHelpTrigger);

    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    await waitFor(() => host.querySelector('.lobby-panel') === null);
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '邀请与代理');
    expect(host.querySelector('.player-panel-guidance')).toBeNull();
    host.querySelector<HTMLButtonElement>('.panel-help-trigger')!.click();
    await waitFor(() => host.querySelector('.player-help-dialog h2')?.textContent === '邀请与返佣');
    expect(host.querySelector('.player-help-dialog')?.textContent).toContain('邀请链快照计算');
  });

  it('guides a first-time player through the hall and lets them replay the guide from settings', async () => {
    localStorage.removeItem('gameing-hall.hallGuide.v1');
    app = createApp(App);
    app.mount(host);

    await waitFor(() => host.querySelector('.hall-guide') !== null);
    expect(host.querySelector('.hall-guide')?.textContent).toContain('横向浏览游戏');
    expect(host.querySelector('.hall-guide-scrim')).not.toBeNull();
    expect(host.querySelector('.welcome .hall-guide')).toBeNull();
    expect(host.querySelector('.welcome')?.textContent).toContain('可免费本地练习');
    expect(host.querySelector('.game-row')?.classList.contains('guide-target')).toBe(true);

    host.querySelector<HTMLButtonElement>('.hall-guide .hall-guide-next')!.click();
    await waitFor(() => host.querySelector('.hall-guide')?.textContent.includes('从十三张开始') === true);
    expect(host.querySelector('.game-card.featured')?.classList.contains('guide-target')).toBe(true);
    host.querySelector<HTMLButtonElement>('.hall-guide .hall-guide-next')!.click();
    await waitFor(() => host.querySelector('.hall-guide')?.textContent.includes('大厅功能在这里') === true);
    host.querySelector<HTMLButtonElement>('.hall-guide .hall-guide-next')!.click();
    await waitFor(() => host.querySelector('.hall-guide') === null);
    expect(localStorage.getItem('gameing-hall.hallGuide.v1')).toBe('true');
    await waitFor(() => document.activeElement === host.querySelector('.game-row'));

    host.querySelector<HTMLButtonElement>('.lobby-actions button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    host.querySelector<HTMLButtonElement>('.guide-replay')!.click();
    await waitFor(() => host.querySelector('.hall-guide') !== null);
    expect(host.querySelector('.hall-guide')?.textContent).toContain('横向浏览游戏');
    await waitFor(() => document.activeElement === host.querySelector('.hall-guide-next'));
  });

  it('uses a first-visit spotlight for subhall difficulty discovery instead of a permanent instruction card', async () => {
    localStorage.removeItem('gameing-hall.shisanshuiGuide.v1');
    localStorage.setItem('gameing-hall.hallGuide.v1', 'true');
    app = createApp(App);
    app.mount(host);

    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    await waitFor(() => host.querySelector('.subhall-guide') !== null);

    expect(host.querySelector('.subhall-note')).toBeNull();
    expect(host.querySelector('.tier-grid-horizontal')?.classList.contains('guide-target')).toBe(true);
    expect(host.querySelector('.subhall-guide')?.textContent).toContain('最低下注、倍率和最高倍率');
    host.querySelector<HTMLButtonElement>('.subhall-guide button')!.click();
    await waitFor(() => host.querySelector('.subhall-guide') === null);
    expect(localStorage.getItem('gameing-hall.shisanshuiGuide.v1')).toBe('true');
    expect(document.activeElement).toBe(host.querySelector('.tier-grid-horizontal'));
  });

  it('locks the subhall behind the room sheet and restores its scroll and focus when the sheet closes', async () => {
    localStorage.setItem('gameing-hall.hallGuide.v1', 'true');
    localStorage.setItem('gameing-hall.shisanshuiGuide.v1', 'true');
    app = createApp(App);
    app.mount(host);

    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    const tier = host.querySelector<HTMLButtonElement>('.tier-card')!;
    tier.focus();
    tier.click();
    await waitFor(() => host.querySelector('.room-flow-panel') !== null);

    expect(host.querySelector('.subhall-shell')?.hasAttribute('inert')).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.position).toBe('fixed');
    host.querySelector<HTMLButtonElement>('.room-flow-close')!.click();
    await waitFor(() => host.querySelector('.room-flow-panel') === null);

    expect(host.querySelector('.subhall-shell')?.hasAttribute('inert')).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.body.style.position).toBe('');
    expect(document.activeElement).toBe(tier);
  });

  it('uses the connection status as the retry action and presents rules and tier metrics', async () => {
    mocks.getHealth.mockRejectedValueOnce(new Error('offline'));
    app = createApp(App);
    app.mount(host);

    const status = host.querySelector<HTMLButtonElement>('.lobby-shell .connection')!;
    await waitFor(() => status.classList.contains('offline'));
    expect(host.querySelector('.retry-button')).toBeNull();
    expect(status.getAttribute('aria-label')).toContain('点击重新连接');
    status.click();
    await waitFor(() => status.classList.contains('online'));

    expect(host.querySelector('.mobile-game-heading .mobile-game-art')).not.toBeNull();
    expect(host.querySelector('.mobile-game-heading .mobile-card-title h2')?.textContent).toBe('十三张');
    expect(host.querySelector('.mobile-game-description')?.textContent).toContain('整理 13 张牌');
    host.querySelector<HTMLButtonElement>('.rules-trigger')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '十三张玩法规则');
    expect(host.querySelector('.full-game-rules')?.textContent).toContain('头墩只有 3 张');
    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    expect(host.querySelectorAll('.mobile-tier-option')).toHaveLength(3);
    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelectorAll('.subhall-shell .tier-card').length === 3);
    expect(host.querySelector('.subhall-rules')?.textContent).toContain('一副 52 张牌');
    expect(host.querySelector('.tier-metrics')?.textContent).toContain('最低下注');
    expect(host.querySelector('.subhall-config-note')).toBeNull();
    expect(host.querySelector('.subhall-online-entry')).toBeNull();
  });

  it('orders the planned catalogue around the playable fourth desktop card and centers it on entry', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(min-width: 721px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('game-row')) return { left: 0, width: 1000 } as DOMRect;
      if (this.dataset.gameId === 'shisanshui') return { left: 1375, width: 250 } as DOMRect;
      return { left: 0, width: 0 } as DOMRect;
    });
    app = createApp(App);
    app.mount(host);

    const cards = [...host.querySelectorAll<HTMLElement>('.game-row > .game-card')];
    expect(cards).toHaveLength(8);
    expect(cards[3]?.dataset.gameId).toBe('shisanshui');
    expect(cards[0]?.dataset.gameId).toBe('slot5');
    expect(cards[7]?.dataset.gameId).toBe('three-fast');
    expect(host.querySelector('.game-row')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector<HTMLElement>('.game-row')?.scrollLeft).toBe(1000);
  });

  it('shows planned games as upcoming without exposing unfinished preview controls', async () => {
    app = createApp(App);
    app.mount(host);

    const slot5Card = host.querySelector<HTMLElement>('.game-card[data-game-id="slot5"]')!;
    expect(slot5Card.querySelector('.game-tag')?.textContent).toContain('即将开放');
    const comingSoon = slot5Card.querySelector<HTMLButtonElement>('.game-info button')!;
    expect(comingSoon.textContent).toBe('敬请期待');
    expect(comingSoon.disabled).toBe(true);
    expect(host.querySelector('[data-testid="game-module-preview"]')).toBeNull();
  });

  it('redirects direct links to unfinished game pages back to the game catalogue', async () => {
    window.history.replaceState({}, '', '/games/three-fast/preview');
    app = createApp(App);
    app.mount(host);

    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    expect(window.location.pathname).toBe('/');
    expect(host.querySelector('[data-testid="game-module-preview"]')).toBeNull();
  });

  it('assigns a dedicated responsive icon and themed background to every desktop and mobile game card', async () => {
    app = createApp(App);
    app.mount(host);

    const cards = [...host.querySelectorAll<HTMLElement>('.game-row > .game-card')];
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      const gameId = card.dataset.gameId;
      const icon = card.querySelector<HTMLImageElement>('.game-art img, .coming-art img');
      const background = card.querySelector<HTMLImageElement>('.game-card-backdrop img');
      const desktopBackground = card.querySelector<HTMLSourceElement>('.game-card-backdrop source[media="(min-width: 721px)"]');
      expect(icon?.getAttribute('src')).toBe(`/assets/game-icons/${gameId === 'slot5' ? 'jump-high-high' : gameId === 'slot3' ? 'treasure-hero' : gameId}.webp`);
      expect(background?.getAttribute('src')).toBe(`/assets/game-cards/${gameId === 'slot5' ? 'jump-high-high' : gameId === 'slot3' ? 'treasure-hero' : gameId}/poster.webp`);
      expect(desktopBackground?.getAttribute('srcset')).toBe(`/assets/game-cards/${gameId === 'slot5' ? 'jump-high-high' : gameId === 'slot3' ? 'treasure-hero' : gameId}/portrait/${gameId === 'shisanshui' ? 'active' : 'poster'}.avif`);
    }
    expect(host.querySelector<HTMLImageElement>('.mobile-game-art img')?.getAttribute('src')).toBe('/assets/game-icons/shisanshui.webp');
  });

  it('shows the successful lobby connection as 当前在线', async () => {
    mocks.getHealth.mockResolvedValueOnce({});
    app = createApp(App);
    app.mount(host);

    await waitFor(() => host.querySelector('.topbar .connection')?.textContent?.includes('当前在线') === true);
    expect(host.querySelector('.topbar .connection')?.textContent).toContain('当前在线');
  });

  it('activates the hovered mouse card and restores the centered card on pointer leave', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(min-width: 721px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('game-row')) return { left: 0, width: 1000 } as DOMRect;
      if (this.dataset.gameId === 'shisanshui') return { left: 400, width: 200 } as DOMRect;
      return { left: 0, width: 100 } as DOMRect;
    });
    app = createApp(App);
    app.mount(host);
    const sourceFor = (gameId: string) => host.querySelector<HTMLElement>(`[data-game-id="${gameId}"] .game-card-backdrop source`);
    const pictureFor = (gameId: string) => host.querySelector<HTMLElement>(`[data-game-id="${gameId}"] .game-card-backdrop`);
    await waitFor(() => sourceFor('shisanshui')?.getAttribute('srcset')?.endsWith('/active.avif') === true);

    const slotCard = host.querySelector<HTMLElement>('[data-game-id="slot5"]')!;
    const previousSlotPicture = pictureFor('slot5');
    const enter = new Event('pointerenter');
    Object.defineProperty(enter, 'pointerType', { value: 'mouse' });
    slotCard.dispatchEvent(enter);
    await waitFor(() => sourceFor('slot5')?.getAttribute('srcset')?.endsWith('/active.avif') === true);
    expect(pictureFor('slot5')).not.toBe(previousSlotPicture);
    expect(sourceFor('shisanshui')?.getAttribute('srcset')).toContain('/poster.avif');

    const activeSlotPicture = pictureFor('slot5');
    const leave = new Event('pointerleave');
    Object.defineProperty(leave, 'pointerType', { value: 'mouse' });
    slotCard.dispatchEvent(leave);
    await waitFor(() => sourceFor('shisanshui')?.getAttribute('srcset')?.endsWith('/active.avif') === true);
    expect(pictureFor('slot5')).not.toBe(activeSlotPicture);
    expect(sourceFor('slot5')?.getAttribute('srcset')).toContain('/poster.avif');
  });

  it('uses static posters in low-data mode and resumes the active image when disabled', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(min-width: 721px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('game-row')) return { left: 0, width: 1000 } as DOMRect;
      if (this.dataset.gameId === 'shisanshui') return { left: 400, width: 200 } as DOMRect;
      return { left: 0, width: 100 } as DOMRect;
    });
    localStorage.setItem('gameing-hall.clientPreferences.v1', JSON.stringify({ soundEnabled: true, lowDataMode: true }));
    app = createApp(App);
    app.mount(host);

    const featuredSource = () => host.querySelector<HTMLSourceElement>('[data-game-id="shisanshui"] .game-card-backdrop source');
    await waitFor(() => featuredSource()?.getAttribute('srcset')?.endsWith('/poster.avif') === true);
    host.querySelector<HTMLButtonElement>('.topbar .header-action:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    const dataModeToggle = host.querySelectorAll<HTMLInputElement>('.setting-row input')[1]!;
    dataModeToggle.checked = false;
    dataModeToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => featuredSource()?.getAttribute('srcset')?.endsWith('/active.avif') === true);
  });

  it('shows real loading phases while Pixi initializes and then reveals the practice table', async () => {
    let finishMount!: (session: { dispose: () => Promise<void> }) => void;
    mocks.mountLocalGame.mockReturnValueOnce(new Promise((resolve) => { finishMount = resolve; }));
    app = createApp(App);
    app.mount(host);

    host.querySelector<HTMLButtonElement>('.mobile-tier-option')!.click();
    await waitFor(() => host.querySelector('.game-loading') !== null);
    await waitFor(() => host.querySelector('.game-load-steps .current')?.textContent === '初始化画面');
    expect(host.querySelector('.game-load-track[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('加载中');
    expect(host.querySelector('.game-loading')?.textContent).toContain('首次进入需要准备牌桌资源');

    finishMount({ dispose: vi.fn().mockResolvedValue(undefined) });
    await waitFor(() => host.querySelector('.game-loading') === null);
    expect(host.querySelector('.practice-shell')).not.toBeNull();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the page transition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
