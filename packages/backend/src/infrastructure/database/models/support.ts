/**
 * support — 客服 IM：`support_conversation` / `support_message`。
 *
 * 领域所有者：support 模块（models/support.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.8；数据库设计SDD §5.9。
 * DDL 以迁移 0015-create-support.ts 为准。
 *
 * 读写用例：
 * - `SupportConversationModel`：用户与客服的一次服务会话（一个用户可创建多个独立
 *   问题会话）；order_id / withdrawal_id 关联（FK 由迁移 0015 直建 RESTRICT）。
 * - `SupportMessageModel`：持久化客服会话消息（不硬删除，脱敏保留行位；
 *   status 可 VISIBLE→REDACTED，updated_at 正常更新，不属于不可变表）。
 *
 * 常量注意（对照 SDD §5.9 与 contracts/support.ts）：
 * - `SupportConversationStatus`：DDL CHECK IN (1,2,3,4)，而 contracts 现有
 *   WAITING_SUPPORT=1/WAITING_USER=2/CLOSED=3 无第 4 值——本地常量按 DDL 保留
 *   到 4 并以注释标注待与 SDD §5.9 对齐（决策点）。
 * - 消息 asset_id 外键待 0017 补建（目标 asset 表）。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { standardTableOptions, type ModelInitFn, type ModelInitOptions } from './_shared.js';

// ---------------------------------------------------------------------------
// support_conversation
// ---------------------------------------------------------------------------

/**
 * `support_conversation` 表属性。未读计数与消息写入同事务更新；
 * closed_at 后不可继续追加消息。
 */
export interface SupportConversationModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 发起咨询的用户，引用 user.id；一个用户可创建多个独立问题会话。 */
  userId: string;
  /** 当前负责的客服 Admin；NULL 表示待领取，引用 user.id。 */
  assignedAdminUserId: string | null;
  /** 问题分类：ACCOUNT=1/PAYMENT=2/WITHDRAWAL=3/GAME=4/OTHER=5（与 contracts 一致）。 */
  categoryType: number;
  /** 用户提交的问题标题。 */
  subject: string;
  /** 关联的商城订单（如适用），引用 order.id。 */
  orderId: string | null;
  /** 关联的提现申请（如适用），引用 withdrawal.id。 */
  withdrawalId: string | null;
  /** 最近一条消息时间，用于队列排序，UTC。 */
  lastMessageAt: Date | string | null;
  /** INT UNSIGNED：用户侧未读消息计数；与消息写入同事务更新。 */
  userUnreadCount: number;
  /** INT UNSIGNED：客服侧未读消息计数；与消息写入同事务更新。 */
  supportUnreadCount: number;
  /** 会话关闭时间；关闭后不可继续追加消息。 */
  closedAt: Date | string | null;
}

export type SupportConversationModelCreationAttributes = Optional<
  SupportConversationModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SupportConversationModel
  extends Model<SupportConversationModelAttributes, SupportConversationModelCreationAttributes>
  implements SupportConversationModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  assignedAdminUserId!: string | null;
  categoryType!: number;
  subject!: string;
  orderId!: string | null;
  withdrawalId!: string | null;
  lastMessageAt!: Date | string | null;
  userUnreadCount!: number;
  supportUnreadCount!: number;
  closedAt!: Date | string | null;
  static associate(models: { SupportConversationModel: typeof SupportConversationModel }): void {
    void models.SupportConversationModel;
    // user / assigned_admin_user / order / withdrawal 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// support_message
// ---------------------------------------------------------------------------

/**
 * `support_message` 表属性。消息不硬删除（撤回/隐私清理以 REDACTED 状态保留行位，
 * deleted_at 恒 NULL）；TEXT/SYSTEM_NOTICE 不带 asset，IMAGE/ATTACHMENT 必须带
 * READY 私有 asset（CHECK 强制；asset 外键待 0017 补建）。
 */
export interface SupportMessageModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 所属客服会话，引用 support_conversation.id。 */
  supportConversationId: string;
  /** CHAR(36)：客户端生成的幂等键，弱网重试不得重复发消息。 */
  messageKey: string;
  /** 发信 user；SYSTEM 通知为空，其他消息指向统一 user。 */
  senderUserId: string | null;
  /** 发信方类型：CUSTOMER=1/ADMIN=2/SYSTEM=3（与 contracts 一致）。 */
  senderType: number;
  /** 消息类型：TEXT=1/IMAGE=2/ATTACHMENT=3/SYSTEM_NOTICE=4。 */
  messageType: number;
  /** 文本内容；不得包含密码、OTP、TOTP secret 或支付密钥。 */
  bodyText: string | null;
  /** 图片/附件消息必填，必须是私有且 READY 的 asset；外键待 0017 补建。 */
  assetId: string | null;
  /** 执行脱敏/撤回的客服 Admin，引用 user.id。 */
  redactedByUserId: string | null;
  /** 消息被脱敏时间。 */
  redactedAt: Date | string | null;
}

