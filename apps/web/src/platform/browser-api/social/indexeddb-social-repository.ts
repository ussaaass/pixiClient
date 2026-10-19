import type { SocialContentActionRequestDto, SocialContentActionStateDto, SocialMessageDto, SocialOwnProfileResponseDto, SocialPostDto, SocialPostReplyDto, SocialPublicProfileDto, SocialPublicProfileRelationshipValue, SocialTopicDto } from '@gameing/contracts/social';
import type { BrowserDevelopmentDatabase, LocalEncryptedAsset, LocalSocialContent, LocalSocialConversation, LocalSocialFriendship, LocalSocialInteraction, LocalSocialMessage, LocalUser } from '../database';
import type { EncryptedMessageAsset, SocialMessageAssetRepository } from '../../assets/social-message-asset-application';
import type { ConversationRecord, FriendshipRecord, SocialFriendsRepositoryPort } from '../../social/social-friends-use-cases';
import type { SocialRepositoryPort } from '../../social/social-application';
import type { SocialAccessRepositoryPort } from '../../social/social-access-policy';
import { RewardType } from '@gameing/contracts/referral';
import { ensureLocalDemoCommunity, ensureLocalDemoSocialUsers, localDemoProfileOutcomes } from './local-demo-social-seed';
import { CoinMarketTradeStatus } from '@gameing/contracts/coin-market';

const FRIEND_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const SOCIAL_CONTENT_TYPE = { POST: 1, REPLY: 2 } as const;
const LOCAL_TOPICS: SocialTopicDto[] = [
  { topicId: '7101', topicKey: 'SHISANSHUI_STRATEGY', title: '十三张牌型讨论', description: '聊聊摆牌思路与牌型取舍。', status: 'ACTIVE' },
  { topicId: '7102', topicKey: 'GAME_EXPERIENCE', title: '游戏心得', description: '记录本地练习中的发现。', status: 'ACTIVE' },
  { topicId: '7103', topicKey: 'HALL_CHAT', title: '大厅交流', description: '分享对游戏大厅的建议。', status: 'ACTIVE' },
];

