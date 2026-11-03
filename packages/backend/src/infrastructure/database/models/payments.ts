/**
 * payments — 支付、订单与出款：`payment_provider` / `payment_channel` / `product` /
 * `order`（保留字）/ `payment_event`（不可变）/ `external_settlement` / `payout_account` /
 * `withdrawal` / `payout_attempt`。
 *
 * 领域所有者：payments 模块（models/payments.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.4；数据库设计SDD §5.4。
 * DDL 以迁移 0010-create-asset-payments.ts 为准。
 *
 * 读写用例：
 * - `PaymentProviderModel` / `PaymentChannelModel`：渠道与提供商配置（Mock 操作页、admin 渠道管理）。
 * - `ProductModel`：商品目录与版本（在售版本不改价，修改新建版本；active_marker 生成列）。
 * - `OrderModel`：下单→支付→履约全链路；`order` 是 MySQL 保留字，Sequelize 对
 *   `tableName: 'order'` 自动加反引号，raw SQL 处须手工加（A.12 第 7 条）。
 * - `PaymentEventModel`（不可变）：支付回调/查询/对账证据 append-only。
 * - `ExternalSettlementModel`：外部资金收支与渠道对账（CHECK net=gross-fee；
 *   flow_type 与关联列组合由 CHECK 约束）。
 * - `PayoutAccountModel`：收款账户版本（资料变化新增版本，不覆盖处理中出款目标）。
 * - `WithdrawalModel`：提现申请审核与占款（WithdrawalStatus 1~9 状态机）。
 * - `PayoutAttemptModel`：外部出款尝试与未知结果恢复（active_marker 生成列限制
 *   每笔提现至多一个有效尝试）。
 *
 * 金额列 DECIMAL(36,12)/DECIMAL(38,12) 接口 wire 为十进制字符串；有符号 BIGINT
 * 金额列同样十进制字符串。
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
// payment_provider
// ---------------------------------------------------------------------------

/** `payment_provider` 表属性。secret_reference 为密钥管理器引用而非密钥值。 */
export interface PaymentProviderModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  providerCode: string;
  /** PaymentProviderType：AGGREGATOR=1/SELF_TRON=2/MOCK=3。 */
  providerType: number;
  name: string;
  adapterKey: string;
  secretReference: string | null;
  /** JSON：下单查询对账及出款能力声明。 */
  capabilitySnapshot: Record<string, unknown>;
}

export type PaymentProviderModelCreationAttributes = Optional<
  PaymentProviderModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class PaymentProviderModel
  extends Model<PaymentProviderModelAttributes, PaymentProviderModelCreationAttributes>
  implements PaymentProviderModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  providerCode!: string;
  providerType!: number;
  name!: string;
  adapterKey!: string;
  secretReference!: string | null;
  capabilitySnapshot!: Record<string, unknown>;
  static associate(models: { PaymentProviderModel: typeof PaymentProviderModel }): void {
    void models.PaymentProviderModel;
  }
}

// ---------------------------------------------------------------------------
// payment_channel
// ---------------------------------------------------------------------------

/** `payment_channel` 表属性。method_type 取值 1~6（MethodType）。 */
export interface PaymentChannelModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  paymentProviderId: string;
  channelCode: string;
  /** MethodType：ALIPAY=1/WECHAT=2/BANK=3/UNIONPAY_QR=4/ECNY=5/USDT_TRON=6。 */
  methodType: number;
  channelConfig: Record<string, unknown>;
  feeConfig: Record<string, unknown>;
  /** INT：玩家支付方式列表展示顺序；按 priority、id 稳定排序。 */
  priority: number;
}

export type PaymentChannelModelCreationAttributes = Optional<
  PaymentChannelModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class PaymentChannelModel
  extends Model<PaymentChannelModelAttributes, PaymentChannelModelCreationAttributes>
  implements PaymentChannelModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  paymentProviderId!: string;
  channelCode!: string;
  methodType!: number;
  channelConfig!: Record<string, unknown>;
  feeConfig!: Record<string, unknown>;
  priority!: number;
  static associate(models: { PaymentChannelModel: typeof PaymentChannelModel; PaymentProviderModel: typeof PaymentProviderModel }): void {
    PaymentChannelModel.belongsTo(models.PaymentProviderModel, {
      foreignKey: 'payment_provider_id',
      as: 'paymentProvider',
      constraints: false,
    });
  }
}

// ---------------------------------------------------------------------------
// product
// ---------------------------------------------------------------------------

/**
 * `product` 表属性。price_amount DECIMAL(36,12) 接口 wire 为十进制字符串；
 * active_marker 生成列：status=ON_SALE 且未删除为 1，否则 NULL（不进入 attributes）。
 */
