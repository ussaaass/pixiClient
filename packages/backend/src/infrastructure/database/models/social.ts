/**
 * social — 社区、私聊与内容审核：`social_topic` / `social_post` / `social_post_reply` /
 * `social_friendship` / `social_conversation` / `social_message` /
 * `social_content_interaction` / `social_block` / `social_report`。
 *
 * 领域所有者：social 模块（models/social.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.7；数据库设计SDD §5.12。
 * DDL 以迁移 0014-create-social.ts 为准。
 *
 * 读写用例：
 * - `SocialTopicModel`：平台公共或代理域专属的社区话题目录；唯一索引使用
 *   COALESCE(agent_domain_id,0) 归一（MySQL 9 表达式索引，迁移 DDL 层生效）。
 * - `SocialPostModel` / `SocialPostReplyModel`：帖子/回复及其审核（HIDDEN 保留原内容，
 *   REDACTED 清空正文与附件引用）；asset_ids JSON 为 asset.id 数组（外键待 0017 补建）。
 * - `SocialFriendshipModel`：好友申请与关系（pair 用 low/high_user_id 归一，U(low,high)）。
 * - `SocialConversationModel`：一对一私聊及双方阅读游标（U(low,high)，消息高水位
 *   last_message_no，已读游标 CHECK 不得超过高水位）。
 * - `SocialMessageModel`：私聊消息持久化记录（脱敏保留行位，不硬删；
 *   TEXT⇒body_text 非空且 asset 空、IMAGE⇒asset 非空的组合 CHECK）。
 * - `SocialContentInteractionModel`：轻量互动（DISLIKE/FOLLOW_AUTHOR；
 *   interaction_key U 保证同一互动一条当前状态）。
 * - `SocialBlockModel` / `SocialReportModel`：屏蔽与举报审核。
 *
 * 各表 `agent_domain_id` FK 由迁移管理（0009 目标表已建，RESTRICT）。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { standardTableOptions, type ModelInitFn, type ModelInitOptions } from './_shared.js';

// ---------------------------------------------------------------------------
// social_topic
// ---------------------------------------------------------------------------

/** `social_topic` 表属性。agent_domain_id 可空表示平台公共话题；cover_asset_id 外键待 0017 补建。 */
export interface SocialTopicModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 话题所属代理域；NULL 表示平台公共话题，引用 agent_domain.id。 */
  agentDomainId: string | null;
  /** scope 内稳定话题键。 */
  topicKey: string;
  name: string;
  description: string | null;
  /** 话题封面，引用 asset 表；外键待 0017 补建。 */
  coverAssetId: string | null;
  /** 同域展示排序；数值不是状态常量。 */
  sortOrder: number;
}

export type SocialTopicModelCreationAttributes = Optional<
  SocialTopicModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialTopicModel
  extends Model<SocialTopicModelAttributes, SocialTopicModelCreationAttributes>
  implements SocialTopicModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  agentDomainId!: string | null;
  topicKey!: string;
  name!: string;
  description!: string | null;
  coverAssetId!: string | null;
  sortOrder!: number;
  static associate(models: { SocialTopicModel: typeof SocialTopicModel }): void {
    void models.SocialTopicModel;
    // agent_domain / cover_asset 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_post
// ---------------------------------------------------------------------------

/**
 * `social_post` 表属性。asset_ids JSON 为帖子图片对应的 asset.id 数组
 * （写时逐个校验归属/READY/图片 MIME，不存文件 URL 或密钥）；
 * HIDDEN 保留原内容，REDACTED 清空正文与附件引用（CHECK 强制）。
 */
export interface SocialPostModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  agentDomainId: string | null;
  /** 帖子主话题，引用 social_topic.id。 */
  socialTopicId: string;
  /** 作者，引用 user.id。 */
  userId: string;
  /** 创建/重试幂等键。 */
  postKey: string;
  title: string | null;
  /** MEDIUMTEXT：正文；脱敏/删除时清空。 */
  bodyText: string | null;
  /** JSON：帖子图片对应的 asset.id 数组；外键待 0017 补建。 */
  assetIds: string[];
  /** 运营置顶失效时间。 */
  pinnedUntil: Date | string | null;
  /** 执行置顶的 Admin/运营者，引用 user.id。 */
  pinnedByUserId: string | null;
  /** 最近处理内容的 Admin/代理 user，引用 user.id。 */
  moderatedByUserId: string | null;
  /** 最近审核时间。 */
  moderatedAt: Date | string | null;
  /** 脱敏审核理由，不记录私密凭证。 */
  moderationNote: string | null;
}

