/**
 * referral — 邀请关系与返佣：`referral_binding` / `referral_binding_event`（不可变）/
 * `referral_reward_allocation`。
 *
 * 领域所有者：referral 模块（models/referral.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.5；数据库设计SDD §5.5。
 * DDL 以迁移 0012-create-referral.ts 为准。
 *
 * 读写用例：
 * - `ReferralBindingModel`：用户当前邀请上级链快照（五级含本人、最多四个上级；
 *   有意反范式化的 parent_1~4 固定层级列 + benefit_cents 查询投影）。
 * - `ReferralBindingEventModel`（不可变）：初绑与 Admin 换绑的前后链、来源及原因证据流水。
 * - `ReferralRewardAllocationModel`：每个来源订单每个上级的奖励或跳过记录
 *   （reward_type 决定模式；POSTED 时同事务增加上级 benefit_cents 投影）。
 *
 * parent_n_benefit_cents 为 BIGINT UNSIGNED 查询投影（十进制字符串 wire）；
 * basis_subcents / exact_reward_subcents 为 DECIMAL(38,12) 精确值（十进制字符串 wire）。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import {
  appendOnlyHooks,
  appendOnlyModelOptions,
  standardTableOptions,
  binaryDataType,
  type ModelInitFn,
  type ModelInitOptions,
} from './_shared.js';

// ---------------------------------------------------------------------------
// referral_binding
// ---------------------------------------------------------------------------

/**
 * `referral_binding` 表属性。每人至多一行（U(user_id)）；链字段必须连续
 * （CHECK：parent_2 非空 ⇒ parent_1 非空，依此类推）；不得包含本人或重复用户。
 */
export interface ReferralBindingModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 当前被邀请用户（U(user_id)）。 */
  userId: string;
  /** 直属上级，奖励层级 1。 */
  parent1UserId: string;
  /** 上上级，奖励层级 2。 */
  parent2UserId: string | null;
  /** 第三级上级。 */
  parent3UserId: string | null;
  /** 第四级上级，奖励层级 4。 */
  parent4UserId: string | null;
  /** BIGINT UNSIGNED 查询投影：此用户为直属上级累计产生的已发人民币返点分。 */
  parent1BenefitCents: string;
  /** 第二级上级累计已发返点分（查询投影）。 */
  parent2BenefitCents: string;
  /** 第三级上级累计已发返点分（查询投影）。 */
  parent3BenefitCents: string;
  /** 第四级上级累计已发返点分（查询投影）。 */
  parent4BenefitCents: string;
  /** 当前上级链生效时间。 */
  boundAt: Date | string;
  /** BindingSource：IP_ATTRIBUTION=1/INVITE_CODE=2/ADMIN=3。 */
  bindingSource: number;
}

export type ReferralBindingModelCreationAttributes = Optional<
  ReferralBindingModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class ReferralBindingModel
  extends Model<ReferralBindingModelAttributes, ReferralBindingModelCreationAttributes>
  implements ReferralBindingModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  parent1UserId!: string;
  parent2UserId!: string | null;
  parent3UserId!: string | null;
  parent4UserId!: string | null;
  parent1BenefitCents!: string;
  parent2BenefitCents!: string;
  parent3BenefitCents!: string;
  parent4BenefitCents!: string;
  boundAt!: Date | string;
  bindingSource!: number;
  static associate(models: { ReferralBindingModel: typeof ReferralBindingModel }): void {
    ReferralBindingModel.belongsTo(models.ReferralBindingModel, {
      foreignKey: 'parent_1_user_id',
      as: 'parent1',
      constraints: false,
    });
    // user / parent_2~4 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// referral_binding_event（不可变）
// ---------------------------------------------------------------------------

/**
 * `referral_binding_event` 表属性（不可变绑定证据）。status 固定 RECORDED=1；
 * updated_at 固定等于 created_at；deleted_at 恒 NULL（迁移 CHECK）。
 * 同一管理员请求重算多个下级时共用 request_key，逐用户写事件。
 */
export interface ReferralBindingEventModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 被绑定或换绑用户。 */
  userId: string;
  /** 换绑前直属上级。 */
  previousParent1UserId: string | null;
  /** 新绑定或换绑后的直属上级。 */
  newParent1UserId: string;
  /** 仅 Admin 换绑操作人。 */
  adminUserId: string | null;
  /** 绑定操作幂等键（U(binding_key)）。 */
  bindingKey: string;
  /** 同一批子树重算事件的关联请求键。 */
  requestKey: string;
  /** 归因来源：IP_ATTRIBUTION=1/INVITE_CODE=2/ADMIN=3。 */
  sourceType: number;
  /** 本次归因使用的邀请码快照。 */
  inviteCodeUsed: string | null;
  /** BINARY(32)：成功归因时 IP 的限期带密钥摘要。 */
  ipLookupHash: Uint8Array | null;
  /** Redis 中最后有效邀请版本。 */
  attributionVersion: string | null;
  /** JSON：before/after 两份链快照；键为 parent_1_user_id 至 parent_4_user_id。 */
  relationSnapshot: Record<string, unknown>;
  reason: string;
}

