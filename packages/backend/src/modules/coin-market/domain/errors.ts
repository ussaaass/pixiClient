/**
 * coin-market 领域错误码 + 错误类型（SDD §9 第 7 步：金币集市挂牌 / 成交）。
 *
 * 领域所有者：coin-market 模块（domain/errors.ts 纯函数，无 IO；用例层 /
 * 适配器层经本表抛错，路由层映射 HTTP 错误码）。
 * 对应 SDD 章节：后端实施 SDD §4（用例/仓储错误映射）、§9 第 7 步
 * （金币集市：挂牌 / 成交 / 确认 / 取消）、§5.13（coin_market_listing
 * 5 态 + coin_market_trade 11 态状态机）；contracts coin-market.ts
 * （CoinMarketErrorCode 对齐，本表 CM 前缀码值与 contracts 码值一致，
 * 经本表统一映射，不直接 import contracts，保持模块内聚）。
 *
 * 错误码约定（CM 前缀，对齐 @gameing/contracts/coin-market CoinMarketErrorCode）：
 * - `LISTING_NOT_FOUND`：挂牌行缺失（404 语义）。
 * - `TRADE_NOT_FOUND`：交易行缺失（404 语义）。
 * - `LISTING_NOT_CANCELLABLE`：挂牌非 ACTIVE（PAUSED/COMPLETED/CANCELLED/SUSPENDED
 *   不可取消，409 语义，状态机前置校验失败）。
 * - `LISTING_FULL`：可成交量 available_coins = 0（不可再成交，409 语义）。
 * - `TRADE_NOT_ALLOWED`：交易非可确认 / 可取消状态（卖家确认收款仅
 *   SELLER_CONFIRMATION_PENDING=2，409 语义，状态机前置校验失败）。
 * - `TRADE_DEADLINE_PASSED`：付款截止时间已过（PAYMENT_DEADLINE_SECONDS 超时，
 *   交易推进 PAYMENT_EXPIRED=9 前读到的旧态，409 语义）。
 * - `AMOUNT_MISMATCH`：成交金额与挂牌报价不符（gross_cents = ceil(price ×
 *   coins ÷ 1000) 整除偏差，400 语义，数据不一致不可重试）。
 * - `COINS_INSUFFICIENT`：预占金币数量超过挂牌可成交量（400 语义）。
 * - `IDEMPOTENCY_KEY_REUSED`：trade_key / listing_key 幂等键命中但内容不同
 *   （409 语义，同键异内容）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失 / 状态机转换影响行数 0
 *   （可重试，503 语义）。
 *
 * 注：contracts `CoinMarketTradeStatus` 为 P0 本地 9 值简化（apps/web
 * browser-api 在用），本模块用 **models/coin-market.ts 的 11 值权威常量**
 * （DDL 权威，SDD §5.13）；双轨差异登记："contracts 9 值 vs DDL 11 值，
 * 对齐归 §9 第 9 步 Admin cutover"（Lead 统一验证时确认）。
 */

import { UniqueConstraintError } from 'sequelize';

/** coin-market 错误码常量表（CM 前缀；码值对齐 contracts CoinMarketErrorCode，常量 0 不占位）。 */
export const CM = {
  /** 挂牌行缺失（404 语义）。 */
  LISTING_NOT_FOUND: 'LISTING_NOT_FOUND',
  /** 交易行缺失（404 语义）。 */
  TRADE_NOT_FOUND: 'TRADE_NOT_FOUND',
  /** 挂牌非 ACTIVE，不可取消（409 语义）。 */
  LISTING_NOT_CANCELLABLE: 'LISTING_NOT_CANCELLABLE',
  /** 可成交量 = 0，不可再成交（409 语义）。 */
  LISTING_FULL: 'LISTING_FULL',
  /** 交易非可确认状态（409 语义，状态机前置校验失败）。 */
  TRADE_NOT_ALLOWED: 'TRADE_NOT_ALLOWED',
  /** 付款截止时间已过（409 语义，PAYMENT_DEADLINE_SECONDS 超时）。 */
  TRADE_DEADLINE_PASSED: 'TRADE_DEADLINE_PASSED',
  /** 成交金额与挂牌报价不符（400 语义，数据不一致不可重试）。 */
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  /** 预占金币数量超过挂牌可成交量（400 语义）。 */
  COINS_INSUFFICIENT: 'COINS_INSUFFICIENT',
  /** 幂等键命中但内容不同（409 语义，同键异内容）。 */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** Sequelize 故障 / 行缺失 / 状态机影响行数 0（可重试，503 语义）。 */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

/** coin-market 错误码联合类型。 */
export type CoinMarketErrorCode = (typeof CM)[keyof typeof CM];

/**
 * 领域错误类（用例 / 仓储层抛出；路由层 `isCoinMarketDomainError` 捕获映射 HTTP）。
 * 携带 `code`（CM 表之一）+ 可选 `retryable`（决定路由层 5xx vs 4xx 映射）。
 */
export class CoinMarketDomainError extends Error {
  constructor(
    public readonly code: CoinMarketErrorCode,
    message: string,
    public readonly options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = 'CoinMarketDomainError';
  }
}

/** 类型守卫：捕获 CoinMarketDomainError（路由层错误映射用）。 */
export function isCoinMarketDomainError(err: unknown): err is CoinMarketDomainError {
  return err instanceof CoinMarketDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（幂等兜底用；U(listing_key) / U(trade_key) /
 * U(chain_tx_id) / U(asset_operation_id) 命中 → 返回既有行，不产生第二行，
 * 验收红线"成交幂等"）。
 * 检测 `UniqueConstraintError`（Sequelize 6 抽象）或
 * MySQL `ER_DUP_ENTRY`（errno 1062，驱动层直接抛出时兜底）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof UniqueConstraintError) return true;
  const anyErr = err as { code?: string; errno?: number; sqlMessage?: string };
  if (anyErr.code === 'ER_DUP_ENTRY' || anyErr.errno === 1062) return true;
  return false;
}