export interface ProductModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  productCode: string;
  /** ProductType：COIN_TOP_UP=1；其他商品类型由商城领域常量扩展。 */
  productType: number;
  /** BIGINT UNSIGNED：商品版本；在售版本不改价或履约内容，修改新建版本。 */
  version: string;
  name: string;
  /** DECIMAL(36,12)：商品价格数量，接口 wire 十进制字符串。 */
  priceAmount: string;
  priceCurrency: string;
  /** JSON：商品履约定义；金币商品含购买金币、赠币及流水要求。 */
  fulfillmentSpec: Record<string, unknown>;
  /**
   * 生成列，只读：TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status=2 AND
   * deleted_at IS NULL THEN 1 ELSE NULL END) STORED；不进入 model attributes（A.12 第 6 条）。
   */
  /** 生成列（数据库层只读，非 TS 层 readonly）；不进 model attributes（A.12 第 6 条）。 */
  activeMarker: number | null;
}

export type ProductModelCreationAttributes = Optional<ProductModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class ProductModel extends Model<ProductModelAttributes, ProductModelCreationAttributes> implements ProductModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  productCode!: string;
  productType!: number;
  version!: string;
  name!: string;
  priceAmount!: string;
  priceCurrency!: string;
  fulfillmentSpec!: Record<string, unknown>;
  /** 生成列，只读（见 interface 注释）。 */
  activeMarker!: number | null;
  static associate(models: { ProductModel: typeof ProductModel }): void {
    void models.ProductModel;
  }
}

// ---------------------------------------------------------------------------
// order（保留字）
// ---------------------------------------------------------------------------

/**
 * `order` 表属性（保留字，Sequelize 对 tableName 自动加反引号；raw SQL 须手工加）。
 * 金额列 DECIMAL(36,12) 接口 wire 十进制字符串；actual_cny_cents 有符号 BIGINT。
 * deleted_at 恒 NULL（订单不可软删，迁移 CHECK）。
 */
export interface OrderModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  /** 下单时商品版本，引用 product.id。 */
  productId: string;
  /** 固定支付路由，引用 payment_channel.id；创建后不可切换。 */
  paymentChannelId: string;
  orderKey: string;
  /** 外部渠道订单号；U(payment_channel_id, provider_order_key)。 */
  providerOrderKey: string | null;
  paymentCurrency: string;
  /** DECIMAL(36,12)：请求原币支付金额，接口 wire 十进制字符串。 */
  requestedAmount: string;
  /** DECIMAL(36,12)：确认实付原币金额。 */
  actualAmount: string | null;
  /** 有符号 BIGINT：实际支付人民币金额/锁定人民币等值，充值返点基数。 */
  actualCnyCents: string | null;
  /** JSON：商品履约快照、USDT 汇率来源/汇率/采样时间、赠送要求及返点政策。 */
  extra: Record<string, unknown>;
  /** 成功履约资金操作，引用 asset_operation.id（RESTRICT 外键）。 */
  assetOperationId: string | null;
  expiresAt: Date | string;
  paidAt: Date | string | null;
  fulfilledAt: Date | string | null;
}

export type OrderModelCreationAttributes = Optional<OrderModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class OrderModel extends Model<OrderModelAttributes, OrderModelCreationAttributes> implements OrderModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  productId!: string;
  paymentChannelId!: string;
  orderKey!: string;
  providerOrderKey!: string | null;
  paymentCurrency!: string;
  requestedAmount!: string;
  actualAmount!: string | null;
  actualCnyCents!: string | null;
  extra!: Record<string, unknown>;
  assetOperationId!: string | null;
  expiresAt!: Date | string;
  paidAt!: Date | string | null;
  fulfilledAt!: Date | string | null;
  static associate(models: {
    OrderModel: typeof OrderModel;
    PaymentChannelModel: typeof PaymentChannelModel;
    ProductModel: typeof ProductModel;
  }): void {
    OrderModel.belongsTo(models.ProductModel, {
      foreignKey: 'product_id',
      as: 'product',
      constraints: false,
    });
    OrderModel.belongsTo(models.PaymentChannelModel, {
      foreignKey: 'payment_channel_id',
      as: 'paymentChannel',
      constraints: false,
    });
    // user / asset_operation 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// payment_event（不可变）
// ---------------------------------------------------------------------------

/**
 * `payment_event` 表属性（不可变支付证据）。CHECK：三个目标引用恰有一个非 NULL。
 * payload_ciphertext 为 MEDIUMBLOB（加密密文，模型保持二进制原样）。
 */
export interface PaymentEventModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  paymentProviderId: string;
  /** 可定位的商城订单；与 payout_attempt_id/coin_market_trade_id 恰一非空。 */
  orderId: string | null;
  /** 可定位的出款尝试。 */
  payoutAttemptId: string | null;
  /** 可定位的平台通道集市成交；外键待 0016 补建。 */
  coinMarketTradeId: string | null;
  eventKey: string;
  /** EventType：CALLBACK=1/QUERY=2/RECONCILIATION=3。 */
  eventType: number;
  /** VerificationResult：VERIFIED=1/REJECTED=2。 */
  verificationResult: number;
  /** BINARY(32)：规范化原消息哈希。 */
  payloadHash: Uint8Array;
  /** MEDIUMBLOB：必要审计消息的加密密文。 */
  payloadCiphertext: Uint8Array;
  occurredAt: Date | string;
  receivedAt: Date | string;
}

