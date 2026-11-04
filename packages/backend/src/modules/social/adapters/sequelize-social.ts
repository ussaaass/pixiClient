/**
 * social 仓储适配器（Sequelize 实现各 Repo 端口；models/social.ts 9 model
 * 的唯一写入点，行锁/幂等/状态机转换全在此层）。
 *
 * 领域所有者：social 模块（models/social.ts 为其唯一 model 定义；
 * 各表行锁/幂等/游标单调约定经本层落库，领域规则经 domain/ 纯函数校验）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 social_conversation →
 * social_message，幂等先抢唯一约束；所有分录/outbox 同事务）、§9 第 5 步
 * （社交与客服：双账号私信幂等、坐席领取/回复/重开、消息补拉一致性）、
 * §3.2 实体归属矩阵（social owns 9 social_* 表，models/social.ts）；
 * 数据库设计 SDD §5.12（各表 U 约束、游标单调递增且 ≤ 高水位、
 * CHECK 关系归一 low<high）。
 *
 * 行锁与并发约定（与 rooms 适配器 `sequelize-rooms.ts` 同款纪律）：
 * - `lock: 'FOR UPDATE'` 字符串字面量写法（InnoDB 行锁，§4 锁顺序）；
 * - 不可变表（本模块无不可变表；social_message 脱敏保留行位，不硬删，
 *   status SENT=1 → REDACTED=2 更新正常，不属于不可变表）；
 * - 唯一约束幂等兜底：`U(post_key)` / `U(reply_key)` /
 *   `U(low_user_id, high_user_id)`（会话 + 好友两处独立 U）/
 *   `U(social_conversation_id, message_no)` /
 *   `U(sender_user_id, client_message_id)` 命中 → 返回既有行
 *   （不产生第二行，验收红线"双账号私信幂等"）；
 * - 状态机转换由用例层经 `domain/message-rules.ts` 纯函数前置校验，
 *   本层只做 UPDATE 落库（影响行数 0 = 状态已变 → 抛 FENCING_CONFLICT，
 *   由用例层捕获映射）。
 *
 * 错误码映射（social domain/errors.ts S 表）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失 / 状态机转换影响行数 0
 *   （可重试）。
 * - 幂等兜底命中 → 返回既有行（`inserted: false`），不抛错。
 *
 * 结构约定（每表一类，不混类）：
 * 各 Repo 接口各有 `create` / `lockByPk` 等同名方法，一个类无法实现两个
 * 签名，故拆为 4 个独立类（`SequelizePostRepo` / `SequelizeConversationRepo` /
 * `SequelizeMessageRepo` / `SequelizeFriendshipRepo`），各实现自己的接口；
 * 共享 `txOf` 辅助函数保留在文件顶部，各 Repo 类都调。装配层
 * （assembly.ts）按角色独立构造，与 rooms 模块 5 个独立类同款模式。
 * 注：Sequelize 6 的 BIGINT 列在严格模式（string 属性接口）下 create/update
 * 入参经 `as never` 桥接（rooms 适配器同款写法，_shared.ts 第 8 条）。
 * `exactOptionalPropertyTypes` 下 Sequelize 查询 options 对象经 `as never`
 * 整体桥接（rooms 适配器同款写法；`lock: txq ? 'FOR UPDATE' : undefined`
 * + `transaction: txq` 直传，不写 `?? undefined`）。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type {
  SocialTopicModel,
  SocialPostModel,
  SocialPostReplyModel,
  SocialFriendshipModel,
  SocialConversationModel,
  SocialMessageModel,
} from '../../../infrastructure/database/models/social.js';
import {
  SocialPostStatus,
  SocialPostReplyStatus,
  SocialFriendshipStatus,
  SocialConversationStatus,
  SocialMessageStatus,
  ActiveStatus,
} from '../../../infrastructure/database/models/social.js';
import type { PostRepo, ConversationRepo, MessageRepo, FriendshipRepo, Tx } from '../ports/social-repository.js';
import { SocialDomainError, S } from '../domain/errors.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 rooms 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化；options 经 `as never` 整体桥接后直传）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

/** 共享 social 6 model 类（构造注入，不用全局，SDD §4）。
 * 首版 6 端点实际用到 topic/post/reply/friendship/conversation/message 6 表，
 * content_interaction/block/report 三表归 §9 第 9 步 Admin 模块，不在本层。 */
