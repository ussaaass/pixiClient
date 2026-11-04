/**
 * payments 实体专属不变量（纯函数，无 IO）：订单过期判定、支付事件匹配校验、
 * 提现状态机转换表、提现报价/金额门禁。
 *
 * 领域所有者：payments 模块（domain 包 `@gameing/domain/wallet` 通用纯函数
 * 之外的 payments 专属规则；依赖 contracts，无 IO）。
 * 对应 SDD 章节：后端实施 SDD §9 第 3 步（支付与提现）、§10 红线（重复回调
 * 只发一次金币）；双资产文档 §3（"支付通知必须匹配订单、金额、币种和支付
 * 状态"）、§4（提现九态状态机：1→2→3→4→5；1/2→7 释放占款；6/9 释放占款；
 * 8 保持占款）、§5（1000 枚整数倍门槛、5% 费率向上取整到分、72 小时出款
 * 等待）。
 *
 * 约定：
 * - 金额全链路 BigInt（金币枚 / CNY 分）；本文件不产生 wire 字符串；
 * - 通用纯函数（calculatePurchaseCoins / createWithdrawalQuote /
 *   withdrawalQuoteMatches / calculateWithdrawalFee）直接 import
 *   `@gameing/domain/wallet`，不在 backend 重写（任务硬约定）；
 * - withdrawal 状态机转换表为九态全量登记（§4），adapter `transition`
 *   校验时查表，非法转换 → 用例映射 WITHDRAWAL_NOT_CANCELLABLE 或
 *   WALLET_STORAGE_UNAVAILABLE（语义见 withdrawal-cancel / withdrawal 用例
 *   头注释）。
 */

import { FundingErrorCode } from '@gameing/contracts/wallet-funding';
import {
  DEFAULT_MINIMUM_WITHDRAWAL_COINS,
  DEFAULT_WITHDRAWAL_FEE_BPS,
  calculatePurchaseCoins,
  calculateWithdrawalFee,
} from '@gameing/domain/wallet';
import type { ExchangeRate } from '../../wallet/ports/wallet-repository.js';
import { OrderStatus, WithdrawalStatus } from '../../../infrastructure/database/models/payments.js';
import { PaymentDomainError, P } from './errors.js';

// ---------------------------------------------------------------------------
// 订单常量（§4 "常量 0 不占位"）
// ---------------------------------------------------------------------------

/**
 * 订单过期时长（双资产文档 §5.2 默认窗口 15 分钟为 USDT 尾数窗口，
 * 通用订单 30 分钟为 Mock 渠道登记值；真实渠道以渠道对账超时为准，
 * 决策点登记在 assembly.ts）。
 */
export const ORDER_TTL_MINUTES = 30;

