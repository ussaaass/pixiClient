/**
 * coin-market — 金币集市：`coin_market_listing` / `coin_market_trade`。
 *
 * 领域所有者：coin-market 模块（models/coin-market.ts 为其唯一 model 定义；
 * 与 payments.ts 分文件，见 SDD §3.2 归属矩阵 / 附录 A.11）。
 * 对应 SDD 章节：后端实施SDD 附录 A.11；数据库设计SDD §5.13。
 * DDL 以迁移 0016-create-coin-market.ts 为准。
 *
 * 读写用例：
 * - `CoinMarketListingModel`：卖家金币挂牌与库存状态（挂牌总量恒等式
 *   listed = available + reserved + filled + cancelled，迁移 CHECK 强制；
 *   hold_type=COIN_MARKET_LISTING=5 的唯一金币占款）。
 * - `CoinMarketTradeModel`：买家对挂牌的一笔部分成交（付款、争议与结算流程），
 *   有自身 11 值状态机（CoinMarketTradeStatus），**不是**不可变表——
 *   `deleted_at` 恒 NULL 由迁移 CHECK 保证（非软删路径），但 status/时间列随
 *   状态机正常更新，故 options 用 `outboxTableOptions`（paranoid: false +
 *   正常 timestamps）而非 append-only hooks。
 *
 * 两表 `deleted_at` 恒 NULL：与 outbox 同款的 `paranoid: false` 选项基座
 * （A.12 第 5 条例外口径，DDL CHECK 保证恒 NULL）。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { outboxTableOptions, type ModelInitFn, type ModelInitOptions } from './_shared.js';

// ---------------------------------------------------------------------------
// coin_market_listing
// ---------------------------------------------------------------------------

/**
 * `coin_market_listing` 表属性。U(listing_key)、U(asset_hold_id)；
 * 库存恒等式 listed_coins = available + reserved + filled + cancelled（迁移 CHECK）；
 * price_cents_per_1000_coins > 0（CHECK）；platform_payment_opt_in 仅 0/1 普通布尔。
 */
export interface CoinMarketListingModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 挂牌卖家，引用 user.id。 */
  sellerUserId: string;
  /** 创建/重试幂等键（U(listing_key)）。 */
  listingKey: string;
  /** 本挂牌唯一金币占款，引用 asset_hold.id；hold_type=COIN_MARKET_LISTING=5（U）。 */
  assetHoldId: string;
  /** 挂牌总量，必须大于 0（有符号 BIGINT 十进制字符串 wire）。 */
  listedCoins: string;
  /** 当前可成交量。 */
  availableCoins: string;
  /** 尚未完成的交易预占量。 */
  reservedCoins: string;
  /** 已完成成交量。 */
  filledCoins: string;
  /** 挂牌关闭后释放的剩余量。 */
  cancelledCoins: string;
  /** BIGINT UNSIGNED：每 1000 金币的挂牌价，单位为人民币分；正整数。 */
  priceCentsPer1000Coins: string;
  /** 已登记收款方式常量；首版支持方式沿用支付渠道/USDT 目录。 */
  receiveMethod: number;
  /** 加密或脱敏的卖家收款方式快照；仅交易参与方按权限读取。 */
  receiveSnapshot: Record<string, unknown> | null;
  /** 0/1 仅为普通布尔值：卖家是否主动开放该挂牌的平台支付路径。 */
  platformPaymentOptIn: number;
  /** 撤销时间。 */
  cancelledAt: Date | string | null;
  /** 暂停/冻结挂牌的 Admin 或有权运营者，引用 user.id。 */
  suspendedByUserId: string | null;
}