export type SocialPostModelCreationAttributes = Optional<
  SocialPostModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialPostModel
  extends Model<SocialPostModelAttributes, SocialPostModelCreationAttributes>
  implements SocialPostModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  agentDomainId!: string | null;
  socialTopicId!: string;
  userId!: string;
  postKey!: string;
  title!: string | null;
  bodyText!: string | null;
  assetIds!: string[];
  pinnedUntil!: Date | string | null;
  pinnedByUserId!: string | null;
  moderatedByUserId!: string | null;
  moderatedAt!: Date | string | null;
  moderationNote!: string | null;
  static associate(models: { SocialPostModel: typeof SocialPostModel; SocialTopicModel: typeof SocialTopicModel }): void {
    SocialPostModel.belongsTo(models.SocialTopicModel, {
      foreignKey: 'social_topic_id',
      as: 'topic',
      constraints: false,
    });
    // user / agent_domain / pinned_by / moderated_by 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_post_reply
// ---------------------------------------------------------------------------

/**
 * `social_post_reply` 表属性。回复深度最多一层（parent_social_post_reply_id
 * 引用同表，NULL 表示直接回复帖子）；scope 继承自帖子。
 */
export interface SocialPostReplyModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 所属帖子，引用 social_post.id；scope 继承自帖子。 */
  socialPostId: string;
  /** 被回复的一级回复；NULL 表示直接回复帖子。 */
  parentSocialPostReplyId: string | null;
  /** 作者，引用 user.id。 */
  userId: string;
  /** 创建/重试幂等键。 */
  replyKey: string;
  bodyText: string | null;
  moderatedByUserId: string | null;
  moderatedAt: Date | string | null;
  moderationNote: string | null;
}

export type SocialPostReplyModelCreationAttributes = Optional<
  SocialPostReplyModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialPostReplyModel
  extends Model<SocialPostReplyModelAttributes, SocialPostReplyModelCreationAttributes>
  implements SocialPostReplyModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  socialPostId!: string;
  parentSocialPostReplyId!: string | null;
  userId!: string;
  replyKey!: string;
  bodyText!: string | null;
  moderatedByUserId!: string | null;
  moderatedAt!: Date | string | null;
  moderationNote!: string | null;
  static associate(models: { SocialPostReplyModel: typeof SocialPostReplyModel }): void {
    SocialPostReplyModel.belongsTo(models.SocialPostReplyModel, {
      foreignKey: 'parent_social_post_reply_id',
      as: 'parentReply',
      constraints: false,
    });
    // social_post / user / moderated_by 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_friendship
// ---------------------------------------------------------------------------

/**
 * `social_friendship` 表属性。pair 用 low_user_id < high_user_id 归一（CHECK 强制）；
 * requester 必须是 pair 成员（CHECK 强制）。
 */
export interface SocialFriendshipModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  agentDomainId: string | null;
  /** pair 中较小 user ID，引用 user.id。 */
  lowUserId: string;
  /** pair 中较大 user ID，引用 user.id。 */
  highUserId: string;
  /** 发起好友申请的 user，必须是 pair 成员。 */
  requesterUserId: string;
  /** 接受或拒绝时间。 */
  respondedAt: Date | string | null;
  /** 删除好友关系时间。 */
  endedAt: Date | string | null;
}

