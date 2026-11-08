/**
 * wallet 实体专属不变量（金额守恒 / 版本冲突 / 汇率解析 / 请求哈希 / 流水门槛）。
 *
 * 领域所有者：wallet 模块（纯函数，依赖 @gameing/domain 与 contracts，无 IO）。
 * 对应 SDD 章节：后端实施 SDD §1（"backend 模块的 domain/ 子目录只放该实体
 * 专属的不变量与映射，不复制 domain 包规则"）、§4（事务/幂等/审计约定）；
 * 双资产文档 §2（兑换按分子/分母解析为整数分、不足 1 分余数舍弃、双账本
 * 守恒边界分开核对）；§5（新用户首次赠币 1000 枚、默认 5 倍有效下注流水）。
 *
 * 约定：
 * - 金额全链路 BigInt（金币枚 / CNY 分）；本文件不产生任何 wire 字符串
 *   （跨层格式化归 adapters/row-mappers.ts，SDD §2 第 2 条）；
 * - 通用纯函数（5% 手续费、报价构造、汇率计算、报价匹配）直接 import
 *   `@gameing/domain/wallet`，不在 backend 重写（任务硬约定 4）。
 */

import { createHash } from 'node:crypto';
import type { WalletTransferQuoteDto, WalletExchangeQuoteDto } from '@gameing/contracts/wallet';
import { transferQuoteMatches, exchangeQuoteMatches, DEFAULT_COIN_TRANSFER_FEE_BPS } from '@gameing/domain/wallet';
import type { ExchangeRate } from '../ports/wallet-repository.js';
import type { LedgerPost } from '../ports/wallet-repository.js';
import { W, WalletDomainError } from './errors.js';

/** 转账手续费率（5%，BPS；domain 包 DEFAULT_COIN_TRANSFER_FEE_BPS 单一来源）。 */
export const TRANSFER_FEE_BPS = DEFAULT_COIN_TRANSFER_FEE_BPS;

/** 新用户欢迎赠币默认枚数（双资产文档 §5 "已确定新用户首次赠币 1000 枚"；
 * 可经配置注入，首版固定常量，决策点登记）。 */
export const WELCOME_GIFT_COINS_DEFAULT = 1_000n;

/** 赠币流水倍数默认值（双资产文档 §5 "默认 5 倍有效下注流水"；
 * gift_grant.turnover_multiplier 列默认 5）。 */
export const TURN_MULTIPLIER_DEFAULT = 5;

// ---------------------------------------------------------------------------
// 请求哈希（asset_operation.request_hash BINARY(32)，防同键异内容重放）
// ---------------------------------------------------------------------------

/** 规范化请求摘要（SHA-256；入参为 JSON 稳定序列化字符串）。 */
export function requestHashOf(payload: unknown): Uint8Array {
  const normalized = JSON.stringify(payload);
  return createHash('sha256').update(normalized).digest();
}

// ---------------------------------------------------------------------------
// 汇率解析（ConfigReader 实现调用；parser allowlist + 范围校验，SDD §4）
// ---------------------------------------------------------------------------

/**
 * 解析 `cny_to_coin_ratio` 配置字符串（"人民币元:金币"，如 `1:10`）为整数分形式。
 * parser allowlist（双资产文档 §2 "按分子/分母解析为整数分"）：
 * - 仅接受 `^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$`（分子/分母均正整数，各 ≤ 9 位）；
 * - 金额单位换算：元 × 100 → 分（rateCashFen = cashYuan × 100n）。
 * 格式非法 / 缺失 → 返回 null（调用方映射 EXCHANGE_NOT_AVAILABLE，
 * 双资产文档 §2 "配置缺失/非法 → EXCHANGE_NOT_AVAILABLE"）。
 */
export function parseCnyToCoinRatio(raw: string | null | undefined): ExchangeRate | null {
  if (typeof raw !== 'string') return null;
  const match = /^([1-9][0-9]{0,8}):([1-9][0-9]{0,8})$/.exec(raw.trim());
  if (match === null) return null;
  const cashYuan = BigInt(match[1] ?? '0');
  const coins = BigInt(match[2] ?? '0');
  if (cashYuan <= 0n || coins <= 0n) return null;
  return { rateCoinUnits: coins, rateCashFen: cashYuan * 100n };
}

// ---------------------------------------------------------------------------
// 报价校验（提交时配置/费率变化 → 重新报价，双资产文档 §2）
// ---------------------------------------------------------------------------

