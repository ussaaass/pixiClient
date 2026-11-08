/**
 * wallet — 资产账本：`asset_account` / `asset_operation`（不可变）/ `asset_entry`（不可变）/
 * `asset_hold` / `coin_exchange`（不可变）/ `gift_grant`（不可变）/ `turnover_state`。
 *
 * 领域所有者：wallet 模块（models/wallet.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.3；数据库设计SDD §5.3（asset_account/asset_operation/
 * asset_entry/asset_hold/coin_exchange/gift_grant）与 §5.6（turnover_state）。
 * DDL 以迁移 0003~0006（0003-create-asset-account / 0004-create-asset-operation /
 * 0005-create-asset-hold / 0006-create-asset-entry）与 0010-create-asset-payments.ts 为准。
 *
 * 读写用例：
 * - `AssetAccountModel`：钱包 summary/activity/transfer/exchange（乐观并发走 version 列）；
 *   资金账户不软删（deleted_at 恒 NULL，注释见 DDL）。
 * - `AssetOperationModel`（不可变）：资金命令幂等根，append-only；冲正走新操作 +
 *   reverses_asset_operation_id，不修改原行。
 * - `AssetEntryModel`（不可变）：逐笔分录对应账户版本；同账户同版本唯一。
 * - `AssetHoldModel`：占款生命周期（OPEN/PARTIAL/CONSUMED/RELEASED），有效占款之和等于
 *   账户 frozen_amount。
 * - `CoinExchangeModel`（不可变）/ `GiftGrantModel`（不可变）：兑换与赠币的账务事实快照。
 * - `TurnoverStateModel`：每用户流水资格汇总（赠币 +required、结算 -wager）。
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
// asset_account
// ---------------------------------------------------------------------------

/**
 * `asset_account` 表属性。有符号金额列（amount/frozen_amount）用 BIGINT 有符号，
 * 接口为十进制字符串 wire 格式；`version` 为 BIGINT UNSIGNED 乐观并发版本。
 * CHECK：frozen_amount>=0 且 <=GREATEST(amount,0)；系统 CNY 余额不可负。
 */
export interface AssetAccountModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  /** AccountType：PLAYER=1/SYSTEM=2，开户时由 user.role_type 推导且禁止修改。 */
  accountType: number;
  /** AssetType：COIN=1/CNY_BALANCE=2。 */
  assetType: number;
  /** Currency：金币为 COI，人民币余额为 CNY，必须与 asset_type 对应（CHAR(3)）。 */
  currency: string;
  /** 有符号资产总额（十进制字符串 wire）：金币为枚，人民币为分；系统金币发行余额可为负。 */
  amount: string;
  /** 有效占款总额，是 amount 的一部分而非额外资产。 */
  frozenAmount: string;
  /** BIGINT UNSIGNED：每次资产或冻结变更递增的版本号，用于分录对账与乐观并发。 */
  version: string;
}

export type AssetAccountModelCreationAttributes = Optional<
  AssetAccountModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AssetAccountModel
  extends Model<AssetAccountModelAttributes, AssetAccountModelCreationAttributes>
  implements AssetAccountModelAttributes
{
  declare id: string;
  declare status: number;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  declare deletedAt: Date | string | null;
  declare userId: string;
  declare accountType: number;
  declare assetType: number;
  declare currency: string;
  declare amount: string;
  declare frozenAmount: string;
  declare version: string;
  static associate(models: { AssetAccountModel: typeof AssetAccountModel }): void {
    void models.AssetAccountModel;
    // user 侧 belongsTo 在 identity.ts / index.ts 跨文件登记（user 为保留字表，FK 由迁移管理）。
  }
}

// ---------------------------------------------------------------------------
// asset_operation（不可变）
// ---------------------------------------------------------------------------

/**
 * `asset_operation` 表属性（不可变，幂等根）。status 固定 RECORDED=1；
 * updated_at 固定等于 created_at；deleted_at 恒 NULL（迁移 CHECK）。
 * `operation_type` 取值 1~14（AssetOperationType，见常量区）；
 * 资金金额列（coins/费用等）为有符号 BIGINT，接口十进制字符串 wire。
 */