export type CoinMarketListingModelCreationAttributes = Optional<
  CoinMarketListingModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class CoinMarketListingModel
  extends Model<CoinMarketListingModelAttributes, CoinMarketListingModelCreationAttributes>
  implements CoinMarketListingModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  sellerUserId!: string;
  listingKey!: string;
  assetHoldId!: string;
  listedCoins!: string;
  availableCoins!: string;
  reservedCoins!: string;
  filledCoins!: string;
  cancelledCoins!: string;
  priceCentsPer1000Coins!: string;
  receiveMethod!: number;
  receiveSnapshot!: Record<string, unknown> | null;
  platformPaymentOptIn!: number;
  cancelledAt!: Date | string | null;
  suspendedByUserId!: string | null;
  static associate(models: { CoinMarketListingModel: typeof CoinMarketListingModel }): void {
    void models.CoinMarketListingModel;
    // user / asset_hold 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// coin_market_trade
// ---------------------------------------------------------------------------

/**
 * `coin_market_trade` 表属性。U(trade_key)、U(chain_tx_id)、U(asset_operation_id)；
 * 净收恒等式：payment_mode=2 ⇒ seller_net_cents = max(gross_cents - fee_cents, 0)（迁移 CHECK）；
 * 11 值状态机（CoinMarketTradeStatus）；resolution_code ∈ {1,2} 或 NULL。
 */
export interface CoinMarketTradeModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 来源挂牌，引用 coin_market_listing.id。 */
  coinMarketListingId: string;
  /** 本笔买家，引用 user.id。 */
  buyerUserId: string;
  /** 接受挂牌幂等键（U(trade_key)）。 */
  tradeKey: string;
  /** 本笔预占金币数量，必须大于 0。 */
  coins: string;
  /** 本笔买家应付人民币分，按挂牌报价 ceil(price × coins ÷ 1000)。 */
  grossCents: string;
  /** 付款方式：DIRECT=1/PLATFORM_CHANNEL=2/USDT=3。 */
  paymentMode: number;
  /** 平台通道成交所选支付方式，引用 payment_channel.id；非平台通道为空。 */
  paymentChannelId: string | null;
  /** 本笔平台通道费率快照；默认配置 2000 bps，非平台通道为 0。 */
  feeRateBps: number;
  /** 从卖家应收中扣除的费用，按统一货币舍入规则。 */
  feeCents: string;
  /** 平台通道成交卖家净收金额；直接场外付款为 0（不经平台钱包）。 */
  sellerNetCents: string;
  /** 买家付款凭证；私有加密 asset，引用 asset 表；外键待 0017 补建。 */
  paymentProofAssetId: string | null;
  /** USDT 链上交易标识，唯一性由 TRON payment handler 校验（U）。 */
  chainTxId: string | null;
  /** 该笔交易锁定的每日 CNY/USDT 汇率。 */
  usdtRateSnapshot: string | null;
  /** 接受挂牌后 48h 截止。 */
  paymentDeadlineAt: Date | string;
  /** 凭证提交后 48h 截止；USDT 核验路径可空。 */
  sellerResponseDeadlineAt: Date | string | null;
  /** 卖家申诉后买家补证截止（48h）。 */
  buyerEvidenceDeadlineAt: Date | string | null;
  /** 买家针对申诉提交的补充银行付款凭证；外键待 0017 补建。 */
  buyerEvidenceAssetId: string | null;
  /** 买家补充证据提交时间；开始卖家回应举证窗口。 */
  buyerEvidenceSubmittedAt: Date | string | null;
  /** 买家补证后卖家回应证据截止（48h）。 */
  sellerEvidenceDeadlineAt: Date | string | null;
  /** 卖家针对买家补证提交的回应凭证；外键待 0017 补建。 */
  sellerEvidenceAssetId: string | null;
  /** 卖家回应证据提交时间。 */
  sellerEvidenceSubmittedAt: Date | string | null;
  /** 卖家提交回应或回应期届满后，平台默认 48h 裁定截止；手动延期时更新并审计。 */
  platformDecisionDeadlineAt: Date | string | null;
  /** 卖家申诉说明；不得填写完整支付账号或敏感凭证。 */
  sellerDisputeNote: string | null;
  /** 买家付款凭证/链上交易提交时间。 */
  paidAt: Date | string | null;
  /** 关联本笔争议客服会话，引用 support_conversation.id；会话内容仍由客服领域管理。 */
  supportConversationId: string | null;
  /** 普通工作人员裁决人员，引用 user.id。 */
  adjudicatedByUserId: string | null;
  /** 裁定结果：RELEASE_TO_BUYER=1/RETURN_TO_SELLER=2；未裁决为空。 */
  resolutionCode: number | null;
  /** 裁决理由，禁止写入支付凭证明文。 */
  resolutionNote: string | null;
  /** 普通工作人员作出裁定的时间。 */
  adjudicatedAt: Date | string | null;
  /** 成交放币/返还对应的钱包操作，引用 asset_operation.id；仅由 wallet 用例写入（U）。 */
  assetOperationId: string | null;
}