/** 转账报价是否仍匹配当前费率（domain 包 transferQuoteMatches 复用）。 */
export function checkTransferQuote(
  quote: WalletTransferQuoteDto,
  now: Date,
): 'OK' | (typeof W)['TRANSFER_QUOTE_EXPIRED'] | (typeof W)['TRANSFER_QUOTE_CHANGED'] {
  if (new Date(quote.expiresAt).getTime() <= now.getTime()) return W.TRANSFER_QUOTE_EXPIRED;
  if (!transferQuoteMatches(quote, TRANSFER_FEE_BPS)) return W.TRANSFER_QUOTE_CHANGED;
  return 'OK';
}

/** 兑换报价是否仍匹配当前汇率（domain 包 exchangeQuoteMatches 复用）。 */
export function checkExchangeQuote(
  quote: WalletExchangeQuoteDto,
  rate: ExchangeRate,
  now: Date,
): 'OK' | (typeof W)['EXCHANGE_QUOTE_EXPIRED'] | (typeof W)['EXCHANGE_QUOTE_CHANGED'] {
  if (new Date(quote.expiresAt).getTime() <= now.getTime()) return W.EXCHANGE_QUOTE_EXPIRED;
  if (!exchangeQuoteMatches(quote, rate.rateCoinUnits, rate.rateCashFen)) return W.EXCHANGE_QUOTE_CHANGED;
  return 'OK';
}

// ---------------------------------------------------------------------------
// 金额守恒校验（用例入账前调用；双资产文档 §2 "两种资产均不部分提交"）
// ---------------------------------------------------------------------------

/**
 * 双账本守恒校验：一次资金操作内全部分录的 delta 合计须等于期望净值
 * （内部转账/兑换/赠币同事务，系统账户作为来源/归宿，
 * "外部收支与内部转账守恒边界分开"——本函数校验操作内全账户合计 = 0）。
 * 违反 → 抛 WALLET_STORAGE_UNAVAILABLE（记账后拦截，事务回滚不产生部分提交）。
 */
export function assertConservation(posts: LedgerPost[], expectedNet: bigint): void {
  const sum = posts.reduce((acc, p) => acc + p.amount, 0n);
  if (sum !== expectedNet) {
    throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `ledger conservation violated: sum=${sum} expected=${expectedNet}`);
  }
}

/**
 * 版本冲突判定（account_version 乐观锁；A.3 `U(asset_account_id, account_version)`
 * 天然阻断并发错账）：postEntries 条件 UPDATE 影响行数 0 表示锁读后被并发修改。
 * 冲突可安全重试（重读账户再记账），故抛可重试的 WALLET_STORAGE_UNAVAILABLE。
 * （adapter 内联判定抛错；本函数供用例层独立校验场景复用。）
 */
export function assertVersionNotConflicted(affectedRows: number, accountId: string): void {
  if (affectedRows === 0) {
    throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `version conflict on account ${accountId}`, {
      retryable: true,
    });
  }
}

/**
 * 可用余额门禁（amount - frozen_amount ≥ 需要支出额；玩家资产不可透支，
 * AGENTS.md "玩家资产与系统人民币余额不允许透支"；冻结额计入占用，
 * AGENTS.md "校验本金加手续费的可用余额及冻结"）。
 */
export function assertAvailableBalance(accountAmount: bigint, accountFrozen: bigint, required: bigint): void {
  const available = accountAmount - accountFrozen;
  if (available < required) {
    throw new WalletDomainError(W.INSUFFICIENT_AVAILABLE_BALANCE, 'insufficient available balance');
  }
}

/**
 * 兑换金额门禁（双资产文档 §2 "兑入余额按人民币分向下取整，不足 1 分余数
 * 舍弃"）：结果必须 ≥ 1 分，否则报价值不足（INVALID_EXCHANGE_AMOUNT，
 * domain 包 calculateExchangeCashFen 的 0 结果语义对齐）。
 */
export function assertExchangeAmountPositive(cashFen: bigint): void {
  if (cashFen <= 0n) {
    throw new WalletDomainError(W.INVALID_EXCHANGE_AMOUNT, 'exchange amount rounds below 1 CNY fen');
  }
}

// ---------------------------------------------------------------------------
// 流水门槛判定（turnover_state；双资产文档 §2 "未完成流水禁止提现及转出"）
// ---------------------------------------------------------------------------

/**
 * 流水门槛纯函数：remaining_coins（十进制字符串 wire）> 0 → false（禁止
 * 提现/转出）；无行（undefined/null）= 无流水要求 = true。
 * 非法值按未通过处理（防御性，避免脏数据放行）。
 */
export function checkTurnoverGate(remainingCoins: string | null | undefined): boolean {
  if (remainingCoins === null || remainingCoins === undefined) return true;
  try {
    return BigInt(remainingCoins) === 0n;
  } catch {
    return false;
  }
}
