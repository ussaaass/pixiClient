/**
 * coin-market 模块用例：挂牌取消（POST /me/coin-market/listings/:id/cancel，
 * 200 幂等重放；ACTIVE=1 → CANCELLED=4 + 仅释放未成交 available 对应 asset_hold，同事务）。
 *
 * 领域所有者：coin-market 模块（coin_market_listing 状态机 + asset_hold
 * 释放经 AssetLedger port，不直接查表；SDD §5.13 "挂牌关闭后释放剩余量"）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 coin_market_listing → asset_hold，
 * 幂等先抢唯一约束；所有分录 / outbox 同事务）、§9 第 7 步（挂牌取消 +
 * 释放占款）、§5.13（coin_market_listing CANCELLED=4 + available →
 * cancelled 守恒变更）；docs/04_domains/双资产充值兑换与提现.md §4
 * （拒绝 / 取消 / 失败幂等释放占款）。
 *
 * 用例语义：
 * - 卖家取消自己的挂牌（前置校验 sellerUserId = 当前用户；非 ACTIVE →
 *   幂等重放已 CANCELLED → 静默返回既有值 200；非 ACTIVE 非 CANCELLED →
 *   抛 LISTING_NOT_CANCELLABLE 409）；
 * - 同事务 listing 守恒变更（available → cancelled）+ wallet ledger 原子
 *   释放并记账 shared asset_hold（COIN_MARKET_RELEASE operation 幂等）。
 * - 幂等重放：已 CANCELLED → 静默返回既有值（不产生第二笔，验收红线
 *   "取消幂等"）。
 *
 * 错误码映射（CM → 触发条件）：
 * - `LISTING_NOT_FOUND`：挂牌行缺失（404 语义）。
 * - `LISTING_NOT_CANCELLABLE`：挂牌非 ACTIVE（PAUSED / COMPLETED /
 *   SUSPENDED，409 语义，状态机前置校验失败）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 守恒破坏 / 状态机影响行数 0
 *   （可重试，503 语义）。
 */

import type { ListingRepo, Tx } from '../ports/coin-market-repository.js';
import type { AssetLedger, EntryIntent } from '../../wallet/ports/wallet-repository.js';
import { WalletOperationType, WalletEntryType } from '../../wallet/ports/wallet-repository.js';
import { requestHashOf } from '../../wallet/domain/ledger-rules.js';
import { AssetType, AccountType, HoldType } from '../../../infrastructure/database/models/wallet.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { CoinMarketListingStatus5 } from '../domain/listing-rules.js';

export interface ListingCancelledDto {
  listingId: string;
  status: number;
  cancelledCoins: string;
  cancelledAt: string;
  /** 是否为新取消（false = 幂等重放，已 CANCELLED 行读回既有值）。 */
  inserted: boolean;
}

/**
 * 挂牌取消用例（构造注入 ListingRepo + AssetLedger + Clock，不用全局，
 * SDD §4；取消 + 释放占款同事务，经 walletModule.ledger releaseHold，
 * 与 rooms 释放占款同款模式）。
 */
export class ListingCancelUseCase {
  constructor(
    private readonly listingRepo: ListingRepo,
    private readonly ledger: AssetLedger,
    private readonly clock: Clock,
  ) {}