export type SocialFriendshipModelCreationAttributes = Optional<
  SocialFriendshipModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialFriendshipModel
  extends Model<SocialFriendshipModelAttributes, SocialFriendshipModelCreationAttributes>
  implements SocialFriendshipModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  agentDomainId!: string | null;
  lowUserId!: string;
  highUserId!: string;
  requesterUserId!: string;
  respondedAt!: Date | string | null;
  endedAt!: Date | string | null;
  static associate(models: { SocialFriendshipModel: typeof SocialFriendshipModel }): void {
    void models.SocialFriendshipModel;
    // agent_domain / low / high / requester 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_conversation
// ---------------------------------------------------------------------------

/**
 * `social_conversation` 表属性。首版仅一对一（pair 用 low/high 归一，U(low,high)）。
 * 消息序号：last_message_no 高水位、user_low/high_read_through_no 已读游标
 * （CHECK 不得超过高水位；BIGINT UNSIGNED 十进制字符串 wire）。
 * open_messaging_day 为 DATE 类型（上海自然日，字符串 wire）。
 */
export interface SocialConversationModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  agentDomainId: string | null;
  lowUserId: string;
  highUserId: string;
  /** BIGINT UNSIGNED：当前会话消息序号高水位；普通计数，允许 0。 */
  lastMessageNo: string;
  /** BIGINT UNSIGNED：low 用户已读消息序号；只能单调递增且不得超过高水位。 */
  userLowReadThroughNo: string;
  /** BIGINT UNSIGNED：high 用户已读消息序号。 */
  userHighReadThroughNo: string;
  /** 最近消息时间。 */
  lastMessageAt: Date | string | null;
  /** 陌生人首句发送方；等待另一方回复时记录。 */
  pendingFirstMessageUserId: string | null;
  /** DATE：收到首句回复后允许陌生人双方继续发送的上海自然日。 */
  openMessagingDay: string | null;
}

export type SocialConversationModelCreationAttributes = Optional<
  SocialConversationModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialConversationModel
  extends Model<SocialConversationModelAttributes, SocialConversationModelCreationAttributes>
  implements SocialConversationModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  agentDomainId!: string | null;
  lowUserId!: string;
  highUserId!: string;
  lastMessageNo!: string;
  userLowReadThroughNo!: string;
  userHighReadThroughNo!: string;
  lastMessageAt!: Date | string | null;
  pendingFirstMessageUserId!: string | null;
  openMessagingDay!: string | null;
  static associate(models: { SocialConversationModel: typeof SocialConversationModel }): void {
    void models.SocialConversationModel;
    // agent_domain / low / high / pending 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_message
// ---------------------------------------------------------------------------

/**
 * `social_message` 表属性。脱敏保留行位（不硬删，deleted_at 恒 NULL）；
 * U(social_conversation_id,message_no)、U(sender_user_id,client_message_id)。
 * asset_id 引用 asset 表（外键待 0017 补建）。
 */
export interface SocialMessageModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 所属会话及 scope 权威来源，引用 social_conversation.id。 */
  socialConversationId: string;
  /** BIGINT UNSIGNED：会话内单调递增序号。 */
  messageNo: string;
  /** 发送者，必须是会话成员，引用 user.id。 */
  senderUserId: string;
  /** 发送端幂等键。 */
  clientMessageId: string;
  /** 消息类型：TEXT=1/IMAGE=2。 */
  messageType: number;
  /** TEXT 内容；加密附件不放正文。 */
  bodyText: string | null;
  /** 单个私有加密附件，引用 asset 表；外键待 0017 补建。 */
  assetId: string | null;
  redactedByUserId: string | null;
  redactedAt: Date | string | null;
}

export type SocialMessageModelCreationAttributes = Optional<
  SocialMessageModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialMessageModel
  extends Model<SocialMessageModelAttributes, SocialMessageModelCreationAttributes>
  implements SocialMessageModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  socialConversationId!: string;
  messageNo!: string;
  senderUserId!: string;
  clientMessageId!: string;
  messageType!: number;
  bodyText!: string | null;
  assetId!: string | null;
  redactedByUserId!: string | null;
  redactedAt!: Date | string | null;
  static associate(models: { SocialMessageModel: typeof SocialMessageModel }): void {
    void models.SocialMessageModel;
    // social_conversation / sender / redacted_by / asset 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_content_interaction
// ---------------------------------------------------------------------------

/**
 * `social_content_interaction` 表属性。互动可撤销但保留记录（deleted_at 恒 NULL）；
 * interaction_key U 保证同一 actor/target/action 只有一条当前状态；
 * target_type 与三个目标列组合 CHECK（恰好一个非 NULL）。
 */
export interface SocialContentInteractionModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 服务端生成的 actor/target/action 稳定组合键。 */
  interactionKey: string;
  /** 执行互动的 user，引用 user.id。 */
  actorUserId: string;
  /** 互动目标类型：POST=1/POST_REPLY=2/USER=3。 */
  targetType: number;
  /** target_type=POST 时填写，引用 social_post.id。 */
  socialPostId: string | null;
  /** target_type=POST_REPLY 时填写，引用 social_post_reply.id。 */
  socialPostReplyId: string | null;
  /** target_type=USER 时填写；FOLLOW_AUTHOR 的目标作者，引用 user.id。 */
  targetUserId: string | null;
  /** 互动类型：DISLIKE=1/FOLLOW_AUTHOR=2；举报独立记录在 social_report。 */
  actionType: number;
  /** 取消 dislike/关注时记录结束时间。 */
  endedAt: Date | string | null;
}

