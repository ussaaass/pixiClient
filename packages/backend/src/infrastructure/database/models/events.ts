/**
 * events — 事务后任务队列：`outbox`。
 *
 * 领域所有者：platform-events 模块（models/events.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.10；数据库设计SDD §5.8 outbox。
 * DDL 以迁移 0018-create-outbox.ts 为准。
 *
 * 读写用例：outbox 与业务事实同事务写入，worker 负责至少一次投递；
 * 消费者以 event_key 幂等。
 *
 * 状态机例外（A.10 登记口径）：outbox **不是**不可变表——行 append-only（不删不改），
 * 但 `status` 有 OutboxStatus PENDING=1/PROCESSING=2/SENT=3/DEAD=4 状态机，
 * `updated_at` 随投递正常更新；仅 `deleted_at` 恒 NULL（迁移 CHECK 保证）。
 * 故使用 `outboxTableOptions`（正常 timestamps + paranoid: false），
 * 不使用 append-only hooks。
 *
 * `user_id` / `asset_operation_id` / `round_id` 引用列（十进制字符串 wire）；
 * FK 全部由迁移管理（RESTRICT），模型侧不建 constraints。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { outboxTableOptions, type ModelInitFn, type ModelInitOptions } from './_shared.js';

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

/**
 * `outbox` 表属性。event_key U（消费者幂等）；payload JSON 为版本化最小负载
 * （不含私牌和密钥）；status 随投递状态机流转，updated_at 正常更新。
 */
export interface OutboxModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 消费者幂等事件值（U(event_key)）。 */
  eventKey: string;
  /** 事件或任务主题。 */
  topic: string;
  /** 玩家私有通知目标，引用 user.id。 */
  userId: string | null;
  /** 资金操作源，引用 asset_operation.id。 */
  assetOperationId: string | null;
  /** 公开牌局源，引用 round.id。 */
  roundId: string | null;
  /** 版本化最小负载，不含私牌和密钥。 */
  payload: Record<string, unknown>;
  /** INT UNSIGNED：事件 schema 版本（CHECK >=1）。 */
  payloadVersion: number;
  /** 允许投递时间。 */
  availableAt: Date | string;
  /** INT UNSIGNED：重试次数；普通计数，允许 0。 */
  attempts: number;
  /** 领取任务的进程。 */
  lockedBy: string | null;
  /** 任务领取租约。 */
  leaseUntil: Date | string | null;
  /** 完成投递时间。 */
  sentAt: Date | string | null;
  /** 脱敏失败代码。 */
  lastErrorCode: string | null;
}

export type OutboxModelCreationAttributes = Optional<OutboxModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class OutboxModel extends Model<OutboxModelAttributes, OutboxModelCreationAttributes> implements OutboxModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  eventKey!: string;
  topic!: string;
  userId!: string | null;
  assetOperationId!: string | null;
  roundId!: string | null;
  payload!: Record<string, unknown>;
  payloadVersion!: number;
  availableAt!: Date | string;
  attempts!: number;
  lockedBy!: string | null;
  leaseUntil!: Date | string | null;
  sentAt!: Date | string | null;
  lastErrorCode!: string | null;
  static associate(models: { OutboxModel: typeof OutboxModel }): void {
    void models.OutboxModel;
    // user / asset_operation / round 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

/** OutboxStatus：投递状态机（非不可变表，status 可流转）。 */
export const OutboxStatus = { PENDING: 1, PROCESSING: 2, SENT: 3, DEAD: 4 } as const;
export type OutboxStatusValue = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export function register_OutboxModel(sequelize: Sequelize): void {
  (OutboxModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '投递状态，取值见 OutboxStatus：PENDING=1/PROCESSING=2/SENT=3/DEAD=4',
      },
      eventKey: {
        field: 'event_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '消费者幂等事件值',
      },
      topic: {
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '事件或任务主题',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '玩家私有通知目标，引用 user.id',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '资金操作源，引用 asset_operation.id',
      },
      roundId: {
        field: 'round_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '公开牌局源，引用 round.id',
      },
      payload: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '版本化最小负载，不含私牌和密钥',
      },
      payloadVersion: {
        field: 'payload_version',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '事件 schema 版本',
      },
      availableAt: {
        field: 'available_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '允许投递时间，UTC',
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '重试次数；普通计数，允许 0',
      },
      lockedBy: {
        field: 'locked_by',
        type: DataTypes.STRING(128),
        allowNull: true,
        comment: '领取任务的进程',
      },
      leaseUntil: {
        field: 'lease_until',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '任务领取租约，UTC',
      },
      sentAt: {
        field: 'sent_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '完成投递时间，UTC',
      },
      lastErrorCode: {
        field: 'last_error_code',
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '脱敏失败代码',
      },
    },

    {
      // outbox 例外（A.10）：正常 timestamps（updated_at 随投递状态机更新），
      // 仅 paranoid: false——行 append-only，deleted_at 恒 NULL 由迁移 CHECK 保证。
      ...outboxTableOptions('outbox'),
      comment: '数据库提交后的可靠通知与任务',
      sequelize,
    } as unknown as ModelInitOptions<OutboxModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface EventModels {
  OutboxModel: typeof OutboxModel;
}

/** 定义 1 个 events model（不在此声明跨文件关联）。 */
export function initEvents(sequelize: Sequelize, models: EventModels): void {
  register_OutboxModel(sequelize);
  void models;
}

/** 声明 events 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateEvents(models: EventModels): void {
  OutboxModel.associate(models);
}