export type PaymentEventModelCreationAttributes = Optional<
  PaymentEventModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class PaymentEventModel
  extends Model<PaymentEventModelAttributes, PaymentEventModelCreationAttributes>
  implements PaymentEventModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  paymentProviderId!: string;
  orderId!: string | null;
  payoutAttemptId!: string | null;
  coinMarketTradeId!: string | null;
  eventKey!: string;
  eventType!: number;
  verificationResult!: number;
  payloadHash!: Uint8Array;
  payloadCiphertext!: Uint8Array;
  occurredAt!: Date | string;
  receivedAt!: Date | string;
  static associate(models: { PaymentEventModel: typeof PaymentEventModel; PaymentProviderModel: typeof PaymentProviderModel }): void {
    PaymentEventModel.belongsTo(models.PaymentProviderModel, {
      foreignKey: 'payment_provider_id',
      as: 'paymentProvider',
      constraints: false,
    });
    // order / payout_attempt / coin_market_trade 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// external_settlement
// ---------------------------------------------------------------------------

/**
 * `external_settlement` 表属性。CHECK：net_cny_cents=gross_cny_cents-fee_cny_cents；
 * flow_type 与关联列组合 CHECK。金额列 DECIMAL(36,12)/有符号 BIGINT 接口 wire 十进制字符串。
 * deleted_at 恒 NULL（外部资金事实禁止删除，迁移 CHECK）。
 */
export interface ExternalSettlementModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  paymentProviderId: string | null;
  orderId: string | null;
  payoutAttemptId: string | null;
  coinMarketTradeId: string | null;
  /** 手续费调整所对应的原外部资金记录，引用 external_settlement.id。 */
  relatedExternalSettlementId: string | null;
  assetOperationId: string | null;
  settlementKey: string;
  externalTransactionKey: string;
  /** ExternalFlowType：IN=1/OUT=2/FEE_ADJUSTMENT=3/FUNDING=4。 */
  flowType: number;
  originalCurrency: string;
  /** DECIMAL(36,12)：原币有符号收支数量，接口 wire 十进制字符串。 */
  originalAmount: string;
  /** 有符号 BIGINT：人民币等值毛额。 */
  grossCnyCents: string;
  /** 有符号 BIGINT：费用分；正数增加费用，负数表示费用退回/冲减。 */
  feeCnyCents: string;
  /** 有符号 BIGINT：内部人民币净变动（=gross-fee）。 */
  netCnyCents: string;
  valuationSnapshot: Record<string, unknown>;
  settledAt: Date | string | null;
}

export type ExternalSettlementModelCreationAttributes = Optional<
  ExternalSettlementModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class ExternalSettlementModel
  extends Model<ExternalSettlementModelAttributes, ExternalSettlementModelCreationAttributes>
  implements ExternalSettlementModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  paymentProviderId!: string | null;
  orderId!: string | null;
  payoutAttemptId!: string | null;
  coinMarketTradeId!: string | null;
  relatedExternalSettlementId!: string | null;
  assetOperationId!: string | null;
  settlementKey!: string;
  externalTransactionKey!: string;
  flowType!: number;
  originalCurrency!: string;
  originalAmount!: string;
  grossCnyCents!: string;
  feeCnyCents!: string;
  netCnyCents!: string;
  valuationSnapshot!: Record<string, unknown>;
  settledAt!: Date | string | null;
  static associate(models: {
    ExternalSettlementModel: typeof ExternalSettlementModel;
    PaymentProviderModel: typeof PaymentProviderModel;
  }): void {
    ExternalSettlementModel.belongsTo(models.PaymentProviderModel, {
      foreignKey: 'payment_provider_id',
      as: 'paymentProvider',
      constraints: false,
    });
    // 自引用 related_external_settlement_id（RESTRICT 外键由迁移管理）。
    ExternalSettlementModel.belongsTo(models.ExternalSettlementModel, {
      foreignKey: 'related_external_settlement_id',
      as: 'relatedSettlement',
      constraints: false,
    });
    // order / payout_attempt / coin_market_trade / asset_operation 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// payout_account
// ---------------------------------------------------------------------------

/**
 * `payout_account` 表属性。资料变化新增版本，不覆盖处理中出款目标；
 * account_ciphertext VARBINARY(8192) 为加密收款资料（模型保持二进制原样）；
 * lookup_hash BINARY(32) 供查询和去重。
 */
export interface PayoutAccountModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  accountKey: string;
  /** BIGINT UNSIGNED：收款资料版本。 */
  version: string;
  /** 提供商支持的出款方法常量（MethodType）。 */
  methodType: number;
  /** VARBINARY(8192)：收款人、号码等加密资料。 */
  accountCiphertext: Uint8Array;
  /** BINARY(32)：规范化账户摘要，供查询和去重。 */
  lookupHash: Uint8Array;
  maskedLabel: string;
}

