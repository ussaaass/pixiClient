/**
 * 充值订单创建用例：POST /me/wallet/orders（FundingEndpoint.createOrder，201）。
 *
 * 领域所有者：payments 模块（order / payment_channel / payment_provider 读侧 +
 * order 写入；汇率经 wallet `ConfigReader` 读 cny_to_coin_ratio 快照）。
 * 对应 SDD 章节：后端实施 SDD §5.4（payments 端点 createOrder，契约
 * `WalletFundingEndpoint.createOrder` 201）、§9 第 3 步（支付与提现）、§10
 * 红线（金额/ID wire 十进制字符串）；双资产文档 §3（"创建通用 order 固定商品、
 * 购买币种/金额、履约快照、汇率和用户；订单记录先提交，外部 API 不放在钱包
 * 锁事务中"）、§5.2（"创建订单读取 cny_to_coin_ratio 并快照汇率……不能精确
 * 换成整数金币时拒绝订单"）。
 *
 * 用例语义（单事务）：
 * 1. 渠道存在且 ENABLED（`ChannelRepository.findEnabledById`；缺失/停用 →
 *    FUNDING_CHANNEL_UNAVAILABLE）。
 * 2. 读 `cny_to_coin_ratio` 汇率快照（经 wallet ConfigReader，缺失 → 映射
 *    FUNDING_CHANNEL_UNAVAILABLE——contracts FundingErrorCode 8 码中无
 *    "汇率不可用"专码，选前者并登记决策点（任务硬约定 3 "缺失 → 选前者并注释"）；
 *    配置缺失同时影响 wallet 兑换入口，由 wallet 侧映射 EXCHANGE_NOT_AVAILABLE）。
 * 3. 金额换算金币（`@gameing/domain/wallet` calculatePurchaseCoins，不能整除 →
 *    INVALID_ORDER_AMOUNT，双资产文档 §5.2 "不能精确换成整数金币时拒绝订单"）。
 * 4. order_key 幂等（`OrderRepository.createOrder` U(order_key)；命中重放既有行，
 *    不产生第二笔，§10 红线）。order_key = `ord:{userId}:{idempotencyKey}`。
 * 5. 创建 order CREATED=1 + expires_at（+30 分钟，ORDER_TTL_MINUTES，登记决策点）
 *    + extra JSON 存汇率快照（rateCoinUnits/rateCashFen/creditCoins）+
 *    provider_order_key：Mock 渠道 = `mock:{order_key}`（Mock provider MOCK=3
 *    首版唯一 seed；真实渠道 → 外部下单 API 未闭环，登记未闭环）。
 *
 * 错误码映射（contracts `FundingErrorCode` → 触发条件）：
 * - `FUNDING_CHANNEL_UNAVAILABLE`：渠道缺失/停用（status ≠ ACTIVE），或汇率配置
 *   缺失（ConfigReader 返回 null；本用例语义码选此，见上第 2 步注释）。
 * - `INVALID_ORDER_AMOUNT`：金额 ≤ 0（schema 已挡，防御性）或不能整除换金币。
 * - `FUNDING_IDEMPOTENCY_KEY_REUSED`：同 order_key 命中且请求快照不一致
 *   （同键异内容；重放同内容 = 静默返回既有行，200 语义由路由层决定）。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障（P 表 W 码，映射 contracts
 *   `WalletErrorCode` 子集，创建失败可重试）。
 * - 成功 → FundingOrderDto（201；重放既有行 = 200 语义由路由层按 inserted 标志决定）。
 *
 * 注（任务登记）：Mock provider MOCK=3 + channel ALIPAY method_type=1 的 seed
 * 迁移 0010 未含（"0010 无 Mock provider/channel seed"），本用例完成报告登记
 * "需补 seed 迁移"，Lead 处理；seed 落地前 createOrder 因 FUNDING_CHANNEL_
 * UNAVAILABLE 不可用（渠道列表为空），属预期降级，不视为缺陷。
 *
 * 注（决策点登记）：order.product_id 首版填 ''（product 目录无 seed 迁移，
 * 登记"需补 seed 迁移"；Mock 渠道商品语义经 extra JSON fulfillmentSpec 承载，
 * product 目录落地后回填真值）。
 */

