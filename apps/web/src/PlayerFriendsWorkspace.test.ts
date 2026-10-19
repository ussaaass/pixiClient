import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App as VueApp } from 'vue';
import type { SocialFriendsApplication } from './platform/social/friends-application';
import PlayerFriendsWorkspace from './components/PlayerFriendsWorkspace.vue';

describe('private message deep link', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host?.remove();
    vi.unstubAllGlobals();
  });

  it('opens a stranger conversation when it is not yet in the conversation list', async () => {
    const application = {
      listFriends: vi.fn(async () => []),
      ownProfile: vi.fn(async () => ({ userId: '10', displayName: '我', friendCode: 'MYCODE1234' })),
      listConversations: vi.fn(async () => []),
      openConversation: vi.fn(async () => ({ conversationId: 'conversation-1' })),
      listMessages: vi.fn(async () => ({ messages: [], peerIsFriend: false, canSend: true, requiresReply: false })),
    } as unknown as SocialFriendsApplication;
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerFriendsWorkspace, {
      application,
      mode: 'messages',
      currentUserId: '10',
      initialPeer: { userId: '20', displayName: '陈先生', friendCode: 'PROFILE8231' },
    });
    app.mount(host);

    await waitFor(() => Boolean(host.querySelector('.social-chat-panel')));
    expect(application.openConversation).toHaveBeenCalledWith('20');
    expect(host.querySelector('.social-chat-panel')?.getAttribute('aria-label')).toBe('与陈先生的私信');
    expect(host.textContent).toContain('陌生人每天先发一条文字开场消息');
  });

  it('hands a friend conversation to the full-screen messages route from the friends page', async () => {
    const peer = { userId: '20', displayName: '山茶同学', friendCode: 'SC7P3W9N2B', state: 'ACCEPTED', updatedAt: '2026-10-18T08:00:00.000Z' };
    const application = {
      listFriends: vi.fn(async () => [peer]),
      ownProfile: vi.fn(async () => ({ userId: '10', displayName: '我', friendCode: 'MYCODE1234' })),
      listConversations: vi.fn(async () => []),
      openConversation: vi.fn(async () => ({ conversationId: 'conversation-42' })),
      listMessages: vi.fn(async () => ({ messages: [], peerIsFriend: true, canSend: true, requiresReply: false })),
    } as unknown as SocialFriendsApplication;
    const onOpenPeerConversation = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerFriendsWorkspace, {
      application,
      mode: 'friends',
      currentUserId: '10',
      onOpenPeerConversation,
    });
    app.mount(host);

    await waitFor(() => Boolean(host.querySelector('.social-friend-row')));
    host.querySelector<HTMLButtonElement>('.social-friend-row button')!.click();
    await waitFor(() => onOpenPeerConversation.mock.calls.length === 1);

    expect(application.openConversation).toHaveBeenCalledWith('20');
    expect(onOpenPeerConversation).toHaveBeenCalledWith({ userId: '20', displayName: '山茶同学', friendCode: 'SC7P3W9N2B', conversationId: 'conversation-42' });
  });

  it('opens typed attachment options and searches loaded chat messages', async () => {
    mountFriendChat([
      { messageId: '31', body: '周末来打牌吗' },
      { messageId: '32', body: '我带一副新牌' },
    ]);
    await waitFor(() => Boolean(host.querySelector('.social-chat-panel')));

    host.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.click();
    await waitFor(() => Boolean(host.querySelector('.social-attachment-menu')));
    expect(host.querySelector('.social-attachment-menu')?.textContent).toContain('照片、动图或视频');
    expect(host.querySelector('.social-attachment-menu')?.textContent).toContain('语音消息');

    host.querySelector<HTMLButtonElement>('[aria-label="搜索聊天消息"]')!.click();
    await waitFor(() => Boolean(host.querySelector('[aria-label="搜索当前已加载的消息"]')));
    const input = host.querySelector<HTMLInputElement>('[aria-label="搜索当前已加载的消息"]')!;
    input.value = '新牌';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => host.querySelectorAll('.social-chat-messages article').length === 1);
    expect(host.querySelector('.social-chat-messages')?.textContent).toContain('我带一副新牌');
    expect(host.querySelector('.social-chat-messages')?.textContent).not.toContain('周末来打牌吗');
  });

  it('records a voice message into the encrypted-attachment preview flow', async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
    class FakeMediaRecorder {
      state: RecordingState = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;
      static isTypeSupported(): boolean { return true; }
      start(): void { this.state = 'recording'; }
      stop(): void {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' }) } as BlobEvent);
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    mountFriendChat([]);
    await waitFor(() => Boolean(host.querySelector('.social-chat-panel')));

    host.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.click();
    await waitFor(() => Boolean(host.querySelector('.social-attachment-menu')));
    host.querySelector<HTMLButtonElement>('.social-attachment-menu [role="menuitem"]:nth-child(2)')!.click();
    await waitFor(() => Boolean(host.querySelector('.social-voice-recording')));
    host.querySelector<HTMLButtonElement>('.social-voice-recording button')!.click();
    await waitFor(() => Boolean(host.querySelector('.social-message-pending-attachments audio')));
    expect(host.querySelector('.social-message-pending-attachments')?.textContent).toContain('voice-message-');
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  function mountFriendChat(messages: { messageId: string; body: string }[]): void {
    const application = {
      listFriends: vi.fn(async () => [{ userId: '20', displayName: '陈先生', friendCode: 'PROFILE8231', state: 'ACCEPTED', updatedAt: '2026-10-18T08:00:00.000Z' }]),
      ownProfile: vi.fn(async () => ({ userId: '10', displayName: '我', friendCode: 'MYCODE1234' })),
      listConversations: vi.fn(async () => []),
      openConversation: vi.fn(async () => ({ conversationId: '21' })),
      listMessages: vi.fn(async () => ({
        conversationId: '21',
        messages: messages.map((message) => ({ ...message, conversationId: '21', clientMessageId: `00000000-0000-4000-8000-${message.messageId.padStart(12, '0')}`, senderUserId: '20', createdAt: '2026-10-18T08:00:00.000Z' })),
        peerIsFriend: true,
        canSend: true,
        requiresReply: false,
      })),
      uploadAttachment: vi.fn(async () => ({ assetId: '701', kind: 3, mimeType: 'audio/webm', fileName: 'voice-message.webm', byteSize: 4 })),
      sendMessage: vi.fn(async () => ({})),
    } as unknown as SocialFriendsApplication;
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerFriendsWorkspace, {
      application,
      mode: 'messages',
      currentUserId: '10',
      initialPeer: { userId: '20', displayName: '陈先生', friendCode: 'PROFILE8231' },
    });
    app.mount(host);
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('UI state did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