export class IndexedDbSocialRepository implements SocialFriendsRepositoryPort, SocialRepositoryPort, SocialAccessRepositoryPort, SocialMessageAssetRepository {
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
    const actorForSeed = await this.currentActor();
    if (actorForSeed) await ensureLocalDemoCommunity(this.database, actorForSeed.userId, actorForSeed.displayName);
    const rows = await this.database.getAllFromIndex('social_content', 'by-topic-created', IDBKeyRange.bound([topicKey, ''], [topicKey, '\uffff']));
    const actor = await this.currentActor();
    const visibleRows: LocalSocialContent[] = [];
    for (const row of rows) {
      if (row.contentType !== SOCIAL_CONTENT_TYPE.POST || !row.post) continue;
      if (actor && await this.isUserBlocked(actor.userId, row.ownerUserId)) continue;
      visibleRows.push(row);
    }
    return visibleRows
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.contentId.localeCompare(left.contentId))
      .map((row) => this.toPost(row, actor?.userId));
  }

  async findPost(postId: string): Promise<SocialPostDto | null> {
    const actorForSeed = await this.currentActor();
    if (actorForSeed) await ensureLocalDemoCommunity(this.database, actorForSeed.userId, actorForSeed.displayName);
    const row = await this.database.get('social_content', postId);
    if (!row || row.contentType !== SOCIAL_CONTENT_TYPE.POST || !row.post) return null;
    const actor = await this.currentActor();
    if (actor && await this.isUserBlocked(actor.userId, row.ownerUserId)) return null;
    return this.toPost(row, actor?.userId);
  }

  async savePost(post: SocialPostDto): Promise<void> {
    const actor = await this.currentActor();
    if (!actor) throw new Error('SOCIAL_ACTOR_REQUIRED');
    const author = await this.database.get('users', actor.userId);
    if (!author) throw new Error('SOCIAL_ACTOR_REQUIRED');
    const profile = await this.ensureProfile(author);
    const row: LocalSocialContent = {
      contentId: post.postId,
      contentType: SOCIAL_CONTENT_TYPE.POST,
      topicKey: post.topicKey,
      postId: post.postId,
      ownerUserId: actor.userId,
      createdAt: post.createdAt,
      post: { ...post, authorLabel: actor.displayName, authorProfileKey: profile.friendCode, isOwnPost: true, assetIds: [...post.assetIds] },
    };
    await this.database.add('social_content', row);
  }

  async listReplies(postId: string): Promise<SocialPostReplyDto[]> {
    const rows = await this.database.getAllFromIndex('social_content', 'by-post-created', IDBKeyRange.bound([postId, ''], [postId, '\uffff']));
    const actor = await this.currentActor();
    const visibleRows: LocalSocialContent[] = [];
    for (const row of rows) {
      if (row.contentType !== SOCIAL_CONTENT_TYPE.REPLY || !row.reply) continue;
      if (actor && await this.isUserBlocked(actor.userId, row.ownerUserId)) continue;
      visibleRows.push(row);
    }
    return visibleRows
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.contentId.localeCompare(right.contentId))
      .map((row) => this.toReply(row, actor?.userId));
  }

  async findReply(replyId: string): Promise<SocialPostReplyDto | null> {
    const row = await this.database.get('social_content', replyId);
    if (!row || row.contentType !== SOCIAL_CONTENT_TYPE.REPLY || !row.reply) return null;
    const actor = await this.currentActor();
    if (actor && await this.isUserBlocked(actor.userId, row.ownerUserId)) return null;
    return this.toReply(row, actor?.userId);
  }

  async saveReply(reply: SocialPostReplyDto): Promise<void> {
    const [actor, post] = await Promise.all([this.currentActor(), this.database.get('social_content', reply.postId)]);
    if (!actor) throw new Error('SOCIAL_ACTOR_REQUIRED');
    if (!post || post.contentType !== SOCIAL_CONTENT_TYPE.POST || !post.post) throw new Error('SOCIAL_POST_NOT_FOUND');
    const author = await this.database.get('users', actor.userId);
    if (!author) throw new Error('SOCIAL_ACTOR_REQUIRED');
    const profile = await this.ensureProfile(author);
    const row: LocalSocialContent = {
      contentId: reply.replyId,
      contentType: SOCIAL_CONTENT_TYPE.REPLY,
      topicKey: post.topicKey,
      postId: reply.postId,
      ownerUserId: actor.userId,
      createdAt: reply.createdAt,
      reply: { ...reply, authorLabel: actor.displayName, authorProfileKey: profile.friendCode, isOwnReply: true, assetIds: [...reply.assetIds] },
    };
    await this.database.add('social_content', row);
  }

  async contentActionState(actorUserId: string, resourceType: 'POST' | 'REPLY', resourceId: string): Promise<SocialContentActionStateDto> {
    const target = await this.database.get('social_content', resourceId);
    if (!target) return { disliked: false, followingAuthor: false, reported: false };
    const contentAction = await this.database.get('social_interactions', `${actorUserId}:${resourceType}:${resourceId}:DISLIKE`);
    const reportAction = await this.database.get('social_interactions', `${actorUserId}:${resourceType}:${resourceId}:REPORT`);
    const authorAction = await this.database.get('social_interactions', `${actorUserId}:USER:${target.ownerUserId}:FOLLOW_AUTHOR`);
    return { disliked: contentAction?.active ?? false, followingAuthor: authorAction?.active ?? false, reported: reportAction?.active ?? false };
  }

  async applyContentAction(actorUserId: string, request: SocialContentActionRequestDto): Promise<SocialContentActionStateDto> {
    const target = await this.database.get('social_content', request.resourceId);
    if (!target || target.contentType !== (request.resourceType === 'POST' ? SOCIAL_CONTENT_TYPE.POST : SOCIAL_CONTENT_TYPE.REPLY)) throw new Error('SOCIAL_CONTENT_NOT_FOUND');
    const targetType = request.action === 'FOLLOW_AUTHOR' || request.action === 'UNFOLLOW_AUTHOR' ? 'USER' : request.resourceType;
    const targetId = targetType === 'USER' ? target.ownerUserId : request.resourceId;
    const action = request.action === 'CLEAR_DISLIKE' ? 'DISLIKE' : request.action === 'UNFOLLOW_AUTHOR' ? 'FOLLOW_AUTHOR' : request.action;
    const interactionKey = `${actorUserId}:${targetType}:${targetId}:${action}`;
    const active = request.action !== 'CLEAR_DISLIKE' && request.action !== 'UNFOLLOW_AUTHOR';
    const existing = await this.database.get('social_interactions', interactionKey);
    const interaction: LocalSocialInteraction = {
      interactionKey, actorUserId, targetType, targetId, action,
      active: action === 'REPORT' && existing?.active ? true : active,
      ...(action === 'REPORT' && (existing?.reasonCode ?? request.reasonCode) ? { reasonCode: existing?.reasonCode ?? request.reasonCode! } : {}),
      ...(action === 'REPORT' && (existing?.details ?? request.details?.trim()) ? { details: existing?.details ?? request.details!.trim() } : {}),
      createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now(),
    };
    await this.database.put('social_interactions', interaction);
    return this.contentActionState(actorUserId, request.resourceType, request.resourceId);
  }

  async getPublicProfile(publicProfileKey: string): Promise<SocialPublicProfileDto | null> {
    const actor = await this.currentActor();
    if (!actor) return null;
    await ensureLocalDemoCommunity(this.database, actor.userId, actor.displayName);
    const binding = await this.database.get('referral_bindings', actor.userId);
    const directParent = binding ? await this.database.get('users', binding.parent1UserId) : undefined;
    if (directParent?.rewardType === RewardType.CUSTOMER_LOSS_REBATE) return null;
    const user = await this.database.getFromIndex('users', 'by-friend-code', publicProfileKey);
    if (!user || user.status !== 'ACTIVE') return null;
    const blockedByTarget = await this.database.get('social_interactions', `${user.userId}:USER:${actor.userId}:BLOCK_USER`);
    if (blockedByTarget?.active) return null;
    const own = await this.ensureProfile(user);
    const pair = BigInt(actor.userId) < BigInt(user.userId) ? `${actor.userId}:${user.userId}` : `${user.userId}:${actor.userId}`;
    const friendship = await this.database.get('social_friendships', pair);
    const relationship: SocialPublicProfileRelationshipValue = user.userId === actor.userId ? 'NONE' : friendship?.state === 'ACCEPTED' ? 'FRIEND'
      : friendship?.state === 'PENDING' ? (friendship.requesterUserId === actor.userId ? 'REQUEST_SENT' : 'REQUEST_RECEIVED') : 'NONE';
    const blockedByMe = (await this.database.get('social_interactions', `${actor.userId}:USER:${user.userId}:BLOCK_USER`))?.active ?? false;
    const reportedByMe = (await this.database.get('social_interactions', `${actor.userId}:USER:${user.userId}:REPORT_USER`))?.active ?? false;
    const followedByMe = (await this.database.get('social_interactions', `${actor.userId}:USER:${user.userId}:FOLLOW_AUTHOR`))?.active ?? false;
    const outcomes = user.isDemoFixture ? localDemoProfileOutcomes(user.userId, Date.now()) : [];
    const inPeriod = outcomes.filter((item) => Date.now() - Date.parse(item.settledAt) <= 30 * 24 * 60 * 60 * 1000);
    const wins = inPeriod.filter((item) => item.netCoins > 0).length;
    const losses = inPeriod.filter((item) => item.netCoins < 0).length;
    const draws = inPeriod.filter((item) => item.netCoins === 0).length;
    const decided = wins + losses;
    const gameCounts = new Map<string, { gameKey: string; gameName: string; settledRounds: number }>();
    for (const outcome of inPeriod) {
      const game = gameCounts.get(outcome.gameKey) ?? { gameKey: outcome.gameKey, gameName: outcome.gameName, settledRounds: 0 };
      game.settledRounds += 1;
      gameCounts.set(outcome.gameKey, game);
    }
    const tradeRows = await this.database.getAll('coin_market_trades');
    const completedCoinMarketTradeCount = user.isDemoFixture
      ? [12, 7, 4, 2, 1][Number(user.userId.slice(-1)) % 5]!
      : tradeRows.filter((trade) => (trade.buyerUserId === user.userId || trade.sellerUserId === user.userId) && trade.status === CoinMarketTradeStatus.RELEASED).length;
    const sessionRows = await this.database.getAllFromIndex('sessions', 'by-user', user.userId);
    const firstSeen = sessionRows.map((session) => session.createdAt).sort()[0];
    const joinedAt = user.createdAt ?? firstSeen ?? this.now();
    return {
      publicProfileKey: own.friendCode,
      isSelf: user.userId === actor.userId,
      publicCode: own.friendCode,
      displayName: user.displayName,
      avatarAssetId: null,
      bio: user.bio ?? null,
      joinedMonth: joinedAt.slice(0, 7),
      recentWonCoins: inPeriod.filter((item) => item.netCoins > 0).reduce((sum, item) => sum + BigInt(item.netCoins), 0n).toString(),
      recentWinRate: { wins, losses, draws, rateBps: decided ? Math.round(wins * 10_000 / decided) : null, periodDays: 30 },
      favoriteGames: [...gameCounts.values()].sort((left, right) => right.settledRounds - left.settledRounds || left.gameKey.localeCompare(right.gameKey)).slice(0, 3).map((game) => ({
        ...game,
      recentResults: inPeriod.filter((item) => item.gameKey === game.gameKey).slice(0, 5).map((item) => ({ result: item.netCoins > 0 ? 'WIN' as const : item.netCoins < 0 ? 'LOSS' as const : 'DRAW' as const, settledAt: item.settledAt })),
      })),
      completedCoinMarketTradeCount,
      profileLandingUrl: `${window.location.origin}/social/users/${encodeURIComponent(own.friendCode)}`,
      relationship,
      followedByMe,
      blockedByMe,
      reportedByMe,
    };
  }

  async setFollowAuthor(publicProfileKey: string, followed: boolean): Promise<boolean> {
    const actor = await this.currentActor();
    if (!actor) throw new Error('SOCIAL_ACTOR_REQUIRED');
    const user = await this.database.getFromIndex('users', 'by-friend-code', publicProfileKey);
    if (!user || user.userId === actor.userId || user.status !== 'ACTIVE') throw new Error('SOCIAL_PROFILE_NOT_FOUND');
    if (await this.isUserBlocked(actor.userId, user.userId)) throw new Error('SOCIAL_USER_BLOCKED');
    const interactionKey = `${actor.userId}:USER:${user.userId}:FOLLOW_AUTHOR`;
    const existing = await this.database.get('social_interactions', interactionKey);
    await this.database.put('social_interactions', {
      interactionKey, actorUserId: actor.userId, targetType: 'USER', targetId: user.userId,
      action: 'FOLLOW_AUTHOR', active: followed, createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now(),
    });
    return followed;
  }

  async listPublicProfilePosts(publicProfileKey: string): Promise<{ items: SocialPostDto[]; nextCursor: null }> {
    const actor = await this.currentActor();
    if (!actor) return { items: [], nextCursor: null };
    await ensureLocalDemoCommunity(this.database, actor.userId, actor.displayName);
    const user = await this.database.getFromIndex('users', 'by-friend-code', publicProfileKey);
    if (!user || user.status !== 'ACTIVE') return { items: [], nextCursor: null };
    if (await this.isUserBlocked(actor.userId, user.userId)) return { items: [], nextCursor: null };
    const rows = await this.database.getAll('social_content');
    const items = await Promise.all(rows.filter((row) => row.ownerUserId === user.userId && row.contentType === SOCIAL_CONTENT_TYPE.POST && row.post?.status === 'PUBLISHED')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.contentId.localeCompare(left.contentId))
      .slice(0, 100).map(async (row) => ({ ...this.toPost(row, actor.userId), authorProfileKey: (await this.ensureProfile(user)).friendCode })));
    return { items, nextCursor: null };
  }

  async isUserBlocked(leftUserId: string, rightUserId: string): Promise<boolean> {
    if (leftUserId === rightUserId) return false;
    const [leftBlocksRight, rightBlocksLeft] = await Promise.all([
      this.database.get('social_interactions', `${leftUserId}:USER:${rightUserId}:BLOCK_USER`),
      this.database.get('social_interactions', `${rightUserId}:USER:${leftUserId}:BLOCK_USER`),
    ]);
    return Boolean(leftBlocksRight?.active || rightBlocksLeft?.active);
  }

  async setBlockAuthor(publicProfileKey: string, blocked: boolean): Promise<boolean> {
    const actor = await this.currentActor();
    if (!actor) throw new Error('SOCIAL_ACTOR_REQUIRED');
    const target = await this.database.getFromIndex('users', 'by-friend-code', publicProfileKey);
    if (!target || target.userId === actor.userId || target.status !== 'ACTIVE') throw new Error('SOCIAL_PROFILE_NOT_FOUND');
    const interactionKey = `${actor.userId}:USER:${target.userId}:BLOCK_USER`;
    const existing = await this.database.get('social_interactions', interactionKey);
    await this.database.put('social_interactions', {
      interactionKey, actorUserId: actor.userId, targetType: 'USER', targetId: target.userId, action: 'BLOCK_USER', active: blocked,
      createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now(),
    });
    return blocked;
  }

  async reportAuthor(request: import('@gameing/contracts/social').SocialAuthorReportRequestDto): Promise<void> {
    const actor = await this.currentActor();
    if (!actor) throw new Error('SOCIAL_ACTOR_REQUIRED');
    const target = await this.database.getFromIndex('users', 'by-friend-code', request.publicProfileKey);
    if (!target || target.userId === actor.userId || target.status !== 'ACTIVE') throw new Error('SOCIAL_PROFILE_NOT_FOUND');
    const interactionKey = `${actor.userId}:USER:${target.userId}:REPORT_USER`;
    const existing = await this.database.get('social_interactions', interactionKey);
    await this.database.put('social_interactions', {
      interactionKey, actorUserId: actor.userId, targetType: 'USER', targetId: target.userId, action: 'REPORT_USER', active: true,
      reasonCode: existing?.reasonCode ?? request.reasonCode,
      ...(existing?.details ?? request.details?.trim() ? { details: existing?.details ?? request.details!.trim() } : {}),
      createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now(),
    });
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
    await ensureLocalDemoSocialUsers(this.database);
    const credential = await this.database.getFromIndex('credentials', 'by-lookup', username.trim().toLocaleLowerCase());
    if (credential?.state !== 'ACTIVE' || credential.identifierType !== 'USERNAME') return null;
    return this.getOwnProfile(credential.userId);
  }

  async findUserByFriendCode(friendCode: string): Promise<SocialOwnProfileResponseDto | null> {
    await ensureLocalDemoSocialUsers(this.database);
    const user = await this.database.getFromIndex('users', 'by-friend-code', friendCode);
    return user ? this.getOwnProfile(user.userId) : null;
  }

  async listFriendships(userId: string): Promise<FriendshipRecord[]> {
    const actor = await this.currentActor();
    if (actor?.userId === userId) await ensureLocalDemoCommunity(this.database, actor.userId, actor.displayName);
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

  async listConversations(userId: string): Promise<ConversationRecord[]> {
    const actor = await this.currentActor();
    if (actor?.userId === userId) await ensureLocalDemoCommunity(this.database, actor.userId, actor.displayName);
    return (await this.database.getAll('social_conversations')).filter((row) => row.lowUserId === userId || row.highUserId === userId);
  }

  async getConversation(conversationId: string): Promise<ConversationRecord | null> {
    return (await this.database.get('social_conversations', conversationId)) ?? null;
  }

  async saveConversation(conversation: ConversationRecord): Promise<void> {
    await this.database.put('social_conversations', conversation as LocalSocialConversation);
  }

  async listMessages(conversationId: string): Promise<SocialMessageDto[]> {
    const actor = await this.currentActor();
    if (actor) await ensureLocalDemoCommunity(this.database, actor.userId, actor.displayName);
    const rows = await this.database.getAllFromIndex('social_messages', 'by-conversation', IDBKeyRange.bound([conversationId, ''], [conversationId, '\uffff']));
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100).map((row) => this.toDto(row));
  }

  async findMessageByClientId(clientMessageId: string): Promise<SocialMessageDto | null> {
    const row = await this.database.getFromIndex('social_messages', 'by-client-id', clientMessageId);
    return row ? this.toDto(row) : null;
  }

  async saveMessage(message: SocialMessageDto, updatedConversation?: ConversationRecord): Promise<void> {
    const tx = this.database.transaction(['social_messages', 'social_conversations'], 'readwrite');
    const conversations = tx.objectStore('social_conversations');
    const conversation = await conversations.get(message.conversationId);
    if (!conversation) { tx.abort(); throw new Error('SOCIAL_CONVERSATION_NOT_FOUND'); }
    await tx.objectStore('social_messages').put({ ...message } satisfies LocalSocialMessage);
    await conversations.put(updatedConversation ? { ...updatedConversation } : { ...conversation, updatedAt: message.createdAt });
    await tx.done;
  }

  async save(asset: EncryptedMessageAsset): Promise<void> {
    await this.database.add('assets', { assetId: asset.assetId, ownerUserId: asset.ownerUserId, authorizedUserIds: [...asset.authorizedUserIds], kind: asset.kind, mimeType: asset.mimeType, fileName: asset.fileName, byteSize: asset.byteSize, ciphertext: asset.ciphertext, aes128Key: asset.keys.aes128Key, hmacSha256Key: asset.keys.hmacSha256Key, createdAt: asset.createdAt } satisfies LocalEncryptedAsset);
  }

  async find(assetId: string): Promise<EncryptedMessageAsset | undefined> {
    const asset = await this.database.get('assets', assetId);
    if (!asset) return undefined;
    return { ...asset, keys: { aes128Key: asset.aes128Key, hmacSha256Key: asset.hmacSha256Key } };
  }

  async canSendMessageAssets(senderUserId: string, recipientUserId: string, assetIds: string[]): Promise<boolean> {
    for (const assetId of assetIds) {
      const asset = await this.database.get('assets', assetId);
      if (!asset || asset.ownerUserId !== senderUserId || !asset.authorizedUserIds.includes(recipientUserId)) return false;
    }
    return true;
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
    return { messageId: row.messageId, conversationId: row.conversationId, clientMessageId: row.clientMessageId, senderUserId: row.senderUserId, body: row.body, ...(row.attachments?.length ? { attachments: row.attachments.map((attachment) => ({ ...attachment })) } : {}), createdAt: row.createdAt };
  }
}