  async run(userId: string, listingId: string, tx: Tx): Promise<ListingCancelledDto> {
    const transaction = tx.transaction as { finished?: string | undefined } | null | undefined;
    if (transaction == null || transaction.finished != null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌取消资金处理必须在活动事务中运行。', { retryable: true });
    }
    const operationRequestHash = requestHashOf({ listingId, action: 'cancel', userId });
    // 1. 行锁读挂牌（status + 守恒前置校验）
    const listing = await this.listingRepo.lockListing(listingId, tx);
    if (listing === null) {
      throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${listingId}`);
    }

    // 2. 前置校验：归属 + 状态
    if (listing.sellerUserId !== userId) {
      throw new CoinMarketDomainError(CM.LISTING_NOT_CANCELLABLE, '非本人挂牌，不可取消。', {
        retryable: false,
      });
    }
    if (listing.status === CoinMarketListingStatus5.CANCELLED) {
      // Idempotent replay must return the original operation snapshot for either
      // positive or zero available inventory.
      const replay = await this.ledger.claimOperation({
        operationKey: `coin-market:listing:${listingId}:cancel`,
        operationType: WalletOperationType.COIN_MARKET_RELEASE,
        requestHash: operationRequestHash,
        initiatedByUserId: userId,
        extra: { listingId, holdId: listing.assetHoldId, releasedCoins: BigInt(listing.cancelledCoins).toString() },
        reason: 'coin-market listing cancellation replay',
        tx,
      });
      if (!replay.inserted) {
        const snapshot = await this.ledger.getOperationResultSnapshot(replay.operation.id, tx);
        if (snapshot !== null) return { ...(snapshot as unknown as ListingCancelledDto), inserted: false };
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌取消幂等操作缺少结果快照。', { retryable: true });
      }
      // A pre-existing cancelled row without its original operation/snapshot is
      // not reconstructible safely: cancelledCoins is not a ledger delta.
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌已取消但缺少原账本操作或结果快照。', { retryable: true });
    }
    if (listing.status !== CoinMarketListingStatus5.ACTIVE) {
      // PAUSED / COMPLETED / SUSPENDED → 不可取消（需 Admin 操作，§9 第 9 步）
      throw new CoinMarketDomainError(CM.LISTING_NOT_CANCELLABLE, `挂牌非 ACTIVE，不可取消（status=${listing.status}）。`, {
        retryable: false,
      });
    }

    // 3. claim stable cancellation operation even when available is zero, so
    // the listing state change is still replayable with an immutable snapshot.
    const available = BigInt(listing.availableCoins);
    const now = await this.clock.now();
    const claimed = await this.ledger.claimOperation({
      operationKey: `coin-market:listing:${listingId}:cancel`,
      operationType: WalletOperationType.COIN_MARKET_RELEASE,
      requestHash: operationRequestHash,
      initiatedByUserId: userId,
      extra: { listingId, holdId: listing.assetHoldId, releasedCoins: available.toString() },
      reason: 'coin-market listing cancellation',
      tx,
    });
    if (!claimed.inserted) {
      const snapshot = await this.ledger.getOperationResultSnapshot(claimed.operation.id, tx);
      if (snapshot !== null) return { ...(snapshot as unknown as ListingCancelledDto), inserted: false };
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌取消幂等操作缺少结果快照。', { retryable: true });
    }
    const operationId = claimed.operation.id;
    const account = await this.ledger.readAccount(listing.sellerUserId, AssetType.COIN, AccountType.PLAYER, tx);
    if (account === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌卖家金币账户缺失。');
    if (available > 0n) await this.ledger.lockAccountsByIds([account.id], tx);
    const hold = await this.ledger.readHoldForOperation(
      listing.assetHoldId,
      { accountId: account.id, holdType: HoldType.COIN_MARKET_LISTING, amount: available },
      tx,
    );
    if (hold === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌占款与挂牌状态不一致。', { retryable: true });
    if (available > 0n) {
      const intents: EntryIntent[] = [
        {
          accountId: account.id,
          delta: 0n,
          frozenDelta: -available,
          entryType: WalletEntryType.HOLD,
          assetHoldId: listing.assetHoldId,
          memo: `coin-market listing cancel release ${available} coins`,
        },
      ];
      await this.ledger.releaseHoldAmount({ operationId, holdId: listing.assetHoldId, amount: available, intents }, tx);
    }

    // 4. 写挂牌取消（ACTIVE → CANCELLED + available → cancelled 守恒变更）
    const result = await this.listingRepo.cancelListing({
      listingId,
      cancelledAt: now,
      tx,
    });
    if (result === null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌取消状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }
    const dto = {
      listingId,
      status: result.status,
      cancelledCoins: result.cancelledCoins,
      cancelledAt: result.cancelledAt !== null ? toIso(result.cancelledAt) : now.toISOString(),
      inserted: true,
    };
    await this.ledger.setCommitted(operationId, now, { ...dto }, tx);
    return dto;
  }
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}
