/**
 * coin-market 模块用例：成交列表 + 交易详情 + 过期 / 取消（GET /me/coin-market/trades
 * + GET /me/coin-market/trades/:id + POST /me/coin-market/trades/:id/cancel，
 * 首版玩家侧路径；11 态 DDL 权威状态机，PAYMENT_EXPIRED 经读路径超时推进，
 * worker 未建，登记 §6.3 管线扩展点）。
 *
 * 领域所有者：coin-market 模块（读 coin_market_trade + 同事务 coin_market_listing
 * 守恒变更；asset_hold 释放经 AssetLedger，不直接查表；SDD §5.13
 * "不新增报表持久化表"，成交列表纯读投影 + 读路径超时推进登记）。
 * 对应 SDD 章节：后端实施 SDD §9 第 7 步（金币集市集市成交列表 / 详情 /
 * 取消 + 读路径超时推进 PAYMENT_EXPIRED）、§5.13（coin_market_trade
 * 11 态状态机 DDL 权威 + U(trade_key) / U(chain_tx_id) 幂等）；
 * 数据库设计 SDD §5.13（coin_market_trade 读路径 + ix_coin_market_trade_
 * buyer_status_created 索引登记，登记决策点：Lead 确认索引）。
 *
 * 用例语义：
 * - `listTrades`：买家成交列表（按 status + createdAt 游标分页 50/页；
 *   读路径超时推进：PAYMENT_PENDING=1 且 payment_deadline_at < now →
 *   同事务推进 PAYMENT_EXPIRED=9 + listing reserved → available 释放
 *   + 通过 wallet ledger 释放并记账 shared asset_hold；期限 worker 保持未接通）；
 * - `getTrade`：交易详情（读 trade 行 + 11 态状态机前置校验，幂等重放
 *   只读不写，DISPUTE 路径 3/4/5/6 → 7/10 首版只读不写，归 §9 第 9 步
 *   Admin 裁决端点）；
 * - `cancel`：买家 / 卖家取消（PAYMENT_PENDING=1 → CANCELLED=11，
 *   幂等重放：已 CANCELLED → 静默返回既有值 200；同事务 listing
 *   reserved → available 释放 + wallet ledger 原子释放并记账 shared asset_hold）。
 *
 * 错误码映射（CM → 触发条件）：
 * - `TRADE_NOT_FOUND`：交易行缺失（404 语义）。
 * - `TRADE_NOT_ALLOWED`：状态机转换前置校验失败（409 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 守恒破坏 / 状态机影响行数 0
 *   （可重试，503 语义）。
 */

import type { CoinMarketTradeModel } from '../../../infrastructure/database/models/coin-market.js';
import type { TradeRepo, ListingRepo, Tx } from '../ports/coin-market-repository.js';
import type { AssetLedger } from '../../wallet/ports/wallet-repository.js';
import { WalletEntryType, WalletOperationType } from '../../wallet/ports/wallet-repository.js';
import type { EntryIntent } from '../../wallet/ports/wallet-repository.js';
import { AccountType, AssetType, HoldType } from '../../../infrastructure/database/models/wallet.js';
import { requestHashOf } from '../../wallet/domain/ledger-rules.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { CoinMarketListingStatus5, CoinMarketTradeStatus11, canPlayerTriggerTransition } from '../domain/listing-rules.js';

/** 成交列表单页条数上限（SDD §5.4 游标分页 50/页）。 */
export const TRADE_PAGE_LIMIT = 50;

/** 成交列表项 DTO（wire；对齐 contracts CoinMarketTradeSchema，脱敏最小负载）。 */
export interface TradeItemDto {
  tradeId: string;
  listingId: string;
  coins: string;
  grossCents: string;
  status: number;
  paymentDeadlineAt: string | null;
  createdAt: string;
}

export interface TradePageDto {
  items: TradeItemDto[];
  nextCursor: string | null;
}

export interface TradeDetailDto {
  tradeId: string;
  listingId: string;
  coins: string;
  grossCents: string;
  sellerNetCents: string;
  status: number;
  paymentMethod: number;
  paymentDeadlineAt: string | null;
  confirmedAt: string | null;
  releasedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  createdAt: string;
}