export interface AssetOperationModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  operationKey: string;
  /** AssetOperationType：TRANSFER=1 ... COIN_MARKET_RELEASE=14。 */
  operationType: number;
  requestHash: Uint8Array;
  initiatedByUserId: string | null;
  operatedByAdminUserId: string | null;
  approvedByAdminUserId: string | null;
  adminSessionKey: string | null;
  /** 冲正/补偿的原操作；可被多次部分补偿。 */
  reversesAssetOperationId: string | null;
  reason: string | null;
  /** 用例级不可变细节快照（费率、舍入规则、邀请链快照等），账务金额仍以分录为准。 */
  extra: Record<string, unknown> | null;
  resultSnapshot: Record<string, unknown> | null;
  committedAt: Date | string | null;
}

export type AssetOperationModelCreationAttributes = Optional<
  AssetOperationModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AssetOperationModel
  extends Model<AssetOperationModelAttributes, AssetOperationModelCreationAttributes>
  implements AssetOperationModelAttributes
{
  declare id: string;
  declare status: number;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  declare deletedAt: Date | string | null;
  declare operationKey: string;
  declare operationType: number;
  declare requestHash: Uint8Array;
  declare initiatedByUserId: string | null;
  declare operatedByAdminUserId: string | null;
  declare approvedByAdminUserId: string | null;
  declare adminSessionKey: string | null;
  declare reversesAssetOperationId: string | null;
  declare reason: string | null;
  declare extra: Record<string, unknown> | null;
  declare resultSnapshot: Record<string, unknown> | null;
  declare committedAt: Date | string | null;
  static associate(models: { AssetOperationModel: typeof AssetOperationModel }): void {
    // 自引用：reverses_asset_operation_id → asset_operation.id（RESTRICT 外键由迁移 0004 管理）。
    AssetOperationModel.belongsTo(models.AssetOperationModel, {
      foreignKey: 'reverses_asset_operation_id',
      as: 'reversesOperation',
      constraints: false,
    });
    // user 侧三条 FK（initiated_by/operated_by/approved_by）在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// asset_entry（不可变）
// ---------------------------------------------------------------------------

/**
 * `asset_entry` 表属性（不可变分录）。delta/frozen_delta/amount_after/frozen_after 为
 * 有符号 BIGINT（十进制字符串 wire）；entry_seq INT UNSIGNED 从 1 开始；
 * account_version 为 BIGINT UNSIGNED。
 */
export interface AssetEntryModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  assetOperationId: string;
  assetAccountId: string;
  assetHoldId: string | null;
  /** INT UNSIGNED：同一操作内的分录序号，从 1 开始。 */
  entrySeq: number;
  /** EntryType：INTERNAL=1/EXTERNAL=2/HOLD=3/COMPENSATION=4；HOLD 当且仅当带 asset_hold_id。 */
  entryType: number;
  /** 资产总额变动，有符号整数。 */
  delta: string;
  /** 冻结额变动，有符号整数；冻结释放不增加总额。 */
  frozenDelta: string;
  amountAfter: string;
  frozenAfter: string;
  /** BIGINT UNSIGNED：变更后的账户版本号。 */
  accountVersion: string;
  memo: string;
}

export type AssetEntryModelCreationAttributes = Optional<
  AssetEntryModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AssetEntryModel
  extends Model<AssetEntryModelAttributes, AssetEntryModelCreationAttributes>
  implements AssetEntryModelAttributes
{
  declare id: string;
  declare status: number;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  declare deletedAt: Date | string | null;
  declare assetOperationId: string;
  declare assetAccountId: string;
  declare assetHoldId: string | null;
  declare entrySeq: number;
  declare entryType: number;
  declare delta: string;
  declare frozenDelta: string;
  declare amountAfter: string;
  declare frozenAfter: string;
  declare accountVersion: string;
  declare memo: string;
  static associate(models: { AssetEntryModel: typeof AssetEntryModel }): void {
    void models.AssetEntryModel;
    // asset_operation / asset_account / asset_hold 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// asset_hold
// ---------------------------------------------------------------------------

/**
 * `asset_hold` 表属性。占款不是额外资产，是 asset_account.amount 里被锁住的一部分；
 * CHECK 0<=remaining_amount<=amount AND amount>0；deleted_at 恒 NULL（生命周期用
 * status/closed_at 表达）。
 */
export interface AssetHoldModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  assetAccountId: string;
  assetOperationId: string;
  holdKey: string;
  /** HoldType：GAME=1/WITHDRAWAL=2/REWARD=3/CHANNEL_UNSETTLED=4/COIN_MARKET_LISTING=5。 */
  holdType: number;
  /** 创建时的占款金额（十进制字符串 wire），必须为正。 */
  amount: string;
  /** 尚未释放或消耗的金额。 */
  remainingAmount: string;
  expiresAt: Date | string | null;
  closedAt: Date | string | null;
}

export type AssetHoldModelCreationAttributes = Optional<
  AssetHoldModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AssetHoldModel extends Model<AssetHoldModelAttributes, AssetHoldModelCreationAttributes> implements AssetHoldModelAttributes {
  declare id: string;
  declare status: number;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  declare deletedAt: Date | string | null;
  declare assetAccountId: string;
  declare assetOperationId: string;
  declare holdKey: string;
  declare holdType: number;
  declare amount: string;
  declare remainingAmount: string;
  declare expiresAt: Date | string | null;
  declare closedAt: Date | string | null;
  static associate(models: { AssetHoldModel: typeof AssetHoldModel }): void {
    void models.AssetHoldModel;
    // asset_account / asset_operation 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// coin_exchange（不可变）
// ---------------------------------------------------------------------------

/**
 * `coin_exchange` 表属性（不可变账务事实）。coins/cash_cents/fee_cents 为有符号 BIGINT
 * （十进制字符串 wire）；rate_coin_units 默认 10、rate_cash_cents 默认 100；
 * rounding_type 默认 2（FLOOR_CREDIT）。
 */
export interface CoinExchangeModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  assetOperationId: string;
  /** 用户扣除金币，有符号整数。 */
  coins: string;
  /** 用户增加人民币分，有符号整数。 */
  cashCents: string;
  /** 独立兑换费用，默认无新增费用。 */
  feeCents: string;
  /** 比例金币整数分子，默认 10。 */
  rateCoinUnits: string;
  /** 比例人民币分分母，默认 100。 */
  rateCashCents: string;
  /** RoundingMode：CEIL_CHARGE=1/FLOOR_CREDIT=2；默认 2。 */
  roundingType: number;
  /** 用户确认的报价定位值（U(preview_key)）。 */
  previewKey: string;
}

export type CoinExchangeModelCreationAttributes = Optional<
  CoinExchangeModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class CoinExchangeModel
  extends Model<CoinExchangeModelAttributes, CoinExchangeModelCreationAttributes>
  implements CoinExchangeModelAttributes
{
  declare id: string;
  declare status: number;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  declare deletedAt: Date | string | null;
  declare userId: string;
  declare assetOperationId: string;
  declare coins: string;
  declare cashCents: string;
  declare feeCents: string;
  declare rateCoinUnits: string;
  declare rateCashCents: string;
  declare roundingType: number;
  declare previewKey: string;
  static associate(models: { CoinExchangeModel: typeof CoinExchangeModel }): void {
    void models.CoinExchangeModel;
    // user / asset_operation 侧 FK 在 index.ts 跨文件登记（order 外键无 join 需要，不入模型）。
  }
}

// ---------------------------------------------------------------------------
// gift_grant（不可变）
// ---------------------------------------------------------------------------

/**
 * `gift_grant` 表属性（不可变账务事实）。coins 为赠送金币；turnover_multiplier 为
 * DECIMAL(12,4) 默认 5（接口 wire 字符串）；required_turnover_coins 为实际增加的整数
 * 流水要求。`order_id` 外键随 0010 批次内建（目标 order 表）。
 */
export interface GiftGrantModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  assetOperationId: string;
  /** 商品附赠金币的来源订单，引用 order 表。 */
  orderId: string | null;
  grantKey: string;
  /** 实际赠送金币（十进制字符串 wire）。 */
  coins: string;
  /** DECIMAL(12,4)：流水倍数快照；默认 5 倍，场景配置在发放时固化。接口 wire 为十进制字符串。 */
  turnoverMultiplier: string;
  /** 实际增加的整数流水要求（十进制字符串 wire）。 */
  requiredTurnoverCoins: string;
}

export type GiftGrantModelCreationAttributes = Optional<
  GiftGrantModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class GiftGrantModel extends Model<GiftGrantModelAttributes, GiftGrantModelCreationAttributes> implements GiftGrantModelAttributes {
  declare id: string;
  declare status: number;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  declare deletedAt: Date | string | null;
  declare userId: string;
  declare assetOperationId: string;
  declare orderId: string | null;
  declare grantKey: string;
  declare coins: string;
  declare turnoverMultiplier: string;
  declare requiredTurnoverCoins: string;
  static associate(models: { GiftGrantModel: typeof GiftGrantModel }): void {
    void models.GiftGrantModel;
    // user / asset_operation / order 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// turnover_state
// ---------------------------------------------------------------------------

/**
 * `turnover_state` 表属性。每用户至多一行（U(user_id)）；remaining_coins 为所有赠币
 * 要求合计后仍须完成的有效下注额；只扣到 0，超出部分不结转。
 */
export interface TurnoverStateModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  /** 仍须完成的有效下注额（十进制字符串 wire）；CHECK remaining_coins>=0。 */
  remainingCoins: string;
  /** BIGINT UNSIGNED：每次流水要求变更递增的版本号。 */
  version: string;
}

export type TurnoverStateModelCreationAttributes = Optional<
  TurnoverStateModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class TurnoverStateModel
  extends Model<TurnoverStateModelAttributes, TurnoverStateModelCreationAttributes>
  implements TurnoverStateModelAttributes
{
  declare id: string;
  declare status: number;
  declare createdAt: Date | string;
  declare updatedAt: Date | string;
  declare deletedAt: Date | string | null;
  declare userId: string;
  declare remainingCoins: string;
  declare version: string;
  static associate(models: { TurnoverStateModel: typeof TurnoverStateModel }): void {
    void models.TurnoverStateModel;
    // user 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移，当前为本地常量）
// ---------------------------------------------------------------------------

export const AccountType = { PLAYER: 1, SYSTEM: 2 } as const;
export type AccountTypeValue = (typeof AccountType)[keyof typeof AccountType];

export const AssetType = { COIN: 1, CNY_BALANCE: 2 } as const;
export type AssetTypeValue = (typeof AssetType)[keyof typeof AssetType];

/** RecordStatus：不可变分录/操作行固定 1（与 identity.ts 同源，单一来源在 contracts 落地后统一）。 */
export const RecordStatus = { RECORDED: 1 } as const;
export type RecordStatusValue = (typeof RecordStatus)[keyof typeof RecordStatus];

/** AssetOperationType：资金用例类型（1~14）。 */
export const AssetOperationType = {
  TRANSFER: 1,
  COIN_EXCHANGE: 2,
  GIFT_GRANT: 3,
  GAME_SETTLEMENT: 4,
  ORDER_FULFILLMENT: 5,
  WITHDRAWAL_HOLD: 6,
  WITHDRAWAL_SETTLEMENT: 7,
  WITHDRAWAL_RELEASE: 8,
  ADMIN_ADJUSTMENT: 9,
  COMPENSATION: 10,
  REFERRAL_REWARD: 11,
  COIN_MARKET_HOLD: 12,
  COIN_MARKET_TRADE: 13,
  COIN_MARKET_RELEASE: 14,
} as const;
export type AssetOperationTypeValue = (typeof AssetOperationType)[keyof typeof AssetOperationType];

/** EntryType：分录类型。 */
export const EntryType = { INTERNAL: 1, EXTERNAL: 2, HOLD: 3, COMPENSATION: 4 } as const;
export type EntryTypeValue = (typeof EntryType)[keyof typeof EntryType];

/** HoldStatus：占款生命周期状态。 */
export const HoldStatus = { OPEN: 1, PARTIAL: 2, CONSUMED: 3, RELEASED: 4 } as const;
export type HoldStatusValue = (typeof HoldStatus)[keyof typeof HoldStatus];

/** HoldType：占款类型。 */
export const HoldType = {
  GAME: 1,
  WITHDRAWAL: 2,
  REWARD: 3,
  CHANNEL_UNSETTLED: 4,
  COIN_MARKET_LISTING: 5,
} as const;
export type HoldTypeValue = (typeof HoldType)[keyof typeof HoldType];

/** RoundingMode：兑换舍入模式。 */
export const RoundingMode = { CEIL_CHARGE: 1, FLOOR_CREDIT: 2 } as const;
export type RoundingModeValue = (typeof RoundingMode)[keyof typeof RoundingMode];

/** TurnoverStatus：流水资格状态。 */
export const TurnoverStatus = { ACTIVE: 1, COMPLETE: 2, REVERSED: 3 } as const;
export type TurnoverStatusValue = (typeof TurnoverStatus)[keyof typeof TurnoverStatus];

/** ActiveStatus：行工作状态（多文件共用，单一来源在 contracts 落地后统一）。 */
export const ActiveStatus = { ACTIVE: 1, DISABLED: 2, RETIRED: 3 } as const;
export type ActiveStatusValue = (typeof ActiveStatus)[keyof typeof ActiveStatus];

export function register_AssetAccountModel(sequelize: Sequelize): void {
  (AssetAccountModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '账户状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '账户主体，引用 user.id' },
      accountType: {
        field: 'account_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '账户类型：PLAYER=1/SYSTEM=2，开户时由 user.role_type 推导且禁止修改',
      },
      assetType: {
        field: 'asset_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '资产类型：COIN=1/CNY_BALANCE=2',
      },
      currency: {
        type: DataTypes.CHAR(3),
        allowNull: false,
        comment: '币种：金币为 COI，人民币余额为 CNY，必须与 asset_type 对应',
      },
      amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '有符号资产总额：金币为枚，人民币为分',
      },
      frozenAmount: {
        field: 'frozen_amount',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '有效占款总额，是 amount 的一部分而非额外资产',
      },
      version: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: '每次资产或冻结变更递增的版本号，用于分录对账与乐观并发',
      },
    },

    {
      ...standardTableOptions('asset_account'),
      comment: '系统和玩家的分资产余额账户',
      sequelize,
    } as unknown as ModelInitOptions<AssetAccountModel>,
  );
}

export function register_AssetOperationModel(sequelize: Sequelize): void {
  (AssetOperationModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '操作状态，固定为 RecordStatus.RECORDED=1，已成立的资产事实不可改写',
      },
      operationKey: {
        field: 'operation_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '全局业务语义幂等键，不只是随机请求号',
      },
      operationType: {
        field: 'operation_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '资金用例类型，取值见 AssetOperationType（1~14）',
      },
      requestHash: {
        field: 'request_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '规范化请求摘要，防止同键不同内容的重放',
      },
      initiatedByUserId: {
        field: 'initiated_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '玩家发起人，引用 user.id；系统任务为空',
      },
      operatedByAdminUserId: {
        field: 'operated_by_admin_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Admin 操作人，引用 user.id；人工资产调整时必填',
      },
      approvedByAdminUserId: {
        field: 'approved_by_admin_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '双人复核审批人，引用 user.id；非复核操作为空',
      },
      adminSessionKey: {
        field: 'admin_session_key',
        type: DataTypes.CHAR(36),
        allowNull: true,
        comment: '发起操作的 Redis Admin 会话定位键，不存会话内容',
      },
      reversesAssetOperationId: {
        field: 'reverses_asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '本操作冲正或补偿的原操作，引用 asset_operation.id；可被多次部分补偿',
      },
      reason: { field: 'reason', type: DataTypes.STRING(500), allowNull: true, comment: '人工调整或补偿原因' },
      extra: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '用例级不可变细节快照（费率、舍入规则、邀请链快照等），账务金额仍以分录为准',
      },
      resultSnapshot: {
        field: 'result_snapshot',
        type: DataTypes.JSON,
        allowNull: true,
        comment: '提交后可重复返回的结果快照',
      },
      committedAt: {
        field: 'committed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '资金事务成功提交的业务时间，UTC',
      },
    },

    {
      ...appendOnlyModelOptions('asset_operation'),
      hooks: { ...appendOnlyHooks('asset_operation') },
      comment: '跨账户记账操作及幂等根，所有分录同事务归属此操作',
      sequelize,
    } as unknown as ModelInitOptions<AssetOperationModel>,
  );
}