export type SocialContentInteractionModelCreationAttributes = Optional<
  SocialContentInteractionModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialContentInteractionModel
  extends Model<SocialContentInteractionModelAttributes, SocialContentInteractionModelCreationAttributes>
  implements SocialContentInteractionModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  interactionKey!: string;
  actorUserId!: string;
  targetType!: number;
  socialPostId!: string | null;
  socialPostReplyId!: string | null;
  targetUserId!: string | null;
  actionType!: number;
  endedAt!: Date | string | null;
  static associate(models: { SocialContentInteractionModel: typeof SocialContentInteractionModel }): void {
    void models.SocialContentInteractionModel;
    // actor / social_post / social_post_reply / target_user 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_block
// ---------------------------------------------------------------------------

/** `social_block` 表属性。解除屏蔽时更新状态不删除历史（deleted_at 恒 NULL）；
 * 不能自我屏蔽（CHECK 强制）。 */
export interface SocialBlockModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 屏蔽关系 scope，引用 agent_domain.id。 */
  agentDomainId: string | null;
  /** 发起屏蔽的 user，引用 user.id。 */
  blockerUserId: string;
  /** 被屏蔽的 user，引用 user.id。 */
  blockedUserId: string;
  /** 解除屏蔽时间。 */
  endedAt: Date | string | null;
}

export type SocialBlockModelCreationAttributes = Optional<
  SocialBlockModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialBlockModel
  extends Model<SocialBlockModelAttributes, SocialBlockModelCreationAttributes>
  implements SocialBlockModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  agentDomainId!: string | null;
  blockerUserId!: string;
  blockedUserId!: string;
  endedAt!: Date | string | null;
  static associate(models: { SocialBlockModel: typeof SocialBlockModel }): void {
    void models.SocialBlockModel;
    // agent_domain / blocker / blocked 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// social_report
// ---------------------------------------------------------------------------

/**
 * `social_report` 表属性。举报审计保留（deleted_at 恒 NULL）；
 * target_type 与四个目标列组合 CHECK（恰好一个非 NULL）。
 */
export interface SocialReportModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 举报审核 scope；按目标内容归属，引用 agent_domain.id。 */
  agentDomainId: string | null;
  /** 举报创建幂等键。 */
  reportKey: string;
  /** 举报人，引用 user.id。 */
  reporterUserId: string;
  /** 举报目标类型：POST=1/POST_REPLY=2/MESSAGE=3/USER=4。 */
  targetType: number;
  /** 帖子目标；仅对应 POST。 */
  socialPostId: string | null;
  /** 回复目标；仅对应 POST_REPLY。 */
  socialPostReplyId: string | null;
  /** 私聊消息目标；仅对应 MESSAGE。 */
  socialMessageId: string | null;
  /** 仅 target_type=USER 时的举报目标；内容作者从目标实体读取。 */
  reportedUserId: string | null;
  /** 已登记举报原因常量，取值由共享代码维护。 */
  reasonCode: number;
  /** 举报补充说明，不复制整段私聊/帖子作为证据。 */
  details: string | null;
  /** 处理举报的 Admin/获授权代理，引用 user.id。 */
  handledByUserId: string | null;
  handledAt: Date | string | null;
  /** 处理结果常量；未结案为空。 */
  resolutionCode: number | null;
  resolutionNote: string | null;
}

