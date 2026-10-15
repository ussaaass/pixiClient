import type { SocialPostDto, SocialPostReplyDto, SocialTopicDto } from '@gameing/contracts/social';
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
      .filter((post) => post.topicKey === topicKey && post.status === 'PUBLISHED')
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

  async createId(): Promise<string> {
    const id = this.nextId.toString();
    this.nextId += 1n;
    return id;
  }

  now(): string {
    return new Date().toISOString();
  }
}