export type PayoutAccountModelCreationAttributes = Optional<
  PayoutAccountModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class PayoutAccountModel
  extends Model<PayoutAccountModelAttributes, PayoutAccountModelCreationAttributes>
  implements PayoutAccountModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  accountKey!: string;
  version!: string;
  methodType!: number;
  accountCiphertext!: Uint8Array;
  lookupHash!: Uint8Array;
  maskedLabel!: string;
  static associate(models: { PayoutAccountModel: typeof PayoutAccountModel }): void {
    void models.PayoutAccountModel;
    // user 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// withdrawal
// ---------------------------------------------------------------------------

/**
 * `withdrawal` 表属性。WithdrawalStatus 1~9 状态机；
 * coin_equivalent DECIMAL(38,12) 接口 wire 十进制字符串；deleted_at 恒 NULL（迁移 CHECK）。
 */
export interface WithdrawalModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  /** 固定收款账户版本，引用 payout_account.id。 */
  payoutAccountId: string;
  /** 创建占款操作，引用 asset_operation.id。 */
  assetOperationId: string;
  /** 用户人民币占款，引用 asset_hold.id。 */
  assetHoldId: string;
  withdrawalKey: string;
  /** 用户要求实际到账的净额（十进制字符串 wire）。 */
  cashCents: string;
  /** 申请时确认费用，默认 0。 */
  feeCents: string;
  /** DECIMAL(38,12)：门槛检验的金币等值，接口 wire 十进制字符串。 */
  coinEquivalent: string;
  /** 最小金币等值快照，默认 1000。 */
  minimumCoins: string;
  /** JSON：身份门禁、流水、比例及手续费快照。 */
  policySnapshot: Record<string, unknown>;
  /** 最早可提交出款时间（默认申请时间后 72 小时）。 */
  payoutNotBeforeAt: Date | string;
  /** 一次性审批事件定位值（U(approval_key)）。 */
  approvalKey: string | null;
  approvedAt: Date | string | null;
  completedAt: Date | string | null;
  failureReason: string | null;
}

export type WithdrawalModelCreationAttributes = Optional<
  WithdrawalModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class WithdrawalModel
  extends Model<WithdrawalModelAttributes, WithdrawalModelCreationAttributes>
  implements WithdrawalModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  payoutAccountId!: string;
  assetOperationId!: string;
  assetHoldId!: string;
  withdrawalKey!: string;
  cashCents!: string;
  feeCents!: string;
  coinEquivalent!: string;
  minimumCoins!: string;
  policySnapshot!: Record<string, unknown>;
  payoutNotBeforeAt!: Date | string;
  approvalKey!: string | null;
  approvedAt!: Date | string | null;
  completedAt!: Date | string | null;
  failureReason!: string | null;
  static associate(models: { WithdrawalModel: typeof WithdrawalModel; PayoutAccountModel: typeof PayoutAccountModel }): void {
    WithdrawalModel.belongsTo(models.PayoutAccountModel, {
      foreignKey: 'payout_account_id',
      as: 'payoutAccount',
      constraints: false,
    });
    // user / asset_operation / asset_hold 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// payout_attempt
// ---------------------------------------------------------------------------

/**
 * `payout_attempt` 表属性。PayoutStatus 1~5；active_marker 生成列：
 * status IN (PREPARED,SENDING,UNKNOWN) 且未删除为 1，否则 NULL（不进入 attributes）。
 * deleted_at 恒 NULL（迁移 CHECK）。
 */
export interface PayoutAttemptModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  withdrawalId: string;
  /** 可用代理出款渠道；人工出款为空，引用 payment_channel.id。 */
  paymentChannelId: string | null;
  /** INT UNSIGNED：尝试序号，从 1 开始。 */
  attemptNo: number;
  /** 渠道幂等出款请求号；UNKNOWN 结果须用相同键查询原结果。 */
  payoutKey: string;
  providerPayoutKey: string | null;
  /** BINARY(32)：同键请求一致性摘要。 */
  requestHash: Uint8Array;
  requestedAt: Date | string | null;
  resolvedAt: Date | string | null;
  /**
   * 生成列（数据库层只读，非 TS 层 readonly）：TINYINT UNSIGNED GENERATED ALWAYS AS
   * (CASE WHEN status IN (1,2,3) AND deleted_at IS NULL THEN 1 ELSE NULL END) STORED；
   * 不进 model attributes（A.12 第 6 条）。
   */
  activeMarker: number | null;
}