export type SocialReportModelCreationAttributes = Optional<
  SocialReportModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SocialReportModel
  extends Model<SocialReportModelAttributes, SocialReportModelCreationAttributes>
  implements SocialReportModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  agentDomainId!: string | null;
  reportKey!: string;
  reporterUserId!: string;
  targetType!: number;
  socialPostId!: string | null;
  socialPostReplyId!: string | null;
  socialMessageId!: string | null;
  reportedUserId!: string | null;
  reasonCode!: number;
  details!: string | null;
  handledByUserId!: string | null;
  handledAt!: Date | string | null;
  resolutionCode!: number | null;
  resolutionNote!: string | null;
  static associate(models: { SocialReportModel: typeof SocialReportModel }): void {
    void models.SocialReportModel;
    // agent_domain / reporter / social_post / social_post_reply / social_message / reported_user / handled_by 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

export const SocialPostStatus = { PENDING_REVIEW: 1, PUBLISHED: 2, HIDDEN: 3, REDACTED: 4 } as const;
export type SocialPostStatusValue = (typeof SocialPostStatus)[keyof typeof SocialPostStatus];

export const SocialPostReplyStatus = { PENDING_REVIEW: 1, PUBLISHED: 2, HIDDEN: 3, REDACTED: 4 } as const;
export type SocialPostReplyStatusValue = (typeof SocialPostReplyStatus)[keyof typeof SocialPostReplyStatus];

export const SocialFriendshipStatus = { PENDING: 1, ACCEPTED: 2, REJECTED: 3, REMOVED: 4 } as const;
export type SocialFriendshipStatusValue = (typeof SocialFriendshipStatus)[keyof typeof SocialFriendshipStatus];

export const SocialConversationStatus = { ACTIVE: 1, READ_ONLY: 2, CLOSED: 3 } as const;
export type SocialConversationStatusValue = (typeof SocialConversationStatus)[keyof typeof SocialConversationStatus];

export const SocialMessageStatus = { SENT: 1, REDACTED: 2 } as const;
export type SocialMessageStatusValue = (typeof SocialMessageStatus)[keyof typeof SocialMessageStatus];

export const SocialMessageType = { TEXT: 1, IMAGE: 2 } as const;
export type SocialMessageTypeValue = (typeof SocialMessageType)[keyof typeof SocialMessageType];

export const SocialContentInteractionStatus = { ACTIVE: 1, REMOVED: 2 } as const;
export type SocialContentInteractionStatusValue = (typeof SocialContentInteractionStatus)[keyof typeof SocialContentInteractionStatus];

export const SocialInteractionTargetType = { POST: 1, POST_REPLY: 2, USER: 3 } as const;
export type SocialInteractionTargetTypeValue = (typeof SocialInteractionTargetType)[keyof typeof SocialInteractionTargetType];

export const SocialInteractionActionType = { DISLIKE: 1, FOLLOW_AUTHOR: 2 } as const;
export type SocialInteractionActionTypeValue = (typeof SocialInteractionActionType)[keyof typeof SocialInteractionActionType];

export const SocialBlockStatus = { ACTIVE: 1, REMOVED: 2 } as const;
export type SocialBlockStatusValue = (typeof SocialBlockStatus)[keyof typeof SocialBlockStatus];

export const SocialReportStatus = { OPEN: 1, RESOLVED: 2, DISMISSED: 3 } as const;
export type SocialReportStatusValue = (typeof SocialReportStatus)[keyof typeof SocialReportStatus];

export const SocialReportTargetType = { POST: 1, POST_REPLY: 2, MESSAGE: 3, USER: 4 } as const;
export type SocialReportTargetTypeValue = (typeof SocialReportTargetType)[keyof typeof SocialReportTargetType];

/** ActiveStatus：行工作状态（多文件共用，单一来源在 contracts 落地后统一）。 */
export const ActiveStatus = { ACTIVE: 1, DISABLED: 2, RETIRED: 3 } as const;
export type ActiveStatusValue = (typeof ActiveStatus)[keyof typeof ActiveStatus];

export function register_SocialTopicModel(sequelize: Sequelize): void {
  (SocialTopicModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '话题行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '话题所属代理域；NULL 表示平台公共话题，引用 agent_domain.id',
      },
      topicKey: {
        field: 'topic_key',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: 'scope 内稳定话题键',
      },
      name: { type: DataTypes.STRING(100), allowNull: false, comment: '展示名称' },
      description: {
        type: DataTypes.STRING(1000),
        allowNull: true,
        comment: '话题说明',
      },
      coverAssetId: {
        field: 'cover_asset_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '话题封面，引用 asset 表；外键待 0017 补建',
      },
      sortOrder: {
        field: 'sort_order',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '同域展示排序；数值不是状态常量',
      },
    },

    {
      ...standardTableOptions('social_topic'),
      comment: '平台公共或代理域专属的社区话题目录',
      sequelize,
    } as unknown as ModelInitOptions<SocialTopicModel>,
  );
}