export function register_AssetEntryModel(sequelize: Sequelize): void {
  (AssetEntryModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '分录状态，固定为 RecordStatus.RECORDED=1，已入账不可改写',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属记账操作，引用 asset_operation.id',
      },
      assetAccountId: {
        field: 'asset_account_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '对应资产账户，引用 asset_account.id',
      },
      assetHoldId: {
        field: 'asset_hold_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '此分录创建、消耗或释放的占款，引用 asset_hold.id；非占款分录为空',
      },
      entrySeq: {
        field: 'entry_seq',
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '同一操作内的分录序号，从 1 开始',
      },
      entryType: {
        field: 'entry_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '分录类型：INTERNAL=1/EXTERNAL=2/HOLD=3/COMPENSATION=4',
      },
      delta: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '资产总额变动，有符号整数（金币为枚，人民币为分）',
      },
      frozenDelta: {
        field: 'frozen_delta',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '冻结额变动，有符号整数；冻结释放不增加总额',
      },
      amountAfter: {
        field: 'amount_after',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '变更后的资产总额，用于逐笔对账',
      },
      frozenAfter: {
        field: 'frozen_after',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '变更后的冻结额',
      },
      accountVersion: {
        field: 'account_version',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '变更后的账户版本号，与 asset_account.version 对应',
      },
      memo: { type: DataTypes.STRING(500), allowNull: false, comment: '分录含义及人工调整原因，必须可读' },
    },

    {
      ...appendOnlyModelOptions('asset_entry'),
      hooks: { ...appendOnlyHooks('asset_entry') },
      comment: '不可变资产变动及冻结分录，逐笔对应账户版本',
      sequelize,
    } as unknown as ModelInitOptions<AssetEntryModel>,
  );
}

