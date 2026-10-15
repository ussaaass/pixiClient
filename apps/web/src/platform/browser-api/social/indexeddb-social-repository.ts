import type { SocialMessageDto, SocialOwnProfileResponseDto, SocialPostDto, SocialPostReplyDto, SocialTopicDto } from '@gameing/contracts/social';
import type { BrowserDevelopmentDatabase, LocalSocialContent, LocalSocialConversation, LocalSocialFriendship, LocalSocialMessage, LocalUser } from '../database';
import type { ConversationRecord, FriendshipRecord, SocialFriendsRepositoryPort } from '../../social/social-friends-use-cases';
import type { SocialRepositoryPort } from '../../social/social-application';
import type { SocialAccessRepositoryPort } from '../../social/social-access-policy';
import { RewardType } from '@gameing/contracts/referral';

const FRIEND_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const SOCIAL_CONTENT_TYPE = { POST: 1, REPLY: 2 } as const;
const LOCAL_TOPICS: SocialTopicDto[] = [
  { topicId: '7101', topicKey: 'SHISANSHUI_STRATEGY', title: '十三张牌型讨论', description: '聊聊摆牌思路与牌型取舍。', status: 'ACTIVE' },
  { topicId: '7102', topicKey: 'GAME_EXPERIENCE', title: '游戏心得', description: '记录本地练习中的发现。', status: 'ACTIVE' },
  { topicId: '7103', topicKey: 'HALL_CHAT', title: '大厅交流', description: '分享对游戏大厅的建议。', status: 'ACTIVE' },
];

export class IndexedDbSocialRepository implements SocialFriendsRepositoryPort, SocialRepositoryPort, SocialAccessRepositoryPort {
  constructor(
    private readonly database: BrowserDevelopmentDatabase,
    private readonly getActor: () => { userId: string; displayName: string } | null = () => null,
  ) {}

  async currentActor(): Promise<{ userId: string; displayName: string } | null> {
    const actor = this.getActor();
    if (!actor || !/^[1-9][0-9]{0,19}$/.test(actor.userId) || !actor.displayName.trim()) return null;
    return { userId: actor.userId, displayName: actor.displayName.trim().slice(0, 48) };
  }

  async directParentRewardType(userId: string): Promise<import('@gameing/contracts/referral').RewardTypeValue | null> {
    const binding = await this.database.get('referral_bindings', userId);
    if (!binding) return null;
    const parent = await this.database.get('users', binding.parent1UserId);
    return parent?.rewardType ?? RewardType.RECHARGE_REBATE;
  }

  async listTopics(): Promise<SocialTopicDto[]> {
    return LOCAL_TOPICS.map((topic) => ({ ...topic }));
  }

  async findTopic(topicKey: string): Promise<SocialTopicDto | null> {
    const topic = LOCAL_TOPICS.find((item) => item.topicKey === topicKey);
    return topic ? { ...topic } : null;
  }