export function register_SocialPostModel(sequelize: Sequelize): void {
  (SocialPostModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '帖子状态，取值见 SocialPostStatus：PENDING_REVIEW=1/PUBLISHED=2/HIDDEN=3/REDACTED=4',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '帖子 scope；NULL 表示平台公共社区，引用 agent_domain.id',
      },
      socialTopicId: {
        field: 'social_topic_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '帖子主话题，引用 social_topic.id',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '作者，引用 user.id' },
      postKey: {
        field: 'post_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '创建/重试幂等键',
      },
      title: { type: DataTypes.STRING(160), allowNull: true, comment: '可选标题' },
      bodyText: {
        field: 'body_text',
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '正文；脱敏/删除时清空',
      },
      assetIds: {
        field: 'asset_ids',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '帖子图片对应的 asset.id 数组；不存文件 URL 或密钥；写时逐个校验归属/READY/图片 MIME',
      },
      pinnedUntil: {
        field: 'pinned_until',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '运营置顶失效时间，UTC',
      },
      pinnedByUserId: {
        field: 'pinned_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '执行置顶的 Admin/运营者，引用 user.id',
      },
      moderatedByUserId: {
        field: 'moderated_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '最近处理内容的 Admin/代理 user，引用 user.id',
      },
      moderatedAt: {
        field: 'moderated_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最近审核时间，UTC',
      },
      moderationNote: {
        field: 'moderation_note',
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: '脱敏审核理由，不记录私密凭证',
      },
    },

    {
      ...standardTableOptions('social_post'),
      comment: '社区公开帖子及其可见范围/审核状态',
      sequelize,
    } as unknown as ModelInitOptions<SocialPostModel>,
  );
}

export function register_SocialPostReplyModel(sequelize: Sequelize): void {
  (SocialPostReplyModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '回复状态，取值见 SocialPostReplyStatus：PENDING_REVIEW=1/PUBLISHED=2/HIDDEN=3/REDACTED=4',
      },
      socialPostId: {
        field: 'social_post_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属帖子，引用 social_post.id；scope 继承自帖子',
      },
      parentSocialPostReplyId: {
        field: 'parent_social_post_reply_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '被回复的一级回复；NULL 表示直接回复帖子；回复深度最多一层',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '作者，引用 user.id' },
      replyKey: {
        field: 'reply_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '创建/重试幂等键',
      },
      bodyText: {
        field: 'body_text',
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '回复正文；脱敏/删除时清空',
      },
      moderatedByUserId: {
        field: 'moderated_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '最近处理内容的 Admin/代理 user，引用 user.id',
      },
      moderatedAt: {
        field: 'moderated_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最近审核时间，UTC',
      },
      moderationNote: {
        field: 'moderation_note',
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: '脱敏审核理由',
      },
    },

    {
      ...standardTableOptions('social_post_reply'),
      comment: '社区帖子下的一级回复与跟帖',
      sequelize,
    } as unknown as ModelInitOptions<SocialPostReplyModel>,
  );
}

export function register_SocialFriendshipModel(sequelize: Sequelize): void {
  (SocialFriendshipModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '好友关系状态，取值见 SocialFriendshipStatus：PENDING=1/ACCEPTED=2/REJECTED=3/REMOVED=4',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '当前关系 scope，引用 agent_domain.id；仅同一有效 scope 可建立关系',
      },
      lowUserId: {
        field: 'low_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'pair 中较小 user ID，引用 user.id',
      },
      highUserId: {
        field: 'high_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'pair 中较大 user ID，引用 user.id',
      },
      requesterUserId: {
        field: 'requester_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '发起好友申请的 user，引用 user.id；必须是 pair 成员',
      },
      respondedAt: {
        field: 'responded_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '接受或拒绝时间，UTC',
      },
      endedAt: {
        field: 'ended_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '删除好友关系时间，UTC',
      },
    },

    {
      ...standardTableOptions('social_friendship'),
      comment: '两位用户之间的好友申请和关系状态',
      sequelize,
    } as unknown as ModelInitOptions<SocialFriendshipModel>,
  );
}