/** 订单过期判定时刻（订单过期后进入 EXPIRED=5，模拟支付入口拒绝）。 */
export function isOrderExpired(expiresAt: Date | string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

/** 订单是否可进入支付/履约（CREATED=1 / PAYING=2 态可履约；其余拒绝）。 */
export function isOrderPayable(status: number): boolean {
  return status === OrderStatus.CREATED || status === OrderStatus.PAYING;
}

// ---------------------------------------------------------------------------
// 支付事件匹配校验（双资产文档 §3 "必须匹配订单、金额、币种和支付状态"）
// ---------------------------------------------------------------------------

export interface PaymentMatchInput {
  /** 事件声明的实付原币金额（CNY 为分；USDT 为 USDT 分位，经订单锁定汇率
   * 折算 CNY 分后比对，§3 "跨币种实际支付先固定计价汇率版本"）。 */
  paidCnyFen: bigint;
  /** 订单锁定的汇率分子（rateCoinUnits，见 order.extra JSON 快照）。 */
  order: {
    requestedAmount: string;
    paymentCurrency: string;
    status: number;
    expiresAt: Date | string;
    extra: Record<string, unknown> | null;
  };
  /** 事件币种（与订单 payment_currency 比对）。 */
  eventCurrency: string;
  now: Date;
}

export type PaymentMatchResult =
  | { ok: true }
  | {
      ok: false;
      reason: (typeof P)['FUNDING_ORDER_NOT_PAYABLE'] | (typeof P)['FUNDING_ORDER_EXPIRED'] | (typeof P)['FUNDING_ORDER_AMOUNT_MISMATCH'];
    };

/**
 * 四匹配校验：订单状态（CREATED/PAYING 可履约）+ 订单未过期 + 币种匹配 +
 * 金额匹配（实付 CNY 分 == 订单请求 CNY 分；Mock 渠道 = 请求全额，
 * 真实渠道 = 实付净额扣渠道费，§3 "充值返点按实付金额"）。
 * 任一不匹配 → 拒绝不履约（不产生分录，§10 红线）。
 */
export function matchPaymentEvent(input: PaymentMatchInput): PaymentMatchResult {
  const { order } = input;
  if (!isOrderPayable(order.status)) {
    return { ok: false, reason: P.FUNDING_ORDER_NOT_PAYABLE };
  }
  if (isOrderExpired(order.expiresAt, input.now)) {
    return { ok: false, reason: P.FUNDING_ORDER_EXPIRED };
  }
  if (order.paymentCurrency !== input.eventCurrency) {
    return { ok: false, reason: P.FUNDING_ORDER_AMOUNT_MISMATCH };
  }
  const requestedFen = BigInt(order.requestedAmount);
  if (requestedFen <= 0n) {
    return { ok: false, reason: P.FUNDING_ORDER_NOT_PAYABLE };
  }
  if (input.paidCnyFen < requestedFen) {
    // 实付少于请求 → 错额拒绝（双资产文档 §5.2 "错额请求拒绝且不产生账本分录"）。
    return { ok: false, reason: P.FUNDING_ORDER_AMOUNT_MISMATCH };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 金额换算（充值 CNY → 金币；@gameing/domain/wallet calculatePurchaseCoins）
// ---------------------------------------------------------------------------

/**
 * 充值金额换算金币（不能整除 → INVALID_ORDER_AMOUNT，双资产文档 §5.2
 * "不能精确换成整数金币时拒绝订单"）。domain 包 calculatePurchaseCoins
 * 抛 Error(FundingErrorCode.INVALID_ORDER_AMOUNT)，本处捕获转
 * PaymentDomainError（携带稳定码，HTTP 边界映射 envelope）。
 */
export function purchaseCoinsForFen(amountCnyFen: bigint, rate: ExchangeRate): bigint {
  try {
    return calculatePurchaseCoins(amountCnyFen, rate.rateCoinUnits, rate.rateCashFen);
  } catch (err) {
    if (err instanceof Error && err.message === FundingErrorCode.INVALID_ORDER_AMOUNT) {
      throw new PaymentDomainError(P.INVALID_ORDER_AMOUNT, 'purchase amount not convertible to whole coins');
    }
    throw new PaymentDomainError(P.INVALID_ORDER_AMOUNT, 'purchase coin calculation failed');
  }
}

// ---------------------------------------------------------------------------
// 提现纯规则（§4：5% 费率向上取整到分、1000 枚整数倍门槛、72h 出款等待）
// ---------------------------------------------------------------------------

/** 提现手续费率（5%，BPS；双资产文档 §4 "默认 5%"，domain 包单一来源）。 */
export const WITHDRAWAL_FEE_BPS = DEFAULT_WITHDRAWAL_FEE_BPS;

/** 最低提现金币门槛（1000 枚整数倍；双资产文档 §4/§5，domain 包单一来源）。 */
export const MINIMUM_WITHDRAWAL_COINS = DEFAULT_MINIMUM_WITHDRAWAL_COINS;

/** 出款等待时长（72h；双资产文档 §4 "申请后至少等待 72 小时"，§5.1 "出款等待 72 小时"）。 */
export const WITHDRAWAL_DELAY_HOURS = 72;

/**
 * 提现净到账金额门禁（§4/§5 "最低 1000 金币整数倍门槛校验净到账额对应的
 * 金币数，手续费不计入门槛"）：
 * - 净额 > 0（schema 已挡，防御性二次校验）；
 * - 净额按汇率折金币 = 门槛的整数倍（calculatePurchaseCoins 同方向公式：
 *   netCnyFen × rateCoinUnits / rateCashFen 须整除，否则 WITHDRAWAL_
 *   MINIMUM_OR_MULTIPLE_INVALID——"金币兑余额后提现"的等值口径，
 *   双资产文档 §4 "默认 1:10 对应 1100 金币等值"）；
 * - 折合金币 ≥ MINIMUM_WITHDRAWAL_COINS（1000 枚）。
 */
export function assertWithdrawalNetCny(netCnyFen: bigint, rate: ExchangeRate): { coinEquivalent: bigint; minimumCoins: bigint } {
  if (netCnyFen <= 0n) {
    throw new PaymentDomainError(P.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID, 'withdrawal net must be positive');
  }
  const numerator = netCnyFen * rate.rateCoinUnits;
  if (numerator % rate.rateCashFen !== 0n) {
    throw new PaymentDomainError(P.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID, 'net amount not a whole coin multiple');
  }
  const coinEquivalent = numerator / rate.rateCashFen;
  if (coinEquivalent < MINIMUM_WITHDRAWAL_COINS) {
    throw new PaymentDomainError(P.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID, 'below minimum withdrawal threshold');
  }
  if (coinEquivalent % MINIMUM_WITHDRAWAL_COINS !== 0n) {
    throw new PaymentDomainError(P.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID, 'withdrawal must be a multiple of the minimum');
  }
  return { coinEquivalent, minimumCoins: MINIMUM_WITHDRAWAL_COINS };
}

/** 提现手续费（向上取整到分；domain 包 calculateWithdrawalFee 复用）。 */
export function withdrawalFeeOf(netCnyFen: bigint): bigint {
  return calculateWithdrawalFee(netCnyFen, WITHDRAWAL_FEE_BPS);
}

// ---------------------------------------------------------------------------
// 提现状态机转换表（§4 九态：1→2→3→4→5；1/2→7 释放占款；6/9 释放占款；
// 8 保持占款）
// ---------------------------------------------------------------------------

export type WithdrawalStatusValue = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

/**
 * 九态转换表（双资产文档 §4 "状态采用常量 REQUESTED=1…FAILED=9"）：
 * - 1 REQUESTED → 2 REVIEWING（审核中）→ 3 APPROVED（审核通过，可提前完成）
 *   → 4 PAYING（出款中）→ 5 SUCCEEDED（成功，占款转完成扣款）；
 * - 1/2 → 7 CANCELLED（合法取消，释放占款，§4 "待审核状态可取消"）；
 * - 3/4 → 6 REJECTED（拒绝，释放占款，§4 "拒绝、合法取消或已确认出款失败时幂等释放"）；
 * - 4/8 → 9 FAILED（出款失败，释放占款）；
 * - 3/4 → 8 PAYMENT_UNKNOWN（支付结果未知，保持占款不重发，§4 "保持占款，
 *   不直接重发或释放导致二次出款"）；
 * - 6/7/9 → 终态（无出边；8 → 9 经查询/对账后确认失败释放，§4 "查询/对账"）。
 *
 * 占款语义（asset_hold，HoldStatus 经 WITHDRAWAL_HOLD=6 / WITHDRAWAL_RELEASE=8
 * 分录操作）：
 * - 创建（REQUESTED）= OPEN 占款（用户 CNY -（净+费），系统 CNY +（净+费），
 *   asset_hold 行）；
 * - 1/2→7、3/4→6、4/8→9 = 释放占款（WITHDRAWAL_RELEASE=8 反向分录）；
 * - 8 = 保持占款（不释放，等待查询/对账结论，§10 "未知出款不重复支付"）；
 * - 4→5 = 占款转完成扣款（WITHDRAWAL_SETTLEMENT=7，不释放而是消耗占款，
 *   §4 "确认支付成功才将占款转为完成扣款"；首版出款 worker 未闭环，
 *   本转换表登记语义，实际 SUCCEEDED 分录待 §9 第 3 步出款 worker）。
 */
export const withdrawalAllowedTransitions: Record<WithdrawalStatusValue, WithdrawalStatusValue[]> = {
  [WithdrawalStatus.REQUESTED]: [WithdrawalStatus.REVIEWING, WithdrawalStatus.CANCELLED],
  [WithdrawalStatus.REVIEWING]: [WithdrawalStatus.APPROVED, WithdrawalStatus.CANCELLED, WithdrawalStatus.REJECTED],
  [WithdrawalStatus.APPROVED]: [WithdrawalStatus.PAYING, WithdrawalStatus.REJECTED],
  [WithdrawalStatus.PAYING]: [
    WithdrawalStatus.SUCCEEDED,
    WithdrawalStatus.REJECTED,
    WithdrawalStatus.PAYMENT_UNKNOWN,
    WithdrawalStatus.FAILED,
  ],
  [WithdrawalStatus.SUCCEEDED]: [],
  [WithdrawalStatus.REJECTED]: [],
  [WithdrawalStatus.CANCELLED]: [],
  // PAYMENT_UNKNOWN=8：保持占款不释放（§4 "保持占款，不直接重发或释放导致二次
  // 出款"）；首版设终态（无出边），等待人工对账/查询结论后管理员手工推进 9；
  // 登记决策点（出款 worker 落地后 8→9 经 WITHDRAWAL_RELEASE=8 释放分录）。
  [WithdrawalStatus.PAYMENT_UNKNOWN]: [],
  [WithdrawalStatus.FAILED]: [],
};

/** 转换是否合法（adapter `transition` 校验；非法 → 用例映射错误码）。 */
export function isWithdrawalTransitionAllowed(from: WithdrawalStatusValue, to: WithdrawalStatusValue): boolean {
  return (withdrawalAllowedTransitions[from] ?? []).includes(to);
}

/** 该转换是否需释放占款（§4 语义；8 保持占款除外）。 */
export function transitionReleasesHold(from: WithdrawalStatusValue, to: WithdrawalStatusValue): boolean {
  if (!isWithdrawalTransitionAllowed(from, to)) return false;
  // 合法取消（7）/ 拒绝（6）/ 失败（9）= 释放；成功（5）= 消耗（转完成扣款）；
  // 未知（8）= 保持；1→2 / 3→4 审核/出款推进 = 保持。
  return to === WithdrawalStatus.CANCELLED || to === WithdrawalStatus.REJECTED || to === WithdrawalStatus.FAILED;
}

// ---------------------------------------------------------------------------
// 请求哈希（payment_event / withdrawal 幂等键 content 摘要；与 wallet 同款）
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

/** 规范化请求摘要（SHA-256；防同键异内容重放，§4 幂等纪律）。 */
export function requestHashOf(payload: unknown): Uint8Array {
  const normalized = JSON.stringify(payload);
  return createHash('sha256').update(normalized).digest();
}

// ---------------------------------------------------------------------------
// 身份三选一（§5 "已绑定邮箱/手机或用户名密码判定"）
// ---------------------------------------------------------------------------

export interface IdentityUserFields {
  username: string | null;
  passwordHash: string | null;
  email: string | null;
  emailVerifiedAt: Date | string | null;
  phone: string | null;
  phoneVerifiedAt: Date | string | null;
}

/**
 * 提现身份门禁（双资产文档 §5 "提现身份三选一"；AGENTS.md "联系方式绑定
 * 不做验证码验证"——绑定 = 字段非空且已验证时间戳非空，首版从 user 行
 * 字段判定，§5.1 同款口径）。满足其一即可：
 * 1. 邮箱已绑定（email 非空 + emailVerifiedAt 非空）；
 * 2. 手机已绑定（phone 非空 + phoneVerifiedAt 非空）；
 * 3. 用户名 + 密码有效（username 非空 + passwordHash 非空）。
 * 全不满足 → 返回 false（用例映射 INVALID_PAYOUT_ACCOUNT——contracts 无
 * "身份未验证"专码，P 表只映射既有码子集，errors.ts 头注释登记）。
 */
export function identitySatisfied(user: IdentityUserFields): boolean {
  const emailBound = user.email !== null && user.email !== undefined && user.email !== '' && user.emailVerifiedAt !== null;
  const phoneBound = user.phone !== null && user.phone !== undefined && user.phone !== '' && user.phoneVerifiedAt !== null;
  const usernamePassword = user.username !== null && user.username !== '' && user.passwordHash !== null && user.passwordHash !== '';
  return emailBound || phoneBound || usernamePassword;
}