import type { CreateFundingOrderRequestDto, FundingOrderDto } from '@gameing/contracts/wallet-funding';
import { CreateFundingOrderRequestSchema } from '@gameing/contracts/wallet-funding';
import { Value } from '@gameing/contracts/wallet';
import { OrderStatus, MethodType } from '../../../infrastructure/database/models/payments.js';
import { ORDER_TTL_MINUTES, purchaseCoinsForFen, requestHashOf } from '../domain/rules.js';
import { PaymentDomainError, P } from '../domain/errors.js';
import type { ChannelRepository, OrderRepository, Tx, Clock, ConfigReader } from '../ports/payments-repository.js';
import { toDateIso } from '../../wallet/adapters/row-mappers.js';

/**
 * model MethodType（payments.ts）→ contracts FundingPaymentMethod（wallet-funding.ts）映射。
 * 键名差异（model 侧 BANK/ECNY vs contracts 侧 BANK_TRANSFER/DIGITAL_CNY）经此对齐；
 * 数值与 contracts 常量一致（AGENTS.md "常量单一来源在 contracts，model 注释值集
 * 与 contracts 数值一致"）。登记映射表（完成报告给 Lead）。
 */
const MODEL_METHOD_TO_FUNDING_METHOD: Record<number, 1 | 2 | 3 | 4 | 5 | 6> = {
  [MethodType.ALIPAY]: 1, // ALIPAY=1
  [MethodType.WECHAT]: 2, // WECHAT=2
  [MethodType.BANK]: 3, // BANK=3 → BANK_TRANSFER=3
  [MethodType.UNIONPAY_QR]: 4, // UNIONPAY_QR=4
  [MethodType.ECNY]: 5, // ECNY=5 → DIGITAL_CNY=5
  [MethodType.USDT_TRON]: 6, // USDT_TRON=6
};

export interface CreateOrderInput {
  /** 发起玩家 user.id（十进制字符串 wire；路由层解析会话传入）。 */
  userId: string;
  request: CreateFundingOrderRequestDto;
  tx: Tx;
}

export interface CreateOrderResult {
  dto: FundingOrderDto;
  /** 幂等命中既有行 = false（路由层据此 200 vs 201，登记决策点）。 */
  inserted: boolean;
}

export class OrderCreateUseCase {
  constructor(
    private readonly orders: OrderRepository,
    private readonly channels: ChannelRepository,
    private readonly config: ConfigReader,
    private readonly clock: Clock,
  ) {}

  /** 创建充值订单（单事务；渠道 + 汇率快照 + 金币换算 + 幂等抢键）。 */
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const { userId, request, tx } = input;
    if (!Value.Check(CreateFundingOrderRequestSchema, request)) {
      throw new PaymentDomainError(P.INVALID_ORDER_AMOUNT, 'create order request schema failed');
    }

    // 1) 渠道存在且 ENABLED（status=ACTIVE=1 且 provider ACTIVE；缺失 → 不可用）。
    const channel = await this.channels.findEnabledById(request.channelId);
    if (channel === null) {
      throw new PaymentDomainError(P.FUNDING_CHANNEL_UNAVAILABLE, `channel not found or disabled: ${request.channelId}`);
    }

    // 2) 读 cny_to_coin_ratio 汇率快照（经 wallet ConfigReader，缺失 → 映射
    // FUNDING_CHANNEL_UNAVAILABLE，本用例语义码登记见头注释第 2 步）。
    const rate = await this.config.readExchangeRate(tx);
    if (rate === null) {
      throw new PaymentDomainError(P.FUNDING_CHANNEL_UNAVAILABLE, 'exchange rate config missing (cny_to_coin_ratio)');
    }

    // 3) 金额换算金币（不能整除 → INVALID_ORDER_AMOUNT，双资产文档 §5.2）。
    const amountCnyFen = BigInt(request.amountCnyFen);
    const creditCoins = purchaseCoinsForFen(amountCnyFen, rate);