export type CoinMarketTradeModelCreationAttributes = Optional<
  CoinMarketTradeModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class CoinMarketTradeModel
  extends Model<CoinMarketTradeModelAttributes, CoinMarketTradeModelCreationAttributes>
  implements CoinMarketTradeModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  coinMarketListingId!: string;
  buyerUserId!: string;
  tradeKey!: string;
  coins!: string;
  grossCents!: string;
  paymentMode!: number;
  paymentChannelId!: string | null;
  feeRateBps!: number;
  feeCents!: string;
  sellerNetCents!: string;
  paymentProofAssetId!: string | null;
  chainTxId!: string | null;
  usdtRateSnapshot!: string | null;
  paymentDeadlineAt!: Date | string;
  sellerResponseDeadlineAt!: Date | string | null;
  buyerEvidenceDeadlineAt!: Date | string | null;
  buyerEvidenceAssetId!: string | null;
  buyerEvidenceSubmittedAt!: Date | string | null;
  sellerEvidenceDeadlineAt!: Date | string | null;
  sellerEvidenceAssetId!: string | null;
  sellerEvidenceSubmittedAt!: Date | string | null;
  platformDecisionDeadlineAt!: Date | string | null;
  sellerDisputeNote!: string | null;
  paidAt!: Date | string | null;
  supportConversationId!: string | null;
  adjudicatedByUserId!: string | null;
  resolutionCode!: number | null;
  resolutionNote!: string | null;
  adjudicatedAt!: Date | string | null;
  assetOperationId!: string | null;
  static associate(models: { CoinMarketTradeModel: typeof CoinMarketTradeModel }): void {
    void models.CoinMarketTradeModel;
    // listing / user / payment_channel / support_conversation / asset_operation / asset 侧 FK
    // 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移——
// contracts 已有 CoinMarketListingStatus（5 值一致），trade 状态 11 值以 0016 DDL 为准）
// ---------------------------------------------------------------------------

export const CoinMarketListingStatus = {
  ACTIVE: 1,
  PAUSED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
  SUSPENDED: 5,
} as const;
export type CoinMarketListingStatusValue = (typeof CoinMarketListingStatus)[keyof typeof CoinMarketListingStatus];

export const CoinMarketTradeStatus = {
  PAYMENT_PENDING: 1,
  SELLER_CONFIRMATION_PENDING: 2,
  DISPUTED: 3,
  BUYER_EVIDENCE_PENDING: 4,
  SELLER_EVIDENCE_PENDING: 5,
  PLATFORM_REVIEW: 6,
  RELEASED: 7,
  AUTO_RELEASED: 8,
  PAYMENT_EXPIRED: 9,
  RESOLVED_RETURN: 10,
  CANCELLED: 11,
} as const;
export type CoinMarketTradeStatusValue = (typeof CoinMarketTradeStatus)[keyof typeof CoinMarketTradeStatus];

export const CoinMarketPaymentMode = { DIRECT: 1, PLATFORM_CHANNEL: 2, USDT: 3 } as const;
export type CoinMarketPaymentModeValue = (typeof CoinMarketPaymentMode)[keyof typeof CoinMarketPaymentMode];

export const CoinMarketResolutionCode = { RELEASE_TO_BUYER: 1, RETURN_TO_SELLER: 2 } as const;
export type CoinMarketResolutionCodeValue = (typeof CoinMarketResolutionCode)[keyof typeof CoinMarketResolutionCode];

// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface CoinMarketModels {
  CoinMarketListingModel: typeof CoinMarketListingModel;
  CoinMarketTradeModel: typeof CoinMarketTradeModel;
}

/** 定义 2 个 coin-market model（不在此声明跨文件关联）。 */
export function initCoinMarket(sequelize: Sequelize, models: CoinMarketModels): void {
  registerCoinMarketListingModel(sequelize);
  registerCoinMarketTradeModel(sequelize);
  void models;
}

