/**
 * social 模块仓储端口（social_topic / social_post / social_post_reply /
 * social_friendship / social_conversation / social_message /
 * social_content_interaction / social_block / social_report）。
 *
 * 领域所有者：social 模块（adapters/sequelize-social.ts 各 Repo 类实现各端口；
 * models/social.ts 为唯一 model 定义）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（社交与客服：好友/私信/社区 +
 * 消息 outbox→Socket 双端投递 + 断线补拉）、§4（锁顺序/幂等先抢唯一约束/
 * 所有分录/outbox 同事务）、§5.4（social 端点）；数据库设计 SDD §5.12
 * （social 各表 U 约束、游标单调递增且 ≤ 高水位、CHECK 关系归一 low<high）。
 *
 * 约定（与 rooms 模块 ports/rooms-repository.ts 同款纪律）：
 * - 方法名经实体前缀区分（createPost / lockPost / createConversation /
 *   lockConversation / appendMessage / findMessageByClientKey /
 *   createFriendship / lockFriendship / …，各表 CRUD 语义独立，无重名冲突）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型），用例内所有
 *   写操作共享同一事务（回滚即整事务回滚）；
 * - 幂等兜底：`U(post_key)` / `U(reply_key)` / `U(low_user_id, high_user_id)` /
 *   `U(social_conversation_id, message_no)` / `U(sender_user_id,
 *   client_message_id)` 命中 → 返回既有行（`inserted: false`，不产生第二行，
 *   验收红线"双账号私信幂等"）；
 * - 游标单调：`message_no` 新值 = 会话 last_message_no + 1（行锁读后
 *   同事务写，U(conversation_id, message_no) 兜底）；已读游标
 *   `user_low/high_read_through_no` 只能递增且 ≤ 高水位（用例层校验，
 *   本层只做 UPDATE 落库）。
 *
 * 注：本文件只声明首版 6 端点（§5.4 social 端点中 201/200 可重放部分）实际
 * 用到的方法；审核/屏蔽/举报/互动（social_moderation / social_block /
 * social_report / social_content_interaction）端点未在本步落地，对应表
 * 方法留待 Admin 模块（§9 第 9 步）补建，不在本端口范围。
 */

import type {
  SocialTopicModel,
  SocialPostModel,
  SocialPostReplyModel,
  SocialFriendshipModel,
  SocialConversationModel,
  SocialMessageModel,
} from '../../../infrastructure/database/models/social.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';

export type { Tx };

// ---------------------------------------------------------------------------
// PostRepo（social_topic + social_post + social_post_reply）
// 方法名：findTopicByKey / lockPost / createPost / lockPostReply / createPostReply
// ---------------------------------------------------------------------------

export interface PostRepo {
  /**
   * 按 topic_key 查 active 话题（topic.status = ACTIVE=1；缺行 → null，
   * 用例映射 SOCIAL_TOPIC_NOT_FOUND）。
   */
  findTopicByKey(topicKey: string, agentDomainId: string | null, tx: Tx): Promise<SocialTopicModel | null>;

  /**
   * 创建帖子（social_post PENDING_REVIEW=1；U(post_key) 唯一约束幂等兜底，
   * 命中 → 返回既有行（inserted: false），不产生第二帖）。
   * @param input.postKey 客户端幂等键（创建/重试同键异内容 → IDEMPOTENCY_KEY_REUSED，
   *   同键同内容 → 幂等重放返回既有行）。
   */
  createPost(input: {
    agentDomainId: string | null;
    socialTopicId: string;
    userId: string;
    postKey: string;
    title: string | null;
    bodyText: string | null;
    assetIds: string[];
    tx: Tx;
  }): Promise<{ inserted: boolean; post: SocialPostModel }>;

  /** 按主键锁读帖子（SELECT ... FOR UPDATE；post 行锁，回复前置校验）。 */
  lockPost(postId: string, tx: Tx): Promise<SocialPostModel | null>;

  /** 按主键锁读一级回复（SELECT ... FOR UPDATE；嵌套回复深度校验前置）。 */
  lockPostReply(replyId: string, tx: Tx): Promise<SocialPostReplyModel | null>;