type SocialModels = {
  SocialTopicModel: typeof SocialTopicModel;
  SocialPostModel: typeof SocialPostModel;
  SocialPostReplyModel: typeof SocialPostReplyModel;
  SocialFriendshipModel: typeof SocialFriendshipModel;
  SocialConversationModel: typeof SocialConversationModel;
  SocialMessageModel: typeof SocialMessageModel;
};

// ---------------------------------------------------------------------------
// PostRepo（social_topic + social_post + social_post_reply）
// ---------------------------------------------------------------------------

/**
 * topic + post + post_reply 仓储（PostRepo；Sequelize 实现）。
 * topic 只读（目录由 §9 第 9 步 Admin 管理端点维护，本层只查 active 行）；
 * post / post_reply 创建（U 幂等兜底）+ 行锁读（回复前置校验）。
 */
export class SequelizePostRepo implements PostRepo {
  constructor(private readonly models: SocialModels) {}

  async findTopicByKey(topicKey: string, agentDomainId: string | null, tx: Tx): Promise<SocialTopicModel | null> {
    const txq = txOf(tx);
    const where: Record<string, unknown> = {
      topicKey,
      status: ActiveStatus.ACTIVE,
    };
    // agent_domain_id 可空 = 平台公共话题；COALESCE(agent_domain_id,0) 归一
    // 表达式索引由迁移 DDL 层生效（§A.7 登记），查询侧直接按列值匹配。
    if (agentDomainId === null) {
      where.agentDomainId = null;
    } else {
      where.agentDomainId = agentDomainId as never;
    }
    const row = await this.models.SocialTopicModel.findOne({
      where,
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async createPost(input: {
    agentDomainId: string | null;
    socialTopicId: string;
    userId: string;
    postKey: string;
    title: string | null;
    bodyText: string | null;
    assetIds: string[];
    tx: Tx;
  }): Promise<{ inserted: boolean; post: SocialPostModel }> {
    const txq = txOf(input.tx);
    // U(post_key) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.models.SocialPostModel.findOne({
      where: { postKey: input.postKey },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, post: existing };
    }
    const post = await this.models.SocialPostModel.create(
      {
        agentDomainId: input.agentDomainId,
        socialTopicId: input.socialTopicId as never,
        userId: input.userId as never,
        postKey: input.postKey,
        title: input.title,
        bodyText: input.bodyText,
        assetIds: input.assetIds,
        status: SocialPostStatus.PENDING_REVIEW,
      } as never,
      { transaction: txq } as never,
    );
    return { inserted: true, post };
  }

  async lockPost(postId: string, tx: Tx): Promise<SocialPostModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialPostModel.findByPk(postId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async lockPostReply(replyId: string, tx: Tx): Promise<SocialPostReplyModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialPostReplyModel.findByPk(replyId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async createPostReply(input: {
    socialPostId: string;
    parentSocialPostReplyId: string | null;
    userId: string;
    replyKey: string;
    bodyText: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; reply: SocialPostReplyModel }> {
    const txq = txOf(input.tx);
    // U(reply_key) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.models.SocialPostReplyModel.findOne({
      where: { replyKey: input.replyKey },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, reply: existing };
    }
    const reply = await this.models.SocialPostReplyModel.create(
      {
        socialPostId: input.socialPostId as never,
        parentSocialPostReplyId: input.parentSocialPostReplyId as never,
        userId: input.userId as never,
        replyKey: input.replyKey,
        bodyText: input.bodyText,
        status: SocialPostReplyStatus.PENDING_REVIEW,
      } as never,
      { transaction: txq } as never,
    );
    return { inserted: true, reply };
  }
}

// ---------------------------------------------------------------------------
// ConversationRepo（social_conversation）
// ---------------------------------------------------------------------------

/**
 * 会话仓储（ConversationRepo；Sequelize 实现）。
 * 行锁读（追加消息前读 last_message_no）+ 创建（U(low,high) 幂等兜底）+
 * 游标推进（advanceReadThrough，单调递增且 ≤ 高水位由用例层前置校验）。
 */
export class SequelizeConversationRepo implements ConversationRepo {
  constructor(private readonly models: SocialModels) {}

  async createConversation(input: {
    agentDomainId: string | null;
    lowUserId: string;
    highUserId: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; conversation: SocialConversationModel }> {
    const txq = txOf(input.tx);
    // U(low_user_id, high_user_id) 幂等兜底：先按 pair 归一读既有行
    const existing = await this.models.SocialConversationModel.findOne({
      where: { lowUserId: input.lowUserId as never, highUserId: input.highUserId as never },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, conversation: existing };
    }
    const conversation = await this.models.SocialConversationModel.create(
      {
        agentDomainId: input.agentDomainId,
        lowUserId: input.lowUserId as never,
        highUserId: input.highUserId as never,
        lastMessageNo: '0',
        userLowReadThroughNo: '0',
        userHighReadThroughNo: '0',
        status: SocialConversationStatus.ACTIVE,
      } as never,
      { transaction: txq } as never,
    );
    return { inserted: true, conversation };
  }

  async lockConversation(conversationId: string, tx: Tx): Promise<SocialConversationModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialConversationModel.findByPk(conversationId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async findConversationByPk(conversationId: string, tx: Tx): Promise<SocialConversationModel | null> {
    const txq = txOf(tx);
    // 只读无锁（避免不必要行锁，SDD §4 读用例直接无事务调用）
    const row = await this.models.SocialConversationModel.findByPk(conversationId, {
      transaction: txq,
    } as never);
    return row;
  }

  async findConversationBetween(lowUserId: string, highUserId: string, tx: Tx): Promise<SocialConversationModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialConversationModel.findOne({
      where: { lowUserId: lowUserId as never, highUserId: highUserId as never },
      transaction: txq,
    } as never);
    return row;
  }

  async listConversationsByUser(userId: string, tx: Tx): Promise<SocialConversationModel[]> {
    const txq = txOf(tx);
    const rows = await this.models.SocialConversationModel.findAll({
      where: {
        [Op.or]: [{ lowUserId: userId as never }, { highUserId: userId as never }],
      },
      order: [
        // 按 last_message_at 降序（null 值排最后），前 100 条
        ['lastMessageAt', 'DESC'],
      ],
      limit: 100,
      transaction: txq,
    } as never);
    return rows;
  }

  async advanceReadThrough(input: {
    conversationId: string;
    userLowReadThroughNo: string | null;
    userHighReadThroughNo: string | null;
    tx: Tx;
  }): Promise<SocialConversationModel> {
    const txq = txOf(input.tx);
    const updates: Record<string, unknown> = {};
    if (input.userLowReadThroughNo !== null) {
      updates.userLowReadThroughNo = input.userLowReadThroughNo as never;
    }
    if (input.userHighReadThroughNo !== null) {
      updates.userHighReadThroughNo = input.userHighReadThroughNo as never;
    }
    const where = { id: input.conversationId };
    if (Object.keys(updates).length === 0) {
      // 两侧均为 null → 纯读会话（无更新），直接锁读返回
      const row = await this.models.SocialConversationModel.findByPk(input.conversationId, {
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never);
      if (row === null) {
        throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `会话不存在：${input.conversationId}`, { retryable: true });
      }
      return row;
    }
    const [affected] = await this.models.SocialConversationModel.update(
      updates as never,
      { where, transaction: txq, lock: txq ? 'FOR UPDATE' : undefined } as never,
    );
    if (affected === 0) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `会话不存在：${input.conversationId}`, { retryable: true });
    }
    const row = await this.models.SocialConversationModel.findByPk(input.conversationId, {
      transaction: txq,
    } as never);
    if (row === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `会话不存在：${input.conversationId}`, { retryable: true });
    }
    return row;
  }
}

