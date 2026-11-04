/**
 * 支付事件处理用例（Mock 回调 + 真实 webhook 共用入口；验收红线"重复回调
 * 只发一次金币"）。
 *
 * 领域所有者：payments 模块（payment_event 去重 + order 两步推进 + 资产分录
 * 履约 + external_settlement + outbox，全部同事务）。
 * 对应 SDD 章节：后端实施 SDD §9 第 3 步（支付与提现；Mock 下单→支付事件→
 * 履约）、§10 红线（资金命令幂等、同事务分录+outbox、失败可重查原结果）、
 * §6.3（所有分录/outbox 同事务）；双资产文档 §3（"经服务端验证的支付通知
 * 必须匹配订单、金额、币种和支付状态；持久化 payment_event 去重，再在受控
 * 事务内发放金币……回调重复或先后乱序均不重复发金币"）、§5（"上线前验证
 * 重复回调只发一次金币"）。
 *
 * 用例语义（单事务，经 AssetLedger + module.withTx 同事务 outbox）：
 * 1. 事件去重（`PaymentEventRepository.claimEvent` U(provider_id,event_key)；
 *    命中既有行 → 静默重放（不产生第二笔分录，§10 红线；INSERT 唯一键捕获
 *    ER_DUP_ENTRY，wallet 同款幂等写法）。
 * 2. 四匹配校验（`matchPaymentEvent` 纯函数：订单状态 CREATED/PAYING 可履约 +
 *    未过期 + 币种匹配 + 金额匹配；不匹配 → 拒绝不履约（event 行 VERIFIED 已
 *    落库但订单不动，无分录，"错额请求拒绝且不产生账本分录"，双资产文档 §5.2）。
 * 3. 履约（`ORDER_FULFILLMENT=5` 操作 + 三分录 + external_settlement + outbox）：
 *    - order 两步推进 CREATED/PAYING → PAID(3) → FULFILLED(4)（`transitionOrder`）；
 *    - asset_operation（ORDER_FULFILLMENT=5，经 ledger.claimOperation 幂等）；
 *    - 三分录（经 ledger.postEntries，锁序 asset_account.id 升序）：
 *      玩家 COI +coins / 系统 COI -coins / 系统 CNY +实付净额
 *      （双资产文档 §2 "充值净现金流入系统（实付减通道费）、用户获币来自系统
 *      库存；系统金币发行余额可为负"，Mock 渠道费=0 净额=实付）；
 *    - external_settlement（IN 向，gross=实付、fee=0、net=实付，U(settlement_key)）；
 *    - outbox(topic 'payments.order.paid') 同事务（§6.3）。
 *
 * 错误码映射（contracts `FundingErrorCode` + `WalletErrorCode` 子集 → 触发）：
 * - `FUNDING_ORDER_NOT_FOUND`：事件 orderId 缺失或订单行不存在。
 * - `FUNDING_ORDER_NOT_PAYABLE`：订单状态不可履约（非 CREATED/PAYING，如已
 *   FULFILLED=4/EXPIRED=5）。
 * - `FUNDING_ORDER_EXPIRED`：订单已过 expires_at（超时不自动发币，双资产文档
 *   §5.2 "订单过期后转为 EXPIRED，不能模拟入账"）。
 * - `FUNDING_ORDER_AMOUNT_MISMATCH`：币种或实付金额与订单请求不符（错额拒绝）。
 * - `FUNDING_IDEMPOTENCY_KEY_REUSED`：同 event_key 命中且内容不一致（防御，
 *   首版重放静默，登记决策点）。
 * - `IDEMPOTENCY_KEY_REUSED` / `WALLET_STORAGE_UNAVAILABLE`（W 码子集）：
 *   账本抢键/乐观冲突（可重试）。
 * - 成功 → 履约结果（订单 FULFILLED；重复回调 = 静默 200，无第二笔，§10）。
 *
 * event_type 取值登记（任务硬约定 6）：contracts 无 CHAIN_DEPOSIT 常量，
 * models/payments.ts `PaymentEventType` 注释值集 CALLBACK=1/QUERY=2/
 * RECONCILIATION=3；本用例 Mock 回调走 CALLBACK=1，链到账走 CHAIN_DEPOSIT=4
 * （首版用 4，constants 未注册，与 model 注释对齐，待 contracts 补，chain-
 * deposit.ts 注释同款登记）。
 */

import { AssetOperationType, AssetType, AccountType } from '../../../infrastructure/database/models/wallet.js';
import { OrderStatus, ExternalFlowType } from '../../../infrastructure/database/models/payments.js';
import { matchPaymentEvent, requestHashOf } from '../domain/rules.js';
import { PaymentDomainError, P } from '../domain/errors.js';
import type {
  OrderRepository,
  PaymentEventRepository,
  ExternalSettlementRepository,
  Tx,
  AssetLedger,
  Clock,
  EntryIntent,
  OutboxPort,
  SystemIdentityPort,
} from '../ports/payments-repository.js';
import { WalletEntryType } from '../../wallet/ports/wallet-repository.js';