  /**
   * 创建回复（social_post_reply PENDING_REVIEW=1；U(reply_key) 唯一约束幂等兜底；
   * parent_social_post_reply_id 引用同表 → 最多一层嵌套，CHECK 由迁移保证）。
   */
  createPostReply(input: {
    socialPostId: string;
    parentSocialPostReplyId: string | null;
    userId: string;
    replyKey: string;
    bodyText: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; reply: SocialPostReplyModel }>;
}

// ---------------------------------------------------------------------------
// ConversationRepo（social_conversation）
// 方法名：createConversation / lockConversation / findConversationBetween /
//         listConversationsByUser / advanceReadThrough
// ---------------------------------------------------------------------------

export interface ConversationRepo {
  /**
   * 创建一对一会话（social_conversation ACTIVE=1；pair 归一 U(low_user_id,
   *   high_user_id) 唯一约束幂等兜底，命中 → 返回既有行，不产生第二会话）。
   * @param input.lowUserId / input.highUserId 归一后 low < high（用例层经
   *   `normalizePair` 纯函数计算后传入，本层不再比较）。
   */
  createConversation(input: {
    agentDomainId: string | null;
    lowUserId: string;
    highUserId: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; conversation: SocialConversationModel }>;

  /** 按主键锁读会话（SELECT ... FOR UPDATE；会话行锁，追加消息前读 last_message_no）。 */
  lockConversation(conversationId: string, tx: Tx): Promise<SocialConversationModel | null>;

  /** 按主键读会话（只读无锁；缺行 → null；成员校验/补拉用，避免不必要行锁）。 */
  findConversationByPk(conversationId: string, tx: Tx): Promise<SocialConversationModel | null>;

  /** 按 pair 归一查会话（U(low,high) 至多一行；缺行 → null）。 */
  findConversationBetween(lowUserId: string, highUserId: string, tx: Tx): Promise<SocialConversationModel | null>;

  /** 用户会话列表（GET /me/social/conversations；只读，按 last_message_at 降序，前 100 条）。 */
  listConversationsByUser(userId: string, tx: Tx): Promise<SocialConversationModel[]>;

  /**
   * 推进已读游标（user_low/high_read_through_no 单调递增；
   * 超过高水位 last_message_no 的非法游标 → 用例层前置校验，本层只做 UPDATE）。
   * @param userLowReadThroughNo / userHighReadThroughNo 十进制字符串，至少一侧非 null。
   */
  advanceReadThrough(input: {
    conversationId: string;
    userLowReadThroughNo: string | null;
    userHighReadThroughNo: string | null;
    tx: Tx;
  }): Promise<SocialConversationModel>;
}

// ---------------------------------------------------------------------------
// MessageRepo（social_message）
// 方法名：appendMessage / findMessageByClientKey / listMessagesAfterNo
// ---------------------------------------------------------------------------

export interface MessageRepo {
  /**
   * 追加消息（social_message SENT=1；U(social_conversation_id, message_no) 保证
   * 会话内单调递增；U(sender_user_id, client_message_id) 幂等兜底——
   * 命中 → 返回既有行（inserted: false，不产生第二行，验收红线"双账号私信幂等"）。
   * @param input.messageNo 新序号 = 会话 last_message_no + 1（用例层经
   *   `nextMessageNo` 纯函数计算后传入，本层不再 +1）。
   */
  appendMessage(input: {
    socialConversationId: string;
    messageNo: string;
    senderUserId: string;
    clientMessageId: string;
    messageType: number;
    bodyText: string | null;
    assetId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; message: SocialMessageModel }>;

  /** 按 (sender_user_id, client_message_id) 查（幂等重放用；U 约束保证至多一行）。 */
  findMessageByClientKey(senderUserId: string, clientMessageId: string, tx: Tx): Promise<SocialMessageModel | null>;

  /**
   * 补拉消息（message_no > afterNo，升序，limit 条；SDD §9 第 5 步验收
   * "消息补拉一致性"；first version 按 message_no 升序补拉，游标 after_message_no 含 0 起点）。
   * @param afterMessageNo 十进制字符串（`0` = 从头拉取，缺省）。
   * @param limit 单页上限（首版固定 50，可经配置注入，决策点登记）。
   */
  listMessagesAfterNo(conversationId: string, afterMessageNo: string, limit: number, tx: Tx): Promise<SocialMessageModel[]>;
}

// ---------------------------------------------------------------------------
// FriendshipRepo（social_friendship）
// 方法名：findFriendshipBetween / lockFriendship / createFriendship /
//         markFriendshipAccepted / markFriendshipRejected
// ---------------------------------------------------------------------------

export interface FriendshipRepo {
  /** 按 pair 归一查好友关系（U(low,high) 至多一行；缺行 → null）。 */
  findFriendshipBetween(lowUserId: string, highUserId: string, tx: Tx): Promise<SocialFriendshipModel | null>;

  /** 按 pair 归一锁读（SELECT ... FOR UPDATE；状态机转换前置校验）。 */
  lockFriendship(lowUserId: string, highUserId: string, tx: Tx): Promise<SocialFriendshipModel | null>;

  /** 按主键锁读好友关系（SELECT ... FOR UPDATE；状态机转换前置校验）。 */
  lockFriendshipByPk(friendshipId: string, tx: Tx): Promise<SocialFriendshipModel | null>;

  /**
   * 创建好友申请（social_friendship PENDING=1；U(low,high) 唯一约束幂等兜底，
   * 命中 → 返回既有行（inserted: false，不产生第二申请，验收红线"好友申请幂等"）。
   * @param input.requesterUserId 必须是 pair 成员（CHECK 由迁移保证）。
   */
  createFriendship(input: {
    agentDomainId: string | null;
    lowUserId: string;
    highUserId: string;
    requesterUserId: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; friendship: SocialFriendshipModel }>;

  /** 推进 PENDING=1 → ACCEPTED=2（同事务回填 responded_at；影响行数 0 → 抛 FENCING_CONFLICT）。 */
  markFriendshipAccepted(friendshipId: string, respondedAt: Date, tx: Tx): Promise<SocialFriendshipModel>;

  /** 推进 PENDING=1 → REJECTED=3（同事务回填 responded_at；影响行数 0 → 抛 FENCING_CONFLICT）。 */
  markFriendshipRejected(friendshipId: string, respondedAt: Date, tx: Tx): Promise<SocialFriendshipModel>;
}
