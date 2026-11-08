import type { AssetLedger } from '../../wallet/ports/wallet-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';
import type { ListingRepo, TradeRepo, Tx } from '../ports/coin-market-repository.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { TradeListUseCase } from './trade-list.js';

/** Bounded, transaction-scoped PAYMENT_EXPIRED scan. Each selected trade is processed by the exact same expiry core as read paths. */
export class CoinMarketExpiryScanUseCase {
  private readonly tradeList: TradeListUseCase;
  private readonly clock: Clock;

  constructor(
    private readonly trades: TradeRepo,
    listings: ListingRepo,
    ledger: AssetLedger,
    clock: Clock,
    private readonly batchLimit = 100,
  ) {
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 1000) throw new RangeError('batchLimit must be 1..1000');
    this.tradeList = new TradeListUseCase(trades, listings, ledger, clock);
    this.clock = clock;
  }

  async run(tx: Tx): Promise<{ selected: number; expired: number }> {
    const transaction = tx.transaction as { finished?: string | undefined } | null | undefined;
    if (transaction == null || transaction.finished != null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '到期扫描必须在活动事务中运行。', { retryable: true });
    }
    const dueAt = this.clock.now();
    const ids = await this.trades.listDuePaymentPendingTradeIds({ dueAt, limit: this.batchLimit, tx });
    if (ids.length > this.batchLimit)
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '到期扫描返回数量超过批次上限。', { retryable: true });
    let expired = 0;
    for (const tradeId of ids) {
      if ((await this.tradeList.expirePaymentPending(tradeId, tx)) !== null) expired += 1;
    }
    return { selected: ids.length, expired };
  }
}