export type SupportMessageModelCreationAttributes = Optional<
  SupportMessageModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SupportMessageModel
  extends Model<SupportMessageModelAttributes, SupportMessageModelCreationAttributes>
  implements SupportMessageModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  supportConversationId!: string;
  messageKey!: string;
  senderUserId!: string | null;
  senderType!: number;
  messageType!: number;
  bodyText!: string | null;
  assetId!: string | null;
  redactedByUserId!: string | null;
  redactedAt!: Date | string | null;
  static associate(models: { SupportMessageModel: typeof SupportMessageModel }): void {
    void models.SupportMessageModel;
    // support_conversation / sender / redacted_by / asset 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

/**
 * SupportConversationStatus：contracts 现有 WAITING_SUPPORT=1/WAITING_USER=2/CLOSED=3；
 * 迁移 0015 DDL CHECK IN (1,2,3,4)——第 4 值待与数据库设计 SDD §5.9 对齐
 * （见文件头"决策点"），当前本地常量先按 DDL 保留 4。
 */
export const SupportConversationStatus = { WAITING_SUPPORT: 1, WAITING_USER: 2, CLOSED: 3 } as const;
export type SupportConversationStatusValue = (typeof SupportConversationStatus)[keyof typeof SupportConversationStatus];

/** SupportMessageStatus：消息状态。 */
export const SupportMessageStatus = { VISIBLE: 1, REDACTED: 2 } as const;
export type SupportMessageStatusValue = (typeof SupportMessageStatus)[keyof typeof SupportMessageStatus];

/** SupportMessageType：消息类型（与 contracts 数值一致；key 为 DDL 注释命名）。 */
export const SupportMessageType = { TEXT: 1, IMAGE: 2, ATTACHMENT: 3, SYSTEM_NOTICE: 4 } as const;
export type SupportMessageTypeValue = (typeof SupportMessageType)[keyof typeof SupportMessageType];

export function register_SupportConversationModel(sequelize: Sequelize): void {
  (SupportConversationModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment:
          '会话状态，取值见 SupportConversationStatus：WAITING_SUPPORT=1/WAITING_USER=2/CLOSED=3；CHECK 含 4，第 4 值待定（见文件头决策点）',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '发起咨询的用户，引用 user.id；一个用户可创建多个独立问题会话',
      },
      assignedAdminUserId: {
        field: 'assigned_admin_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '当前负责的客服 Admin；NULL 表示待领取，引用 user.id',
      },
      categoryType: {
        field: 'category_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '问题分类，取值见 SupportCategoryType：ACCOUNT=1/PAYMENT=2/WITHDRAWAL=3/GAME=4/OTHER=5',
      },
      subject: {
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '用户提交的问题标题',
      },
      orderId: {
        field: 'order_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联的商城订单（如适用），引用 order.id',
      },
      withdrawalId: {
        field: 'withdrawal_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联的提现申请（如适用），引用 withdrawal.id',
      },
      lastMessageAt: {
        field: 'last_message_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最近一条消息时间，用于队列排序，UTC',
      },
      userUnreadCount: {
        field: 'user_unread_count',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '用户侧未读消息计数；与消息写入同事务更新',
      },
      supportUnreadCount: {
        field: 'support_unread_count',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '客服侧未读消息计数；与消息写入同事务更新',
      },
      closedAt: {
        field: 'closed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '会话关闭时间，UTC；关闭后不可继续追加消息',
      },
    },

    {
      ...standardTableOptions('support_conversation'),
      comment: '用户与客服之间的一次服务会话',
      sequelize,
    } as unknown as ModelInitOptions<SupportConversationModel>,
  );
}

export function register_SupportMessageModel(sequelize: Sequelize): void {
  (SupportMessageModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '消息状态，取值见 SupportMessageStatus：VISIBLE=1/REDACTED=2',
      },
      supportConversationId: {
        field: 'support_conversation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属客服会话，引用 support_conversation.id',
      },
      messageKey: {
        field: 'message_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '客户端生成的幂等键，弱网重试不得重复发消息',
      },
      senderUserId: {
        field: 'sender_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '发信 user；SYSTEM 通知为空，其他消息指向统一 user',
      },
      senderType: {
        field: 'sender_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '发信方类型，取值见 SupportSenderType：CUSTOMER=1/ADMIN=2/SYSTEM=3',
      },
      messageType: {
        field: 'message_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '消息类型，取值见 SupportMessageType：TEXT=1/IMAGE=2/ATTACHMENT=3/SYSTEM_NOTICE=4',
      },
      bodyText: {
        field: 'body_text',
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '文本内容；不得包含密码、OTP、TOTP secret 或支付密钥',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '图片/附件消息必填，必须是私有且 READY 的 asset；TEXT/SYSTEM_NOTICE 为空；外键待 0017 补建',
      },
      redactedByUserId: {
        field: 'redacted_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '执行脱敏/撤回的客服 Admin，引用 user.id',
      },
      redactedAt: {
        field: 'redacted_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '消息被脱敏时间，UTC',
      },
    },

    {
      ...standardTableOptions('support_message'),
      comment: '持久化客服会话消息',
      sequelize,
    } as unknown as ModelInitOptions<SupportMessageModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface SupportModels {
  SupportConversationModel: typeof SupportConversationModel;
  SupportMessageModel: typeof SupportMessageModel;
}

/** 定义 2 个 support model（不在此声明跨文件关联）。 */
export function initSupport(sequelize: Sequelize, models: SupportModels): void {
  register_SupportConversationModel(sequelize);
  register_SupportMessageModel(sequelize);
  void models;
}

/** 声明 support 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateSupport(models: SupportModels): void {
  SupportConversationModel.associate(models);
  SupportMessageModel.associate(models);
}