export type ReferralBindingEventModelCreationAttributes = Optional<
  ReferralBindingEventModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class ReferralBindingEventModel
  extends Model<ReferralBindingEventModelAttributes, ReferralBindingEventModelCreationAttributes>
  implements ReferralBindingEventModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  previousParent1UserId!: string | null;
  newParent1UserId!: string;
  adminUserId!: string | null;
  bindingKey!: string;
  requestKey!: string;
  sourceType!: number;
  inviteCodeUsed!: string | null;
  ipLookupHash!: Uint8Array | null;
  attributionVersion!: string | null;
  relationSnapshot!: Record<string, unknown>;
  reason!: string;
  static associate(models: { ReferralBindingEventModel: typeof ReferralBindingEventModel }): void {
    void models.ReferralBindingEventModel;
    // user / previous_parent / new_parent / admin_user 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// referral_reward_allocation
// ---------------------------------------------------------------------------

/**
 * `referral_reward_allocation` 表属性。每条记录对应一个已履约金币购买订单及当时
 * 邀请链中的一个上级；U(order_id,user_id)、U(asset_hold_id)。
 * basis_subcents/exact_reward_subcents 为 DECIMAL(38,12) 精确值（十进制字符串 wire）；
 * reward_cents CHECK >= 0；reward_cents=0 不建 hold。
 */
export interface ReferralRewardAllocationModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 领取奖励的上级，引用 user.id。 */
  userId: string;
  /** JSON：奖励计算时的四级上级 ID 快照，键为 parent_1_user_id 至 parent_4_user_id。 */
  ancestrySnapshot: Record<string, unknown>;
  /** 金币购买返点评估来源订单，引用 order.id。 */
  orderId: string;
  /** 履约或审核资金操作，引用 asset_operation.id。 */
  assetOperationId: string;
  /** 正金额返点的余额冻结；reward_cents=0 不建 hold。 */
  assetHoldId: string | null;
  /** 上级模式快照：RECHARGE=1/LOSS=2；本表只记录充值返点。 */
  rewardType: number;
  /** 上级层级，1 到 4；1 为直属。 */
  ancestorDepth: number;
  /** INT UNSIGNED：本级比例快照，默认 1000/800/500/300 bps。 */
  rateBps: number;
  /** DECIMAL(38,12)：精确人民币分基数，接口 wire 十进制字符串。 */
  basisSubcents: string;
  /** DECIMAL(38,12)：舍入前人民币分奖励。 */
  exactRewardSubcents: string;
  /** 实际入账人民币分（CHECK >= 0，十进制字符串 wire）。 */
  rewardCents: string;
  /** JSON：舍入方式与余数。 */
  roundingSnapshot: Record<string, unknown>;
  /** 充值返点入账后 2 天可解冻时刻。 */
  unlockAt: Date | string | null;
  /** 模式不符或不足一分等原因。 */
  skipReason: string | null;
}