export function register_AssetHoldModel(sequelize: Sequelize): void {
  (AssetHoldModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '占款状态，取值见 HoldStatus：OPEN=1/PARTIAL=2/CONSUMED=3/RELEASED=4',
      },
      assetAccountId: {
        field: 'asset_account_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被占用账户，引用 asset_account.id',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '创建本占款的操作，引用 asset_operation.id',
      },
      holdKey: {
        field: 'hold_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '业务语义唯一的占款键，用于幂等创建',
      },
      holdType: {
        field: 'hold_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '占款类型：GAME=1/WITHDRAWAL=2/REWARD=3/CHANNEL_UNSETTLED=4/COIN_MARKET_LISTING=5',
      },
      amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '创建时的占款金额，必须为正',
      },
      remainingAmount: {
        field: 'remaining_amount',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '尚未释放或消耗的金额',
      },
      expiresAt: {
        field: 'expires_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '奖励可释放时刻或业务期限，UTC；NULL 表示无期限',
      },
      closedAt: {
        field: 'closed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '占款关闭（全部消耗或释放）时间，UTC',
      },
    },

    {
      ...standardTableOptions('asset_hold'),
      comment: '资产冻结占款及其释放生命周期',
      sequelize,
    } as unknown as ModelInitOptions<AssetHoldModel>,
  );
}

