/**
 * payments 仓储端口（payment_provider / payment_channel / order / payment_event /
 * external_settlement / payout_account / withdrawal + user 身份字段只读）。
 *
 * 领域所有者：payments 模块（adapters/sequelize-payments.ts 实现全部端口；
 * 资产分录/锁/抢键经 wallet 模块 `AssetLedger` 端口，本文件不重定义）。
 * 对应 SDD 章节：后端实施 SDD §4（用例与端口；锁顺序、幂等先抢唯一约束、
 * 所有分录/outbox 同事务）、§9 第 3 步（支付与提现）、§3.2 实体归属矩阵
 * （payments owns 9 表 + chain 3 表，models/payments.ts / models/chain.ts）；
 * 双资产文档 §3/§4/§5。
 *
 * 约定（同 wallet ports 纪律）：
 * - 金额/ID 全链路 BigInt 计算，wire 十进制字符串（row-mapper 完成跨层格式化，
 *   本端口出入参已是字符串/BigInt 业务单位——金币为枚、CNY 为分）；
 * - `Tx` 复用 wallet `Tx`（Sequelize 事务句柄鸭子类型，不重复定义两套）；
 * - `AssetLedger` 复用 wallet ports（账本操作全部经 AssetLedger，任务硬约定 1，
 *   本模块不自己写分录 SQL）；
 * - 不可变表（payment_event / external_settlement）只提供 append 路径，
 *   update/destroy 由 model hooks 拦截（A.12 第 5 条）；
 * - 幂等先抢唯一约束（order.U(order_key)、payment_event.U(provider_id,event_key)、
 *   withdrawal.U(withdrawal_key)、asset_operation.U(operation_key)——后者经
 *   AssetLedger.claimOperation，wallet 适配器 ER_DUP_ENTRY 捕获重放同款）；
 * - 行锁 `SELECT ... FOR UPDATE`（lockByPk 逐条，顺序 = 传入顺序 = 防死锁）。
 *
 * 错误码语义（contracts `FundingErrorCode` + `WalletErrorCode` 子集，P 表；
 * 各用例文件头维护自己的映射表）：
 * - `FUNDING_IDEMPOTENCY_KEY_REUSED`：order_key 命中且汇率/金额快照不一致。
 * - `FUNDING_ORDER_NOT_FOUND`：订单行缺失（锁读失败）。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户行缺失 / 乐观冲突。
 */

import type {
  PayoutAccountModel,
  WithdrawalModel,
  PaymentEventModel,
  OrderModel,
  ExternalSettlementModel,
} from '../../../infrastructure/database/models/payments.js';
import type { AssetLedger, ConfigReader, SystemIdentityPort, Tx, EntryIntent, ExchangeRate } from '../../wallet/ports/wallet-repository.js';
import type { TurnoverGateUseCase } from '../../wallet/application/turnover.js';
import type { OutboxPort, OutboxAppendInput } from '../../wallet/ports/outbox-port.js';
import type { Clock } from '../../wallet/ports/clock.js';
import type { ChainScannerPort, ChainDepositCandidate } from './chain-scan-port.js';

export type { Tx, AssetLedger, ConfigReader, SystemIdentityPort, OutboxPort, OutboxAppendInput, Clock, EntryIntent, ExchangeRate };

// ---------------------------------------------------------------------------
// 订单（order）
// ---------------------------------------------------------------------------

/** 订单定位视图（detail/list 只读；status 为 model 常量 1~7）。 */
export interface OrderView {
  id: string;
  userId: string;
  paymentChannelId: string;
  orderKey: string;
  paymentCurrency: string;
  /** DECIMAL(36,12) wire：请求原币金额（CNY 为分）。 */
  requestedAmount: string;
  actualAmount: string | null;
  actualCnyCents: string | null;
  status: number;
  extra: Record<string, unknown> | null;
  assetOperationId: string | null;
  expiresAt: Date | string;
  paidAt: Date | string | null;
  fulfilledAt: Date | string | null;
  createdAt: Date | string;
}

export interface OrderRepository {
  /**
   * 幂等抢键创建订单（`order.U(order_key)`；§4 "幂等先抢唯一约束"）。
   * - 新键成功 → `{ inserted: true, order }`（status = CREATED=1）；
   * - 键已存在且快照一致 → `{ inserted: false, order }`（重放，用例返回既有行，
   *   不产生第二笔，§10 红线）；
   * - 键已存在且快照不一致 → 抛 `FUNDING_IDEMPOTENCY_KEY_REUSED`。
   * `requestHash` 防同键异内容（汇率/金额/币种快照）。
   */
  createOrder(input: {
    userId: string;
    orderKey: string;
    paymentChannelId: string;
    paymentCurrency: string;
    requestedAmount: string;
    requestHash: Uint8Array;
    extra: Record<string, unknown>;
    providerOrderKey: string | null;
    expiresAt: Date;
    tx: Tx;
  }): Promise<{ inserted: boolean; order: OrderModel }>;