export type PayoutAttemptModelCreationAttributes = Optional<
  PayoutAttemptModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class PayoutAttemptModel
  extends Model<PayoutAttemptModelAttributes, PayoutAttemptModelCreationAttributes>
  implements PayoutAttemptModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  withdrawalId!: string;
  paymentChannelId!: string | null;
  attemptNo!: number;
  payoutKey!: string;
  providerPayoutKey!: string | null;
  requestHash!: Uint8Array;
  requestedAt!: Date | string | null;
  resolvedAt!: Date | string | null;
  /** 生成列，只读（见 interface 注释）。 */
  activeMarker!: number | null;
  static associate(models: { PayoutAttemptModel: typeof PayoutAttemptModel; PaymentChannelModel: typeof PaymentChannelModel }): void {
    PayoutAttemptModel.belongsTo(models.PaymentChannelModel, {
      foreignKey: 'payment_channel_id',
      as: 'paymentChannel',
      constraints: false,
    });
    // withdrawal 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

export const PaymentProviderTypeLocal = { AGGREGATOR: 1, SELF_TRON: 2, MOCK: 3 } as const;
export type PaymentProviderTypeLocalValue = (typeof PaymentProviderTypeLocal)[keyof typeof PaymentProviderTypeLocal];

/** MethodType：支付方式（与 contracts PaymentMethod 数值一致，键名按 DDL 注释）。 */
export const MethodType = { ALIPAY: 1, WECHAT: 2, BANK: 3, UNIONPAY_QR: 4, ECNY: 5, USDT_TRON: 6 } as const;
export type MethodTypeValue = (typeof MethodType)[keyof typeof MethodType];

export const ProductStatus = { DRAFT: 1, ON_SALE: 2, OFF_SALE: 3, RETIRED: 4 } as const;
export type ProductStatusValue = (typeof ProductStatus)[keyof typeof ProductStatus];

export const ProductType = { COIN_TOP_UP: 1 } as const;
export type ProductTypeValue = (typeof ProductType)[keyof typeof ProductType];

export const OrderStatus = {
  CREATED: 1,
  PAYING: 2,
  PAID: 3,
  FULFILLED: 4,
  EXPIRED: 5,
  EXCEPTION: 6,
  CANCELLED: 7,
} as const;
export type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus];

/** RecordStatus：不可变事件行固定 1（本地常量，单一来源在 contracts 落地后统一）。 */
export const RecordStatus = { RECORDED: 1 } as const;
export type RecordStatusValue = (typeof RecordStatus)[keyof typeof RecordStatus];

/** PaymentEventType：支付事件类型。 */
export const PaymentEventType = { CALLBACK: 1, QUERY: 2, RECONCILIATION: 3 } as const;
export type PaymentEventTypeValue = (typeof PaymentEventType)[keyof typeof PaymentEventType];

export const PaymentVerificationResult = { VERIFIED: 1, REJECTED: 2 } as const;
export type PaymentVerificationResultValue = (typeof PaymentVerificationResult)[keyof typeof PaymentVerificationResult];

export const ExternalStatus = { OPEN: 1, RECONCILED: 2, DISPUTED: 3, REVERSED: 4 } as const;
export type ExternalStatusValue = (typeof ExternalStatus)[keyof typeof ExternalStatus];

export const ExternalFlowType = { IN: 1, OUT: 2, FEE_ADJUSTMENT: 3, FUNDING: 4 } as const;
export type ExternalFlowTypeValue = (typeof ExternalFlowType)[keyof typeof ExternalFlowType];

/** WithdrawalStatus（与 contracts WalletWithdrawalStatus 数值一致；contracts 键名 PAYMENT_UNKNOWN=8，DDL 注释为 UNKNOWN=8）。 */
export const WithdrawalStatus = {
  REQUESTED: 1,
  REVIEWING: 2,
  APPROVED: 3,
  PAYING: 4,
  SUCCEEDED: 5,
  REJECTED: 6,
  CANCELLED: 7,
  UNKNOWN: 8,
  FAILED: 9,
} as const;
export type WithdrawalStatusValue = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

export const PayoutStatus = { PREPARED: 1, SENDING: 2, UNKNOWN: 3, SUCCEEDED: 4, FAILED: 5 } as const;
export type PayoutStatusValue = (typeof PayoutStatus)[keyof typeof PayoutStatus];

/** ActiveStatus：行工作状态（多文件共用，单一来源在 contracts 落地后统一）。 */
export const ActiveStatus = { ACTIVE: 1, DISABLED: 2, RETIRED: 3 } as const;
export type ActiveStatusValue = (typeof ActiveStatus)[keyof typeof ActiveStatus];

export function register_PaymentProviderModel(sequelize: Sequelize): void {
  (PaymentProviderModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '提供商状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      providerCode: {
        field: 'provider_code',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '稳定提供商代码',
      },
      providerType: {
        field: 'provider_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '提供商类型，取值见 PaymentProviderType：AGGREGATOR=1/SELF_TRON=2/MOCK=3',
      },
      name: { type: DataTypes.STRING(100), allowNull: false, comment: '提供商名称' },
      adapterKey: {
        field: 'adapter_key',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '服务器适配器注册表键',
      },
      secretReference: {
        field: 'secret_reference',
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: '非 Mock provider 的密钥管理器引用，非密钥值；MOCK 无需配置',
      },
      capabilitySnapshot: {
        field: 'capability_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '下单查询对账及出款能力声明',
      },
    },

    {
      ...standardTableOptions('payment_provider'),
      comment: '代理商和自建支付适配器',
      sequelize,
    } as unknown as ModelInitOptions<PaymentProviderModel>,
  );
}