  async listPosts(topicKey: string): Promise<SocialPostDto[]> {
    const rows = await this.database.getAllFromIndex('social_content', 'by-topic-created', IDBKeyRange.bound([topicKey, ''], [topicKey, '\uffff']));
    const actor = await this.currentActor();
    return rows.filter((row) => row.contentType === SOCIAL_CONTENT_TYPE.POST && row.post)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.contentId.localeCompare(left.contentId))
      .map((row) => this.toPost(row, actor?.userId));
  }

  async findPost(postId: string): Promise<SocialPostDto | null> {
    const row = await this.database.get('social_content', postId);
    if (!row || row.contentType !== SOCIAL_CONTENT_TYPE.POST || !row.post) return null;
    const actor = await this.currentActor();
    return this.toPost(row, actor?.userId);
  }

  async savePost(post: SocialPostDto): Promise<void> {
    const actor = await this.currentActor();
    if (!actor) throw new Error('SOCIAL_ACTOR_REQUIRED');
    const row: LocalSocialContent = {
      contentId: post.postId,
      contentType: SOCIAL_CONTENT_TYPE.POST,
      topicKey: post.topicKey,
      postId: post.postId,
      ownerUserId: actor.userId,
      createdAt: post.createdAt,
      post: { ...post, authorLabel: actor.displayName, isOwnPost: true, assetIds: [...post.assetIds] },
    };
    await this.database.add('social_content', row);
  }

  async listReplies(postId: string): Promise<SocialPostReplyDto[]> {
    const rows = await this.database.getAllFromIndex('social_content', 'by-post-created', IDBKeyRange.bound([postId, ''], [postId, '\uffff']));
    const actor = await this.currentActor();
    return rows.filter((row) => row.contentType === SOCIAL_CONTENT_TYPE.REPLY && row.reply)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.contentId.localeCompare(right.contentId))
      .map((row) => this.toReply(row, actor?.userId));
  }

  async findReply(replyId: string): Promise<SocialPostReplyDto | null> {
    const row = await this.database.get('social_content', replyId);
    if (!row || row.contentType !== SOCIAL_CONTENT_TYPE.REPLY || !row.reply) return null;
    const actor = await this.currentActor();
    return this.toReply(row, actor?.userId);
  }

  async saveReply(reply: SocialPostReplyDto): Promise<void> {
    const [actor, post] = await Promise.all([this.currentActor(), this.database.get('social_content', reply.postId)]);
    if (!actor) throw new Error('SOCIAL_ACTOR_REQUIRED');
    if (!post || post.contentType !== SOCIAL_CONTENT_TYPE.POST || !post.post) throw new Error('SOCIAL_POST_NOT_FOUND');
    const row: LocalSocialContent = {
      contentId: reply.replyId,
      contentType: SOCIAL_CONTENT_TYPE.REPLY,
      topicKey: post.topicKey,
      postId: reply.postId,
      ownerUserId: actor.userId,
      createdAt: reply.createdAt,
      reply: { ...reply, authorLabel: actor.displayName, isOwnReply: true, assetIds: [...reply.assetIds] },
    };
    await this.database.add('social_content', row);
  }

  now(): string { return new Date().toISOString(); }

  async createId(): Promise<string> {
    const tx = this.database.transaction('settings', 'readwrite');
    const current = await tx.store.get('next-id');
    const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
    await tx.store.put({ key: 'next-id', value: (id + 1n).toString() });
    await tx.done;
    return id.toString();
  }

  private toPost(row: LocalSocialContent, actorUserId: string | undefined): SocialPostDto {
    if (!row.post) throw new Error('SOCIAL_POST_RECORD_INVALID');
    return { ...row.post, isOwnPost: row.ownerUserId === actorUserId, assetIds: [...row.post.assetIds] };
  }

  private toReply(row: LocalSocialContent, actorUserId: string | undefined): SocialPostReplyDto {
    if (!row.reply) throw new Error('SOCIAL_REPLY_RECORD_INVALID');
    return { ...row.reply, isOwnReply: row.ownerUserId === actorUserId, assetIds: [...row.reply.assetIds] };
  }

  async getOwnProfile(userId: string): Promise<SocialOwnProfileResponseDto | null> {
    const user = await this.database.get('users', userId);
    if (!user || user.status !== 'ACTIVE') return null;
    return this.ensureProfile(user);
  }

  async findUserByExactUsername(username: string): Promise<SocialOwnProfileResponseDto | null> {
    const credential = await this.database.getFromIndex('credentials', 'by-lookup', username.trim().toLocaleLowerCase());
    if (credential?.state !== 'ACTIVE' || credential.identifierType !== 'USERNAME') return null;
    return this.getOwnProfile(credential.userId);
  }

  async findUserByFriendCode(friendCode: string): Promise<SocialOwnProfileResponseDto | null> {
    const user = await this.database.getFromIndex('users', 'by-friend-code', friendCode);
    return user ? this.getOwnProfile(user.userId) : null;
  }

  async listFriendships(userId: string): Promise<FriendshipRecord[]> {
    const [low, high] = await Promise.all([
      this.database.getAllFromIndex('social_friendships', 'by-low', userId),
      this.database.getAllFromIndex('social_friendships', 'by-high', userId),
    ]);
    return [...new Map([...low, ...high].map((row) => [row.pairKey, row])).values()];
  }

  getFriendship(pairKey: string): Promise<FriendshipRecord | null> {
    return this.database.get('social_friendships', pairKey).then((row) => row ?? null);
  }

  async saveFriendship(friendship: FriendshipRecord): Promise<void> {
    await this.database.put('social_friendships', friendship as LocalSocialFriendship);
  }

  async findConversationByPair(pairKey: string): Promise<ConversationRecord | null> {
    const row = await this.database.getFromIndex('social_conversations', 'by-pair', pairKey);
    return row ?? null;
  }

  async getConversation(conversationId: string): Promise<ConversationRecord | null> {
    return (await this.database.get('social_conversations', conversationId)) ?? null;
  }

  async saveConversation(conversation: ConversationRecord): Promise<void> {
    await this.database.put('social_conversations', conversation as LocalSocialConversation);
  }

  async listMessages(conversationId: string): Promise<SocialMessageDto[]> {
    const rows = await this.database.getAllFromIndex('social_messages', 'by-conversation', IDBKeyRange.bound([conversationId, ''], [conversationId, '\uffff']));
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100).map((row) => this.toDto(row));
  }

  async findMessageByClientId(clientMessageId: string): Promise<SocialMessageDto | null> {
    const row = await this.database.getFromIndex('social_messages', 'by-client-id', clientMessageId);
    return row ? this.toDto(row) : null;
  }

  async saveMessage(message: SocialMessageDto): Promise<void> {
    const tx = this.database.transaction(['social_messages', 'social_conversations'], 'readwrite');
    const conversations = tx.objectStore('social_conversations');
    const conversation = await conversations.get(message.conversationId);
    if (!conversation) { tx.abort(); throw new Error('SOCIAL_CONVERSATION_NOT_FOUND'); }
    await tx.objectStore('social_messages').put({ ...message } satisfies LocalSocialMessage);
    await conversations.put({ ...conversation, updatedAt: message.createdAt });
    await tx.done;
  }

  private async ensureProfile(user: LocalUser): Promise<SocialOwnProfileResponseDto> {
    if (user.friendCode) return { userId: user.userId, displayName: user.displayName, friendCode: user.friendCode };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(10));
      const friendCode = Array.from(bytes, (byte) => FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length]).join('');
      if (await this.database.getFromIndex('users', 'by-friend-code', friendCode)) continue;
      const updated = { ...user, friendCode };
      try {
        await this.database.put('users', updated);
        return { userId: updated.userId, displayName: updated.displayName, friendCode };
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error;
      }
    }
    throw new Error('FRIEND_CODE_ALLOCATION_FAILED');
  }

  private toDto(row: LocalSocialMessage): SocialMessageDto {
    return { messageId: row.messageId, conversationId: row.conversationId, clientMessageId: row.clientMessageId, senderUserId: row.senderUserId, body: row.body, createdAt: row.createdAt };
  }
}