/** 声明 coin-market 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateCoinMarket(models: CoinMarketModels): void {
  CoinMarketListingModel.associate(models);
  CoinMarketTradeModel.associate(models);
}

export function registerCoinMarketListingModel(sequelize: Sequelize): void {
  (CoinMarketListingModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '挂牌状态，取值见 CoinMarketListingStatus：ACTIVE=1/PAUSED=2/COMPLETED=3/CANCELLED=4/SUSPENDED=5',
      },
      sellerUserId: {
        field: 'seller_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '挂牌卖家，引用 user.id',
      },
      listingKey: {
        field: 'listing_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '创建/重试幂等键',
      },
      assetHoldId: {
        field: 'asset_hold_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '本挂牌唯一金币占款，引用 asset_hold.id；hold_type=COIN_MARKET_LISTING=5',
      },
      listedCoins: {
        field: 'listed_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '挂牌总量，必须大于 0',
      },
      availableCoins: {
        field: 'available_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '当前可成交量',
      },
      reservedCoins: {
        field: 'reserved_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '尚未完成的交易预占量',
      },
      filledCoins: {
        field: 'filled_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '已完成成交量',
      },
      cancelledCoins: {
        field: 'cancelled_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '挂牌关闭后释放的剩余量',
      },
      priceCentsPer1000Coins: {
        field: 'price_cents_per_1000_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '每 1000 金币的挂牌价，单位为人民币分；正整数',
      },
      receiveMethod: {
        field: 'receive_method',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '已登记收款方式常量；首版支持方式沿用支付渠道/USDT 目录',
      },
      receiveSnapshot: {
        field: 'receive_snapshot',
        type: DataTypes.JSON,
        allowNull: true,
        comment: '加密或脱敏的卖家收款方式快照；仅交易参与方按权限读取',
      },
      platformPaymentOptIn: {
        field: 'platform_payment_opt_in',
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '0/1 仅为普通布尔值，不是状态或枚举；默认不允许平台通道，卖家是否主动开放该挂牌的平台支付路径',
      },
      cancelledAt: {
        field: 'cancelled_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '撤销时间，UTC',
      },
      suspendedByUserId: {
        field: 'suspended_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '暂停/冻结挂牌的 Admin 或有权运营者，引用 user.id',
      },
    },
    {
      // 两表 deleted_at 恒 NULL（迁移 CHECK）：outbox 同款 paranoid: false 基座。
      ...outboxTableOptions('coin_market_listing'),
      comment: '卖家发布的一张金币挂牌及可被多个买家部分成交的库存状态',
      sequelize,
    } as unknown as ModelInitOptions<CoinMarketListingModel>,
  );
}

export function registerCoinMarketTradeModel(sequelize: Sequelize): void {
  (CoinMarketTradeModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment:
          '成交状态，取值见 CoinMarketTradeStatus：PAYMENT_PENDING=1/SELLER_CONFIRMATION_PENDING=2/DISPUTED=3/BUYER_EVIDENCE_PENDING=4/SELLER_EVIDENCE_PENDING=5/PLATFORM_REVIEW=6/RELEASED=7/AUTO_RELEASED=8/PAYMENT_EXPIRED=9/RESOLVED_RETURN=10/CANCELLED=11',
      },
      coinMarketListingId: {
        field: 'coin_market_listing_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '来源挂牌，引用 coin_market_listing.id',
      },
      buyerUserId: {
        field: 'buyer_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '本笔买家，引用 user.id',
      },
      tradeKey: {
        field: 'trade_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '接受挂牌幂等键',
      },
      coins: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '本笔预占金币数量，必须大于 0',
      },
      grossCents: {
        field: 'gross_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '本笔买家应付人民币分，按挂牌报价 ceil(price × coins ÷ 1000)',
      },
      paymentMode: {
        field: 'payment_mode',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '付款方式：DIRECT=1/PLATFORM_CHANNEL=2/USDT=3',
      },
      paymentChannelId: {
        field: 'payment_channel_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '平台通道成交所选支付方式，引用 payment_channel.id',
      },
      feeRateBps: {
        field: 'fee_rate_bps',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本笔平台通道费率快照；默认配置 2000 bps，非平台通道为 0',
      },
      feeCents: {
        field: 'fee_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '从卖家应收中扣除的费用，按统一货币舍入规则',
      },
      sellerNetCents: {
        field: 'seller_net_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '平台通道成交卖家净收金额；直接场外付款为 0（不经平台钱包）',
      },
      paymentProofAssetId: {
        field: 'payment_proof_asset_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '买家付款凭证；私有加密 asset，引用 asset 表；外键待 0017 补建',
      },
      chainTxId: {
        field: 'chain_tx_id',
        type: DataTypes.STRING(160),
        allowNull: true,
        comment: 'USDT 链上交易标识，唯一性由 TRON payment handler 校验',
      },
      usdtRateSnapshot: {
        field: 'usdt_rate_snapshot',
        type: DataTypes.DECIMAL(20, 8),
        allowNull: true,
        comment: '该笔交易锁定的每日 CNY/USDT 汇率',
      },
      paymentDeadlineAt: {
        field: 'payment_deadline_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '接受挂牌后 48h 截止，UTC',
      },
      sellerResponseDeadlineAt: {
        field: 'seller_response_deadline_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '凭证提交后 48h 截止；USDT 核验路径可空，UTC',
      },
      buyerEvidenceDeadlineAt: {
        field: 'buyer_evidence_deadline_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '卖家申诉后买家补证截止（48h），UTC',
      },
      buyerEvidenceAssetId: {
        field: 'buyer_evidence_asset_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '买家针对申诉提交的补充银行付款凭证；外键待 0017 补建',
      },
      buyerEvidenceSubmittedAt: {
        field: 'buyer_evidence_submitted_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '买家补充证据提交时间；开始卖家回应举证窗口，UTC',
      },
      sellerEvidenceDeadlineAt: {
        field: 'seller_evidence_deadline_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '买家补证后卖家回应证据截止（48h），UTC',
      },
      sellerEvidenceAssetId: {
        field: 'seller_evidence_asset_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '卖家针对买家补证提交的回应凭证；外键待 0017 补建',
      },
      sellerEvidenceSubmittedAt: {
        field: 'seller_evidence_submitted_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '卖家回应证据提交时间，UTC',
      },
      platformDecisionDeadlineAt: {
        field: 'platform_decision_deadline_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '卖家提交回应或回应期届满后，平台默认 48h 裁定截止；手动延期时更新并审计，UTC',
      },
      sellerDisputeNote: {
        field: 'seller_dispute_note',
        type: DataTypes.STRING(1000),
        allowNull: true,
        comment: '卖家申诉说明；不得填写完整支付账号或敏感凭证',
      },
      paidAt: {
        field: 'paid_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '买家付款凭证/链上交易提交时间，UTC',
      },
      supportConversationId: {
        field: 'support_conversation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联本笔争议客服会话，引用 support_conversation.id；会话内容仍由客服领域管理',
      },
      adjudicatedByUserId: {
        field: 'adjudicated_by_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '普通工作人员裁决人员，引用 user.id',
      },
      resolutionCode: {
        field: 'resolution_code',
        type: DataTypes.SMALLINT,
        allowNull: true,
        comment: '裁定结果：RELEASE_TO_BUYER=1/RETURN_TO_SELLER=2；未裁决为空',
      },
      resolutionNote: {
        field: 'resolution_note',
        type: DataTypes.STRING(1000),
        allowNull: true,
        comment: '裁决理由，禁止写入支付凭证明文',
      },
      adjudicatedAt: {
        field: 'adjudicated_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '普通工作人员作出裁定的时间，UTC',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '成交放币/返还对应的钱包操作，引用 asset_operation.id；仅由 wallet 用例写入',
      },
    },
    {
      // 两表 deleted_at 恒 NULL（迁移 CHECK）：outbox 同款 paranoid: false 基座；
      // coin_market_trade 有 11 值状态机，非不可变表，不加 append-only hooks。
      ...outboxTableOptions('coin_market_trade'),
      comment: '买家对一张金币挂牌的一笔独立部分成交及其付款、争议和结算过程',
      sequelize,
    } as unknown as ModelInitOptions<CoinMarketTradeModel>,
  );
}