export function register_PaymentChannelModel(sequelize: Sequelize): void {
  (PaymentChannelModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '渠道状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      paymentProviderId: {
        field: 'payment_provider_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属提供商，引用 payment_provider.id',
      },
      channelCode: {
        field: 'channel_code',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '渠道唯一代码',
      },
      methodType: {
        field: 'method_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '支付方式：ALIPAY=1/WECHAT=2/BANK=3/UNIONPAY_QR=4/ECNY=5/USDT_TRON=6',
      },
      channelConfig: {
        field: 'channel_config',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '非秘密商户路由及计费配置',
      },
      feeConfig: {
        field: 'fee_config',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '手续费算法、费率和舍入规则',
      },
      priority: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '玩家支付方式列表展示顺序；按 priority、id 稳定排序',
      },
    },

    {
      ...standardTableOptions('payment_channel'),
      comment: '支付方法与提供商路由',
      sequelize,
    } as unknown as ModelInitOptions<PaymentChannelModel>,
  );
}

export function register_ProductModel(sequelize: Sequelize): void {
  (ProductModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '商品状态，取值见 ProductStatus：DRAFT=1/ON_SALE=2/OFF_SALE=3/RETIRED=4',
      },
      productCode: {
        field: 'product_code',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '稳定商品代码',
      },
      productType: {
        field: 'product_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '商品类型：COIN_TOP_UP=1；其他商品类型由商城领域常量扩展',
      },
      version: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '商品版本；在售版本不改价或履约内容，修改新建版本',
      },
      name: { type: DataTypes.STRING(100), allowNull: false, comment: '显示名称' },
      priceAmount: {
        field: 'price_amount',
        type: DataTypes.DECIMAL(36, 12),
        allowNull: false,
        comment: '商品价格数量',
      },
      priceCurrency: {
        field: 'price_currency',
        type: DataTypes.STRING(16),
        allowNull: false,
        comment: '标价币种，如 CNY',
      },
      fulfillmentSpec: {
        field: 'fulfillment_spec',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '商品履约定义；金币商品含购买金币、赠币及流水要求',
      },
    },

    {
      ...standardTableOptions('product'),
      comment: '商城可售商品目录及版本',
      sequelize,
    } as unknown as ModelInitOptions<ProductModel>,
  );
}

export function register_OrderModel(sequelize: Sequelize): void {
  (OrderModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '订单状态，取值见 OrderStatus：CREATED=1/PAYING=2/PAID=3/FULFILLED=4/EXPIRED=5/EXCEPTION=6/CANCELLED=7',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '购买用户，引用 user.id' },
      productId: { field: 'product_id', type: DataTypes.BIGINT, allowNull: false, comment: '下单时商品版本，引用 product.id' },
      paymentChannelId: {
        field: 'payment_channel_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '固定支付路由，引用 payment_channel.id；创建后不可切换',
      },
      orderKey: {
        field: 'order_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '内部订单号及下单幂等定位值',
      },
      providerOrderKey: {
        field: 'provider_order_key',
        type: DataTypes.STRING(160),
        allowNull: true,
        comment: '外部渠道订单号',
      },
      paymentCurrency: {
        field: 'payment_currency',
        type: DataTypes.STRING(16),
        allowNull: false,
        comment: '实际支付币种',
      },
      requestedAmount: {
        field: 'requested_amount',
        type: DataTypes.DECIMAL(36, 12),
        allowNull: false,
        comment: '请求原币支付金额',
      },
      actualAmount: {
        field: 'actual_amount',
        type: DataTypes.DECIMAL(36, 12),
        allowNull: true,
        comment: '确认实付原币金额',
      },
      actualCnyCents: {
        field: 'actual_cny_cents',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '商业订单的实际支付人民币金额/锁定人民币等值，充值返点基数；USDT 识别尾数不计入商品价格',
      },
      extra: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '商品履约快照、USDT 汇率来源/汇率/采样时间、赠送要求及返点政策；支付币种金额仍以列保存',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '成功履约资金操作，引用 asset_operation.id',
      },
      expiresAt: { field: 'expires_at', type: DataTypes.DATE, allowNull: false, comment: '订单超时时间，UTC' },
      paidAt: { field: 'paid_at', type: DataTypes.DATE, allowNull: true, comment: '验证支付成功时间，UTC' },
      fulfilledAt: {
        field: 'fulfilled_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '金币和返点履约完成时间，UTC',
      },
    },

    {
      // `order` 是 MySQL 保留字：Sequelize 对 tableName 自动加反引号；raw SQL 处手工加。
      ...standardTableOptions('order'),
      comment: '通用商城订单、支付及商品履约状态',
      sequelize,
    } as unknown as ModelInitOptions<OrderModel>,
  );
}

