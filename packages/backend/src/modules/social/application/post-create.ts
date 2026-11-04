/**
 * 创建帖子用例：POST /social/posts（SDD §5.4 social 端点；§9 第 5 步验收）。
 *
 * 领域所有者：social 模块（social_post 写入；social_topic 行读）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（社交与客服：社区 + 私信 + 坐席
 * 队列 + 消息 outbox→Socket 双端投递 + 断线补拉）、§4（幂等先抢
 * `U(post_key)` 唯一约束；所有分录/outbox 同事务）；数据库设计 SDD §5.12
 * （social_post PENDING_REVIEW=1 → PUBLISHED=2 / HIDDEN=3 / REDACTED=4，
 * U(post_key) 创建/重试幂等键）。
 *
 * 用例语义：
 * - 读 social_topic（按 topic_key + agent_domain_id 归一；缺行 → SOCIAL_TOPIC_NOT_FOUND）；
 * - 创建 social_post PENDING_REVIEW=1（post_key 客户端幂等键，U 约束命中 →
 *   返回既有行（inserted: false，幂等重放，不产生第二帖））；
 * - 同事务写 outbox topic `social.post`（审核通过 → PUBLISHED 后投出，
 *   首版 PENDING_REVIEW 阶段先写 outbox 行待 Admin 审核推进状态，登记决策点）。
 *
 * 错误码映射（S → 触发条件）：
 * - `SOCIAL_TOPIC_NOT_FOUND`：topicKey 对应 social_topic 行缺失 / 非 ACTIVE。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - 成功 → PostCreatedDto（201；重放 post_key 命中 = 200 语义由路由层按
 *   `inserted` 标志决定，登记决策点）。
 *
 * 锁顺序（SDD §4）：social_topic（读）→ social_post（写，U(post_key) 兜底），
 * 无跨表锁竞争（topic 行不锁，post 行独立创建）。
 */

import { SocialDomainError, S, isDuplicateKeyError } from '../domain/errors.js';
import type { PostRepo, Tx } from '../ports/social-repository.js';
import type { OutboxPort } from '../ports/social-repository-exports.js';

/** 帖子创建结果（wire DTO；ID 十进制字符串 wire；status 数值常量 wire）。 */
export interface PostCreatedDto {
  postId: string;
  topicKey: string;
  status: number;
  title: string | null;
  bodyText: string | null;
  assetIds: string[];
  createdAt: string;
  /** 重放标志（false = 新创建；true = post_key 命中既有行，路由层据此 200/201）。 */
  inserted: boolean;
}

export class PostCreateUseCase {
  constructor(
    private readonly postRepo: PostRepo,
    private readonly outbox: OutboxPort,
  ) {}

  /**
   * POST /social/posts：创建帖子 + 同事务写 outbox（§4 所有分录/outbox 同事务）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: {
    userId: string;
    agentDomainId: string | null;
    topicKey: string;
    title: string | null;
    body: string | null;
    assetIds: string[];
    postKey: string;
    tx: Tx;
  }): Promise<PostCreatedDto> {
    // 1. 读 social_topic（缺行 / 非 ACTIVE → SOCIAL_TOPIC_NOT_FOUND）
    const topic = await this.postRepo.findTopicByKey(input.topicKey, input.agentDomainId, input.tx);
    if (topic === null || topic.status !== 1) {
      throw new SocialDomainError(S.SOCIAL_TOPIC_NOT_FOUND, `社交话题不存在或未激活：${input.topicKey}`);
    }

    // 2. 创建 social_post PENDING_REVIEW=1（U(post_key) 幂等兜底）
    let postResult: { inserted: boolean; post: { id: string; createdAt: Date | string } };
    try {
      postResult = await this.postRepo.createPost({
        agentDomainId: input.agentDomainId,
        socialTopicId: topic.id,
        userId: input.userId,
        postKey: input.postKey,
        title: input.title,
        bodyText: input.body,
        assetIds: input.assetIds,
        tx: input.tx,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(post_key) 命中 = 幂等重放（前次已创建，直接读回既有行）；
        // 同键异内容 → 由 adapter 层校验 post_key 匹配内容后决定是否重放
        // （首版统一视为幂等重放，登记决策点；若 Lead 要求严格校验内容哈希，
        // 需扩展 adapter 层）。
        throw new SocialDomainError(S.STORAGE_UNAVAILABLE, '帖子幂等键冲突，请重试。', {
          retryable: true,
        });
      }
      throw err;
    }

    // 3. 同事务写 outbox topic `social.post`（§6.3 outbox 权威）
    // PENDING_REVIEW 阶段先写 outbox 行待 Admin 推进审核；
    // Admin 审核通过后投出（登记决策点：首版 PENDING_REVIEW 即写 outbox，
    // 若 Lead 要求审核通过才投，需改 Admin 审核端点触发 outbox 写入）。
    await this.outbox.append({
      topic: 'social.post',
      userId: input.userId,
      payload: {
        postId: postResult.post.id,
        status: 1, // PENDING_REVIEW
        topicKey: input.topicKey,
      },
      eventKey: `social:post:${input.postKey}`,
    });

    return {
      postId: postResult.post.id,
      topicKey: input.topicKey,
      status: 1, // PENDING_REVIEW
      title: input.title,
      bodyText: input.body,
      assetIds: input.assetIds,
      createdAt: typeof postResult.post.createdAt === 'string' ? postResult.post.createdAt : postResult.post.createdAt.toISOString(),
      inserted: postResult.inserted,
    };
  }
}