export type ReferralRewardAllocationModelCreationAttributes = Optional<
  ReferralRewardAllocationModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class ReferralRewardAllocationModel
  extends Model<ReferralRewardAllocationModelAttributes, ReferralRewardAllocationModelCreationAttributes>
  implements ReferralRewardAllocationModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  ancestrySnapshot!: Record<string, unknown>;
  orderId!: string;
  assetOperationId!: string;
  assetHoldId!: string | null;
  rewardType!: number;
  ancestorDepth!: number;
  rateBps!: number;
  basisSubcents!: string;
  exactRewardSubcents!: string;
  rewardCents!: string;
  roundingSnapshot!: Record<string, unknown>;
  unlockAt!: Date | string | null;
  skipReason!: string | null;
  static associate(models: { ReferralRewardAllocationModel: typeof ReferralRewardAllocationModel }): void {
    void models.ReferralRewardAllocationModel;
    // user / order / asset_operation / asset_hold 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

/** RecordStatus：不可变事件行固定 1（本地常量，单一来源在 contracts 落地后统一）。 */
export const RecordStatus = { RECORDED: 1 } as const;
export type RecordStatusValue = (typeof RecordStatus)[keyof typeof RecordStatus];

/** BindingSource：绑定/归因来源。 */
export const BindingSource = { IP_ATTRIBUTION: 1, INVITE_CODE: 2, ADMIN: 3 } as const;
export type BindingSourceValue = (typeof BindingSource)[keyof typeof BindingSource];

/** RewardStatus：返佣分配结果。 */
export const ReferralRewardStatus = { POSTED: 1, SKIPPED: 2 } as const;
export type ReferralRewardStatusValue = (typeof ReferralRewardStatus)[keyof typeof ReferralRewardStatus];

/** RewardType（上级模式快照）：与 contracts referral 包 RECHARGE_REBATE=1/CUSTOMER_LOSS_REBATE=2 数值一致。 */
export const RewardTypeLocal = { RECHARGE: 1, LOSS: 2 } as const;
export type RewardTypeLocalValue = (typeof RewardTypeLocal)[keyof typeof RewardTypeLocal];

/** ActiveStatus：行工作状态（多文件共用，单一来源在 contracts 落地后统一）。 */
export const ActiveStatus = { ACTIVE: 1, DISABLED: 2, RETIRED: 3 } as const;
export type ActiveStatusValue = (typeof ActiveStatus)[keyof typeof ActiveStatus];

export function register_ReferralBindingModel(sequelize: Sequelize): void {
  (ReferralBindingModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '绑定行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '当前被邀请用户，引用 user.id；每人至多一行',
      },
      parent1UserId: {
        field: 'parent_1_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '直属上级，奖励层级1，引用 user.id',
      },
      parent2UserId: {
        field: 'parent_2_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '上上级，奖励层级2，引用 user.id',
      },
      parent3UserId: {
        field: 'parent_3_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '第三级上级，引用 user.id',
      },
      parent4UserId: {
        field: 'parent_4_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '第四级上级，奖励层级4，引用 user.id',
      },
      parent1BenefitCents: {
        field: 'parent_1_benefit_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前绑定关系有效期间，此用户为直属上级累计产生的已发人民币返点分；查询投影',
      },
      parent2BenefitCents: {
        field: 'parent_2_benefit_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前绑定关系有效期间，此用户为第二级上级累计产生的已发返点分；查询投影',
      },
      parent3BenefitCents: {
        field: 'parent_3_benefit_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前绑定关系有效期间，此用户为第三级上级累计产生的已发返点分；查询投影',
      },
      parent4BenefitCents: {
        field: 'parent_4_benefit_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前绑定关系有效期间，此用户为第四级上级累计产生的已发返点分；查询投影',
      },
      boundAt: {
        field: 'bound_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '当前上级链生效时间，UTC',
      },
      bindingSource: {
        field: 'binding_source',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '绑定来源：IP_ATTRIBUTION=1/INVITE_CODE=2/ADMIN=3',
      },
    },

    {
      ...standardTableOptions('referral_binding'),
      comment: '用户当前邀请上级链快照，最多保存直属上级至第四级上级',
      sequelize,
    } as unknown as ModelInitOptions<ReferralBindingModel>,
  );
}

