import { describe, expect, it } from 'vitest';
import { SocialMessageAttachmentKind, type SocialMessageAttachmentDto } from '@gameing/contracts/social';
import { SocialFriendsUseCases, type ConversationRecord, type SocialFriendsRepositoryPort } from './social-friends-use-cases';

describe('SocialFriendsUseCases stranger messaging policy', () => {
  it('allows one opener, then both participants can message until Shanghai midnight after a reply', async () => {
    let now = '2026-10-16T02:00:00.000Z';
    let conversation: ConversationRecord = { conversationId: '1', pairKey: '10:20', lowUserId: '10', highUserId: '20', updatedAt: now };
    const messages: Array<{ messageId: string; conversationId: string; clientMessageId: string; senderUserId: string; body: string; createdAt: string }> = [];
    const repository = {
      getConversation: async () => conversation,
      getFriendship: async () => null,
      findMessageByClientId: async (clientMessageId: string) => messages.find((message) => message.clientMessageId === clientMessageId) ?? null,
      saveMessage: async (message: (typeof messages)[number], updated?: ConversationRecord) => { messages.push(message); if (updated) conversation = updated; },
      isUserBlocked: async () => false,
      createId: async () => String(messages.length + 1),
      now: () => now,
    } as unknown as SocialFriendsRepositoryPort;
    const useCases = new SocialFriendsUseCases(repository);

    await useCases.sendMessage('10', '1', 'open-1', '你好');
    await expect(useCases.sendMessage('10', '1', 'open-2', '再发一条')).rejects.toThrow('SOCIAL_FIRST_CONTACT_WAITING_FOR_REPLY');
    await useCases.sendMessage('20', '1', 'reply-1', '你好，欢迎交流');
    await useCases.sendMessage('10', '1', 'same-day-1', '谢谢');

    now = '2026-10-16T16:00:00.000Z'; // Shanghai 2026-10-17
    await useCases.sendMessage('10', '1', 'next-day-open', '第二天再问一个问题');
    await expect(useCases.sendMessage('10', '1', 'next-day-extra', '连续第二条')).rejects.toThrow('SOCIAL_FIRST_CONTACT_WAITING_FOR_REPLY');
  });

  it('blocks friend requests and conversation reads/writes when either user blocked the other', async () => {
    const conversation: ConversationRecord = { conversationId: '1', pairKey: '10:20', lowUserId: '10', highUserId: '20', updatedAt: '2026-10-16T02:00:00.000Z' };
    const repository = {
      isUserBlocked: async () => true,
      getOwnProfile: async () => ({ userId: '20', displayName: '牌友', friendCode: 'PLAYER2020' }),
      getConversation: async () => conversation,
      findConversationByPair: async () => null,
    } as unknown as SocialFriendsRepositoryPort;
    const useCases = new SocialFriendsUseCases(repository);

    await expect(useCases.requestFriend('10', '20')).rejects.toThrow('SOCIAL_USER_BLOCKED');
    await expect(useCases.openConversation('10', '20')).rejects.toThrow('SOCIAL_USER_BLOCKED');
    await expect(useCases.listMessages('10', '1')).rejects.toThrow('SOCIAL_USER_BLOCKED');
    await expect(useCases.sendMessage('10', '1', 'message-1', '你好')).rejects.toThrow('SOCIAL_USER_BLOCKED');
  });

  it('allows encrypted media references only between friends and retains attachment metadata on the message', async () => {
    const now = '2026-10-18T08:00:00.000Z';
    const conversation: ConversationRecord = { conversationId: '1', pairKey: '10:20', lowUserId: '10', highUserId: '20', updatedAt: now };
    const saved: unknown[] = [];
    const attachments: SocialMessageAttachmentDto[] = [
      { assetId: '301', kind: SocialMessageAttachmentKind.IMAGE, mimeType: 'image/gif', fileName: '牌桌.gif', byteSize: 2048 },
      { assetId: '303', kind: SocialMessageAttachmentKind.AUDIO, mimeType: 'audio/webm', fileName: 'voice-message.webm', byteSize: 4096 },
    ];
    const repository = {
      getConversation: async () => conversation,
      getFriendship: async () => ({ pairKey: '10:20', lowUserId: '10', highUserId: '20', requesterUserId: '10', state: 'ACCEPTED', updatedAt: now }),
      findMessageByClientId: async () => null,
      saveMessage: async (message: unknown) => { saved.push(message); },
      canSendMessageAssets: async () => true,
      isUserBlocked: async () => false,
      createId: async () => '302',
      now: () => now,
    } as unknown as SocialFriendsRepositoryPort;
    const useCases = new SocialFriendsUseCases(repository);
    const result = await useCases.sendMessage('10', '1', 'attachment-client-key', '', attachments);
    expect(result.attachments).toEqual(attachments);
    expect(saved).toHaveLength(1);
  });

  it('keeps stranger openers text-only', async () => {
    const now = '2026-10-18T08:00:00.000Z';
    const repository = {
      getConversation: async () => ({ conversationId: '1', pairKey: '10:20', lowUserId: '10', highUserId: '20', updatedAt: now }),
      getFriendship: async () => null,
      findMessageByClientId: async () => null,
      saveMessage: async () => undefined,
      canSendMessageAssets: async () => true,
      isUserBlocked: async () => false,
      createId: async () => '302',
      now: () => now,
    } as unknown as SocialFriendsRepositoryPort;
    const useCases = new SocialFriendsUseCases(repository);
    await expect(useCases.sendMessage('10', '1', 'cold-attachment-key', '', [{ assetId: '301', kind: SocialMessageAttachmentKind.IMAGE, mimeType: 'image/png', fileName: 'a.png', byteSize: 100 }])).rejects.toThrow('SOCIAL_ATTACHMENT_FRIENDS_ONLY');
  });
});
