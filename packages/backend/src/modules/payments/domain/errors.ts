/**
 * payments 领域错误（携带稳定错误码，由 HTTP 边界映射 envelope）。
 *
 * 领域所有者：payments 模块（全部 application 用例抛出，adapters/HTTP 边界消费）。
 * 对应 SDD 章节：后端实施 SDD §5.4（payments 端点）与 §9 第 3 步（支付与提现）、
 * 双资产文档 §3/§4/§5（充值履约/提现/验收红线）；与 wallet 模块
 * domain/errors.ts 同款纪律（每个用例文件维护自己的错误码映射表，
 * 本文件只提供抛错工具与错误码快捷引用）。
 *
 * 错误码来源（任务约定"映射 contracts FundingErrorCode + WalletErrorCode 子集"，
 * 不新写 DTO 亦不新增第二套码表；P 的取值即两个 const 对象中的码字符串）：
 * - FundingErrorCode（@gameing/contracts/wallet-funding）：INVALID_ORDER_AMOUNT /
 *   FUNDING_CHANNEL_UNAVAILABLE / FUNDING_ORDER_NOT_FOUND / FUNDING_ORDER_NOT_PAYABLE /
 *   FUNDING_ORDER_EXPIRED / FUNDING_ORDER_AMOUNT_MISMATCH / FUNDING_IDEMPOTENCY_KEY_REUSED /
 *   USDT_INVOICE_CAPACITY_REACHED；
 * - WalletErrorCode（@gameing/contracts/wallet）提现/收款账户子集：PAYOUT_ACCOUNT_NOT_FOUND /
 *   PAYOUT_ACCOUNT_IN_USE / INVALID_PAYOUT_ACCOUNT / WITHDRAWAL_CONFIG_INVALID /
 *   WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID / WITHDRAWAL_QUOTE_EXPIRED /
 *   WITHDRAWAL_QUOTE_CHANGED / WITHDRAWAL_NOT_FOUND / WITHDRAWAL_NOT_CANCELLABLE /
 *   IDEMPOTENCY_KEY_REUSED / WALLET_STORAGE_UNAVAILABLE / TURNOVER_INCOMPLETE /
 *   INSUFFICIENT_AVAILABLE_BALANCE。
 *
 * 注（任务登记）：contracts FundingErrorCode / WalletErrorCode 均无"提现身份三选一
 * 未满足"专码（如 IDENTITY_NOT_VERIFIED）；本模块 P 仅映射既有码子集，身份校验
 * 失败的对外码由装配层裁决（建议 PAYOUT 域码或 400 通用），不在此处新增码表。
 */

import { FundingErrorCode } from '@gameing/contracts/wallet-funding';
import { WalletErrorCode } from '@gameing/contracts/wallet';

/**
 * 携带稳定业务错误码的 payments 领域错误
 * （HTTP 边界 `code` 字段直接取 `error.code`；与 wallet/identity 模块同款结构）。
 */
export class PaymentDomainError extends Error {
  /** 稳定业务错误码（P 表码字符串）。 */
  readonly code: string;
  /** 是否可重试（默认 false；WALLET_STORAGE_UNAVAILABLE 乐观冲突可重试）。 */
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'PaymentDomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** payments 错误码快捷引用（FundingErrorCode + WalletErrorCode 子集映射表，P 表）。 */
export const P = {
  // --- 订单/渠道（contracts FundingErrorCode 原码） ---
  INVALID_ORDER_AMOUNT: FundingErrorCode.INVALID_ORDER_AMOUNT,
  FUNDING_CHANNEL_UNAVAILABLE: FundingErrorCode.FUNDING_CHANNEL_UNAVAILABLE,
  FUNDING_ORDER_NOT_FOUND: FundingErrorCode.FUNDING_ORDER_NOT_FOUND,
  FUNDING_ORDER_NOT_PAYABLE: FundingErrorCode.FUNDING_ORDER_NOT_PAYABLE,
  FUNDING_ORDER_EXPIRED: FundingErrorCode.FUNDING_ORDER_EXPIRED,
  FUNDING_ORDER_AMOUNT_MISMATCH: FundingErrorCode.FUNDING_ORDER_AMOUNT_MISMATCH,
  FUNDING_IDEMPOTENCY_KEY_REUSED: FundingErrorCode.FUNDING_IDEMPOTENCY_KEY_REUSED,
  USDT_INVOICE_CAPACITY_REACHED: FundingErrorCode.USDT_INVOICE_CAPACITY_REACHED,
  // --- 提现/收款账户（contracts WalletErrorCode 原码） ---
  PAYOUT_ACCOUNT_NOT_FOUND: WalletErrorCode.PAYOUT_ACCOUNT_NOT_FOUND,
  PAYOUT_ACCOUNT_IN_USE: WalletErrorCode.PAYOUT_ACCOUNT_IN_USE,
  INVALID_PAYOUT_ACCOUNT: WalletErrorCode.INVALID_PAYOUT_ACCOUNT,
  WITHDRAWAL_CONFIG_INVALID: WalletErrorCode.WITHDRAWAL_CONFIG_INVALID,
  WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID: WalletErrorCode.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID,
  WITHDRAWAL_QUOTE_EXPIRED: WalletErrorCode.WITHDRAWAL_QUOTE_EXPIRED,
  WITHDRAWAL_QUOTE_CHANGED: WalletErrorCode.WITHDRAWAL_QUOTE_CHANGED,
  WITHDRAWAL_NOT_FOUND: WalletErrorCode.WITHDRAWAL_NOT_FOUND,
  WITHDRAWAL_NOT_CANCELLABLE: WalletErrorCode.WITHDRAWAL_NOT_CANCELLABLE,
  IDEMPOTENCY_KEY_REUSED: WalletErrorCode.IDEMPOTENCY_KEY_REUSED,
  WALLET_STORAGE_UNAVAILABLE: WalletErrorCode.WALLET_STORAGE_UNAVAILABLE,
  TURNOVER_INCOMPLETE: WalletErrorCode.TURNOVER_INCOMPLETE,
  INSUFFICIENT_AVAILABLE_BALANCE: WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE,
} as const;
export type PaymentErrorCodeValue = (typeof P)[keyof typeof P];

/** 判断是否为 payments 领域错误（用例/装配层捕获分支用）。 */
export function isPaymentDomainError(err: unknown): err is PaymentDomainError {
  return err instanceof PaymentDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（ER_DUP_ENTRY；与 wallet/identity 模块同款，
 * 各模块本地一份以守模块依赖方向铁律，不跨模块 import domain 工具）。
 * payments 用例用它区分"幂等键命中重放"与"同键异内容"。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { name?: string; parent?: { code?: string; errno?: number } } | null;
  if (e === null || e === undefined) return false;
  if (typeof e.name === 'string' && e.name === 'SequelizeUniqueConstraintError') return true;
  const code = e.parent?.code;
  const errno = e.parent?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}