export function register_ReferralBindingEventModel(sequelize: Sequelize): void {
  (ReferralBindingEventModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '事件状态，固定为 RecordStatus.RECORDED=1，绑定证据不可改写',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被绑定或换绑用户，引用 user.id',
      },
      previousParent1UserId: {
        field: 'previous_parent_1_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '换绑前直属上级，引用 user.id',
      },
      newParent1UserId: {
        field: 'new_parent_1_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '新绑定或换绑后的直属上级，引用 user.id',
      },
      adminUserId: {
        field: 'admin_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '仅 Admin 换绑操作人，引用 user.id',
      },
      bindingKey: {
        field: 'binding_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '绑定操作幂等键',
      },
      requestKey: {
        field: 'request_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '同一批子树重算事件的关联请求键',
      },
      sourceType: {
        field: 'source_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '归因来源：IP_ATTRIBUTION=1/INVITE_CODE=2/ADMIN=3',
      },
      inviteCodeUsed: {
        field: 'invite_code_used',
        type: DataTypes.STRING(32),
        allowNull: true,
        comment: '本次归因使用的邀请码快照',
      },
      ipLookupHash: {
        field: 'ip_lookup_hash',
        type: binaryDataType(32),
        allowNull: true,
        comment: '成功归因时 IP 的限期带密钥摘要',
      },
      attributionVersion: {
        field: 'attribution_version',
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'Redis 中最后有效邀请版本',
      },
      relationSnapshot: {
        field: 'relation_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: 'before/after 两份链快照；键为 parent_1_user_id 至 parent_4_user_id',
      },
      reason: {
        type: DataTypes.STRING(500),
        allowNull: false,
        comment: '绑定或换绑原因',
      },
    },

    {
      ...appendOnlyModelOptions('referral_binding_event'),
      hooks: { ...appendOnlyHooks('referral_binding_event') },
      comment: '初绑及管理换绑不可变证据',
      sequelize,
    } as unknown as ModelInitOptions<ReferralBindingEventModel>,
  );
}

export function register_ReferralRewardAllocationModel(sequelize: Sequelize): void {
  (ReferralRewardAllocationModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '奖励状态，取值见 RewardStatus：POSTED=1/SKIPPED=2',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '领取奖励的上级，引用 user.id',
      },
      ancestrySnapshot: {
        field: 'ancestry_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '奖励计算时的四级上级 ID 快照，键为 parent_1_user_id 至 parent_4_user_id',
      },
      orderId: {
        field: 'order_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '金币购买返点评估来源订单，引用 order.id',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '履约或审核资金操作，引用 asset_operation.id',
      },
      assetHoldId: {
        field: 'asset_hold_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '正金额返点的余额冻结，引用 asset_hold.id；reward_cents=0 不建 hold',
      },
      rewardType: {
        field: 'reward_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '上级模式快照：RECHARGE=1/LOSS=2；本表只记录充值返点',
      },
      ancestorDepth: {
        field: 'ancestor_depth',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '上级层级，1 到 4；1 为直属',
      },
      rateBps: {
        field: 'rate_bps',
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '本级比例快照，默认 1000/800/500/300 bps',
      },
      basisSubcents: {
        field: 'basis_subcents',
        type: DataTypes.DECIMAL(38, 12),
        allowNull: false,
        comment: '精确人民币分基数',
      },
      exactRewardSubcents: {
        field: 'exact_reward_subcents',
        type: DataTypes.DECIMAL(38, 12),
        allowNull: false,
        comment: '舍入前人民币分奖励',
      },
      rewardCents: {
        field: 'reward_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '实际入账人民币分',
      },
      roundingSnapshot: {
        field: 'rounding_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '舍入方式与余数',
      },
      unlockAt: {
        field: 'unlock_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '充值返点入账后 2 天可解冻时刻，UTC',
      },
      skipReason: {
        field: 'skip_reason',
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: '模式不符或不足一分等原因',
      },
    },

    {
      ...standardTableOptions('referral_reward_allocation'),
      comment: '每个来源每个上级的奖励或跳过记录',
      sequelize,
    } as unknown as ModelInitOptions<ReferralRewardAllocationModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface ReferralModels {
  ReferralBindingModel: typeof ReferralBindingModel;
  ReferralBindingEventModel: typeof ReferralBindingEventModel;
  ReferralRewardAllocationModel: typeof ReferralRewardAllocationModel;
}

/** 定义 3 个 referral model（不在此声明跨文件关联）。 */
export function initReferral(sequelize: Sequelize, models: ReferralModels): void {
  register_ReferralBindingModel(sequelize);
  register_ReferralBindingEventModel(sequelize);
  register_ReferralRewardAllocationModel(sequelize);
  void models;
}

/** 声明 referral 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateReferral(models: ReferralModels): void {
  ReferralBindingModel.associate(models);
  ReferralBindingEventModel.associate(models);
  ReferralRewardAllocationModel.associate(models);
}