export function register_PaymentEventModel(sequelize: Sequelize): void {
  (PaymentEventModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '事件状态，固定为 RecordStatus.RECORDED=1，支付证据不可改写',
      },
      paymentProviderId: {
        field: 'payment_provider_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '消息提供商，引用 payment_provider.id',
      },
      orderId: {
        field: 'order_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '可定位的商城订单，引用 order.id',
      },
      payoutAttemptId: {
        field: 'payout_attempt_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '可定位的出款尝试，引用 payout_attempt.id；外键随批次内建',
      },
      coinMarketTradeId: {
        field: 'coin_market_trade_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '可定位的平台通道集市成交；外键待 0016 补建',
      },
      eventKey: {
        field: 'event_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '提供商事件号或规范化语义去重键',
      },
      eventType: {
        field: 'event_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '事件类型：CALLBACK=1/QUERY=2/RECONCILIATION=3',
      },
      verificationResult: {
        field: 'verification_result',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '验签结果：VERIFIED=1/REJECTED=2',
      },
      payloadHash: {
        field: 'payload_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '规范化原消息哈希',
      },
      payloadCiphertext: {
        field: 'payload_ciphertext',
        type: DataTypes.BLOB,
        allowNull: false,
        comment: '必要审计消息的加密密文',
      },
      occurredAt: { field: 'occurred_at', type: DataTypes.DATE, allowNull: false, comment: '渠道事件时间，UTC' },
      receivedAt: { field: 'received_at', type: DataTypes.DATE, allowNull: false, comment: '服务端接收时间，UTC' },
    },

    {
      ...appendOnlyModelOptions('payment_event'),
      hooks: { ...appendOnlyHooks('payment_event') },
      comment: '不可变支付回调及查询证据',
      sequelize,
    } as unknown as ModelInitOptions<PaymentEventModel>,
  );
}

export function register_ExternalSettlementModel(sequelize: Sequelize): void {
  (ExternalSettlementModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '对账状态，取值见 ExternalStatus：OPEN=1/RECONCILED=2/DISPUTED=3/REVERSED=4',
      },
      paymentProviderId: {
        field: 'payment_provider_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '渠道提供商，自有资金注入可为空，引用 payment_provider.id',
      },
      orderId: { field: 'order_id', type: DataTypes.BIGINT, allowNull: true, comment: '入款订单，引用 order.id' },
      payoutAttemptId: {
        field: 'payout_attempt_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '出款尝试，引用 payout_attempt.id；外键随批次内建',
      },
      coinMarketTradeId: {
        field: 'coin_market_trade_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '平台通道集市成交；外键待 0016 补建',
      },
      relatedExternalSettlementId: {
        field: 'related_external_settlement_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '手续费调整所对应的原外部资金记录，引用 external_settlement.id',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '内部收支记账操作，引用 asset_operation.id',
      },
      settlementKey: {
        field: 'settlement_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '外部收支语义键',
      },
      externalTransactionKey: {
        field: 'external_transaction_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '渠道流水或链交易定位',
      },
      flowType: {
        field: 'flow_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '资金流向，取值见 ExternalFlowType：IN=1/OUT=2/FEE_ADJUSTMENT=3/FUNDING=4',
      },
      originalCurrency: {
        field: 'original_currency',
        type: DataTypes.STRING(16),
        allowNull: false,
        comment: '实际外部币种',
      },
      originalAmount: {
        field: 'original_amount',
        type: DataTypes.DECIMAL(36, 12),
        allowNull: false,
        comment: '原币有符号收支数量',
      },
      grossCnyCents: {
        field: 'gross_cny_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '人民币等值毛额，有符号',
      },
      feeCnyCents: {
        field: 'fee_cny_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '有符号费用分；正数增加费用，负数表示费用退回/冲减',
      },
      netCnyCents: {
        field: 'net_cny_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '内部人民币净变动',
      },
      valuationSnapshot: {
        field: 'valuation_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '计价、是否实换汇和费用证据',
      },
      settledAt: {
        field: 'settled_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '渠道实际结算完成时刻，UTC',
      },
    },

    {
      ...standardTableOptions('external_settlement'),
      comment: '平台外部资金收支及渠道对账',
      sequelize,
    } as unknown as ModelInitOptions<ExternalSettlementModel>,
  );
}

export function register_PayoutAccountModel(sequelize: Sequelize): void {
  (PayoutAccountModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '收款账户状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '账户所有者，引用 user.id' },
      accountKey: {
        field: 'account_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '稳定收款账户定位值',
      },
      version: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '收款资料版本；资料变化新增版本，不覆盖处理中出款目标',
      },
      methodType: {
        field: 'method_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '提供商支持的出款方法常量',
      },
      accountCiphertext: {
        field: 'account_ciphertext',
        type: binaryDataType(8192),
        allowNull: false,
        comment: '收款人、号码等加密资料',
      },
      lookupHash: {
        field: 'lookup_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '规范化账户摘要，供查询和去重',
      },
      maskedLabel: {
        field: 'masked_label',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '客户端脱敏显示名称',
      },
    },

    {
      ...standardTableOptions('payout_account'),
      comment: '用户指定收款账户的版本',
      sequelize,
    } as unknown as ModelInitOptions<PayoutAccountModel>,
  );
}

