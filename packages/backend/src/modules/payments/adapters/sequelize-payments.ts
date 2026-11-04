import type { Transaction } from 'sequelize';
import type {
  PaymentProviderModel,
  PaymentChannelModel,
  OrderModel,
  PaymentEventModel,
  ExternalSettlementModel,
  PayoutAccountModel,
  WithdrawalModel,
} from '../../../infrastructure/database/models/payments.js';
import type { UserModel as IdentityUserModel } from '../../../infrastructure/database/models/identity.js';
import {
  RecordStatus as PaymentsRecordStatus,
  ActiveStatus,
  ExternalFlowType,
  PaymentVerificationResult,
} from '../../../infrastructure/database/models/payments.js';
import type {
  OrderRepository,
  ChannelRepository,
  PayoutAccountRepository,
  WithdrawalRepository,
  PaymentEventRepository,
  ExternalSettlementRepository,
  IdentityReader,
  Tx,
} from '../ports/payments-repository.js';
import { PaymentDomainError, P, isDuplicateKeyError } from '../domain/errors.js';
import { isWithdrawalTransitionAllowed } from '../domain/rules.js';

/** 取事务（Sequelize Transaction 鸭子类型；无 tx = 测试/无事务直连，
 * 返回 `Transaction | null` 与 wallet 适配器同款约定）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

export interface PaymentsModelSet {
  PaymentProviderModel: typeof PaymentProviderModel;
  PaymentChannelModel: typeof PaymentChannelModel;
  OrderModel: typeof OrderModel;
  PaymentEventModel: typeof PaymentEventModel;
  ExternalSettlementModel: typeof ExternalSettlementModel;
  PayoutAccountModel: typeof PayoutAccountModel;
  WithdrawalModel: typeof WithdrawalModel;
  UserModel: typeof IdentityUserModel;
}

// ChannelRepository 的视图映射（PaymentChannelModel + paymentProvider include →
// ChannelView；拆独立函数保持文件单一职责，与 wallet 适配器逐段注释风格一致）。
type ChannelRowView = PaymentChannelModel & {
  paymentProvider?: { providerType?: number; name?: string; status?: number };
};

function channelRowToView(row: ChannelRowView) {
  const provider = row.paymentProvider;
  return {
    id: row.id,
    channelCode: row.channelCode,
    methodType: row.methodType,
    priority: row.priority,
    displayName: provider?.name ?? row.channelCode,
    providerType: provider?.providerType ?? 1,
  };
}

// ---------------------------------------------------------------------------
// order（保留字表：Sequelize 自动加反引号；raw SQL 须手工加，A.12 第 7 条）
// ---------------------------------------------------------------------------

export class SequelizeOrderRepository implements OrderRepository {
  constructor(private readonly models: PaymentsModelSet) {}

  async createOrder(input: {
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
  }): Promise<{ inserted: boolean; order: OrderModel }> {
    const txq = txOf(input.tx);
    try {
      const order = await this.models.OrderModel.create(
        {
          userId: input.userId,
          productId: '', // 首版无 product seed（登记"需补 seed 迁移"）：Mock 渠道
          // 商品语义经 extra JSON fulfillmentSpec 快照承载，product 目录落地后
          // 回填真值（decision point，assembly.ts 头注释同款登记）。
          paymentChannelId: input.paymentChannelId,
          orderKey: input.orderKey,
          providerOrderKey: input.providerOrderKey,
          paymentCurrency: input.paymentCurrency,
          requestedAmount: input.requestedAmount,
          actualAmount: null,
          actualCnyCents: null,
          extra: input.extra,
          assetOperationId: null,
          expiresAt: input.expiresAt,
          paidAt: null,
          fulfilledAt: null,
          status: 1, // OrderStatus.CREATED
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, order };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(order_key) 命中：同键重放（用例据汇率/金币快照复核一致性，
        // 不一致抛 FUNDING_IDEMPOTENCY_KEY_REUSED——本处返回既有行，
        // 由用例 `createOrder` 捕获判定，wallet claimOperation 同款语义）。
        const existing = await this.models.OrderModel.findOne({
          where: { orderKey: input.orderKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'order_key conflict without row');
        }
        return { inserted: false, order: existing };
      }
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'order create failed');
    }
  }

  async findByOrderKey(orderKey: string, tx?: Tx): Promise<OrderModel | null> {
    return await this.models.OrderModel.findOne({ where: { orderKey }, transaction: txOf(tx) });
  }

  async listByUser(userId: string, limit = 50, tx?: Tx) {
    const rows = await this.models.OrderModel.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      limit,
      transaction: txOf(tx),
    });
    return rows.map((r) => this.toView(r));
  }

  async lockByPk(orderId: string, tx: Tx): Promise<OrderModel> {
    const row = await this.models.OrderModel.findByPk(orderId, {
      lock: 'FOR UPDATE',
      transaction: txOf(tx),
    } as never);
    if (row === null) {
      throw new PaymentDomainError(P.FUNDING_ORDER_NOT_FOUND, `order not found: ${orderId}`);
    }
    return row;
  }

  async transitionOrder(input: {
    orderId: string;
    toStatus: number;
    paidAt?: Date | null;
    fulfilledAt?: Date | null;
    actualAmount?: string | null;
    actualCnyCents?: string | null;
    assetOperationId?: string | null;
    extra?: Record<string, unknown> | null;
    tx: Tx;
  }): Promise<OrderModel> {
    const row = await this.lockByPk(input.orderId, input.tx);
    const patch: Record<string, unknown> = { status: input.toStatus };
    if (input.paidAt !== undefined) patch.paidAt = input.paidAt;
    if (input.fulfilledAt !== undefined) patch.fulfilledAt = input.fulfilledAt;
    if (input.actualAmount !== undefined) patch.actualAmount = input.actualAmount;
    if (input.actualCnyCents !== undefined) patch.actualCnyCents = input.actualCnyCents;
    if (input.assetOperationId !== undefined) patch.assetOperationId = input.assetOperationId;
    if (input.extra !== undefined) patch.extra = input.extra;
    await row.update(patch as never, { transaction: txOf(input.tx) } as never);
    return row;
  }

  private toView(row: OrderModel) {
    return {
      id: row.id,
      userId: row.userId,
      paymentChannelId: row.paymentChannelId,
      orderKey: row.orderKey,
      paymentCurrency: row.paymentCurrency,
      requestedAmount: row.requestedAmount,
      actualAmount: row.actualAmount,
      actualCnyCents: row.actualCnyCents,
      status: row.status,
      extra: row.extra ?? null,
      assetOperationId: row.assetOperationId,
      expiresAt: row.expiresAt,
      paidAt: row.paidAt,
      fulfilledAt: row.fulfilledAt,
      createdAt: row.createdAt,
    };
  }
}

// ---------------------------------------------------------------------------
// 渠道（payment_channel + payment_provider include；listEnabledChannelsByMethod）
// ---------------------------------------------------------------------------

export class SequelizeChannelRepository implements ChannelRepository {
  constructor(private readonly models: PaymentsModelSet) {}

  async listEnabledChannelsByMethod(methodType?: number) {
    const where: Record<string, unknown> = { status: ActiveStatus.ACTIVE };
    if (methodType !== undefined) where.methodType = methodType;
    const rows = await this.models.PaymentChannelModel.findAll({
      where,
      include: [
        {
          model: this.models.PaymentProviderModel,
          as: 'paymentProvider',
          required: true,
          where: { status: ActiveStatus.ACTIVE },
          attributes: ['id', 'providerType', 'name'],
        },
      ],
      order: [
        ['priority', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    return rows.map((r) => channelRowToView(r as ChannelRowView));
  }

  async findEnabledById(channelId: string) {
    const row = (await this.models.PaymentChannelModel.findByPk(channelId, {
      include: [
        {
          model: this.models.PaymentProviderModel,
          as: 'paymentProvider',
          required: true,
          attributes: ['id', 'providerType', 'name', 'status'],
        },
      ],
    })) as ChannelRowView | null;
    if (row === null || row.status !== ActiveStatus.ACTIVE) return null;
    if (
      row.paymentProvider !== undefined &&
      row.paymentProvider.status !== undefined &&
      row.paymentProvider.status !== ActiveStatus.ACTIVE
    ) {
      return null;
    }
    return channelRowToView(row);
  }
}

// ---------------------------------------------------------------------------
// 收款账户（payout_account；create 幂等去重 + 软删）
// ---------------------------------------------------------------------------

export class SequelizePayoutAccountRepository implements PayoutAccountRepository {
  constructor(private readonly models: PaymentsModelSet) {}

  async listByUser(userId: string) {
    return await this.models.PayoutAccountModel.findAll({
      where: { userId, status: ActiveStatus.ACTIVE },
      order: [['version', 'DESC']],
    });
  }

  async create(input: {
    userId: string;
    accountKey: string;
    methodType: number;
    accountCiphertext: Uint8Array;
    lookupHash: Uint8Array;
    maskedLabel: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; account: PayoutAccountModel }> {
    // 幂等去重：同 user 同 lookup_hash 已有有效版本 → 返回既有行（资料相同
    // 不重复建版本，§4 "提现固定所选账户版本"；U(user_id, lookup_hash, version)
    // 由迁移管理，本处先查后建 + ER_DUP_ENTRY 兜底）。
    const existing = await this.lookupHash(input.userId, input.lookupHash, input.tx);
    if (existing !== null) {
      // 既有有效版本：重放静默成功（version 不变，处理中出款目标不受影响）。
      return { inserted: false, account: existing };
    }
    try {
      const account = await this.models.PayoutAccountModel.create(
        {
          userId: input.userId,
          accountKey: input.accountKey, // CHAR(36) 稳定定位值（用例层经 crypto.randomUUID 生成）
          methodType: input.methodType,
          accountCiphertext: input.accountCiphertext,
          lookupHash: input.lookupHash,
          maskedLabel: input.maskedLabel,
          version: '1', // 首版固定 1（资料变化新增版本，§4 "不覆盖处理中出款目标"）
          status: ActiveStatus.ACTIVE,
        } as never,
        { transaction: txOf(input.tx) } as never,
      );
      return { inserted: true, account };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const hit = await this.lookupHash(input.userId, input.lookupHash, input.tx);
        if (hit !== null) return { inserted: false, account: hit };
      }
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'payout account create failed');
    }
  }

  async lockByPk(accountId: string, tx: Tx): Promise<PayoutAccountModel> {
    const row = await this.models.PayoutAccountModel.findByPk(accountId, {
      lock: 'FOR UPDATE',
      transaction: txOf(tx),
    } as never);
    if (row === null || row.status !== ActiveStatus.ACTIVE) {
      throw new PaymentDomainError(P.PAYOUT_ACCOUNT_NOT_FOUND, `payout account not found: ${accountId}`);
    }
    return row;
  }

  async lookupHash(userId: string, lookupHash: Uint8Array, tx: Tx): Promise<PayoutAccountModel | null> {
    return await this.models.PayoutAccountModel.findOne({
      where: { userId, lookupHash, status: ActiveStatus.ACTIVE },
      order: [['version', 'DESC']],
      transaction: txOf(tx),
    });
  }

  async softDelete(accountId: string, userId: string, tx: Tx): Promise<number> {
    const [affected] = await this.models.PayoutAccountModel.update(
      { status: ActiveStatus.RETIRED } as never,
      {
        where: { id: accountId, userId, status: ActiveStatus.ACTIVE },
        transaction: txOf(tx),
      } as never,
    );
    // 软删语义（§4 "提现固定所选账户版本，处理中修改账户不更改当前出款目标"）：
    // 置 RETIRED=3 而非物理删除；withdrawal 已固定 payout_account.id 版本行，
    // 不受后续软删影响（decision point：deleted_at 双标记，迁移 CHECK 约束）。
    return affected;
  }
}

// ---------------------------------------------------------------------------
// 提现（withdrawal；状态机经 domain/rules.ts 校验）
// ---------------------------------------------------------------------------

export class SequelizeWithdrawalRepository implements WithdrawalRepository {
  constructor(private readonly models: PaymentsModelSet) {}

  async createWithdrawal(input: {
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
  }): Promise<{ inserted: boolean; withdrawal: WithdrawalModel }> {
    const txq = txOf(input.tx);
    try {
      const withdrawal = await this.models.WithdrawalModel.create(
        {
          userId: input.userId,
          payoutAccountId: input.payoutAccountId,
          assetOperationId: input.assetOperationId,
          assetHoldId: input.assetHoldId,
          withdrawalKey: input.withdrawalKey,
          cashCents: input.cashCents,
          feeCents: input.feeCents,
          coinEquivalent: input.coinEquivalent,
          minimumCoins: input.minimumCoins,
          policySnapshot: input.policySnapshot,
          payoutNotBeforeAt: input.payoutNotBeforeAt,
          approvalKey: null,
          approvedAt: null,
          completedAt: null,
          failureReason: null,
          status: 1, // WithdrawalStatus.REQUESTED
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, withdrawal };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(withdrawal_key) 命中：同键重放（占款与 withdrawal 已成立，
        // 不产生第二笔，§10 红线；用例据快照复核一致性）。
        const existing = await this.models.WithdrawalModel.findOne({
          where: { withdrawalKey: input.withdrawalKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'withdrawal_key conflict without row');
        }
        return { inserted: false, withdrawal: existing };
      }
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'withdrawal create failed');
    }
  }

  async lockByPk(withdrawalId: string, tx: Tx): Promise<WithdrawalModel> {
    const row = await this.models.WithdrawalModel.findByPk(withdrawalId, {
      lock: 'FOR UPDATE',
      transaction: txOf(tx),
    } as never);
    if (row === null) {
      throw new PaymentDomainError(P.WITHDRAWAL_NOT_FOUND, `withdrawal not found: ${withdrawalId}`);
    }
    return row;
  }

  async transition(input: {
    withdrawalId: string;
    fromStatus: number;
    toStatus: number;
    failureReason?: string | null;
    tx: Tx;
  }): Promise<{ withdrawal: WithdrawalModel; releasesHold: boolean }> {
    const row = await this.lockByPk(input.withdrawalId, input.tx);
    // 状态机校验（domain/rules.ts 转换表；非法 → WITHDRAWAL_NOT_CANCELLABLE）。
    if (
      !isWithdrawalTransitionAllowed(
        input.fromStatus as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
        input.toStatus as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
      )
    ) {
      throw new PaymentDomainError(P.WITHDRAWAL_NOT_CANCELLABLE, `illegal withdrawal transition ${input.fromStatus} -> ${input.toStatus}`);
    }
    if (row.status !== input.fromStatus) {
      // 行锁读到的实际状态与调用方声明不符（并发推进）→ 拒绝，防错账。
      throw new PaymentDomainError(
        P.WITHDRAWAL_NOT_CANCELLABLE,
        `withdrawal status drifted: expected ${input.fromStatus}, found ${row.status}`,
      );
    }
    const releasesHold = input.toStatus === 7 || input.toStatus === 9;
    const patch: Record<string, unknown> = { status: input.toStatus };
    if (input.failureReason !== undefined) patch.failureReason = input.failureReason;
    if (input.toStatus === 5 || input.toStatus === 6 || input.toStatus === 7 || input.toStatus === 9) {
      patch.completedAt = new Date();
    }
    await row.update(patch as never, { transaction: txOf(input.tx) } as never);
    return { withdrawal: row, releasesHold };
  }

  async listByUser(userId: string, limit = 50) {
    return await this.models.WithdrawalModel.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      limit,
    });
  }
}

// ---------------------------------------------------------------------------
// 支付事件（payment_event，不可变；claimEvent 幂等去重）
// ---------------------------------------------------------------------------

export class SequelizePaymentEventRepository implements PaymentEventRepository {
  constructor(private readonly models: PaymentsModelSet) {}

  async claimEvent(input: {
    providerId: string;
    eventKey: string;
    eventType: number;
    verificationResult: number;
    requestHash: Uint8Array;
    orderId: string | null;
    payloadCiphertext: Uint8Array;
    occurredAt: Date;
    tx: Tx;
  }): Promise<{ inserted: boolean; event: PaymentEventModel }> {
    const txq = txOf(input.tx);
    try {
      const event = await this.models.PaymentEventModel.create(
        {
          paymentProviderId: input.providerId,
          orderId: input.orderId,
          payoutAttemptId: null,
          coinMarketTradeId: null,
          eventKey: input.eventKey,
          eventType: input.eventType,
          verificationResult: input.verificationResult === undefined ? PaymentVerificationResult.VERIFIED : input.verificationResult,
          payloadHash: input.requestHash,
          payloadCiphertext: input.payloadCiphertext,
          occurredAt: input.occurredAt,
          receivedAt: new Date(),
          status: PaymentsRecordStatus.RECORDED,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, event };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(payment_provider_id, event_key) 命中 → 重复回调静默重放
        // （验收红线"重复回调只发一次金币"，§10；不产生第二笔分录）。
        const existing = await this.models.PaymentEventModel.findOne({
          where: { paymentProviderId: input.providerId, eventKey: input.eventKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'payment_event conflict without row');
        }
        return { inserted: false, event: existing };
      }
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'payment_event claim failed');
    }
  }
}

// ---------------------------------------------------------------------------
// 外部结算（external_settlement，不可变；settlement_key 幂等）
// ---------------------------------------------------------------------------

export class SequelizeExternalSettlementRepository implements ExternalSettlementRepository {
  constructor(private readonly models: PaymentsModelSet) {}

  async append(input: {
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
  }): Promise<{ inserted: boolean; settlement: ExternalSettlementModel }> {
    const txq = txOf(input.tx);
    try {
      const settlement = await this.models.ExternalSettlementModel.create(
        {
          paymentProviderId: input.providerId,
          orderId: input.orderId,
          payoutAttemptId: null,
          coinMarketTradeId: null,
          relatedExternalSettlementId: null,
          assetOperationId: input.assetOperationId,
          settlementKey: input.settlementKey,
          externalTransactionKey: input.externalTransactionKey,
          flowType: input.flowType === undefined ? ExternalFlowType.IN : input.flowType,
          originalCurrency: input.originalCurrency,
          originalAmount: input.originalAmount,
          grossCnyCents: input.grossCnyCents,
          feeCnyCents: input.feeCnyCents,
          netCnyCents: input.netCnyCents,
          valuationSnapshot: input.valuationSnapshot,
          settledAt: null,
          status: 1, // ExternalStatus.OPEN
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, settlement };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(settlement_key) 命中 → 重放静默（同一外部资金事实不二次记录，§10）。
        const existing = await this.models.ExternalSettlementModel.findOne({
          where: { settlementKey: input.settlementKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'settlement_key conflict without row');
        }
        return { inserted: false, settlement: existing };
      }
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'external_settlement append failed');
    }
  }
}

// ---------------------------------------------------------------------------
// 身份只读（user 行字段；首版经 UserModel 直读，identity repository 同款口径）
// ---------------------------------------------------------------------------

export class SequelizeIdentityReader implements IdentityReader {
  constructor(private readonly models: PaymentsModelSet) {}

  async readUser(userId: string, tx?: Tx) {
    const row = await this.models.UserModel.findByPk(userId, { transaction: txOf(tx) });
    if (row === null) return null;
    return {
      id: row.id,
      status: row.status,
      username: row.username,
      passwordHash: row.passwordHash,
      email: row.email,
      emailVerifiedAt: row.emailVerifiedAt,
      phone: row.phone,
      phoneVerifiedAt: row.phoneVerifiedAt,
    };
  }
}
