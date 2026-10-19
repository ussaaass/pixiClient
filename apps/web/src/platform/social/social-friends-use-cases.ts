import { SocialMessageAttachmentKind, type FriendLookupResponseDto, type SocialConversationListResponseDto, type SocialFriendDto, type SocialMessageAttachmentDto, type SocialMessageDto, type SocialMessageListResponseDto, type SocialOwnProfileResponseDto } from '@gameing/contracts/social';

export type FriendshipState = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REMOVED';
export type FriendshipRecord = { pairKey: string; lowUserId: string; highUserId: string; requesterUserId: string; state: FriendshipState; updatedAt: string };
export type ConversationRecord = { conversationId: string; pairKey: string; lowUserId: string; highUserId: string; updatedAt: string; pendingFirstMessageUserId?: string; openMessagingDay?: string };

export interface SocialFriendsRepositoryPort {
  getOwnProfile(userId: string): Promise<SocialOwnProfileResponseDto | null>;
  findUserByExactUsername(username: string): Promise<SocialOwnProfileResponseDto | null>;
  findUserByFriendCode(friendCode: string): Promise<SocialOwnProfileResponseDto | null>;
  listFriendships(userId: string): Promise<FriendshipRecord[]>;
  isUserBlocked(userId: string, otherUserId: string): Promise<boolean>;
  getFriendship(pairKey: string): Promise<FriendshipRecord | null>;
  saveFriendship(friendship: FriendshipRecord): Promise<void>;
  findConversationByPair(pairKey: string): Promise<ConversationRecord | null>;
  getConversation(conversationId: string): Promise<ConversationRecord | null>;
  listConversations(userId: string): Promise<ConversationRecord[]>;
  saveConversation(conversation: ConversationRecord): Promise<void>;
  listMessages(conversationId: string): Promise<SocialMessageDto[]>;
  findMessageByClientId(clientMessageId: string): Promise<SocialMessageDto | null>;
  saveMessage(message: SocialMessageDto, conversation?: ConversationRecord): Promise<void>;
  canSendMessageAssets(senderUserId: string, recipientUserId: string, assetIds: string[]): Promise<boolean>;
  isUserBlocked(userId: string, otherUserId: string): Promise<boolean>;
  createId(): Promise<string>;
  now(): string;
}

export class SocialFriendsUseCases {
  constructor(private readonly repository: SocialFriendsRepositoryPort) {}

  private pair(left: string, right: string): { pairKey: string; lowUserId: string; highUserId: string } {
    const lowUserId = BigInt(left) < BigInt(right) ? left : right;
    const highUserId = lowUserId === left ? right : left;
    return { pairKey: `${lowUserId}:${highUserId}`, lowUserId, highUserId };
  }

  async ownProfile(userId: string): Promise<SocialOwnProfileResponseDto> {
    const profile = await this.repository.getOwnProfile(userId);
    if (!profile) throw new Error('SOCIAL_USER_NOT_FOUND');
    return profile;
  }

  async lookup(actorId: string, value: string): Promise<FriendLookupResponseDto> {
    const query = value.trim();
    if (query.length < 3 || query.length > 64) return [];
    const profile = await this.repository.findUserByExactUsername(query) ?? await this.repository.findUserByFriendCode(query.replace(/^LG-FRIEND:/i, '').toUpperCase());
    if (!profile || profile.userId === actorId) return [];
    return [profile];
  }