  /** 按 order_key 定位（模拟支付/webhook 入口；缺失返回 null → 用例 NOT_FOUND）。 */
  findByOrderKey(orderKey: string, tx?: Tx): Promise<OrderModel | null>;

  /** 用户订单列表（detail 段；按 created_at 降序，上限 50）。 */
  listByUser(userId: string, limit?: number, tx?: Tx): Promise<OrderView[]>;

  /** 行锁定位（`SELECT ... FOR UPDATE`；缺失抛 FUNDING_ORDER_NOT_FOUND）。 */
  lockByPk(orderId: string, tx: Tx): Promise<OrderModel>;

  /** 两步推进 CREATED/PAYING(1/2) → PAID(3) → FULFILLED(4)（同事务）。 */
  transitionOrder(input: {
    orderId: string;
    toStatus: number;
    paidAt?: Date | null;
    fulfilledAt?: Date | null;
    actualAmount?: string | null;
    actualCnyCents?: string | null;
    assetOperationId?: string | null;
    extra?: Record<string, unknown> | null;
    tx: Tx;
  }): Promise<OrderModel>;
}

// ---------------------------------------------------------------------------
// 渠道（payment_channel / payment_provider）
// ---------------------------------------------------------------------------

/** 渠道视图（listEnabledChannelsByMethod 排序输出；status 仅 ACTIVE=1 放行）。 */
export interface ChannelView {
  id: string;
  channelCode: string;
  methodType: number;
  priority: number;
  displayName: string;
  /** providerType：AGGREGATOR=1/SELF_TRON=2/MOCK=3。 */
  providerType: number;
}

export interface ChannelRepository {
  /**
   * 按 method_type 取已启用渠道（player 支付方式列表；`status=ACTIVE=1` 且
   * provider status=ACTIVE，双资产文档 §1 "用户可从排序后的已启用商户/渠道
   * 中选择"；按 priority ASC、id ASC 稳定排序，§"按 priority、id 稳定排序"）。
   * methodType 缺省 = 全部。
   */
  listEnabledChannelsByMethod(methodType?: number): Promise<ChannelView[]>;

  /** 按渠道 id 定位（createOrder 校验渠道存在且 ENABLED；缺失 → 用例
   * FUNDING_CHANNEL_UNAVAILABLE）。 */
  findEnabledById(channelId: string): Promise<ChannelView | null>;
}

// ---------------------------------------------------------------------------
// 收款账户（payout_account）
// ---------------------------------------------------------------------------

export interface PayoutAccountRepository {
  /** 用户收款账户列表（ActiveStatus=ACTIVE=1；按 version 降序）。 */
  listByUser(userId: string): Promise<PayoutAccountModel[]>;

  /**
   * 创建收款账户版本（首版 version=1；`account_key` UUID 稳定定位值；
   * `lookup_hash` = sha256(规范化明文)，供查询与去重；同 user 同
   * lookup_hash 已有有效版本时返回既有行幂等——资料相同不重复建版本，
   * §4 "提现固定所选账户版本"）。
   */
  create(input: {
    userId: string;
    /** CHAR(36) 稳定定位值（UUID；用例层经 `randomId`/`crypto.randomUUID` 生成）。 */
    accountKey: string;
    methodType: number;
    /** 敏感字段规范化明文（KMS 加密未闭环，首版 account_ciphertext 列存
     * 明文的 base64，登记决策点；model 保持二进制原样口径不变）。 */
    accountCiphertext: Uint8Array;
    lookupHash: Uint8Array;
    maskedLabel: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; account: PayoutAccountModel }>;

  /** 行锁定位（withdrawal 申请固定账户版本用；缺失/软删/非本人 → 用例
   * PAYOUT_ACCOUNT_NOT_FOUND）。 */
  lockByPk(accountId: string, tx: Tx): Promise<PayoutAccountModel>;

  /** 按 lookup_hash 定位有效版本（create 幂等去重）。 */
  lookupHash(userId: string, lookupHash: Uint8Array, tx: Tx): Promise<PayoutAccountModel | null>;

  /** 软删（deleted_at；处理中出款目标不受影响——提现固定所选版本行）。 */
  softDelete(accountId: string, userId: string, tx: Tx): Promise<number>;
}

// ---------------------------------------------------------------------------
// 提现（withdrawal）
// ---------------------------------------------------------------------------

export interface WithdrawalRepository {
  /**
   * 幂等创建提现申请（`withdrawal.U(withdrawal_key)` + 占款同事务；
   * 命中既有行 → `{ inserted: false, withdrawal }` 重放原结果，
   * 不产生第二笔占款，§10 红线）。
   */
  createWithdrawal(input: {
    userId: string;
    withdrawalKey: string;
    payoutAccountId: string;
    assetOperationId: string;
    assetHoldId: string;
    cashCents: string;
    feeCents: string;
    coinEquivalent: string;
    minimumCoins: string;
    policySnapshot: Record<string, unknown>;
    payoutNotBeforeAt: Date;
    tx: Tx;
  }): Promise<{ inserted: boolean; withdrawal: WithdrawalModel }>;