export function register_CoinExchangeModel(sequelize: Sequelize): void {
  (CoinExchangeModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '兑换记录状态，固定为 RecordStatus.RECORDED=1，已入账不可改写',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '兑换用户，引用 user.id' },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '兑换操作，引用 asset_operation.id',
      },
      coins: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '用户扣除金币，有符号整数',
      },
      cashCents: {
        field: 'cash_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '用户增加人民币分，有符号整数',
      },
      feeCents: {
        field: 'fee_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '独立兑换费用，默认无新增费用',
      },
      rateCoinUnits: {
        field: 'rate_coin_units',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '比例金币整数分子，默认 10',
      },
      rateCashCents: {
        field: 'rate_cash_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '比例人民币分分母，默认 100',
      },
      roundingType: {
        field: 'rounding_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 2,
        comment: '舍入模式，取值见 RoundingMode：CEIL_CHARGE=1/FLOOR_CREDIT=2；兑入人民币余额不足 1 分向下取整到分',
      },
      previewKey: {
        field: 'preview_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '用户确认的报价定位值',
      },
    },

    {
      ...appendOnlyModelOptions('coin_exchange'),
      hooks: { ...appendOnlyHooks('coin_exchange') },
      comment: '金币兑人民币余额',
      sequelize,
    } as unknown as ModelInitOptions<CoinExchangeModel>,
  );
}

