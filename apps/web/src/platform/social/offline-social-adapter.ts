import type { SocialAuthorReportRequestDto, SocialContentActionRequestDto, SocialContentActionStateDto, SocialPostDto, SocialPostReplyDto, SocialPublicProfileDto, SocialTopicDto } from '@gameing/contracts/social';
import type { SocialRepositoryPort } from './social-application';

/** Local sandbox only: topics are bundled demo configuration; user content lives in memory. */
export class OfflineSocialAdapter implements SocialRepositoryPort {
  async currentActor(): Promise<{ userId: string; displayName: string }> {
    return { userId: '9000000000000000001', displayName: '本地玩家' };
  }

  private readonly topics: SocialTopicDto[] = [
    { topicId: '7101', topicKey: 'SHISANSHUI_STRATEGY', title: '十三张牌型讨论', description: '聊聊摆牌思路与牌型取舍。', status: 'ACTIVE' },
    { topicId: '7102', topicKey: 'GAME_EXPERIENCE', title: '游戏心得', description: '记录本地练习中的发现。', status: 'ACTIVE' },
    { topicId: '7103', topicKey: 'HALL_CHAT', title: '大厅交流', description: '分享对游戏大厅的建议。', status: 'ACTIVE' },
  ];
  private readonly posts = new Map<string, SocialPostDto>();
  private readonly replies = new Map<string, SocialPostReplyDto>();
  private readonly interactions = new Map<string, { active: boolean; reasonCode?: string; details?: string }>();
  private nextId = 9_000_000_000_000_000_001n;

  async listTopics(): Promise<SocialTopicDto[]> {
    return this.topics.map((topic) => ({ ...topic }));
  }

  async findTopic(topicKey: string): Promise<SocialTopicDto | null> {
    const topic = this.topics.find((item) => item.topicKey === topicKey);
    return topic ? { ...topic } : null;
  }