  async listFriends(actorId: string): Promise<SocialFriendDto[]> {
    const result: SocialFriendDto[] = [];
    for (const relation of await this.repository.listFriendships(actorId)) {
      if (relation.state === 'REJECTED' || relation.state === 'REMOVED') continue;
      const otherId = relation.lowUserId === actorId ? relation.highUserId : relation.lowUserId;
      if (await this.repository.isUserBlocked(actorId, otherId)) continue;
      const profile = await this.repository.getOwnProfile(otherId);
      if (!profile) continue;
      const state = relation.state === 'ACCEPTED' ? 'ACCEPTED' : relation.requesterUserId === actorId ? 'PENDING_OUTGOING' : 'PENDING_INCOMING';
      result.push({ ...profile, state, updatedAt: relation.updatedAt });
    }
    return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async requestFriend(actorId: string, otherId: string): Promise<{ accepted: boolean }> {
    if (actorId === otherId) throw new Error('SELF_FRIEND_REQUEST');
    if (await this.repository.isUserBlocked(actorId, otherId)) throw new Error('SOCIAL_USER_BLOCKED');
    if (!await this.repository.getOwnProfile(otherId)) throw new Error('SOCIAL_USER_NOT_FOUND');
    const pair = this.pair(actorId, otherId);
    const existing = await this.repository.getFriendship(pair.pairKey);
    if (existing?.state === 'ACCEPTED') return { accepted: true };
    if (existing?.state === 'PENDING' && existing.requesterUserId !== actorId) return { accepted: false };
    await this.repository.saveFriendship({ ...pair, requesterUserId: actorId, state: 'PENDING', updatedAt: this.repository.now() });
    return { accepted: false };
  }

  async acceptFriend(actorId: string, otherId: string): Promise<{ accepted: boolean }> {
    return this.transitionIncoming(actorId, otherId, 'ACCEPTED');
  }

  async rejectFriend(actorId: string, otherId: string): Promise<{ accepted: boolean }> {
    return this.transitionIncoming(actorId, otherId, 'REJECTED');
  }

  private async transitionIncoming(actorId: string, otherId: string, state: 'ACCEPTED' | 'REJECTED'): Promise<{ accepted: boolean }> {
    if (await this.repository.isUserBlocked(actorId, otherId)) throw new Error('SOCIAL_USER_BLOCKED');
    const relation = await this.repository.getFriendship(this.pair(actorId, otherId).pairKey);
    if (!relation || relation.state !== 'PENDING' || relation.requesterUserId === actorId) throw new Error('FRIEND_REQUEST_NOT_FOUND');
    await this.repository.saveFriendship({ ...relation, state, updatedAt: this.repository.now() });
    return { accepted: state === 'ACCEPTED' };
  }

  async removeFriend(actorId: string, otherId: string): Promise<{ accepted: boolean }> {
    const relation = await this.repository.getFriendship(this.pair(actorId, otherId).pairKey);
    if (!relation || relation.state !== 'ACCEPTED') throw new Error('FRIEND_REQUEST_NOT_FOUND');
    await this.repository.saveFriendship({ ...relation, state: 'REMOVED', updatedAt: this.repository.now() });
    return { accepted: true };
  }

  async openConversation(actorId: string, otherId: string): Promise<{ conversationId: string }> {
    if (await this.repository.isUserBlocked(actorId, otherId)) throw new Error('SOCIAL_USER_BLOCKED');
    const pair = this.pair(actorId, otherId);
    const current = await this.repository.findConversationByPair(pair.pairKey);
    if (current) return { conversationId: current.conversationId };
    const conversationId = await this.repository.createId();
    await this.repository.saveConversation({ conversationId, ...pair, updatedAt: this.repository.now() });
    return { conversationId };
  }

  async listConversations(actorId: string): Promise<SocialConversationListResponseDto> {
    const result: SocialConversationListResponseDto = [];
    for (const conversation of await this.repository.listConversations(actorId)) {
      const peerUserId = conversation.lowUserId === actorId ? conversation.highUserId : conversation.lowUserId;
      if (await this.repository.isUserBlocked(actorId, peerUserId)) continue;
      const peer = await this.repository.getOwnProfile(peerUserId);
      if (!peer) continue;
      const [messages, friendship] = await Promise.all([
        this.repository.listMessages(conversation.conversationId),
        this.repository.getFriendship(conversation.pairKey),
      ]);
      const last = messages.at(-1);
      const preview = last?.body || (last?.attachments?.some((attachment) => attachment.kind === SocialMessageAttachmentKind.AUDIO) ? '[语音]' : last?.attachments?.some((attachment) => attachment.kind === SocialMessageAttachmentKind.VIDEO) ? '[视频]' : last?.attachments?.length ? '[图片/动图]' : '');
      result.push({ conversationId: conversation.conversationId, peerUserId, peerDisplayName: peer.displayName, peerFriendCode: peer.friendCode, peerIsFriend: friendship?.state === 'ACCEPTED', ...(last ? { lastMessage: preview, lastMessageAt: last.createdAt } : {}) });
    }
    return result.sort((left, right) => (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? ''));
  }

  async listMessages(actorId: string, conversationId: string): Promise<SocialMessageListResponseDto> {
    const conversation = await this.memberConversation(actorId, conversationId);
    const peerUserId = conversation.lowUserId === actorId ? conversation.highUserId : conversation.lowUserId;
    if (await this.repository.isUserBlocked(actorId, peerUserId)) throw new Error('SOCIAL_USER_BLOCKED');
    const friendship = await this.repository.getFriendship(conversation.pairKey);
    const isFriend = friendship?.state === 'ACCEPTED';
    const today = socialPolicyDay(this.repository.now());
    const requiresReply = !isFriend && Boolean(conversation.pendingFirstMessageUserId && conversation.pendingFirstMessageUserId !== actorId);
    const canSend = friendship?.state !== 'REMOVED' && (isFriend || conversation.openMessagingDay === today || !conversation.pendingFirstMessageUserId);
    return { conversationId: conversation.conversationId, messages: await this.repository.listMessages(conversation.conversationId), peerIsFriend: isFriend, canSend, requiresReply };
  }

  async sendMessage(actorId: string, conversationId: string, clientMessageId: string, body: string, attachments: SocialMessageAttachmentDto[] = []): Promise<SocialMessageDto> {
    const conversation = await this.memberConversation(actorId, conversationId);
    const peerUserId = conversation.lowUserId === actorId ? conversation.highUserId : conversation.lowUserId;
    if (await this.repository.isUserBlocked(actorId, peerUserId)) throw new Error('SOCIAL_USER_BLOCKED');
    const friendship = await this.repository.getFriendship(conversation.pairKey);
    if (friendship?.state === 'REMOVED') throw new Error('SOCIAL_FRIENDSHIP_REMOVED');
    const isFriend = friendship?.state === 'ACCEPTED';
    const duplicate = await this.repository.findMessageByClientId(clientMessageId);
    if (duplicate) {
      if (duplicate.conversationId !== conversationId || duplicate.senderUserId !== actorId) throw new Error('IDEMPOTENCY_KEY_REUSED');
      return duplicate;
    }
    const cleanBody = body.trim();
    if ((!cleanBody && !attachments.length) || cleanBody.length > 2000 || attachments.length > 4) throw new Error('SOCIAL_MESSAGE_INVALID');
    if (attachments.length && !isFriend) throw new Error('SOCIAL_ATTACHMENT_FRIENDS_ONLY');
    if (attachments.length && !await this.repository.canSendMessageAssets(actorId, peerUserId, attachments.map((attachment) => attachment.assetId))) throw new Error('SOCIAL_ATTACHMENT_INVALID');
    const createdAt = this.repository.now();
    const day = socialPolicyDay(createdAt);
    let nextConversation = conversation;
    if (!isFriend && conversation.openMessagingDay !== day) {
      if (conversation.pendingFirstMessageUserId) {
        if (conversation.pendingFirstMessageUserId === actorId) throw new Error('SOCIAL_FIRST_CONTACT_WAITING_FOR_REPLY');
        const { pendingFirstMessageUserId: _pending, ...withoutPending } = conversation;
        nextConversation = { ...withoutPending, openMessagingDay: day };
      } else {
        const { openMessagingDay: _openDay, ...withoutOpenDay } = conversation;
        nextConversation = { ...withoutOpenDay, pendingFirstMessageUserId: actorId };
      }
    }
    const message: SocialMessageDto = { messageId: await this.repository.createId(), conversationId, clientMessageId, senderUserId: actorId, body: cleanBody, ...(attachments.length ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}), createdAt };
    await this.repository.saveMessage(message, { ...nextConversation, updatedAt: createdAt });
    return message;
  }

  private async memberConversation(actorId: string, conversationId: string): Promise<ConversationRecord> {
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation || (conversation.lowUserId !== actorId && conversation.highUserId !== actorId)) throw new Error('SOCIAL_CONVERSATION_NOT_FOUND');
    return conversation;
  }
}

export function socialPolicyDay(utcTimestamp: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(utcTimestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