  /** 行锁定位（cancel/transition 前置；缺失 → WITHDRAWAL_NOT_FOUND；
   * 非本人行 → WITHDRAWAL_NOT_FOUND 防御）。 */
  lockByPk(withdrawalId: string, tx: Tx): Promise<WithdrawalModel>;

  /**
   * 状态机转换（domain/rules.ts `withdrawalAllowedTransitions` 校验；
   * 非法转换 → 用例映射 WITHDRAWAL_NOT_CANCELLABLE；`releasesHold` 标记
   * 供用例决定是否追加 WITHDRAWAL_RELEASE=8 反向分录）。
   */
  transition(input: {
    withdrawalId: string;
    fromStatus: number;
    toStatus: number;
    failureReason?: string | null;
    tx: Tx;
  }): Promise<{ withdrawal: WithdrawalModel; releasesHold: boolean }>;

  /** 用户提现申请列表（withdrawals 端点；按 created_at 降序，上限 50）。 */
  listByUser(userId: string, limit?: number): Promise<WithdrawalModel[]>;
}

// ---------------------------------------------------------------------------
// 支付事件（payment_event，不可变）
// ---------------------------------------------------------------------------

export interface PaymentEventRepository {
  /**
   * 幂等认领事件（`payment_event.U(payment_provider_id, event_key)`；
   * 命中既有行 → `{ inserted: false, event }` 静默重放（验收红线"重复回调
   * 只发一次金币"，§10）；新键 → INSERT（VERIFIED=1/REJECTED=2）。
   * 同键异内容（request_hash 不同）→ 抛 IDEMPOTENCY_KEY_REUSED 语义——
   * 首版按既有行的 verification_result 判定静默，登记决策点。
   */
  claimEvent(input: {
    providerId: string;
    eventKey: string;
    eventType: number;
    verificationResult: number;
    requestHash: Uint8Array;
    orderId: string | null;
    payloadCiphertext: Uint8Array;
    occurredAt: Date;
    tx: Tx;
  }): Promise<{ inserted: boolean; event: PaymentEventModel }>;
}

// ---------------------------------------------------------------------------
// 外部结算（external_settlement，不可变）
// ---------------------------------------------------------------------------

export interface ExternalSettlementRepository {
  /**
   * 追加外部资金收支事实（`external_settlement.U(settlement_key)` 幂等；
   * 充值履约时 IN 向：gross=实付、fee=渠道费（Mock=0）、net=gross-fee；
   * CHECK net=gross-fee 由迁移保证）。
   */
  append(input: {
    providerId: string | null;
    orderId: string | null;
    assetOperationId: string;
    settlementKey: string;
    externalTransactionKey: string;
    flowType: number;
    originalCurrency: string;
    originalAmount: string;
    grossCnyCents: string;
    feeCnyCents: string;
    netCnyCents: string;
    valuationSnapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<{ inserted: boolean; settlement: ExternalSettlementModel }>;
}

// ---------------------------------------------------------------------------
// 身份只读（user 行字段；identity repository 同款口径，首版经 UserModel 直读）
// ---------------------------------------------------------------------------

export interface IdentityUserView {
  id: string;
  status: number;
  username: string | null;
  passwordHash: string | null;
  email: string | null;
  emailVerifiedAt: Date | string | null;
  phone: string | null;
  phoneVerifiedAt: Date | string | null;
}

export interface IdentityReader {
  /** 读 user 行（身份三选一 + status=ACTIVE 门禁；缺失返回 null）。 */
  readUser(userId: string, tx?: Tx): Promise<IdentityUserView | null>;
}

// ---------------------------------------------------------------------------
// 用例共享依赖包（装配注入；与 wallet 模块 ports 同型，避免跨模块
// adapters import——任务硬约定 1 "账本操作全部经 AssetLedger"）
// ---------------------------------------------------------------------------

export interface PaymentsSharedDeps {
  ledger: AssetLedger;
  configReader: ConfigReader;
  turnoverGate: TurnoverGateUseCase;
  systemIdentity: SystemIdentityPort;
  clock: Clock;
  outbox: OutboxPort;
  identity: IdentityReader;
}

/** 链扫描端口（worker 入口；Mock 空实现，adapters/mock-chain-scanner.ts）。 */
export type { ChainScannerPort, ChainDepositCandidate };