export interface PaymentEventInput {
  /** 事件定位（provider + event_key；Mock 回调 paymentEventId 即 event_key）。 */
  providerId: string;
  eventKey: string;
  /** 事件类型（CALLBACK=1 / QUERY=2 / RECONCILIATION=3；链到账 CHAIN_DEPOSIT=4
   * 首版未注册，chain-deposit.ts 用 4，登记 decision point）。 */
  eventType: number;
  /** 事件声明的订单（orderId；缺失 → NOT_FOUND）。 */
  orderId: string | null;
  /** 实付原币金额（CNY 为分；USDT 经订单锁定汇率折算 CNY 分后传入，§3
   * "跨币种实际支付先固定计价汇率版本"）。 */
  paidCnyFen: bigint;
  /** 事件币种（与订单 payment_currency 比对）。 */
  currency: string;
  /** 事件发生时间（UTC）。 */
  occurredAt: Date;
  tx: Tx;
  outbox: OutboxPort;
}

export interface PaymentEventResult {
  /** 是否新履约（false = 重复回调静默重放，§10 红线）。 */
  fulfilled: boolean;
  orderId: string;
  operationId: string | null;
}

export class PaymentEventUseCase {
  constructor(
    private readonly orders: OrderRepository,
    private readonly events: PaymentEventRepository,
    private readonly settlements: ExternalSettlementRepository,
    private readonly ledger: AssetLedger,
    private readonly systemIdentity: SystemIdentityPort,
    private readonly clock: Clock,
  ) {}

  /** 处理支付事件（去重 → 四匹配 → 履约三分录 + settlement + outbox 同事务）。 */
  async handle(input: PaymentEventInput): Promise<PaymentEventResult> {
    const { tx, outbox, providerId, eventKey } = input;

    // 1) 事件去重（U(provider_id,event_key)；命中 = 重复回调静默，§10 红线）。
    const requestHash = requestHashOf({
      providerId,
      eventKey,
      orderId: input.orderId,
      paidCnyFen: input.paidCnyFen.toString(),
      currency: input.currency,
      eventType: input.eventType,
    });
    const claimed = await this.events.claimEvent({
      providerId,
      eventKey,
      eventType: input.eventType,
      verificationResult: 1, // VERIFIED（Mock 回调视为已验证；真实 webhook 验签
      // 失败行经 REJECTED=2 落库不履约，登记决策点）
      requestHash,
      orderId: input.orderId,
      payloadCiphertext: new Uint8Array(), // 首版 Mock 无加密密文（KMS 未闭环，登记）
      occurredAt: input.occurredAt,
      tx,
    });
    if (!claimed.inserted) {
      // 重复回调：静默返回，不产生第二笔分录（§10 "重复回调只发一次金币"）。
      // 安全论证：event 行与 asset_operation 行同事务提交——前次已提交则
      // event 行存在且 3a 步 claim 命中 committed 直接重放（不二次发币）；
      // 前次回滚则 event 行也回滚，不会命中本分支（无独立事务窗口）。
      // 真实 webhook 若引入 event 行独立落库，须重查 order.asset_operation_id
      // 判定已履约，登记 decision point。
      const orderId = input.orderId ?? '';
      return { fulfilled: false, orderId, operationId: null };
    }

    // 2) 定位订单 + 四匹配（锁订单行，防并发履约竞态）。
    if (input.orderId === null) {
      throw new PaymentDomainError(P.FUNDING_ORDER_NOT_FOUND, 'payment event without order');
    }
    const order = await this.orders.lockByPk(input.orderId, tx);

    const match = matchPaymentEvent({
      paidCnyFen: input.paidCnyFen,
      order: {
        requestedAmount: order.requestedAmount,
        paymentCurrency: order.paymentCurrency,
        status: order.status,
        expiresAt: order.expiresAt,
        extra: order.extra ?? null,
      },
      eventCurrency: input.currency,
      now: this.clock.now(),
    });
    if (!match.ok) {
      // 拒绝不履约（event 行已落库 REJECTED 语义由 verificationResult 承载；
      // 订单与账本不动，"错额请求拒绝且不产生账本分录"，双资产文档 §5.2）。
      throw new PaymentDomainError(match.reason, `payment event rejected: ${match.reason}`);
    }

    // 3) 履约（ORDER_FULFILLMENT=5 操作 + 三分录 + settlement + outbox，同事务）。
    const orderKey = order.orderKey;
    const extra = order.extra ?? {};
    const creditCoins = BigInt((extra.creditCoins as string | undefined) ?? '0');
    if (creditCoins <= 0n) {
      throw new PaymentDomainError(P.FUNDING_ORDER_NOT_PAYABLE, 'order fulfillment snapshot missing creditCoins');
    }

    // 3a) 幂等抢键（ORDER_FULFILLMENT=5；命中 committed = 重放原结果）。
    const operationKey = `order_fulfillment:${order.id}`;
    const opHash = requestHashOf({ orderId: order.id, orderKey, creditCoins: creditCoins.toString() });
    const op = await this.ledger.claimOperation({
      operationKey,
      operationType: AssetOperationType.ORDER_FULFILLMENT,
      requestHash: opHash,
      initiatedByUserId: order.userId,
      extra: {
        orderId: order.id,
        orderKey,
        creditCoins: creditCoins.toString(),
        paidCnyFen: input.paidCnyFen.toString(),
        currency: input.currency,
      },
      reason: 'funding order fulfillment',
      tx,
    });
    if (!op.inserted) {
      // 重复履约请求（并发/重放）：重放既有操作结果，不产生第二笔（§10 红线）。
      return { fulfilled: true, orderId: order.id, operationId: op.operation.id };
    }
    const operationId = op.operation.id;

    // 3b) 锁账户（玩家 COI → 系统 COI → 系统 CNY；asset_account.id 升序，§4 锁顺序）。
    const playerCoin = await this.ledger.readAccount(order.userId, AssetType.COIN, AccountType.PLAYER, tx);
    const systemCoin = await this.ledger.readAccount(this.systemIdentity.systemUserId, AssetType.COIN, AccountType.SYSTEM, tx);
    const systemCny = await this.ledger.readAccount(this.systemIdentity.systemUserId, AssetType.CNY_BALANCE, AccountType.SYSTEM, tx);
    if (playerCoin === null || systemCoin === null || systemCny === null) {
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'asset account not provisioned for fulfillment');
    }
    const lockIds = [playerCoin.id, systemCoin.id, systemCny.id]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    await this.ledger.lockAccountsByIds(lockIds, tx);

