import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, shallowRef } from 'vue';
import App from './App.vue';
import { LOBBY_GAME_EXPERIENCE_REFERENCE, LOBBY_GAME_REFERENCE } from '@gameing/contracts/lobby-game-reference';

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

const testGameExperienceApi = {
  gameCatalog: async () => structuredClone(LOBBY_GAME_REFERENCE),
  gameExperiences: async () => structuredClone(LOBBY_GAME_EXPERIENCE_REFERENCE),
  gameExperience: async (gameKey: string) => {
    const item = LOBBY_GAME_EXPERIENCE_REFERENCE.find((entry) => entry.game.gameKey === gameKey);
    if (!item) throw new Error('GAME_NOT_FOUND');
    return structuredClone(item);
  },
  gamePreflight: async (gameKey: string, difficultyKey: string) => ({
    gameKey,
    difficultyKey,
    availability: gameKey === 'shisanshui' ? 'READY' as const : 'MODULE_UNAVAILABLE' as const,
    source: 'LOCAL_DEMO' as const,
    message: gameKey === 'shisanshui' ? '本地练习可用；不扣金币、不进行真实结算。' : '该游戏模块尚未接入，当前不会扣除资产或创建游戏局。',
  }),
};
function createLobbyApp(props: Record<string, unknown> = {}) {
  return createApp(App, { gameExperienceApi: testGameExperienceApi, ...props });
}

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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.game-card.featured') !== null);
    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    expect(host.querySelector('.player-primary-nav')).toBeNull();
    host.querySelector<HTMLButtonElement>('.subhall-shell .tier-card')!.click();
    await waitFor(() => host.querySelector('.room-flow-panel') !== null);
    host.querySelector<HTMLButtonElement>('.room-flow-practice')!.click();

    await waitFor(() => mocks.mountLocalGame.mock.calls.length === 1);
    expect(mocks.mountLocalGame.mock.calls[0]?.[0].isConnected).toBe(true);
    expect(host.querySelector('[data-game-mounted="true"]')).not.toBeNull();
    expect(host.querySelector('.player-primary-nav')).toBeNull();
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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.game-card[data-game-id="shisanshui"] .mobile-tier-option') !== null);
    host.querySelector<HTMLButtonElement>('.game-card[data-game-id="shisanshui"] .mobile-tier-option')!.click();
    await waitFor(() => host.querySelector('.practice-shell [data-game-mounted="true"]') !== null);
    expect(host.querySelector('.player-primary-nav')).toBeNull();
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
    app = createLobbyApp();
    app.mount(host);
    await waitFor(() => host.querySelector('.game-card.featured') !== null);
    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    expect(host.querySelector('.player-primary-nav')).toBeNull();
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
    expect(host.querySelector('.player-primary-nav')).toBeNull();
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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.subhall-shell') !== null);
    expect(window.location.pathname).toBe('/games/shisanshui');
  });

  it('opens customer support from the lobby inside the unified messages page', async () => {
    app = createLobbyApp();
    app.mount(host);

    expect(host.querySelector('.topbar .header-action')?.textContent).toContain('钱包');
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(5)')!.click();
    await waitFor(() => host.querySelector('.player-messages-page') !== null);
    expect(window.location.pathname).toBe('/messages/support');
    expect(host.querySelector('.player-messages-heading h2')?.textContent).toBe('客服');
    expect(host.querySelector('.player-message-empty')?.textContent).toContain('登录后联系在线客服');
    expect(host.querySelector('.player-support-status')).toBeNull();

    host.querySelector<HTMLButtonElement>('.player-primary-nav [data-dock-key="lobby"]')!.click();
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(6)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    const soundToggle = host.querySelector<HTMLInputElement>('.setting-row input')!;
    expect(host.querySelector('.setting-row')?.textContent).not.toContain('尚无音频资源');
    soundToggle.checked = false;
    soundToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => localStorage.getItem('gameing-hall.clientPreferences.v1') !== null);
    expect(JSON.parse(localStorage.getItem('gameing-hall.clientPreferences.v1') ?? '{}')).toMatchObject({ soundEnabled: false });
  });

  it('renders the history page with working filters and distinct wallet, invitation, social, notification, and profile workspaces', async () => {
    app = createLobbyApp();
    app.mount(host);

    host.querySelector<HTMLButtonElement>('.topbar .header-action')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '钱包');
    expect(window.location.pathname).toBe('/wallet');
    expect(host.querySelectorAll('.player-wallet-assets article')).toHaveLength(2);
    expect(host.querySelector('.player-wallet-actions')).toBeNull();
    expect(host.querySelector('.player-wallet-assets')?.textContent).toContain('登录后查看');
    expect(host.querySelector('.player-wallet-assets')?.textContent).not.toMatch(/\d{2,}/);

    host.querySelector<HTMLButtonElement>('.player-primary-nav [data-dock-key="lobby"]')!.click();
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(2)')!.click();
    await waitFor(() => host.querySelector('.player-history-page h1')?.textContent === '战绩');
    expect(window.location.pathname).toBe('/history');
    const historyFilters = host.querySelectorAll<HTMLButtonElement>('.history-filter-trigger');
    expect(historyFilters).toHaveLength(2);
    expect(historyFilters[0]?.disabled).toBe(false);
    historyFilters[0]!.click();
    await waitFor(() => host.querySelector('[aria-label="选择游戏"]') !== null);
    const shisanshuiOption = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((option) => option.textContent === '十三张');
    expect(shisanshuiOption).toBeDefined();
    shisanshuiOption!.click();
    await waitFor(() => historyFilters[0]?.textContent?.includes('十三张') === true);
    historyFilters[1]!.click();
    await waitFor(() => host.querySelector('[aria-label="选择时间范围"]') !== null);
    host.querySelector<HTMLButtonElement>('[aria-label="选择时间范围"] [role="option"]')!.click();
    await waitFor(() => historyFilters[1]?.textContent?.includes('近 7 天') === true);
    host.querySelector<HTMLButtonElement>('.history-signin-button')!.click();
    await waitFor(() => host.querySelector('.player-entry-page') !== null);
    host.querySelector<HTMLButtonElement>('.player-entry-header .back-button')!.click();
    await waitFor(() => host.querySelector('.player-history-page') !== null);
    expect(window.location.pathname).toBe('/history');
    host.querySelector<HTMLButtonElement>('.player-history-header .back-button')!.click();
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);

    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '邀请与代理');
    expect(host.querySelector('.player-invite-workspace')?.textContent).toContain('登录后管理邀请与代理申请');

    host.querySelector<HTMLButtonElement>('.mobile-dock [data-dock-key="social"]')!.click();
    await waitFor(() => host.querySelector('.social-page') !== null);
    expect(window.location.pathname).toBe('/social/forum');
    expect(host.querySelector('.lobby-panel')).toBeNull();
    expect(host.querySelector('.social-auth-callout')?.textContent).toContain('登录后开始使用');
    expect(host.querySelector('.social-preview')?.textContent).toContain('话题广场等你加入');
    expect(host.querySelector('.social-mobile-nav button span')).toBeNull();
    expect([...host.querySelectorAll('.social-mobile-nav button')].map((button) => button.textContent?.trim())).toEqual(['话题广场', '金币集市', '好友']);
    host.querySelector<HTMLButtonElement>('.social-mobile-nav button:nth-child(2)')!.click();
    await waitFor(() => window.location.pathname === '/social/market');
    expect(host.querySelector('.social-section-heading h1')?.textContent).toContain('金币挂牌与交易');
    host.querySelector<HTMLButtonElement>('.social-mobile-nav button:nth-child(3)')!.click();
    await waitFor(() => window.location.pathname === '/social/friends');
    expect(host.querySelector('.social-section-heading h1')?.textContent).toContain('找到熟悉的牌友');
    host.querySelector<HTMLButtonElement>('.player-primary-nav [data-dock-key="lobby"]')!.click();
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);

    host.querySelector<HTMLButtonElement>('.mobile-dock button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '我的');
    host.querySelector<HTMLButtonElement>('.profile-shortcuts button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.player-messages-page') !== null);
    expect(window.location.pathname).toBe('/messages');
    expect(host.querySelector('.player-message-shortcuts')?.textContent).toContain('站内信');
    expect(host.querySelector('.player-message-shortcuts')?.textContent).toContain('客服');
    host.querySelector<HTMLButtonElement>('.player-primary-nav button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '我的');
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
    app = createLobbyApp({ identitySessionState: session, checkSocialAccess });
    app.mount(host);

    await waitFor(() => [...host.querySelectorAll('.lobby-actions button')].some((button) => button.textContent?.includes('社区')));
    enabled = false;
    [...host.querySelectorAll<HTMLButtonElement>('.lobby-actions button')].find((button) => button.textContent?.includes('社区'))!.click();
    await waitFor(() => ![...host.querySelectorAll('nav button')].some((button) => button.textContent?.includes('社区')));
    expect(host.querySelector('.lobby-panel')).toBeNull();
    expect(checkSocialAccess).toHaveBeenCalled();
    expect([...host.querySelectorAll('.lobby-actions button')].some((button) => button.textContent?.includes('社区'))).toBe(false);
    expect([...host.querySelectorAll('.mobile-dock button')].some((button) => button.textContent?.includes('社区'))).toBe(false);
  });

  it('keeps sign-out under Settings and preserves My when Settings is closed', async () => {
    const session = shallowRef({
      accessToken: 'local-test-token', tokenType: 'Bearer' as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { userId: '41', displayName: '本地测试玩家', roleType: 1 }, device: { deviceId: '42', trusted: true },
    });
    const logout = vi.fn(async () => {
      session.value = undefined as never;
      return { ok: true as const, value: undefined };
    });
    app = createLobbyApp({
      identitySessionState: session,
      playerEntryApplication: { logout } as never,
    });
    app.mount(host);

    host.querySelector<HTMLButtonElement>('[aria-label="个人菜单"]')!.click();
    await waitFor(() => host.querySelector('.player-profile-card') !== null);
    expect(host.querySelector('.player-profile-card')?.textContent).toContain('本地测试玩家');
    expect(host.querySelector('.profile-shortcuts')?.textContent).not.toContain('退出当前账号');
    host.querySelector<HTMLButtonElement>('.profile-shortcuts button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    expect(window.location.pathname).toBe('/profile');
    expect(host.querySelector('.settings-logout')?.textContent).toBe('退出当前账号');
    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '我的');
    expect(window.location.pathname).toBe('/profile');

    host.querySelector<HTMLButtonElement>('.profile-shortcuts button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    host.querySelector<HTMLButtonElement>('.settings-logout')!.click();
    await waitFor(() => logout.mock.calls.length === 1);
    await waitFor(() => host.querySelector('.lobby-panel') === null);

    expect(logout).toHaveBeenCalledTimes(1);
    expect(session.value).toBeUndefined();
    expect(host.querySelector('.player-entry-trigger')?.textContent).toBe('登录 / 恢复');
  });

  it('keeps password editing in its own dialog and groups TOTP and recovery credentials under security management', async () => {
    const session = shallowRef({
      accessToken: 'local-test-token', tokenType: 'Bearer' as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { userId: '61', displayName: '安全设置玩家', roleType: 1 }, device: { deviceId: '62', trusted: true },
    });
    const settings = {
      username: 'security-player', email: { maskedValue: 'p***@example.test', verified: true }, phone: null,
      passwordConfigured: true, totpEnabled: false, recoveryCredential: { available: true, expiresAt: null },
    };
    const getIdentitySettings = vi.fn(async () => ({ ok: true as const, value: settings }));
    app = createLobbyApp({ identitySessionState: session, playerEntryApplication: { getIdentitySettings } as never });
    app.mount(host);

    host.querySelector<HTMLButtonElement>('[aria-label="个人菜单"]')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '我的');
    await waitFor(() => host.querySelector('.player-profile-fields')?.textContent?.includes('p***@example.test') === true);
    expect(host.querySelector('.player-profile-field[data-profile-field="password"]')).not.toBeNull();
    expect(host.querySelector('.player-profile-field[data-profile-field="totp"]')?.textContent).toContain('恢复二维码 有效');

    const passwordButton = host.querySelector<HTMLButtonElement>('.player-profile-field[data-profile-field="password"] button')!;
    passwordButton.focus();
    passwordButton.click();
    await waitFor(() => document.querySelector('[aria-label="密码管理"]') !== null);
    expect(document.querySelector('.identity-credential-form')?.textContent).toContain('当前密码');
    expect(host.querySelector('.identity-totp-settings')).toBeNull();
    document.querySelector<HTMLElement>('[aria-label="密码管理"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => document.querySelector('[aria-label="密码管理"]') === null);
    expect(document.activeElement).toBe(passwordButton);

    const securityButton = host.querySelector<HTMLButtonElement>('.player-profile-field[data-profile-field="totp"] button')!;
    securityButton.focus();
    securityButton.click();
    await waitFor(() => document.querySelector('.identity-security-dialog') !== null);
    expect(document.querySelector('.identity-security-sticky-header .panel-close')?.getAttribute('aria-label')).toBe('关闭安全管理');
    expect(document.querySelector('.identity-security-dialog .identity-totp-settings')?.textContent).toContain('两步验证');
    expect(document.querySelector('.identity-security-dialog [name="totp-setup-password"]')).not.toBeNull();
    expect(document.querySelector('.identity-security-dialog .identity-credential-form button[type="submit"]')?.textContent).toContain('开始设置');
    expect(document.querySelector('.identity-security-dialog [aria-label="恢复二维码管理"]')).not.toBeNull();
    document.querySelector<HTMLElement>('.identity-security-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => document.querySelector('.identity-security-dialog') === null);
    expect(document.activeElement).toBe(securityButton);
  });

  it('binds a phone without SMS and asks for the old phone with its last three digits when replacing it', async () => {
    const session = shallowRef({
      accessToken: 'local-test-token', tokenType: 'Bearer' as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { userId: '71', displayName: '手机号测试玩家', roleType: 1 }, device: { deviceId: '72', trusted: true },
    });
    let settings = {
      username: 'phone-player', email: null, phone: null as null | { maskedValue: string; verified: boolean },
      passwordConfigured: true, totpEnabled: false, recoveryCredential: { available: false, expiresAt: null },
    };
    const setPhoneContact = vi.fn(async (request: { phone: string }) => {
      settings = { ...settings, phone: { maskedValue: `${request.phone.slice(0, 3)}••••${request.phone.slice(-3)}`, verified: true } };
      return { ok: true as const, value: settings };
    });
    app = createLobbyApp({ identitySessionState: session, playerEntryApplication: { getIdentitySettings: async () => ({ ok: true, value: settings }), setPhoneContact } as never });
    app.mount(host);
    host.querySelector<HTMLButtonElement>('[aria-label="个人菜单"]')!.click();
    await waitFor(() => host.querySelector('.player-profile-fields')?.textContent?.includes('未绑定') === true);
    host.querySelector<HTMLButtonElement>('.player-profile-field[data-profile-field="phone"] button')!.click();
    await waitFor(() => document.querySelector('[aria-label="联系方式管理"]') !== null);
    expect(document.querySelector('.identity-credential-form')?.textContent).toContain('绑定手机');
    expect(document.querySelector('[name="contact-verification-code"]')).toBeNull();

    const fill = (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    fill('[name="new-phone"]', '+14155550123');
    fill('[name="contact-current-password"]', 'existing-password');
    document.querySelector<HTMLButtonElement>('.identity-credential-form button[type="submit"]')!.click();
    await waitFor(() => setPhoneContact.mock.calls.length === 1);
    await waitFor(() => document.querySelector('[aria-label="联系方式管理"]') === null);
    await waitFor(() => host.querySelector('.player-profile-field[data-profile-field="phone"]')?.textContent?.includes('123') === true);
    host.querySelector<HTMLButtonElement>('.player-profile-field[data-profile-field="phone"] button')!.click();
    await waitFor(() => document.querySelector('.identity-credential-form')?.textContent?.includes('尾数为 123') === true);
    expect(document.querySelector('[name="contact-verification-code"]')).toBeNull();
    fill('[name="current-phone"]', '+14155550123');
    fill('[name="new-phone"]', '+14155550124');
    fill('[name="contact-current-password"]', 'existing-password');
    document.querySelector<HTMLButtonElement>('.identity-credential-form button[type="submit"]')!.click();
    await waitFor(() => setPhoneContact.mock.calls.length === 2);
    expect(setPhoneContact.mock.calls[1]?.[0]).toMatchObject({ currentPhone: '+14155550123', phone: '+14155550124' });
  });

  it('opens email and phone editors directly when the account has no password yet', async () => {
    const session = shallowRef({
      accessToken: 'local-test-token', tokenType: 'Bearer' as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { userId: '81', displayName: '未设密码玩家', roleType: 1 }, device: { deviceId: '82', trusted: true },
    });
    const settings = {
      username: null, email: { maskedValue: 'pl***@example.test', verified: false }, phone: null,
      passwordConfigured: false, totpEnabled: false, recoveryCredential: { available: false, expiresAt: null },
    };
    const setEmailContact = vi.fn(async (_request: { email: string; currentEmail?: string }) => ({ ok: true as const, value: { ...settings, email: { maskedValue: 'ne***@example.test', verified: false } } }));
    const setPhoneContact = vi.fn(async (_request: { phone: string }) => ({ ok: true as const, value: { ...settings, phone: { maskedValue: '+14••••123', verified: true } } }));
    app = createLobbyApp({ identitySessionState: session, playerEntryApplication: { getIdentitySettings: async () => ({ ok: true, value: settings }), setEmailContact, setPhoneContact } as never });
    app.mount(host);
    host.querySelector<HTMLButtonElement>('[aria-label="个人菜单"]')!.click();
    await waitFor(() => host.querySelector('.player-profile-field[data-profile-field="email"]') !== null);

    host.querySelector<HTMLButtonElement>('.player-profile-field[data-profile-field="email"] button')!.click();
    await waitFor(() => document.querySelector('[aria-label="联系方式管理"] h3')?.textContent === '更换邮箱');
    expect(document.querySelector('[name="current-email"]')).not.toBeNull();
    expect(document.querySelector('[name="contact-verification-code"]')).toBeNull();
    const oldEmail = document.querySelector<HTMLInputElement>('[name="current-email"]')!;
    oldEmail.value = 'player@example.test';
    oldEmail.dispatchEvent(new Event('input', { bubbles: true }));
    const email = document.querySelector<HTMLInputElement>('[name="new-email"]')!;
    email.value = 'new@example.test';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('.identity-credential-form button[type="submit"]')!.click();
    await waitFor(() => setEmailContact.mock.calls.length === 1);
    expect(setEmailContact.mock.calls[0]?.[0]).toMatchObject({ currentEmail: 'player@example.test', email: 'new@example.test' });

    document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click();
    await waitFor(() => document.querySelector('[aria-label="联系方式管理"]') === null);
    host.querySelector<HTMLButtonElement>('.player-profile-field[data-profile-field="phone"] button')!.click();
    await waitFor(() => document.querySelector('[aria-label="联系方式管理"] h3')?.textContent === '绑定手机');
    expect(document.querySelector('[name="contact-current-password"]')).toBeNull();
    const phone = document.querySelector<HTMLInputElement>('[name="new-phone"]')!;
    phone.value = '+14155550123';
    phone.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('.identity-credential-form button[type="submit"]')!.click();
    await waitFor(() => setPhoneContact.mock.calls.length === 1);
    expect(setPhoneContact.mock.calls[0]?.[0]).toMatchObject({ phone: '+14155550123' });
  });

  it('provides a three-mode player entry screen without exposing implementation status', async () => {
    app = createLobbyApp();
    app.mount(host);
    host.querySelector<HTMLButtonElement>('.mobile-dock button:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '我的');
    expect(window.location.pathname).toBe('/profile');
    host.querySelector<HTMLButtonElement>('.profile-shortcuts ~ .panel-primary')?.click();
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
    await waitFor(() => host.querySelector('.player-primary-page-panel h2')?.textContent === '我的');
    expect(window.location.pathname).toBe('/profile');
  });

  it('renders the player entry on a direct URL and returns to the lobby on browser history navigation', async () => {
    window.history.replaceState({}, '', '/entry');
    app = createLobbyApp();
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
    app = createLobbyApp();
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
    app = createLobbyApp();
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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.rules-trigger') !== null);
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
    app = createLobbyApp();
    app.mount(host);

    const dock = host.querySelector('nav.mobile-dock');
    expect(dock?.querySelectorAll('button')).toHaveLength(5);
    const messagesDockButton = [...(dock?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('消息'));
    expect(messagesDockButton?.querySelector('.dock-icon-svg')).not.toBeNull();
    messagesDockButton?.click();
    await waitFor(() => host.querySelector('.player-messages-page') !== null);
    expect(window.location.pathname).toBe('/messages');
    expect(host.querySelector('.player-messages-mobile-tabs')?.textContent).toContain('站内信');
    host.querySelector<HTMLButtonElement>('.player-messages-mobile-tabs button:last-child')!.click();
    await waitFor(() => window.location.pathname === '/messages/support');
    expect(host.querySelector('.player-messages-heading h2')?.textContent).toBe('客服');

    host.querySelector<HTMLButtonElement>('.player-primary-nav button:last-child')?.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '我的');
    expect(host.querySelector('.profile-shortcuts')?.textContent).toContain('战绩');

    host.querySelector<HTMLButtonElement>('.profile-shortcuts button:last-child')?.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    expect(host.querySelector('.lobby-panel')?.textContent).toContain('低流量模式');
    expect(window.location.pathname).toBe('/profile');
    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '我的');
    expect(window.location.pathname).toBe('/profile');
  });

  it('shows wallet and invitation guidance only in a dismissible overlay', async () => {
    localStorage.setItem('gameing-hall.hallGuide.v1', 'true');
    app = createLobbyApp();
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

    host.querySelector<HTMLButtonElement>('.player-primary-nav [data-dock-key="lobby"]')!.click();
    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    host.querySelector<HTMLButtonElement>('.lobby-actions button:nth-child(3)')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '邀请与代理');
    expect(host.querySelector('.player-panel-guidance')).toBeNull();
    host.querySelector<HTMLButtonElement>('.panel-help-trigger')!.click();
    await waitFor(() => host.querySelector('.player-help-dialog h2')?.textContent === '邀请与返佣');
    expect(host.querySelector('.player-help-dialog')?.textContent).toContain('邀请链快照计算');
  });

  it('guides a first-time player through the hall and lets them replay the guide from settings', async () => {
    localStorage.removeItem('gameing-hall.hallGuide.v1');
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.hall-guide') !== null);
    expect(host.querySelector('.hall-guide')?.textContent).toContain('横向浏览游戏');
    expect(host.querySelector('.hall-guide-scrim')).not.toBeNull();
    expect(host.querySelector('.welcome .hall-guide')).toBeNull();
    expect(host.querySelector('.welcome')?.textContent).toContain('尚未接入的模块');
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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.game-card.featured') !== null);
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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.game-card.featured') !== null);
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
    app = createLobbyApp();
    app.mount(host);

    const status = host.querySelector<HTMLButtonElement>('.lobby-shell .connection')!;
    await waitFor(() => status.classList.contains('offline'));
    await waitFor(() => host.querySelector('.mobile-game-heading .mobile-game-art') !== null);
    expect(host.querySelector('.retry-button')).toBeNull();
    expect(status.getAttribute('aria-label')).toContain('点击重新连接');
    status.click();
    await waitFor(() => status.classList.contains('online'));

    expect(host.querySelector('.mobile-game-heading .mobile-game-art')).not.toBeNull();
    const shisanshuiCard = host.querySelector<HTMLElement>('.game-card[data-game-id="shisanshui"]')!;
    expect(shisanshuiCard.querySelector('.mobile-card-title h2')?.textContent).toBe('十三张');
    expect(shisanshuiCard.querySelector('.mobile-game-description')?.textContent).toContain('十三张牌');
    shisanshuiCard.querySelector<HTMLButtonElement>('.rules-trigger')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '十三张');
    expect(host.querySelector('.full-game-rules')?.textContent).toContain('头墩 3 张');
    host.querySelector<HTMLButtonElement>('.panel-close')!.click();
    expect(shisanshuiCard.querySelectorAll('.mobile-tier-option')).toHaveLength(3);
    host.querySelector<HTMLButtonElement>('.game-card.featured .game-info button')!.click();
    await waitFor(() => host.querySelectorAll('.subhall-shell .tier-card').length === 3);
    expect(host.querySelector('.subhall-rules')?.textContent).toContain('52 张牌');
    expect(host.querySelector('.tier-metrics')?.textContent).toContain('最低投入');
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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelectorAll('.game-row > .game-card').length === 8);
    const cards = [...host.querySelectorAll<HTMLElement>('.game-row > .game-card')];
    expect(cards).toHaveLength(8);
    expect(cards[3]?.dataset.gameId).toBe('shisanshui');
    expect(cards[0]?.dataset.gameId).toBe('slot5');
    expect(cards[7]?.dataset.gameId).toBe('three-fast');
    expect(host.querySelector('.game-row')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector<HTMLElement>('.game-row')?.scrollLeft).toBe(1000);
  });

  it('opens each planned game subhall and reports an unavailable module from the preflight API', async () => {
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelectorAll('.game-row > .game-card').length === 8);
    const slot5Card = host.querySelector<HTMLElement>('.game-card[data-game-id="slot5"]')!;
    expect(slot5Card.querySelector('.game-tag')?.textContent).toContain('玩法与难度预览');
    slot5Card.querySelector<HTMLButtonElement>('.game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-shell h1')?.textContent === '跳高高');
    expect(host.querySelectorAll('.tier-card')).toHaveLength(3);
    expect(host.querySelector('.subhall-rules')?.textContent).toContain('243 路');
    host.querySelector<HTMLButtonElement>('.tier-card')!.click();
    await waitFor(() => host.querySelector('.subhall-entry-feedback') !== null);
    expect(host.querySelector('.subhall-entry-feedback')?.textContent).toContain('不会扣除资产');
    expect(host.querySelectorAll('.subhall-rules a')).toHaveLength(0);
  });

  it('redirects direct links to unfinished game pages back to the game catalogue', async () => {
    window.history.replaceState({}, '', '/games/three-fast/preview');
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.lobby-shell:not(.subhall-shell)') !== null);
    expect(window.location.pathname).toBe('/');
    expect(host.querySelector('[data-testid="game-module-preview"]')).toBeNull();
  });

  it('assigns a dedicated responsive icon and themed background to every desktop and mobile game card', async () => {
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelectorAll('.game-row > .game-card').length === 8);
    const cards = [...host.querySelectorAll<HTMLElement>('.game-row > .game-card')];
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      const gameId = card.dataset.gameId;
      const icon = card.querySelector<HTMLImageElement>('.game-art img, .coming-art img');
      const background = card.querySelector<HTMLImageElement>('.game-card-backdrop-poster img');
      const desktopBackground = card.querySelector<HTMLSourceElement>('.game-card-backdrop-poster source[media="(min-width: 721px)"]');
      expect(icon?.getAttribute('src')).toBe(`/assets/game-icons/${gameId === 'slot5' ? 'jump-high-high' : gameId === 'slot3' ? 'treasure-hero' : gameId}.webp`);
      expect(background?.getAttribute('src')).toBe(`/assets/game-cards/${gameId === 'slot5' ? 'jump-high-high' : gameId === 'slot3' ? 'treasure-hero' : gameId}/poster.webp`);
      expect(desktopBackground?.getAttribute('srcset')).toBe(`/assets/game-cards/${gameId === 'slot5' ? 'jump-high-high' : gameId === 'slot3' ? 'treasure-hero' : gameId}/portrait/poster.avif`);
      expect(card.querySelector('.mobile-game-heading .mobile-game-art img')).not.toBeNull();
      expect(card.querySelector('.mobile-game-description')?.textContent?.trim().length).toBeGreaterThan(0);
      expect(card.querySelector('.rules-trigger')).not.toBeNull();
      expect(card.querySelectorAll('.mobile-tier-option')).toHaveLength(3);
      expect(card.querySelector('.rules-trigger')?.previousElementSibling).toBe(card.querySelector('.mobile-tier-list'));
      expect(card.querySelector('.rules-trigger')?.textContent).toContain('玩法规则与说明');
      expect(card.querySelector('.mobile-game-hall-button')).toBeNull();
    }
    expect(host.querySelector<HTMLImageElement>('.game-card[data-game-id="shisanshui"] .mobile-game-art img')?.getAttribute('src')).toBe('/assets/game-icons/shisanshui.webp');
  });

  it('shows researched gameplay rules in-app without external navigation links', async () => {
    app = createLobbyApp();
    app.mount(host);
    await waitFor(() => host.querySelectorAll('.game-row > .game-card').length === 8);

    const examples = [
      ['slot5', '243 路'],
      ['slot3', '三列、多线与积分'],
      ['mahjong-hule', '1024 ways'],
      ['mahjong-hule-2', '2000 ways'],
      ['bounty-queen', '20 条固定中奖线'],
      ['fishing', '实时同步玩法'],
      ['three-fast', '开放 3 分钟投注'],
    ] as const;

    for (const [gameKey, expectedText] of examples) {
      const card = host.querySelector<HTMLElement>(`.game-card[data-game-id="${gameKey}"]`)!;
      card.querySelector<HTMLButtonElement>('.rules-trigger')!.click();
      await waitFor(() => host.querySelector('.full-game-rules') !== null);
      const rules = host.querySelector<HTMLElement>('.full-game-rules')!;
      expect(rules.textContent).toContain(expectedText);
      expect(rules.querySelectorAll('a[href]')).toHaveLength(0);
      expect(rules.querySelectorAll('p:not(.panel-note)').length).toBeGreaterThanOrEqual(5);
      host.querySelector<HTMLButtonElement>('.panel-close')!.click();
      await waitFor(() => host.querySelector('.lobby-panel') === null);
    }

    host.querySelector<HTMLButtonElement>('.game-card[data-game-id="mahjong-hule"] .game-info button')!.click();
    await waitFor(() => host.querySelector('.subhall-rules') !== null);
    expect(host.querySelectorAll('.game-experience-attribution a[href]')).toHaveLength(0);
  });

  it('shows the successful lobby connection as 当前在线', async () => {
    mocks.getHealth.mockResolvedValueOnce({});
    app = createLobbyApp();
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
    app = createLobbyApp();
    app.mount(host);
    const posterFor = (gameId: string) => host.querySelector<HTMLElement>(`[data-game-id="${gameId}"] .game-card-backdrop-poster`);
    const motionFor = (gameId: string) => host.querySelector<HTMLElement>(`[data-game-id="${gameId}"] .game-card-backdrop-motion`);
    const motionSourceFor = (gameId: string) => motionFor(gameId)?.querySelector('source');
    await waitFor(() => motionSourceFor('shisanshui')?.getAttribute('srcset')?.endsWith('/active.avif') === true);

    const slotCard = host.querySelector<HTMLElement>('[data-game-id="slot5"]')!;
    const previousSlotPoster = posterFor('slot5');
    expect(motionFor('slot5')).toBeNull();
    const enter = new Event('pointerenter');
    Object.defineProperty(enter, 'pointerType', { value: 'mouse' });
    slotCard.dispatchEvent(enter);
    await waitFor(() => motionSourceFor('slot5')?.getAttribute('srcset')?.endsWith('/active.avif') === true);
    expect(posterFor('slot5')).toBe(previousSlotPoster);
    expect(motionFor('slot5')?.classList.contains('ready')).toBe(false);
    motionFor('slot5')?.querySelector('img')?.dispatchEvent(new Event('load'));
    await waitFor(() => motionFor('slot5')?.classList.contains('ready') === true);
    expect(motionSourceFor('shisanshui')).toBeFalsy();

    const leave = new Event('pointerleave');
    Object.defineProperty(leave, 'pointerType', { value: 'mouse' });
    slotCard.dispatchEvent(leave);
    await waitFor(() => motionSourceFor('shisanshui')?.getAttribute('srcset')?.endsWith('/active.avif') === true);
    expect(motionFor('slot5')).toBeNull();
    expect(posterFor('slot5')).toBe(previousSlotPoster);
  });

  it('rebinds the desktop carousel and activates the new center card after returning from the wallet', async () => {
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
    let centeredGameId = 'shisanshui';
    const getBoundingClientRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    getBoundingClientRect.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('game-row')) return { left: 0, width: 1000 } as DOMRect;
      if (this.classList.contains('game-card')) {
        return this.dataset.gameId === centeredGameId
          ? { left: 400, width: 200 } as DOMRect
          : { left: 0, width: 100 } as DOMRect;
      }
      return { left: 0, width: 0 } as DOMRect;
    });
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.game-card.is-centered[data-game-id="shisanshui"]') !== null);
    const firstCarousel = host.querySelector('.game-row');
    host.querySelector<HTMLButtonElement>('.topbar .header-action')!.click();
    await waitFor(() => host.querySelector('.player-wallet-page-heading h2')?.textContent === '钱包');
    host.querySelector<HTMLButtonElement>('.player-primary-nav [data-dock-key="lobby"]')!.click();
    await waitFor(() => host.querySelector('.game-row') !== firstCarousel);

    centeredGameId = 'mahjong-hule';
    host.querySelector('.game-row')!.dispatchEvent(new Event('scroll'));
    await waitFor(() => host.querySelector('.game-card.is-centered[data-game-id="mahjong-hule"]')?.classList.contains('is-motion-active') === true);
    expect(host.querySelector<HTMLSourceElement>('[data-game-id="mahjong-hule"] .game-card-backdrop-motion source')?.getAttribute('srcset')).toContain('/active.avif');
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
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('[data-game-id="shisanshui"]') !== null);
    const featuredSource = () => host.querySelector<HTMLSourceElement>('[data-game-id="shisanshui"] .game-card-backdrop-poster source');
    await waitFor(() => featuredSource()?.getAttribute('srcset')?.endsWith('/poster.avif') === true);
    expect(host.querySelector('[data-game-id="shisanshui"] .game-card-backdrop-motion')).toBeNull();
    host.querySelector<HTMLButtonElement>('.topbar .header-action:last-child')!.click();
    await waitFor(() => host.querySelector('.lobby-panel h2')?.textContent === '设置');
    const dataModeToggle = host.querySelectorAll<HTMLInputElement>('.setting-row input')[1]!;
    dataModeToggle.checked = false;
    dataModeToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => host.querySelector('[data-game-id="shisanshui"] .game-card-backdrop-motion source')?.getAttribute('srcset')?.endsWith('/active.avif') === true);
  });

  it('shows real loading phases while Pixi initializes and then reveals the practice table', async () => {
    let finishMount!: (session: { dispose: () => Promise<void> }) => void;
    mocks.mountLocalGame.mockReturnValueOnce(new Promise((resolve) => { finishMount = resolve; }));
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.game-card[data-game-id="shisanshui"] .mobile-tier-option') !== null);
    host.querySelector<HTMLButtonElement>('.game-card[data-game-id="shisanshui"] .mobile-tier-option')!.click();
    await waitFor(() => host.querySelector('.game-loading') !== null);
    await waitFor(() => host.querySelector('.game-load-steps .current')?.textContent === '初始化画面');
    expect(host.querySelector('.game-load-track[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('加载中');
    expect(host.querySelector('.game-loading')?.textContent).toContain('首次进入需要准备游戏资源');

    finishMount({ dispose: vi.fn().mockResolvedValue(undefined) });
    await waitFor(() => host.querySelector('.game-loading') === null);
    expect(host.querySelector('.practice-shell')).not.toBeNull();
  });

  it('shows a themed loading transition for the selected game before reporting an unavailable module', async () => {
    app = createLobbyApp();
    app.mount(host);

    await waitFor(() => host.querySelector('.game-card[data-game-id="mahjong-hule"] .mobile-tier-option') !== null);
    host.querySelector<HTMLButtonElement>('.game-card[data-game-id="mahjong-hule"] .mobile-tier-option')!.click();
    await waitFor(() => host.querySelector('.game-loading[data-game="mahjong-hule"]') !== null);

    const loading = host.querySelector<HTMLElement>('.game-loading')!;
    expect(loading.textContent).toContain('麻将胡了');
    expect(loading.querySelector('.game-loading-backdrop')?.getAttribute('style')).toContain('/assets/game-subhalls/mahjong-hule.webp');
    expect(loading.querySelector('.game-loading-backdrop')?.getAttribute('style')).not.toContain('/assets/game-cards/');
    expect(loading.querySelector('.game-loading-orbit')).not.toBeNull();
    await waitFor(() => host.querySelector('.game-loading') === null);
    expect(host.querySelector('.game-card[data-game-id="mahjong-hule"] .game-entry-feedback')?.textContent).toContain('尚未接入');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the page transition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
