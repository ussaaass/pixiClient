import type { FriendLookupResponseDto, SocialFriendDto, SocialMessageDto, SocialMessageListResponseDto, SocialOwnProfileResponseDto } from '@gameing/contracts/social';

export type FriendshipState = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REMOVED';
export type FriendshipRecord = { pairKey: string; lowUserId: string; highUserId: string; requesterUserId: string; state: FriendshipState; updatedAt: string };
export type ConversationRecord = { conversationId: string; pairKey: string; lowUserId: string; highUserId: string; updatedAt: string };

export interface SocialFriendsRepositoryPort {
  getOwnProfile(userId: string): Promise<SocialOwnProfileResponseDto | null>;
  findUserByExactUsername(username: string): Promise<SocialOwnProfileResponseDto | null>;
  findUserByFriendCode(friendCode: string): Promise<SocialOwnProfileResponseDto | null>;
  listFriendships(userId: string): Promise<FriendshipRecord[]>;
  getFriendship(pairKey: string): Promise<FriendshipRecord | null>;
  saveFriendship(friendship: FriendshipRecord): Promise<void>;
  findConversationByPair(pairKey: string): Promise<ConversationRecord | null>;
  getConversation(conversationId: string): Promise<ConversationRecord | null>;
  saveConversation(conversation: ConversationRecord): Promise<void>;
  listMessages(conversationId: string): Promise<SocialMessageDto[]>;
  findMessageByClientId(clientMessageId: string): Promise<SocialMessageDto | null>;
  saveMessage(message: SocialMessageDto): Promise<void>;
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
      const profile = await this.repository.getOwnProfile(otherId);
      if (!profile) continue;
      const state = relation.state === 'ACCEPTED' ? 'ACCEPTED' : relation.requesterUserId === actorId ? 'PENDING_OUTGOING' : 'PENDING_INCOMING';
      result.push({ ...profile, state, updatedAt: relation.updatedAt });
    }
    return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async requestFriend(actorId: string, otherId: string): Promise<{ accepted: boolean }> {
    if (actorId === otherId) throw new Error('SELF_FRIEND_REQUEST');
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
    const pair = this.pair(actorId, otherId);
    if ((await this.repository.getFriendship(pair.pairKey))?.state !== 'ACCEPTED') throw new Error('SOCIAL_FRIENDSHIP_REQUIRED');
    const current = await this.repository.findConversationByPair(pair.pairKey);
    if (current) return { conversationId: current.conversationId };
    const conversationId = await this.repository.createId();
    await this.repository.saveConversation({ conversationId, ...pair, updatedAt: this.repository.now() });
    return { conversationId };
  }

  async listMessages(actorId: string, conversationId: string): Promise<SocialMessageListResponseDto> {
    const conversation = await this.memberConversation(actorId, conversationId);
    return { conversationId, messages: await this.repository.listMessages(conversation.conversationId) };
  }

  async sendMessage(actorId: string, conversationId: string, clientMessageId: string, body: string): Promise<SocialMessageDto> {
    const conversation = await this.memberConversation(actorId, conversationId);
    if ((await this.repository.getFriendship(conversation.pairKey))?.state !== 'ACCEPTED') throw new Error('SOCIAL_FRIENDSHIP_REQUIRED');
    const duplicate = await this.repository.findMessageByClientId(clientMessageId);
    if (duplicate) {
      if (duplicate.conversationId !== conversationId || duplicate.senderUserId !== actorId) throw new Error('IDEMPOTENCY_KEY_REUSED');
      return duplicate;
    }
    const cleanBody = body.trim();
    if (!cleanBody || cleanBody.length > 2000) throw new Error('SOCIAL_MESSAGE_INVALID');
    const message: SocialMessageDto = { messageId: await this.repository.createId(), conversationId, clientMessageId, senderUserId: actorId, body: cleanBody, createdAt: this.repository.now() };
    await this.repository.saveMessage(message);
    return message;
  }

  private async memberConversation(actorId: string, conversationId: string): Promise<ConversationRecord> {
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation || (conversation.lowUserId !== actorId && conversation.highUserId !== actorId)) throw new Error('SOCIAL_CONVERSATION_NOT_FOUND');
    return conversation;
  }
}