export function register_SocialConversationModel(sequelize: Sequelize): void {
  (SocialConversationModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '会话状态，取值见 SocialConversationStatus：ACTIVE=1/READ_ONLY=2/CLOSED=3',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '会话当前 scope，引用 agent_domain.id',
      },
      lowUserId: {
        field: 'low_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'pair 中较小 user ID，引用 user.id；首版仅一对一，禁止 self-chat',
      },
      highUserId: {
        field: 'high_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'pair 中较大 user ID，引用 user.id',
      },
      lastMessageNo: {
        field: 'last_message_no',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前会话消息序号高水位；普通计数，允许 0',
      },
      userLowReadThroughNo: {
        field: 'user_low_read_through_no',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: 'low 用户已读消息序号；只能单调递增且不得超过高水位',
      },
      userHighReadThroughNo: {
        field: 'user_high_read_through_no',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: 'high 用户已读消息序号；只能单调递增且不得超过高水位',
      },
      lastMessageAt: {
        field: 'last_message_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最近消息时间，UTC',
      },
      pendingFirstMessageUserId: {
        field: 'pending_first_message_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '陌生人首句发送方；等待另一方回复时记录，好友关系建立后忽略',
      },
      openMessagingDay: {
        field: 'open_messaging_day',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '收到首句回复后允许陌生人双方继续发送的上海自然日',
      },
    },

    {
      ...standardTableOptions('social_conversation'),
      comment: '固定一对一私聊会话及双方阅读游标',
      sequelize,
    } as unknown as ModelInitOptions<SocialConversationModel>,
  );
}

export function register_SocialMessageModel(sequelize: Sequelize): void {
  (SocialMessageModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '消息状态，取值见 SocialMessageStatus：SENT=1/REDACTED=2',
      },
      socialConversationId: {
        field: 'social_conversation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属会话及 scope 权威来源，引用 social_conversation.id',
      },
      messageNo: {
        field: 'message_no',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '会话内单调递增序号',
      },
      senderUserId: {
        field: 'sender_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '发送者，必须是会话成员，引用 user.id',
      },
      clientMessageId: {
        field: 'client_message_id',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '发送端幂等键',
      },
      messageType: {
        field: 'message_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '消息类型：TEXT=1/IMAGE=2',
      },
      bodyText: {
        field: 'body_text',
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '文本内容；加密附件不放正文',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '单个私有加密附件，引用 asset 表；外键待 0017 补建',
      },
      redactedByUserId: {
        field: 'redacted_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '执行脱敏的 Admin/获授权代理，引用 user.id',
      },
      redactedAt: {
        field: 'redacted_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '脱敏时间，UTC',
      },
    },

    {
      ...standardTableOptions('social_message'),
      comment: '一对一社交消息、游标补拉与发送幂等',
      sequelize,
    } as unknown as ModelInitOptions<SocialMessageModel>,
  );
}

export function register_SocialContentInteractionModel(sequelize: Sequelize): void {
  (SocialContentInteractionModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '互动状态，取值见 SocialContentInteractionStatus：ACTIVE=1/REMOVED=2',
      },
      interactionKey: {
        field: 'interaction_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '服务端生成的 actor/target/action 稳定组合键，保证同一互动只有一条当前状态',
      },
      actorUserId: {
        field: 'actor_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '执行互动的 user，引用 user.id',
      },
      targetType: {
        field: 'target_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '互动目标类型：POST=1/POST_REPLY=2/USER=3',
      },
      socialPostId: {
        field: 'social_post_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'target_type=POST 时填写，引用 social_post.id',
      },
      socialPostReplyId: {
        field: 'social_post_reply_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'target_type=POST_REPLY 时填写，引用 social_post_reply.id',
      },
      targetUserId: {
        field: 'target_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'target_type=USER 时填写；FOLLOW_AUTHOR 的目标作者，引用 user.id',
      },
      actionType: {
        field: 'action_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '互动类型：DISLIKE=1/FOLLOW_AUTHOR=2；举报独立记录在 social_report',
      },
      endedAt: {
        field: 'ended_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '取消 dislike/关注时记录结束时间，UTC',
      },
    },

    {
      ...standardTableOptions('social_content_interaction'),
      comment: '用户对帖子或回复的轻量互动状态',
      sequelize,
    } as unknown as ModelInitOptions<SocialContentInteractionModel>,
  );
}