export function register_WithdrawalModel(sequelize: Sequelize): void {
  (WithdrawalModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment:
          '提现状态，取值见 WithdrawalStatus：REQUESTED=1/REVIEWING=2/APPROVED=3/PAYING=4/SUCCEEDED=5/REJECTED=6/CANCELLED=7/UNKNOWN=8/FAILED=9',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '提现用户，引用 user.id' },
      payoutAccountId: {
        field: 'payout_account_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '固定收款账户版本，引用 payout_account.id',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '创建占款操作，引用 asset_operation.id',
      },
      assetHoldId: {
        field: 'asset_hold_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '用户人民币占款，引用 asset_hold.id',
      },
      withdrawalKey: {
        field: 'withdrawal_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '申请业务幂等定位值',
      },
      cashCents: {
        field: 'cash_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '用户要求实际到账的净额，人民币分；提现门槛以该净额对应金币数检验',
      },
      feeCents: {
        field: 'fee_cents',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '申请时确认费用，默认尚无额外规则；申请时冻结额为 cash_cents + fee_cents',
      },
      coinEquivalent: {
        field: 'coin_equivalent',
        type: DataTypes.DECIMAL(38, 12),
        allowNull: false,
        comment: '门槛检验的金币等值',
      },
      minimumCoins: {
        field: 'minimum_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '最小金币等值快照，默认 1000',
      },
      policySnapshot: {
        field: 'policy_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '身份门禁、流水、比例及手续费快照',
      },
      payoutNotBeforeAt: {
        field: 'payout_not_before_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '最早可提交线下/外部出款的时间，默认申请时间后 72 小时，UTC',
      },
      approvalKey: {
        field: 'approval_key',
        type: DataTypes.CHAR(36),
        allowNull: true,
        comment: '一次性审批事件定位值',
      },
      approvedAt: {
        field: 'approved_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '平台余额提现审核通过时间，UTC',
      },
      completedAt: {
        field: 'completed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '实际出款完成时间，UTC',
      },
      failureReason: {
        field: 'failure_reason',
        type: DataTypes.STRING(500),
        allowNull: true,
        comment: '失败或拒绝原因',
      },
    },

    {
      ...standardTableOptions('withdrawal'),
      comment: '人民币提现申请审核与占款',
      sequelize,
    } as unknown as ModelInitOptions<WithdrawalModel>,
  );
}

export function register_PayoutAttemptModel(sequelize: Sequelize): void {
  (PayoutAttemptModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '出款状态，取值见 PayoutStatus：PREPARED=1/SENDING=2/UNKNOWN=3/SUCCEEDED=4/FAILED=5',
      },
      withdrawalId: {
        field: 'withdrawal_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '对应提现，引用 withdrawal.id',
      },
      paymentChannelId: {
        field: 'payment_channel_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '可用代理出款渠道，引用 payment_channel.id；人工出款为空',
      },
      attemptNo: {
        field: 'attempt_no',
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '明确失败后才可递增的尝试序号，从 1 开始',
      },
      payoutKey: {
        field: 'payout_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '渠道幂等出款请求号；UNKNOWN 结果须用相同键查询原结果',
      },
      providerPayoutKey: {
        field: 'provider_payout_key',
        type: DataTypes.STRING(160),
        allowNull: true,
        comment: '渠道返回流水号',
      },
      requestHash: {
        field: 'request_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '同键请求一致性摘要',
      },
      requestedAt: {
        field: 'requested_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '开始请求时间，UTC',
      },
      resolvedAt: {
        field: 'resolved_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '结果明确时间，UTC',
      },
    },

    {
      ...standardTableOptions('payout_attempt'),
      comment: '外部出款尝试与未知结果恢复',
      sequelize,
    } as unknown as ModelInitOptions<PayoutAttemptModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface PaymentModels {
  PaymentProviderModel: typeof PaymentProviderModel;
  PaymentChannelModel: typeof PaymentChannelModel;
  ProductModel: typeof ProductModel;
  OrderModel: typeof OrderModel;
  PaymentEventModel: typeof PaymentEventModel;
  ExternalSettlementModel: typeof ExternalSettlementModel;
  PayoutAccountModel: typeof PayoutAccountModel;
  WithdrawalModel: typeof WithdrawalModel;
  PayoutAttemptModel: typeof PayoutAttemptModel;
}

/** 定义 9 个 payments model（不在此声明跨文件关联）。 */
export function initPayments(sequelize: Sequelize, models: PaymentModels): void {
  register_PaymentProviderModel(sequelize);
  register_PaymentChannelModel(sequelize);
  register_ProductModel(sequelize);
  register_OrderModel(sequelize);
  register_PaymentEventModel(sequelize);
  register_ExternalSettlementModel(sequelize);
  register_PayoutAccountModel(sequelize);
  register_WithdrawalModel(sequelize);
  register_PayoutAttemptModel(sequelize);
  void models;
}

/** 声明 payments 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associatePayments(models: PaymentModels): void {
  PaymentProviderModel.associate(models);
  PaymentChannelModel.associate(models);
  ProductModel.associate(models);
  OrderModel.associate(models);
  PaymentEventModel.associate(models);
  ExternalSettlementModel.associate(models);
  PayoutAccountModel.associate(models);
  WithdrawalModel.associate(models);
  PayoutAttemptModel.associate(models);
}
