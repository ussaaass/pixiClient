import { describe, expect, it } from 'vitest';
import { CoinMarketExpiryScanUseCase } from './coin-market-expiry-scan.js';
import type { AssetLedger } from '../../wallet/ports/wallet-repository.js';
import type { ListingRepo, TradeRepo, Tx } from '../ports/coin-market-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';

const tx: Tx = { transaction: {} };
const now = new Date('2026-11-04T18:00:00Z');

describe('CoinMarketExpiryScanUseCase', () => {
  it('selects at most configured batch and delegates each item to the expiry core', async () => {
    const ids = ['1', '2'];
    const selected: unknown[] = [];
    const trades = {
      async listDuePaymentPendingTradeIds(input: { dueAt: Date; limit: number; tx: Tx }) {
        selected.push(input);
        return ids;
      },
      async getTrade(id: string) {
        return { id, coinMarketListingId: '9', buyerUserId: 'buyer', coins: '1', status: 1, paymentDeadlineAt: new Date('2026-11-03') };
      },
      async lockTrade(id: string) {
        return { id, coinMarketListingId: '9', buyerUserId: 'buyer', coins: '1', status: 1, paymentDeadlineAt: new Date('2026-11-03') };
      },
      async expireTrade() {
        return { status: 9 };
      },
    } as unknown as TradeRepo;
    const listings = {
      async lockListing() {
        return { id: '9', sellerUserId: 'seller', assetHoldId: '10', status: 1 };
      },
    } as unknown as ListingRepo;
    const ledger = {
      async readAccount(userId: string) {
        expect(userId).toBe('seller');
        return { id: '11' };
      },
      async lockAccountsByIds(ids: string[]) {
        expect(ids).toEqual(['11']);
        return [{ id: '11' }];
      },
      async readHoldForOperation(holdId: string, expected: { accountId: string; holdType: number; amount: bigint }) {
        expect(expected.amount).toBe(1n);
        return { id: holdId, assetAccountId: expected.accountId, holdType: expected.holdType, remainingAmount: '1000' };
      },
      async claimOperation() {
        return { inserted: true, operation: { id: '12' } };
      },
      async releaseHoldAmount() {
        return { hold: { remainingAmount: '0' } };
      },
      async setCommitted() {},
    } as unknown as AssetLedger;
    const clock = { now: () => now } as Clock;
    const scanner = new CoinMarketExpiryScanUseCase(trades, listings, ledger, clock, 2);
    expect(await scanner.run(tx)).toEqual({ selected: 2, expired: 2 });
    expect(selected).toEqual([{ dueAt: now, limit: 2, tx }]);
  });

  it('rejects repository results that violate the batch bound', async () => {
    const trades = {
      async listDuePaymentPendingTradeIds() {
        return ['1', '2'];
      },
    } as unknown as TradeRepo;
    const scan = new CoinMarketExpiryScanUseCase(trades, {} as ListingRepo, {} as AssetLedger, { now: () => now }, 1);
    await expect(scan.run(tx)).rejects.toThrow();
  });

  it('rejects absent transaction and invalid batch limit', async () => {
    const trades = {} as TradeRepo;
    const listings = {} as ListingRepo;
    const ledger = {} as AssetLedger;
    const clock = { now: () => now } as Clock;
    expect(() => new CoinMarketExpiryScanUseCase(trades, listings, ledger, clock, 1001)).toThrow(RangeError);
    const scan = new CoinMarketExpiryScanUseCase(trades, listings, ledger, clock);
    await expect(scan.run({ transaction: null })).rejects.toThrow();
    await expect(scan.run({ transaction: { finished: 'commit' } })).rejects.toThrow();
  });
});