export function register_SocialBlockModel(sequelize: Sequelize): void {
  (SocialBlockModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '屏蔽状态，取值见 SocialBlockStatus：ACTIVE=1/REMOVED=2',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '屏蔽关系 scope，引用 agent_domain.id',
      },
      blockerUserId: {
        field: 'blocker_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '发起屏蔽的 user，引用 user.id',
      },
      blockedUserId: {
        field: 'blocked_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被屏蔽的 user，引用 user.id',
      },
      endedAt: {
        field: 'ended_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '解除屏蔽时间，UTC',
      },
    },

    {
      ...standardTableOptions('social_block'),
      comment: '单向用户屏蔽关系',
      sequelize,
    } as unknown as ModelInitOptions<SocialBlockModel>,
  );
}

export function register_SocialReportModel(sequelize: Sequelize): void {
  (SocialReportModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '举报状态，取值见 SocialReportStatus：OPEN=1/RESOLVED=2/DISMISSED=3',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '举报审核 scope；按目标内容归属，引用 agent_domain.id',
      },
      reportKey: {
        field: 'report_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '举报创建幂等键',
      },
      reporterUserId: {
        field: 'reporter_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '举报人，引用 user.id',
      },
      targetType: {
        field: 'target_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '举报目标类型：POST=1/POST_REPLY=2/MESSAGE=3/USER=4',
      },
      socialPostId: {
        field: 'social_post_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '帖子目标；仅对应 POST，引用 social_post.id',
      },
      socialPostReplyId: {
        field: 'social_post_reply_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '回复目标；仅对应 POST_REPLY，引用 social_post_reply.id',
      },
      socialMessageId: {
        field: 'social_message_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '私聊消息目标；仅对应 MESSAGE，引用 social_message.id',
      },
      reportedUserId: {
        field: 'reported_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '仅 target_type=USER 时的举报目标，引用 user.id；内容作者从目标实体读取',
      },
      reasonCode: {
        field: 'reason_code',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '已登记举报原因常量，取值由共享代码维护',
      },
      details: {
        type: DataTypes.STRING(1000),
        allowNull: true,
        comment: '举报补充说明，不复制整段私聊/帖子作为证据',
      },
      handledByUserId: {
        field: 'handled_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '处理举报的 Admin/获授权代理，引用 user.id',
      },
      handledAt: {
        field: 'handled_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '处理时间，UTC',
      },
      resolutionCode: {
        field: 'resolution_code',
        type: DataTypes.SMALLINT,
        allowNull: true,
        comment: '处理结果常量；未结案为空',
      },
      resolutionNote: {
        field: 'resolution_note',
        type: DataTypes.STRING(1000),
        allowNull: true,
        comment: '处理说明',
      },
    },

    {
      ...standardTableOptions('social_report'),
      comment: '社交内容/账号举报及其审核处理状态',
      sequelize,
    } as unknown as ModelInitOptions<SocialReportModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface SocialModels {
  SocialTopicModel: typeof SocialTopicModel;
  SocialPostModel: typeof SocialPostModel;
  SocialPostReplyModel: typeof SocialPostReplyModel;
  SocialFriendshipModel: typeof SocialFriendshipModel;
  SocialConversationModel: typeof SocialConversationModel;
  SocialMessageModel: typeof SocialMessageModel;
  SocialContentInteractionModel: typeof SocialContentInteractionModel;
  SocialBlockModel: typeof SocialBlockModel;
  SocialReportModel: typeof SocialReportModel;
}

/** 定义 9 个 social model（不在此声明跨文件关联）。 */
export function initSocial(sequelize: Sequelize, models: SocialModels): void {
  register_SocialTopicModel(sequelize);
  register_SocialPostModel(sequelize);
  register_SocialPostReplyModel(sequelize);
  register_SocialFriendshipModel(sequelize);
  register_SocialConversationModel(sequelize);
  register_SocialMessageModel(sequelize);
  register_SocialContentInteractionModel(sequelize);
  register_SocialBlockModel(sequelize);
  register_SocialReportModel(sequelize);
  void models;
}

/** 声明 social 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateSocial(models: SocialModels): void {
  SocialTopicModel.associate(models);
  SocialPostModel.associate(models);
  SocialPostReplyModel.associate(models);
  SocialFriendshipModel.associate(models);
  SocialConversationModel.associate(models);
  SocialMessageModel.associate(models);
  SocialContentInteractionModel.associate(models);
  SocialBlockModel.associate(models);
  SocialReportModel.associate(models);
}
