import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue';
import type { NotificationSummaryApplication } from './platform/notifications/notification-summary-application';
import type { SocialFriendsApplication } from './platform/social/friends-application';
import type { SupportClientApplication } from './platform/support/support-application';
import PlayerMessagesPage, { type PlayerMessagesSection } from './components/PlayerMessagesPage.vue';

describe('player messages navigation and refresh', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host?.remove();
    vi.useRealTimers();
  });

  it('keeps visited sections mounted and refreshes the active section manually and once per minute', async () => {
    vi.useFakeTimers();
    let resolveRefresh: ((value: { items: []; unavailableSources: [] }) => void) | undefined;
    const notificationApplication = {
      load: vi.fn()
        .mockResolvedValueOnce({ items: [], unavailableSources: [] })
        .mockImplementation(() => new Promise((resolve) => { resolveRefresh = resolve; })),
    } as unknown as NotificationSummaryApplication;
    const friendsApplication = {
      listFriends: vi.fn(async () => []),
      ownProfile: vi.fn(async () => ({ userId: '1', displayName: '玩家', friendCode: 'PLAYER1234' })),
      listConversations: vi.fn(async () => []),
    } as unknown as SocialFriendsApplication;
    const supportApplication = { listConversations: vi.fn(async () => ({ ok: true, value: [] })) } as unknown as SupportClientApplication;
    const openFriends = vi.fn();
    const Harness = defineComponent({
      setup() {
        const section = ref<PlayerMessagesSection>('all');
        return () => h(PlayerMessagesPage, {
          section: section.value,
          authenticated: true,
          userId: '1',
          socialEnabled: true,
          notificationApplication,
          friendsApplication,
          supportApplication,
          onNavigate: (next: PlayerMessagesSection) => { section.value = next; },
          onOpenFriends: openFriends,
        });
      },
    });
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(Harness);
    app.mount(host);
    await nextTick();
    await Promise.resolve();
    await nextTick();

    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.player-messages-rail nav button')]
      .find((item) => item.textContent?.includes(label))!;
    button('私信').click();
    await nextTick();
    await Promise.resolve();
    await nextTick();
    expect(friendsApplication.listFriends).toHaveBeenCalledTimes(1);
    const chatWorkspace = host.querySelector('.social-friends-workspace');

    button('全部').click();
    await nextTick();
    button('私信').click();
    await nextTick();
    expect(host.querySelector('.social-friends-workspace')).toBe(chatWorkspace);
    expect(friendsApplication.listFriends).toHaveBeenCalledTimes(1);
    host.querySelector<HTMLButtonElement>('.player-messages-friends')!.click();
    expect(openFriends).toHaveBeenCalledTimes(1);

    button('全部').click();
    await nextTick();
    const refreshButton = host.querySelector<HTMLButtonElement>('.player-messages-refresh')!;
    refreshButton.click();
    await nextTick();
    expect(refreshButton.querySelector('svg')?.classList.contains('spinning')).toBe(true);
    resolveRefresh?.({ items: [], unavailableSources: [] });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    expect(refreshButton.querySelector('svg')?.classList.contains('spinning')).toBe(false);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(notificationApplication.load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(notificationApplication.load).toHaveBeenCalledTimes(3);
  });

  it('renders a selected friend conversation as a full-screen secondary page with a back action', async () => {
    const friendsApplication = {
      listFriends: vi.fn(async () => []),
      ownProfile: vi.fn(async () => ({ userId: '1', displayName: '玩家', friendCode: 'PLAYER1234' })),
      listConversations: vi.fn(async () => [{ conversationId: '42', peerUserId: '2', peerDisplayName: '牌友小林', peerFriendCode: 'FRIEND2026', peerIsFriend: true, lastMessage: '晚点见' }]),
      listMessages: vi.fn(async () => ({ conversationId: '42', messages: [{ messageId: '51', conversationId: '42', clientMessageId: 'message-key-1', senderUserId: '2', body: '晚点见', createdAt: '2026-10-18T08:00:00.000Z' }], peerIsFriend: true, canSend: true, requiresReply: false })),
      openAttachment: vi.fn(),
    } as unknown as SocialFriendsApplication;
    const openConversation = vi.fn();
    const closeConversation = vi.fn();
    const Harness = defineComponent({
      setup() {
        return () => h(PlayerMessagesPage, {
          section: 'private',
          authenticated: true,
          userId: '1',
          socialEnabled: true,
          friendsApplication,
          initialConversationId: '42',
          onOpenConversation: openConversation,
          onCloseConversation: closeConversation,
        });
      },
    });
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(Harness);
    app.mount(host);
    await vi.waitFor(() => expect(host.querySelector('.player-conversation-route')).not.toBeNull());
    await vi.waitFor(() => expect(host.querySelector('.social-chat-panel-fullscreen')).not.toBeNull());

    expect(host.querySelector('.player-messages-layout')).toBeNull();
    expect(host.querySelector('.social-chat-header')?.textContent).toContain('牌友小林');
    expect(host.querySelector('.social-chat-messages')?.textContent).toContain('晚点见');
    expect(openConversation).toHaveBeenCalledWith('42');
    host.querySelector<HTMLButtonElement>('.social-chat-back')!.click();
    expect(closeConversation).toHaveBeenCalledTimes(1);
  });
});
