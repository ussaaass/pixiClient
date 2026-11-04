/**
 * 创建回复用例：POST /social/posts/:postId/replies（SDD §5.4 social 端点）。
 *
 * 领域所有者：social 模块（social_post_reply 写入；social_post 行锁读）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步、§4（锁顺序 social_post → social_post_reply，
 * 幂等先抢 `U(reply_key)` 唯一约束）；数据库设计 SDD §5.12
 * （social_post_reply 最多一层嵌套：parent_social_post_reply_id 引用同表，
 * NULL = 直接回复帖子；非一级回复引用 → SOCIAL_REPLY_NOT_ALLOWED）。
 *
 * 用例语义：
 * - 锁读 social_post（post 行锁，回复前置校验：post 存在且非 HIDDEN/REDACTED）；
 * - 若 parentReplyId 非空：锁读一级回复，校验其 parent_social_post_reply_id = NULL
 *   （否则嵌套超过一层 → SOCIAL_REPLY_NOT_ALLOWED）；
 * - 创建 social_post_reply PENDING_REVIEW=1（U(reply_key) 幂等兜底，命中 →
 *   返回既有行（inserted: false，不产生第二回复））；
 * - 同事务写 outbox topic `social.post_reply`（同 post-create 决策点）。
 *
 * 错误码映射（S → 触发条件）：
 * - `SOCIAL_POST_NOT_FOUND`：postId 对应 social_post 行缺失。
 * - `SOCIAL_REPLY_NOT_ALLOWED`：parentReplyId 非一级回复（嵌套超过一层，CHECK 兜底）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - 成功 → ReplyCreatedDto（201；重放 reply_key 命中 = 200 语义由路由层按
 *   `inserted` 标志决定）。
 */

import { SocialDomainError, S } from '../domain/errors.js';
import type { PostRepo, Tx } from '../ports/social-repository.js';
import type { OutboxPort } from '../ports/social-repository-exports.js';

/** 回复创建结果（wire DTO；ID 十进制字符串 wire）。 */
export interface ReplyCreatedDto {
  replyId: string;
  postId: string;
  parentReplyId: string | null;
  status: number;
  bodyText: string | null;
  createdAt: string;
  inserted: boolean;
}

export class PostReplyUseCase {
  constructor(
    private readonly postRepo: PostRepo,
    private readonly outbox: OutboxPort,
  ) {}

  /**
   * POST /social/posts/:postId/replies：创建回复 + 同事务写 outbox。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: {
    userId: string;
    postId: string;
    parentReplyId: string | null;
    body: string | null;
    assetIds: string[];
    replyKey: string;
    tx: Tx;
  }): Promise<ReplyCreatedDto> {
    // 1. 锁读 social_post（缺行 → SOCIAL_POST_NOT_FOUND；非 PENDING/PUBLISHED → 不允许回复）
    const post = await this.postRepo.lockPost(input.postId, input.tx);
    if (post === null) {
      throw new SocialDomainError(S.SOCIAL_POST_NOT_FOUND, `帖子不存在：${input.postId}`);
    }
    // post.status = HIDDEN=3 / REDACTED=4 时允许回复但不展示（CHECK 层兜底）；
    // 首版不做前置 status 校验，HIDDEN/REDACTED 帖回复可见性由 feed 端点过滤。

    // 2. parentReplyId 非空时锁读一级回复，校验嵌套深度（CHECK 兜底）
    let parentReplyId: string | null = null;
    if (input.parentReplyId !== null && input.parentReplyId !== undefined) {
      const parentReply = await this.postRepo.lockPostReply(input.parentReplyId, input.tx);
      if (parentReply === null) {
        throw new SocialDomainError(S.SOCIAL_REPLY_NOT_ALLOWED, `父回复不存在：${input.parentReplyId}`);
      }
      // 一级回复的 parent_social_post_reply_id 必须为 NULL（即直接回复帖子）；
      // 非 NULL → 嵌套超过一层 → SOCIAL_REPLY_NOT_ALLOWED。
      if (parentReply.parentSocialPostReplyId !== null) {
        throw new SocialDomainError(S.SOCIAL_REPLY_NOT_ALLOWED, '回复嵌套超过一层（parent_reply 必须是直接回复帖子的一级回复）。');
      }
      // 父回复必须属于同一帖子
      if (parentReply.socialPostId !== input.postId) {
        throw new SocialDomainError(S.SOCIAL_REPLY_NOT_ALLOWED, '父回复不属于该帖子。');
      }
      parentReplyId = input.parentReplyId;
    }

    // 3. 创建 social_post_reply PENDING_REVIEW=1（U(reply_key) 幂等兜底）
    const replyResult = await this.postRepo.createPostReply({
      socialPostId: input.postId,
      parentSocialPostReplyId: parentReplyId,
      userId: input.userId,
      replyKey: input.replyKey,
      bodyText: input.body,
      tx: input.tx,
    });

    // 4. 同事务写 outbox topic `social.post_reply`
    await this.outbox.append({
      topic: 'social.post_reply',
      userId: input.userId,
      payload: {
        replyId: replyResult.reply.id,
        postId: input.postId,
        parentReplyId,
        status: 1, // PENDING_REVIEW
      },
      eventKey: `social:reply:${input.replyKey}`,
    });

    return {
      replyId: replyResult.reply.id,
      postId: input.postId,
      parentReplyId,
      status: 1, // PENDING_REVIEW
      bodyText: input.body,
      createdAt: typeof replyResult.reply.createdAt === 'string' ? replyResult.reply.createdAt : replyResult.reply.createdAt.toISOString(),
      inserted: replyResult.inserted,
    };
  }
}