// ---------------------------------------------------------------------------
// MessageRepo（social_message）
// ---------------------------------------------------------------------------

/**
 * 消息仓储（MessageRepo；Sequelize 实现）。
 * 追加（U(conversation_id, message_no) 会话内单调递增 + U(sender_user_id,
 * client_message_id) 幂等兜底，同事务更新会话 last_message_no / last_message_at
 * 高水位，保证游标单调不落后）+ 按 client_key 查（幂等重放）+
 * 按 message_no 游标补拉（升序，limit 单页上限）。
 */
export class SequelizeMessageRepo implements MessageRepo {
  constructor(private readonly models: SocialModels) {}

  async appendMessage(input: {
    socialConversationId: string;
    messageNo: string;
    senderUserId: string;
    clientMessageId: string;
    messageType: number;
    bodyText: string | null;
    assetId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; message: SocialMessageModel }> {
    const txq = txOf(input.tx);
    // 1. U(sender_user_id, client_message_id) 幂等兜底：先读既有行，命中 → 返回
    const existingByClientKey = await this.models.SocialMessageModel.findOne({
      where: {
        senderUserId: input.senderUserId as never,
        clientMessageId: input.clientMessageId,
      },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existingByClientKey !== null) {
      return { inserted: false, message: existingByClientKey };
    }
    // 2. U(social_conversation_id, message_no) 兜底：读会话高水位，校验
    //    新 message_no 必须 = last_message_no + 1（否则并发竞态 → 抛 STORAGE_UNAVAILABLE）
    const conversation = await this.models.SocialConversationModel.findByPk(input.socialConversationId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (conversation === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `会话不存在：${input.socialConversationId}`, { retryable: true });
    }
    const expectedNo = (BigInt(conversation.lastMessageNo) + 1n).toString();
    if (input.messageNo !== expectedNo) {
      // 并发竞态：两客户端同时读到同一 last_message_no，算出相同新序号但先写者
      // 已占号——本行序号落后 → 抛错让客户端重试用原 client_message_id 幂等重放。
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `消息序号竞态冲突（期望 ${expectedNo}，实收 ${input.messageNo}），请重试。`, {
        retryable: true,
      });
    }
    // 3. 写 social_message SENT=1（BIGINT message_no / sender_user_id 经 as never 桥接）
    const message = await this.models.SocialMessageModel.create(
      {
        socialConversationId: input.socialConversationId as never,
        messageNo: input.messageNo as never,
        senderUserId: input.senderUserId as never,
        clientMessageId: input.clientMessageId,
        messageType: input.messageType,
        bodyText: input.bodyText,
        assetId: input.assetId,
        status: SocialMessageStatus.SENT,
      } as never,
      { transaction: txq } as never,
    );
    // 4. 同事务更新会话 last_message_no / last_message_at 高水位
    const now = new Date();
    await this.models.SocialConversationModel.update(
      {
        lastMessageNo: input.messageNo as never,
        lastMessageAt: now,
      } as never,
      { where: { id: input.socialConversationId }, transaction: txq } as never,
    );
    return { inserted: true, message };
  }

  async findMessageByClientKey(senderUserId: string, clientMessageId: string, tx: Tx): Promise<SocialMessageModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialMessageModel.findOne({
      where: { senderUserId: senderUserId as never, clientMessageId },
      transaction: txq,
    } as never);
    return row;
  }