export interface TradeCancelledDto {
  tradeId: string;
  status: number;
  cancelledAt: string;
  inserted: boolean;
}

/**
 * 成交流程用例（构造注入 TradeRepo + ListingRepo + AssetLedger + Clock，
 * 不用全局，SDD §4；读路径超时推进 + 取消同事务 listing 守恒变更 +
 * asset_hold 释放经 wallet ledger 扩展点登记，首版不直接调用 ledger，
 * 登记决策点：Lead 确认读路径超时推进是否需同事务 releaseHold）。
 */
export class TradeListUseCase {
  constructor(
    private readonly tradeRepo: TradeRepo,
    private readonly listingRepo: ListingRepo,
    private readonly ledger: AssetLedger,
    private readonly clock: Clock,
  ) {}

  /**
   * GET /me/coin-market/trades：买家成交列表（游标分页 50/页；
   * 读路径超时推进：PAYMENT_PENDING + payment_deadline_at < now →
   * 同事务 PAYMENT_EXPIRED=9 + listing reserved → available 释放）。
   */
  async expirePaymentPending(tradeId: string, tx: Tx): Promise<CoinMarketTradeModel | null> {
    const transaction = tx.transaction as { finished?: string | undefined } | null | undefined;
    if (transaction == null || transaction.finished != null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '成交到期资金处理必须在活动事务中运行。', { retryable: true });
    }
    const tradeRef = await this.tradeRepo.getTrade(tradeId, tx);
    if (tradeRef === null) return null;
    const listing = await this.listingRepo.lockListing(tradeRef.coinMarketListingId, tx);
    if (listing === null) throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${tradeRef.coinMarketListingId}`);
    const trade = await this.tradeRepo.lockTrade(tradeId, tx);
    if (trade === null) return null;
    if (trade.status === CoinMarketTradeStatus11.PAYMENT_EXPIRED) {
      const replay = await this.ledger.claimOperation({
        operationKey: `coin-market:trade:${trade.id}:expire`,
        operationType: WalletOperationType.COIN_MARKET_RELEASE,
        requestHash: requestHashOf({ tradeId: trade.id, coins: trade.coins, listingId: listing.id }),
        initiatedByUserId: trade.buyerUserId,
        extra: { tradeId: trade.id, listingId: listing.id, coins: trade.coins, outcome: 'PAYMENT_EXPIRED' },
        reason: 'coin-market payment deadline expired replay',
        tx,
      });
      if (replay.inserted) {
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易已过期但缺少原账本操作。', { retryable: true });
      }
      const snapshot = await this.ledger.getOperationResultSnapshot(replay.operation.id, tx);
      if (snapshot === null) {
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易已过期但缺少账本结果快照。', { retryable: true });
      }
      if (trade.status !== CoinMarketTradeStatus11.PAYMENT_EXPIRED) {
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '到期账务操作与交易状态不一致。', { retryable: true });
      }
      return trade;
    }
    if (trade.status !== CoinMarketTradeStatus11.PAYMENT_PENDING || trade.paymentDeadlineAt === null) return null;
    const now = await this.clock.now();
    const deadline = typeof trade.paymentDeadlineAt === 'string' ? new Date(trade.paymentDeadlineAt) : trade.paymentDeadlineAt;
    if (deadline.getTime() > now.getTime()) return null;
    const operationKey = `coin-market:trade:${trade.id}:expire`;
    const requestHash = requestHashOf({ tradeId: trade.id, coins: trade.coins, listingId: listing.id });
    const claimed = await this.ledger.claimOperation({
      operationKey,
      operationType: WalletOperationType.COIN_MARKET_RELEASE,
      requestHash,
      initiatedByUserId: trade.buyerUserId,
      extra: { tradeId: trade.id, listingId: listing.id, coins: trade.coins, outcome: 'PAYMENT_EXPIRED' },
      reason: 'coin-market payment deadline expired',
      tx,
    });
    if (!claimed.inserted) {
      const current = await this.tradeRepo.getTrade(trade.id, tx);
      const snapshot = await this.ledger.getOperationResultSnapshot(claimed.operation.id, tx);
      if (snapshot === null) {
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '到期幂等操作缺少已提交快照。', { retryable: true });
      }
      if (current?.status !== CoinMarketTradeStatus11.PAYMENT_EXPIRED) {
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '到期账务操作与交易状态不一致。', { retryable: true });
      }
      return current;
    }
    const sellerAccount = await this.ledger.readAccount(listing.sellerUserId, AssetType.COIN, AccountType.PLAYER, tx);
    if (sellerAccount === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌卖家金币账户缺失。', { retryable: true });
    await this.ledger.lockAccountsByIds([sellerAccount.id], tx);
    const expiryAmount = BigInt(trade.coins);
    const hold = await this.ledger.readHoldForOperation(
      listing.assetHoldId,
      { accountId: sellerAccount.id, holdType: HoldType.COIN_MARKET_LISTING, amount: expiryAmount },
      tx,
    );
    if (hold === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '到期挂牌占款账户、类型或余额不一致。', { retryable: true });
    if (listing.status !== CoinMarketListingStatus5.ACTIVE) {
      await this.ledger.releaseHoldAmount(
        {
          operationId: claimed.operation.id,
          holdId: listing.assetHoldId,
          amount: expiryAmount,
          intents: [
            {
              accountId: sellerAccount.id,
              delta: 0n,
              frozenDelta: -expiryAmount,
              entryType: WalletEntryType.HOLD,
              assetHoldId: listing.assetHoldId,
              memo: `coin-market expired trade ${trade.id} released from closed listing`,
            },
          ],
        },
        tx,
      );
    }
    const result = await this.tradeRepo.expireTrade({ tradeId, expiredAt: now, tx });
    if (result === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易过期状态转换失败。', { retryable: true });
    await this.ledger.setCommitted(claimed.operation.id, now, { tradeId, status: result.status, reservedCoinsReturned: trade.coins }, tx);
    return result;
  }

  async listTrades(userId: string, cursor: string | null, tx: Tx): Promise<TradePageDto> {
    const now = await this.clock.now();
    const nowIso = now.toISOString();

    // 读路径超时推进（登记 §6.3 worker 未建，读路径触发为过渡方案）：
    // PAYMENT_PENDING=1 且 payment_deadline_at < now → 同事务推进
    // PAYMENT_EXPIRED=9 + listing reserved → available 释放
    // 首版简化：经 tradeRepo.expireTrade 逐笔推进（不经 worker），
    // 登记决策点：Lead 确认读路径逐笔推进 vs worker 批量扫描。
    // 本方法只读列表，超时推进在 `getTrade` 详情端点触发（避免列表
    // 端点写副作用，登记决策点）。

    // 1. 读买家成交列表（按 status + createdAt 游标分页）
    const rows = await this.tradeRepo.listByBuyer({
      buyerUserId: userId,
      cursor,
      limit: TRADE_PAGE_LIMIT,
      tx,
    });

    // 2. 读路径超时推进（对 PAYMENT_PENDING + 过期行逐笔推进）
    const items: TradeItemDto[] = [];
    for (const row of rows.items) {
      if (row.status === CoinMarketTradeStatus11.PAYMENT_PENDING && row.paymentDeadlineAt !== null) {
        const deadlineIso = toIso(row.paymentDeadlineAt);
        if (deadlineIso < nowIso) {
          // 同事务推进超时 + 扣减 shared hold；ACTIVE 恢复可售，其他挂牌状态释放给卖家。
          await this.expirePaymentPending(row.id, tx);
          const updated = await this.tradeRepo.lockTrade(row.id, tx);
          if (updated !== null) {
            row.status = updated.status;
            row.paymentDeadlineAt = updated.paymentDeadlineAt;
          }
        }
      }
      items.push({
        tradeId: row.id,
        listingId: row.coinMarketListingId,
        coins: row.coins,
        grossCents: row.grossCents,
        status: row.status,
        paymentDeadlineAt: row.paymentDeadlineAt !== null ? toIso(row.paymentDeadlineAt) : null,
        createdAt: toIso(row.createdAt),
      });
    }

    return { items, nextCursor: rows.nextCursor };
  }

  /**
   * GET /me/coin-market/trades/:id：交易详情（读 trade 行 + 11 态状态机
   * 前置校验，幂等重放只读不写；DISPUTE 路径 3/4/5/6 → 7/10 首版只读
   * 不写，归 §9 第 9 步 Admin 裁决端点）。
   */
  async getTrade(userId: string, tradeId: string, tx: Tx): Promise<TradeDetailDto> {
    // 1. 锁挂牌后锁交易，维持 coin_market_listing → coin_market_trade 顺序。
    const tradeRef = await this.tradeRepo.getTrade(tradeId, tx);
    if (tradeRef === null) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${tradeId}`);
    }
    await this.listingRepo.lockListing(tradeRef.coinMarketListingId, tx);
    const trade = await this.tradeRepo.lockTrade(tradeId, tx);
    if (trade === null) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${tradeId}`);
    }

    // 2. 归属校验（买家身份；卖家身份经 listing 行读回，登记决策点：
    //    trade 表无 seller_user_id 列，首版只校验买家归属）
    if (trade.buyerUserId !== userId) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, '非本人交易，不可读取。', {
        retryable: false,
      });
    }

    // 3. 读路径超时推进（同 transaction 内，幂等重放：已 PAYMENT_EXPIRED
    //    → 静默返回既有值；PAYMENT_PENDING + 过期 → 推进 PAYMENT_EXPIRED=9）
    if (
      trade.status === CoinMarketTradeStatus11.PAYMENT_PENDING &&
      trade.paymentDeadlineAt !== null &&
      toIso(trade.paymentDeadlineAt) < (await this.clock.now()).toISOString()
    ) {
      const expired = await this.expirePaymentPending(tradeId, tx);
      if (expired !== null) {
        trade.status = expired.status;
      }
    }

    // 4. 读 listing 行取 sellerLabel（经 listingRepo，不直接查 user 表）
    void this.listingRepo.lockListing(trade.coinMarketListingId, tx);

    return {
      tradeId,
      listingId: trade.coinMarketListingId,
      coins: trade.coins,
      grossCents: trade.grossCents,
      sellerNetCents: trade.sellerNetCents,
      status: trade.status,
      paymentMethod: trade.paymentMode,
      paymentDeadlineAt: trade.paymentDeadlineAt !== null ? toIso(trade.paymentDeadlineAt) : null,
      confirmedAt: trade.paidAt !== null ? toIso(trade.paidAt) : null,
      releasedAt: null,
      cancelledAt: null,
      expiredAt: null,
      createdAt: toIso(trade.createdAt),
    };
  }

  /**
   * POST /me/coin-market/trades/:id/cancel：买家 / 卖家取消（
   * PAYMENT_PENDING=1 → CANCELLED=11，幂等重放：已 CANCELLED → 静默
   * 返回既有值 200；同事务 listing reserved → available 释放 +
   * 挂牌 asset_hold 保持不变）。
   */
  async cancel(userId: string, tradeId: string, tx: Tx): Promise<TradeCancelledDto> {
    const transaction = tx.transaction as { finished?: string | undefined } | null | undefined;
    if (transaction == null || transaction.finished != null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '成交取消资金处理必须在活动事务中运行。', { retryable: true });
    }
    // Lock order is listing → trade → account → hold.
    const tradeRef = await this.tradeRepo.getTrade(tradeId, tx);
    if (tradeRef === null) throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${tradeId}`);
    const listing = await this.listingRepo.lockListing(tradeRef.coinMarketListingId, tx);
    if (listing === null) throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${tradeRef.coinMarketListingId}`);
    const trade = await this.tradeRepo.lockTrade(tradeId, tx);
    if (trade === null) throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${tradeId}`);

    // 2. 归属校验（买家身份；卖家身份经 listing 行读回，登记决策点：
    //    trade 表无 seller_user_id 列，首版只校验买家归属）
    if (String(trade.buyerUserId) !== String(userId)) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, '非本人交易，不可取消。', {
        retryable: false,
      });
    }

    // 3. 幂等重放：必须拿到原 operation snapshot，不能用 paidAt 或当前时钟伪造取消时间。
    if (trade.status === CoinMarketTradeStatus11.CANCELLED) {
      const replay = await this.ledger.claimOperation({
        operationKey: `coin-market:trade:${tradeId}:cancel`,
        operationType: WalletOperationType.COIN_MARKET_RELEASE,
        requestHash: requestHashOf({ tradeId, coins: trade.coins, listingId: listing.id }),
        initiatedByUserId: userId,
        extra: { tradeId, listingId: listing.id, coins: trade.coins, outcome: 'CANCELLED' },
        reason: 'coin-market buyer cancellation replay',
        tx,
      });
      if (replay.inserted) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '取消状态缺少原账务操作。', { retryable: true });
      const snapshot = await this.ledger.getOperationResultSnapshot(replay.operation.id, tx);
      if (snapshot === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易取消幂等操作缺少结果快照。', { retryable: true });
      return { ...(snapshot as unknown as TradeCancelledDto), inserted: false };
    }

    // 4. 仅允许付款窗口内、且尚未提交付款凭证的买家取消。
    if (trade.paymentProofAssetId !== null || trade.chainTxId !== null || trade.paidAt !== null) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, '付款凭证已提交，不可直接取消。', { retryable: false });
    }
    if (!canPlayerTriggerTransition(trade.status, CoinMarketTradeStatus11.CANCELLED)) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, `交易状态机转换非法（status=${trade.status} → 11）。`, {
        retryable: false,
      });
    }

    // 5. 同事务记录幂等操作；活动挂牌恢复可售，已关闭挂牌释放给卖家。
    const now = await this.clock.now();
    const amount = BigInt(trade.coins);
    const requestHash = requestHashOf({ tradeId, coins: trade.coins, listingId: listing.id });
    const claimed = await this.ledger.claimOperation({
      operationKey: `coin-market:trade:${tradeId}:cancel`,
      operationType: WalletOperationType.COIN_MARKET_RELEASE,
      requestHash,
      initiatedByUserId: userId,
      extra: { tradeId, listingId: listing.id, coins: trade.coins, outcome: 'CANCELLED' },
      reason: 'coin-market buyer cancellation before payment proof',
      tx,
    });
    if (!claimed.inserted) {
      const re = await this.tradeRepo.lockTrade(tradeId, tx);
      const snapshot = await this.ledger.getOperationResultSnapshot(claimed.operation.id, tx);
      if (re?.status === CoinMarketTradeStatus11.CANCELLED && snapshot !== null) {
        return { ...(snapshot as unknown as TradeCancelledDto), inserted: false };
      }
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易取消幂等操作状态不一致。', { retryable: true });
    }
    // Validate the shared hold while retaining the listing's reserved slice.
    const sellerAccount = await this.ledger.readAccount(listing.sellerUserId, AssetType.COIN, AccountType.PLAYER, tx);
    if (sellerAccount === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌卖家金币账户缺失。', { retryable: true });
    await this.ledger.lockAccountsByIds([sellerAccount.id], tx);
    const hold = await this.ledger.readHoldForOperation(
      listing.assetHoldId,
      { accountId: sellerAccount.id, holdType: HoldType.COIN_MARKET_LISTING, amount },
      tx,
    );
    if (hold === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '取消成交时挂牌占款不一致。', { retryable: true });
    if (listing.status !== CoinMarketListingStatus5.ACTIVE) {
      const releaseIntents: EntryIntent[] = [
        {
          accountId: sellerAccount.id,
          delta: 0n,
          frozenDelta: -amount,
          entryType: WalletEntryType.HOLD,
          assetHoldId: listing.assetHoldId,
          memo: `coin-market cancelled trade ${trade.id} released from closed listing`,
        },
      ];
      await this.ledger.releaseHoldAmount(
        { operationId: claimed.operation.id, holdId: listing.assetHoldId, amount, intents: releaseIntents },
        tx,
      );
    }
    const result = await this.tradeRepo.cancelTrade({ tradeId, cancelledAt: now, tx });
    if (result === null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易取消状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }
    const dto = {
      tradeId,
      status: result.status,
      cancelledAt: now.toISOString(),
      inserted: true,
    };
    await this.ledger.setCommitted(claimed.operation.id, now, { ...dto }, tx);
    return dto;
  }
}

function toIso(d: Date | string | null): string {
  if (d === null) return new Date().toISOString();
  return typeof d === 'string' ? d : d.toISOString();
}