    // 3c) 三分录（玩家 COI +coins / 系统 COI -coins / 系统 CNY +实付净额；
    // 守恒：玩家侧 +coins，系统侧 -coins +net，外部收支与内部转账边界分开，
    // 双资产文档 §2 "系统金币发行余额可为负"——本处系统 CNY 不可透支，门禁）。
    const intents: EntryIntent[] = [
      {
        accountId: playerCoin.id,
        delta: creditCoins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `funding order fulfillment: +${creditCoins} coins (order ${orderKey})`,
      },
      {
        accountId: systemCoin.id,
        delta: -creditCoins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `funding order fulfillment: -${creditCoins} coins to user ${order.userId} (system issuance, may go negative)`,
      },
      {
        accountId: systemCny.id,
        delta: input.paidCnyFen,
        frozenDelta: 0n,
        entryType: WalletEntryType.EXTERNAL, // 外部资金进入系统 CNY（EXTERNAL=2，
        // models/wallet.ts EntryType；外部收支与内部转账守恒边界分开，双资产文档 §2）
        memo: `funding order net cash in: +${input.paidCnyFen} fen (order ${orderKey}, mock channel fee 0)`,
      },
    ];
    await this.ledger.postEntries(operationId, intents, tx);

    // 3d) external_settlement（IN 向；Mock 渠道费 0，net=gross，CHECK 约束满足）。
    const settlementKey = `settlement:in:${order.id}:${eventKey}`;
    await this.settlements.append({
      providerId,
      orderId: order.id,
      assetOperationId: operationId,
      settlementKey,
      externalTransactionKey: eventKey,
      flowType: ExternalFlowType.IN,
      originalCurrency: input.currency,
      originalAmount: input.paidCnyFen.toString(),
      grossCnyCents: input.paidCnyFen.toString(),
      feeCnyCents: '0',
      netCnyCents: input.paidCnyFen.toString(),
      valuationSnapshot: {
        source: 'mock',
        paidCnyFen: input.paidCnyFen.toString(),
        feeCnyFen: '0',
        currency: input.currency,
      },
      tx,
    });

    // 3e) order 两步推进 CREATED/PAYING → PAID(3) → FULFILLED(4)（同事务）。
    const paidAt = this.clock.now();
    await this.orders.transitionOrder({
      orderId: order.id,
      toStatus: OrderStatus.PAID,
      paidAt,
      actualAmount: input.paidCnyFen.toString(),
      actualCnyCents: input.paidCnyFen.toString(),
      tx,
    });
    await this.orders.transitionOrder({
      orderId: order.id,
      toStatus: OrderStatus.FULFILLED,
      fulfilledAt: this.clock.now(),
      assetOperationId: operationId,
      tx,
    });

    // 3f) 快照回填 + outbox 同事务（§6.3 "所有分录/outbox 同事务"）。
    await this.ledger.setCommitted(
      operationId,
      this.clock.now(),
      {
        orderId: order.id,
        orderKey,
        creditCoins: creditCoins.toString(),
        paidCnyFen: input.paidCnyFen.toString(),
      },
      tx,
    );
    await outbox.append({
      topic: 'payments.order.paid',
      userId: order.userId,
      assetOperationId: operationId,
      payload: {
        orderId: order.id,
        orderKey,
        creditCoins: creditCoins.toString(),
        paidCnyFen: input.paidCnyFen.toString(),
        currency: input.currency,
      },
    });

    return { fulfilled: true, orderId: order.id, operationId };
  }
}