export function register_GiftGrantModel(sequelize: Sequelize): void {
  (GiftGrantModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '赠币记录状态，固定为 RecordStatus.RECORDED=1，已入账不可改写',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '领取用户，引用 user.id' },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '赠币操作，引用 asset_operation.id',
      },
      orderId: {
        field: 'order_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '商品附赠金币的来源订单，引用 order 表；外键随批次内建',
      },
      grantKey: {
        field: 'grant_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '注册或活动发奖语义键',
      },
      coins: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '实际赠送金币',
      },
      turnoverMultiplier: {
        field: 'turnover_multiplier',
        type: DataTypes.DECIMAL(12, 4),
        allowNull: false,
        defaultValue: 5,
        comment: '流水倍数快照；默认 5 倍，场景配置在发放时固化',
      },
      requiredTurnoverCoins: {
        field: 'required_turnover_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '实际增加的整数流水要求',
      },
    },

    {
      ...appendOnlyModelOptions('gift_grant'),
      hooks: { ...appendOnlyHooks('gift_grant') },
      comment: '赠币及配置快照',
      sequelize,
    } as unknown as ModelInitOptions<GiftGrantModel>,
  );
}

export function register_TurnoverStateModel(sequelize: Sequelize): void {
  (TurnoverStateModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '流水资格状态，取值见 TurnoverStatus：ACTIVE=1/COMPLETE=2/REVERSED=3',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '用户，引用 user.id；每人至多一行' },
      remainingCoins: {
        field: 'remaining_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '用户所有赠币要求合计后仍须完成的有效下注额；只扣到 0，超出部分不结转',
      },
      version: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: '每次流水要求变更递增的版本号',
      },
    },

    {
      ...standardTableOptions('turnover_state'),
      comment: '每用户金币提现/转出资格的累计流水汇总',
      sequelize,
    } as unknown as ModelInitOptions<TurnoverStateModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface WalletModels {
  AssetAccountModel: typeof AssetAccountModel;
  AssetOperationModel: typeof AssetOperationModel;
  AssetEntryModel: typeof AssetEntryModel;
  AssetHoldModel: typeof AssetHoldModel;
  CoinExchangeModel: typeof CoinExchangeModel;
  GiftGrantModel: typeof GiftGrantModel;
  TurnoverStateModel: typeof TurnoverStateModel;
}

/** 定义 7 个 wallet model（不在此声明跨文件关联）。 */
export function initWallet(sequelize: Sequelize, models: WalletModels): void {
  register_AssetAccountModel(sequelize);
  register_AssetOperationModel(sequelize);
  register_AssetEntryModel(sequelize);
  register_AssetHoldModel(sequelize);
  register_CoinExchangeModel(sequelize);
  register_GiftGrantModel(sequelize);
  register_TurnoverStateModel(sequelize);
  void models;
}

/** 声明 wallet 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateWallet(models: WalletModels): void {
  AssetAccountModel.associate(models);
  AssetOperationModel.associate(models);
  AssetEntryModel.associate(models);
  AssetHoldModel.associate(models);
  CoinExchangeModel.associate(models);
  GiftGrantModel.associate(models);
  TurnoverStateModel.associate(models);
}