  async listPosts(topicKey: string): Promise<SocialPostDto[]> {
    return [...this.posts.values()]
      .filter((post) => post.topicKey === topicKey && post.status === 'PUBLISHED' && !this.interactions.get(`${this.actorId}:USER:${post.authorProfileKey}:BLOCK_USER`)?.active)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.postId.localeCompare(left.postId))
      .map((post) => ({ ...post, assetIds: [...post.assetIds] }));
  }

  async findPost(postId: string): Promise<SocialPostDto | null> {
    const post = this.posts.get(postId);
    return post ? { ...post, assetIds: [...post.assetIds] } : null;
  }

  async savePost(post: SocialPostDto): Promise<void> {
    this.posts.set(post.postId, { ...post, assetIds: [...post.assetIds] });
  }

  async listReplies(postId: string): Promise<SocialPostReplyDto[]> {
    return [...this.replies.values()]
      .filter((reply) => reply.postId === postId && reply.status === 'PUBLISHED')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.replyId.localeCompare(right.replyId))
      .map((reply) => ({ ...reply, assetIds: [...reply.assetIds] }));
  }

  async findReply(replyId: string): Promise<SocialPostReplyDto | null> {
    const reply = this.replies.get(replyId);
    return reply ? { ...reply, assetIds: [...reply.assetIds] } : null;
  }

  async saveReply(reply: SocialPostReplyDto): Promise<void> {
    this.replies.set(reply.replyId, { ...reply, assetIds: [...reply.assetIds] });
  }

  async contentActionState(actorUserId: string, resourceType: 'POST' | 'REPLY', resourceId: string): Promise<SocialContentActionStateDto> {
    const item = resourceType === 'POST' ? this.posts.get(resourceId) : this.replies.get(resourceId);
    const author = item?.authorLabel ?? '';
    return {
      disliked: this.interactions.get(`${actorUserId}:${resourceType}:${resourceId}:DISLIKE`)?.active ?? false,
      followingAuthor: this.interactions.get(`${actorUserId}:USER:${author}:FOLLOW_AUTHOR`)?.active ?? false,
      reported: this.interactions.get(`${actorUserId}:${resourceType}:${resourceId}:REPORT`)?.active ?? false,
    };
  }

  async applyContentAction(actorUserId: string, request: SocialContentActionRequestDto): Promise<SocialContentActionStateDto> {
    const item = request.resourceType === 'POST' ? this.posts.get(request.resourceId) : this.replies.get(request.resourceId);
    if (!item) throw new Error('SOCIAL_CONTENT_NOT_FOUND');
    const targetType = request.action === 'FOLLOW_AUTHOR' || request.action === 'UNFOLLOW_AUTHOR' ? 'USER' : request.resourceType;
    const targetId = targetType === 'USER' ? item.authorLabel : request.resourceId;
    const action = request.action === 'CLEAR_DISLIKE' ? 'DISLIKE' : request.action === 'UNFOLLOW_AUTHOR' ? 'FOLLOW_AUTHOR' : request.action;
    const key = `${actorUserId}:${targetType}:${targetId}:${action}`;
    const existing = this.interactions.get(key);
    this.interactions.set(key, {
      active: action === 'REPORT' && existing?.active ? true : request.action !== 'CLEAR_DISLIKE' && request.action !== 'UNFOLLOW_AUTHOR',
      ...(existing?.reasonCode ?? request.reasonCode ? { reasonCode: existing?.reasonCode ?? request.reasonCode! } : {}),
      ...(existing?.details ?? request.details?.trim() ? { details: existing?.details ?? request.details!.trim() } : {}),
    });
    return this.contentActionState(actorUserId, request.resourceType, request.resourceId);
  }

  async getPublicProfile(publicProfileKey: string): Promise<SocialPublicProfileDto | null> {
    const post = [...this.posts.values()].find((item) => item.authorProfileKey === publicProfileKey);
    if (!post) return null;
    const actor = await this.currentActor();
    return {
      publicProfileKey, isSelf: false, publicCode: publicProfileKey, displayName: post.authorLabel, avatarAssetId: null, bio: null, joinedMonth: '2025-06',
      recentWonCoins: '0',
      recentWinRate: { wins: 0, losses: 0, draws: 0, rateBps: null, periodDays: 30 }, favoriteGames: [],
      completedCoinMarketTradeCount: 0, profileLandingUrl: `${window.location.origin}/social/users/${publicProfileKey}`,
      relationship: 'NONE', followedByMe: this.interactions.get(`${actor?.userId}:USER:${publicProfileKey}:FOLLOW_AUTHOR`)?.active ?? false, blockedByMe: this.interactions.get(`${actor?.userId}:USER:${publicProfileKey}:BLOCK_USER`)?.active ?? false,
      reportedByMe: this.interactions.get(`${actor?.userId}:USER:${publicProfileKey}:REPORT_USER`)?.active ?? false,
    };
  }

  async listPublicProfilePosts(publicProfileKey: string): Promise<{ items: SocialPostDto[]; nextCursor: null }> {
    return { items: [...this.posts.values()].filter((post) => post.authorProfileKey === publicProfileKey && post.status === 'PUBLISHED' && !this.interactions.get(`${this.actorId}:USER:${publicProfileKey}:BLOCK_USER`)?.active), nextCursor: null };
  }

  async setFollowAuthor(publicProfileKey: string, followed: boolean): Promise<boolean> {
    const actor = await this.currentActor();
    const key = `${actor.userId}:USER:${publicProfileKey}:FOLLOW_AUTHOR`;
    this.interactions.set(key, { active: followed });
    return followed;
  }

  private readonly actorId = '9000000000000000001';

  async setBlockAuthor(publicProfileKey: string, blocked: boolean): Promise<boolean> {
    const actor = await this.currentActor();
    const key = `${actor.userId}:USER:${publicProfileKey}:BLOCK_USER`;
    const existing = this.interactions.get(key);
    this.interactions.set(key, { active: blocked, ...(existing?.reasonCode ? { reasonCode: existing.reasonCode } : {}) });
    return blocked;
  }

  async reportAuthor(request: SocialAuthorReportRequestDto): Promise<void> {
    const actor = await this.currentActor();
    const key = `${actor.userId}:USER:${request.publicProfileKey}:REPORT_USER`;
    const existing = this.interactions.get(key);
    this.interactions.set(key, { active: true, reasonCode: existing?.reasonCode ?? request.reasonCode, ...(existing?.details ?? request.details?.trim() ? { details: existing?.details ?? request.details!.trim() } : {}) });
  }

  async createId(): Promise<string> {
    const id = this.nextId.toString();
    this.nextId += 1n;
    return id;
  }

  now(): string {
    return new Date().toISOString();
  }
}