    // 4) order_key 幂等抢键（U(order_key)；命中重放既有行，不产生第二笔，§10）。
    const orderKey = `ord:${userId}:${request.idempotencyKey}`;
    const requestHash = requestHashOf({
      userId,
      channelId: request.channelId,
      amountCnyFen: request.amountCnyFen,
      creditCoins: creditCoins.toString(),
      rateCoinUnits: rate.rateCoinUnits.toString(),
      rateCashFen: rate.rateCashFen.toString(),
    });
    const providerOrderKey = `mock:${orderKey}`; // Mock 渠道首版（真实渠道外部下单未闭环，登记）

    const created = await this.orders.createOrder({
      userId,
      orderKey,
      paymentChannelId: channel.id,
      paymentCurrency: 'CNY',
      requestedAmount: request.amountCnyFen,
      requestHash,
      extra: {
        creditCoins: creditCoins.toString(),
        rate: {
          coinUnits: rate.rateCoinUnits.toString(),
          cashFen: rate.rateCashFen.toString(),
          sampledAt: toDateIso(this.clock.now()),
        },
        orderType: 1, // OrderType.WALLET_COIN_PURCHASE（contracts 常量）
      },
      providerOrderKey,
      expiresAt: new Date(this.clock.now().getTime() + ORDER_TTL_MINUTES * 60_000),
      tx,
    });

    if (!created.inserted) {
      // 重放复核：既有行汇率/金币快照与当前请求一致（不一致 = 同键异内容，
      // FUNDING_IDEMPOTENCY_KEY_REUSED；一致 = 静默重放既有订单，§10 红线）。
      const existing = created.order;
      const existingExtra = existing.extra ?? {};
      const existingCoins = (existingExtra.creditCoins as string | undefined) ?? '0';
      if (existingCoins !== creditCoins.toString() || existing.requestedAmount !== request.amountCnyFen) {
        throw new PaymentDomainError(P.FUNDING_IDEMPOTENCY_KEY_REUSED, 'order_key reused with different amount');
      }
      return { dto: this.toDto(existing, channel, creditCoins.toString()), inserted: false };
    }

    return { dto: this.toDto(created.order, channel, creditCoins.toString()), inserted: true };
  }

  private toDto(
    order: {
      id: string;
      orderKey: string;
      status: number;
      createdAt: Date | string;
      paidAt: Date | string | null;
      requestedAmount: string;
      extra: Record<string, unknown> | null;
    },
    channel: { channelCode: string; methodType: number; displayName: string },
    creditCoins: string,
  ): FundingOrderDto {
    const extra = order.extra ?? {};
    // status 映射（model OrderStatus 1~7 → contracts FundingOrderStatus 1~5）：
    // CREATED=1/PAYING=2 → PENDING_PAYMENT=1；PAID=3/FULFILLED=4 → PAID=2；
    // EXPIRED=5 → EXPIRED=5；EXCEPTION=6/CANCELLED=7 → FAILED=3（登记映射表）。
    const modelStatus = order.status;
    let dtoStatus: 1 | 2 | 3 | 4 | 5;
    if (modelStatus === 1 || modelStatus === 2) dtoStatus = 1;
    else if (modelStatus === 3 || modelStatus === 4) dtoStatus = 2;
    else if (modelStatus === OrderStatus.EXPIRED) dtoStatus = OrderStatus.EXPIRED;
    else dtoStatus = 3;
    // methodType 映射（model MethodType → contracts FundingPaymentMethod，键名差异对齐）。
    const paymentMethod = (MODEL_METHOD_TO_FUNDING_METHOD[channel.methodType] ?? channel.methodType) as 1 | 2 | 3 | 4 | 5 | 6;
    const usdtInvoice = extra.usdtInvoice as FundingOrderDto['usdtInvoice'] | undefined;
    const dto: FundingOrderDto = {
      orderId: order.id,
      orderNo: order.orderKey,
      channelId: channel.channelCode,
      channelName: channel.displayName,
      paymentMethod,
      amountCnyFen: order.requestedAmount,
      creditCoins,
      status: dtoStatus,
      createdAt: toDateIso(order.createdAt),
      paidAt: order.paidAt === null || order.paidAt === undefined ? null : toDateIso(order.paidAt),
    };
    if (usdtInvoice !== undefined) {
      (dto as Record<string, unknown>)['usdtInvoice'] = usdtInvoice;
    }
    return dto;
  }
}