  async listMessagesAfterNo(conversationId: string, afterMessageNo: string, limit: number, tx: Tx): Promise<SocialMessageModel[]> {
    const txq = txOf(tx);
    const rows = await this.models.SocialMessageModel.findAll({
      where: {
        socialConversationId: conversationId as never,
        messageNo: { [Op.gt]: afterMessageNo as never },
      },
      order: [['messageNo', 'ASC']],
      limit,
      transaction: txq,
    } as never);
    return rows;
  }
}

// ---------------------------------------------------------------------------
// FriendshipRepo（social_friendship）
// ---------------------------------------------------------------------------

/**
 * 好友关系仓储（FriendshipRepo；Sequelize 实现）。
 * 创建（U(low,high) 幂等兜底，命中 PENDING 行 → 静默返回既有行）+
 * 行锁读（按 pair 归一或按主键）+ 状态机转换（PENDING → ACCEPTED /
 * REJECTED，影响行数 0 → 抛 STORAGE_UNAVAILABLE 可重试，由用例层映射）。
 */
export class SequelizeFriendshipRepo implements FriendshipRepo {
  constructor(private readonly models: SocialModels) {}

  async findFriendshipBetween(lowUserId: string, highUserId: string, tx: Tx): Promise<SocialFriendshipModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialFriendshipModel.findOne({
      where: { lowUserId: lowUserId as never, highUserId: highUserId as never },
      transaction: txq,
    } as never);
    return row;
  }

  async lockFriendship(lowUserId: string, highUserId: string, tx: Tx): Promise<SocialFriendshipModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialFriendshipModel.findOne({
      where: { lowUserId: lowUserId as never, highUserId: highUserId as never },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async lockFriendshipByPk(friendshipId: string, tx: Tx): Promise<SocialFriendshipModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SocialFriendshipModel.findByPk(friendshipId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async createFriendship(input: {
    agentDomainId: string | null;
    lowUserId: string;
    highUserId: string;
    requesterUserId: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; friendship: SocialFriendshipModel }> {
    const txq = txOf(input.tx);
    // U(low_user_id, high_user_id) 幂等兜底：先读既有行
    const existing = await this.models.SocialFriendshipModel.findOne({
      where: { lowUserId: input.lowUserId as never, highUserId: input.highUserId as never },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      // PENDING=1 → 幂等重放（inserted: false）；
      // REJECTED=3 / REMOVED=4 → 首版允许重新发起（UPDATE 回 PENDING=1，
      // 登记决策点：被拒后能否重新发起，首版允许）；
      // ACCEPTED=2 → 已是好友，静默返回既有行（inserted: false）。
      if (existing.status === SocialFriendshipStatus.REJECTED || existing.status === SocialFriendshipStatus.REMOVED) {
        await this.models.SocialFriendshipModel.update(
          {
            status: SocialFriendshipStatus.PENDING,
            requesterUserId: input.requesterUserId as never,
            respondedAt: null,
            endedAt: null,
          } as never,
          { where: { id: existing.id }, transaction: txq } as never,
        );
        return { inserted: false, friendship: existing };
      }
      return { inserted: false, friendship: existing };
    }
    const friendship = await this.models.SocialFriendshipModel.create(
      {
        agentDomainId: input.agentDomainId,
        lowUserId: input.lowUserId as never,
        highUserId: input.highUserId as never,
        requesterUserId: input.requesterUserId as never,
        status: SocialFriendshipStatus.PENDING,
      } as never,
      { transaction: txq } as never,
    );
    return { inserted: true, friendship };
  }

  async markFriendshipAccepted(friendshipId: string, respondedAt: Date, tx: Tx): Promise<SocialFriendshipModel> {
    const txq = txOf(tx);
    const [affected] = await this.models.SocialFriendshipModel.update(
      {
        status: SocialFriendshipStatus.ACCEPTED,
        respondedAt,
      } as never,
      {
        where: { id: friendshipId, status: SocialFriendshipStatus.PENDING },
        transaction: txq,
      } as never,
    );
    if (affected === 0) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, '好友关系状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }
    const row = await this.models.SocialFriendshipModel.findByPk(friendshipId, {
      transaction: txq,
    } as never);
    if (row === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `好友关系不存在：${friendshipId}`, { retryable: true });
    }
    return row;
  }

  async markFriendshipRejected(friendshipId: string, respondedAt: Date, tx: Tx): Promise<SocialFriendshipModel> {
    const txq = txOf(tx);
    const [affected] = await this.models.SocialFriendshipModel.update(
      {
        status: SocialFriendshipStatus.REJECTED,
        respondedAt,
      } as never,
      {
        where: { id: friendshipId, status: SocialFriendshipStatus.PENDING },
        transaction: txq,
      } as never,
    );
    if (affected === 0) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, '好友关系状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }
    const row = await this.models.SocialFriendshipModel.findByPk(friendshipId, {
      transaction: txq,
    } as never);
    if (row === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `好友关系不存在：${friendshipId}`, { retryable: true });
    }
    return row;
  }
}
