import { describe, expect, it, vi } from 'vitest';
import { isValidListingInvariant } from '../domain/listing-rules.js';
import { ListingCreateUseCase } from './listing-create.js';
import { TradeUseCase } from './trade-create.js';
import { TradeListUseCase } from './trade-list.js';
import { ListingCancelUseCase } from './listing-cancel.js';
import { PAYMENT_DEADLINE_SECONDS } from '../domain/listing-rules.js';
import { CoinMarketListingStatus5, CoinMarketTradeStatus11 } from '../domain/listing-rules.js';
import { AccountType, AssetType, HoldType } from '../../../infrastructure/database/models/wallet.js';
import { WalletEntryType } from '../../wallet/ports/wallet-repository.js';
import type { AssetLedger, EntryIntent } from '../../wallet/ports/wallet-repository.js';
import type { CoinMarketListingModel, CoinMarketTradeModel } from '../../../infrastructure/database/models/coin-market.js';
import type { ListingRepo, TradeRepo, Tx } from '../ports/coin-market-repository.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const tx: Tx = { transaction: {} };
const sellerAccount = { id: '10', amount: '20000', frozenAmount: '0' } as never;
const buyerAccount = { id: '11', amount: '5000', frozenAmount: '0' } as never;

function fakeLedger() {
  const operations = new Map<string, { id: string; requestHash: Uint8Array; snapshot: Record<string, unknown> | null }>();
  const entries: Array<{ operationId: string; intents: EntryIntent[] }> = [];
  const claimedKeys: string[] = [];
  let nextId = 100;
  const ledger = {
    async readAccount(userId: string, assetType: number, accountType: number) {
      expect([AssetType.COIN, AccountType.PLAYER]).toEqual([assetType, accountType]);
      if (userId === 'missing') return null;
      if (userId === 'buyer') return buyerAccount;
      return sellerAccount;
    },
    lockAccountsByIds: vi.fn(async (ids: string[]) => {
      expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual(ids);
      return ids.map((id) => (id === '11' ? buyerAccount : sellerAccount));
    }),
    async readHoldForOperation(holdId: string, expected: { accountId: string; holdType: number; amount: bigint }) {
      expect(holdId).toBe('500');
      expect(expected).toMatchObject({ accountId: '10', holdType: HoldType.COIN_MARKET_LISTING });
      expect(expected.amount).toBeGreaterThanOrEqual(0n);
      return { id: holdId, assetAccountId: expected.accountId, holdType: expected.holdType, remainingAmount: '10000' };
    },
    async claimOperation(input: { operationKey: string; requestHash: Uint8Array }) {
      claimedKeys.push(input.operationKey);
      const prev = operations.get(input.operationKey);
      if (prev) {
        expect(Buffer.from(prev.requestHash).equals(Buffer.from(input.requestHash))).toBe(true);
        if (prev.snapshot === null) throw new Error('operation pending');
        return { inserted: false, operation: { id: prev.id } };
      }
      const operation = { id: String(nextId++), requestHash: input.requestHash, snapshot: null };
      operations.set(input.operationKey, operation);
      return { inserted: true, operation: { id: operation.id } };
    },
    async getOperationResultSnapshot(id: string) {
      return [...operations.values()].find((op) => op.id === id)?.snapshot ?? null;
    },
    async setCommitted(id: string, _at: Date, snapshot: Record<string, unknown>) {
      const op = [...operations.values()].find((entry) => entry.id === id);
      if (!op || op.snapshot !== null) throw new Error('operation commit invalid');
      op.snapshot = snapshot;
    },
    async createHold(input: { assetAccountId: string; amount: string; holdKey: string }) {
      return {
        inserted: true,
        hold: {
          id: '500',
          assetAccountId: input.assetAccountId,
          amount: input.amount,
          remainingAmount: input.amount,
          holdKey: input.holdKey,
        },
      };
    },
    async postEntries(operationId: string, intents: EntryIntent[]) {
      entries.push({ operationId, intents });
      return [];
    },
    async releaseHoldAmount(input: { operationId: string; holdId: string; amount: bigint; intents: EntryIntent[] }) {
      expect(input.intents.filter((i) => i.assetHoldId === input.holdId && i.entryType === WalletEntryType.HOLD)).toHaveLength(1);
      expect(input.intents.reduce((sum, i) => sum + i.delta, 0n)).toBe(0n);
      entries.push({ operationId: input.operationId, intents: input.intents });
      return { hold: { remainingAmount: '500' }, posts: [] };
    },
    async consumeHoldAmount(input: { operationId: string; holdId: string; amount: bigint; intents: EntryIntent[] }) {
      expect(input.intents.filter((i) => i.assetHoldId === input.holdId && i.entryType === WalletEntryType.HOLD)).toHaveLength(1);
      entries.push({ operationId: input.operationId, intents: input.intents });
      return { hold: { remainingAmount: '0' }, posts: [] };
    },
    entries,
    claimedKeys,
  } as unknown as AssetLedger & { entries: Array<{ operationId: string; intents: EntryIntent[] }>; claimedKeys: string[] };
  return ledger;
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: '20',
    sellerUserId: 'seller',
    listingKey: 'listing-key-00000001',
    assetHoldId: '500',
    listedCoins: '10000',
    availableCoins: '10000',
    reservedCoins: '0',
    filledCoins: '0',
    cancelledCoins: '0',
    priceCentsPer1000Coins: '100',
    status: CoinMarketListingStatus5.ACTIVE,
    createdAt: now,
    cancelledAt: null,
    ...overrides,
  } as unknown as CoinMarketListingModel;
}

function trade(overrides: Record<string, unknown> = {}) {
  return {
    id: '30',
    coinMarketListingId: '20',
    buyerUserId: 'buyer',
    tradeKey: 'trade-key-00000001',
    coins: '500',
    grossCents: '50',
    sellerNetCents: '50',
    status: CoinMarketTradeStatus11.PAYMENT_PENDING,
    paymentDeadlineAt: new Date('2026-11-03T12:00:00Z'),
    paymentProofAssetId: null,
    chainTxId: null,
    paidAt: null,
    createdAt: now,
    ...overrides,
  } as unknown as CoinMarketTradeModel;
}

function clock() {
  return {
    now() {
      return now;
    },
  };
}

describe('coin market asset lifecycle use cases', () => {
  it('rejects financial lifecycle actions without an active transaction', async () => {
    const ledger = fakeLedger();
    const repo = {
      async lockTrade() {
        return trade();
      },
    } as unknown as TradeRepo;
    const listings = {} as ListingRepo;
    const useCase = new TradeListUseCase(repo, listings, ledger, clock());
    await expect(useCase.expirePaymentPending('30', { transaction: null })).rejects.toMatchObject({ code: expect.any(String) });
    await expect(useCase.expirePaymentPending('30', { transaction: { finished: 'commit' } })).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(ledger.entries).toHaveLength(0);
  });

  it('uses the SDD-confirmed 48 hour buyer payment window', () => {
    expect(PAYMENT_DEADLINE_SECONDS).toBe(48 * 60 * 60);
  });

  it('creates listing hold and frozen entry, replay returns original snapshot', async () => {
    const ledger = fakeLedger();
    let calls = 0;
    const repo = {
      async createListing(input: { assetHoldId: string; listingKey: string }) {
        calls += 1;
        return { inserted: true, listing: listing({ assetHoldId: input.assetHoldId, listingKey: input.listingKey }) };
      },
      async lockListingByKey(key: string) {
        return listing({ listingKey: key });
      },
    } as unknown as ListingRepo;
    const useCase = new ListingCreateUseCase(repo, ledger, clock());
    const input = {
      sellerUserId: 'seller',
      coins: '10000',
      priceCentsPer1000Coins: '100',
      listingKey: 'listing-key-00000001',
      receiveMethod: 1,
      receiveSnapshot: null,
      paymentMethods: [],
      tx,
    };
    const created = await useCase.run(input);
    const replay = await useCase.run(input);
    expect(calls).toBe(1);
    expect(created.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.listingId).toBe(created.listingId);
    expect(ledger.entries[0]?.intents[0]).toMatchObject({
      accountId: '10',
      delta: 0n,
      frozenDelta: 10000n,
      assetHoldId: '500',
      entryType: WalletEntryType.HOLD,
    });
  });

  it('cancels listing and releases only available hold coins; replay is idempotent', async () => {
    const ledger = fakeLedger();
    const active = listing({ availableCoins: '9000', reservedCoins: '1000' });
    let cancelCalls = 0;
    const repo = {
      async lockListing() {
        return active;
      },
      async cancelListing(input: { listingId: string; cancelledAt: Date }) {
        cancelCalls += 1;
        active.status = CoinMarketListingStatus5.CANCELLED;
        active.cancelledAt = input.cancelledAt;
        active.cancelledCoins = '9000';
        active.availableCoins = '0';
        return active;
      },
    } as unknown as ListingRepo;
    const useCase = new ListingCancelUseCase(repo, ledger, clock());
    const result = await useCase.run('seller', '20', tx);
    const replay = await useCase.run('seller', '20', tx);
    expect(cancelCalls).toBe(1);
    expect(result.cancelledCoins).toBe('9000');
    expect(replay.inserted).toBe(false);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.claimedKeys).toEqual(['coin-market:listing:20:cancel', 'coin-market:listing:20:cancel']);
    expect(ledger.entries[0]?.intents[0]).toMatchObject({ delta: 0n, frozenDelta: -9000n, assetHoldId: '500' });
  });

  it('replays a zero-available cancellation from its committed snapshot', async () => {
    const ledger = fakeLedger();
    const closed = listing({ availableCoins: '0', reservedCoins: '10000' });
    let calls = 0;
    const repo = {
      async lockListing() {
        return closed;
      },
      async cancelListing(input: { cancelledAt: Date }) {
        calls += 1;
        closed.status = CoinMarketListingStatus5.CANCELLED;
        closed.cancelledAt = input.cancelledAt;
        return closed;
      },
    } as unknown as ListingRepo;
    const useCase = new ListingCancelUseCase(repo, ledger, clock());
    const first = await useCase.run('seller', '20', tx);
    const second = await useCase.run('seller', '20', tx);
    expect(calls).toBe(1);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(ledger.entries).toHaveLength(0);
  });

  it('returns expired reservation to listing without changing seller hold', async () => {
    const ledger = fakeLedger();
    const expired = trade();
    let expiryCalls = 0;
    const repo = {
      async getTrade() {
        return expired;
      },
      async lockTrade() {
        return expired;
      },
      async expireTrade() {
        expiryCalls += 1;
        expired.status = CoinMarketTradeStatus11.PAYMENT_EXPIRED;
        return expired;
      },
    } as unknown as TradeRepo;
    const listings = {
      async lockListing() {
        return listing({ status: CoinMarketListingStatus5.SUSPENDED, availableCoins: '0', reservedCoins: '500', cancelledCoins: '9500' });
      },
    } as unknown as ListingRepo;
    const useCase = new TradeListUseCase(repo, listings, ledger, clock());
    const result = await useCase.expirePaymentPending('30', tx);
    const replay = await useCase.expirePaymentPending('30', tx);
    expect(result?.status).toBe(CoinMarketTradeStatus11.PAYMENT_EXPIRED);
    expect(replay?.status).toBe(CoinMarketTradeStatus11.PAYMENT_EXPIRED);
    expect(expiryCalls).toBe(1);
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.claimedKeys).toEqual(['coin-market:trade:30:expire', 'coin-market:trade:30:expire']);
  });

  it('cancels buyer trade only before proof and preserves listing hold', async () => {
    const ledger = fakeLedger();
    const pending = trade({ paymentDeadlineAt: new Date('2026-11-05T12:00:00Z') });
    let cancelCalls = 0;
    const trades = {
      async getTrade() {
        return pending;
      },
      async lockTrade() {
        return pending;
      },
      async cancelTrade() {
        cancelCalls += 1;
        pending.status = CoinMarketTradeStatus11.CANCELLED;
        return pending;
      },
    } as unknown as TradeRepo;
    const listings = {
      async lockListing() {
        return listing({ availableCoins: '9500', reservedCoins: '500' });
      },
    } as unknown as ListingRepo;
    const lockAccounts = ledger.lockAccountsByIds as ReturnType<typeof vi.fn>;
    const useCase = new TradeListUseCase(trades, listings, ledger, clock());
    const first = await useCase.cancel('buyer', '30', tx);
    const replay = await useCase.cancel('buyer', '30', tx);
    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(cancelCalls).toBe(1);
    expect(lockAccounts).toHaveBeenCalledOnce();
    expect(lockAccounts).toHaveBeenCalledWith(['10'], tx);
    expect(ledger.entries).toHaveLength(0);
  });

  it('releases reserved slice when cancelling a trade on a cancelled listing', async () => {
    const ledger = fakeLedger();
    const pending = trade({ paymentDeadlineAt: new Date('2026-11-05T12:00:00Z') });
    const trades = {
      async getTrade() {
        return pending;
      },
      async lockTrade() {
        return pending;
      },
      async cancelTrade() {
        pending.status = CoinMarketTradeStatus11.CANCELLED;
        return pending;
      },
    } as unknown as TradeRepo;
    const listings = {
      async lockListing() {
        return listing({ status: CoinMarketListingStatus5.CANCELLED, availableCoins: '0', reservedCoins: '500', cancelledCoins: '9500' });
      },
    } as unknown as ListingRepo;
    const result = await new TradeListUseCase(trades, listings, ledger, clock()).cancel('buyer', '30', tx);
    expect(result.inserted).toBe(true);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.intents[0]).toMatchObject({ accountId: '10', delta: 0n, frozenDelta: -500n, assetHoldId: '500' });
  });

  it('rejects buyer cancellation after payment proof submission', async () => {
    const ledger = fakeLedger();
    const submitted = trade({ paymentProofAssetId: 'proof-asset' });
    const trades = {
      async getTrade() {
        return submitted;
      },
      async lockTrade() {
        return submitted;
      },
    } as unknown as TradeRepo;
    const listings = {
      async lockListing() {
        return listing();
      },
    } as unknown as ListingRepo;
    const useCase = new TradeListUseCase(trades, listings, ledger, clock());
    await expect(useCase.cancel('buyer', '30', tx)).rejects.toMatchObject({ code: expect.any(String) });
    expect(ledger.entries).toHaveLength(0);
  });

  it('consumes seller hold and credits buyer once on final release', async () => {
    const ledger = fakeLedger();
    const pending = trade({ status: CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING });
    let releaseCalls = 0;
    const trades = {
      async getTrade() {
        return pending;
      },
      async lockTrade() {
        return pending;
      },
      async releaseToBuyer() {
        releaseCalls += 1;
        pending.status = CoinMarketTradeStatus11.RELEASED;
        return pending;
      },
    } as unknown as TradeRepo;
    const listings = {
      async lockListing() {
        return listing({ availableCoins: '9500', reservedCoins: '500' });
      },
    } as unknown as ListingRepo;
    const useCase = new TradeUseCase(trades, listings, ledger, clock());
    const result = await useCase.releaseToBuyer({ tradeId: '30', actorUserId: 'buyer', tx });
    const replay = await useCase.releaseToBuyer({ tradeId: '30', actorUserId: 'buyer', tx });
    expect(releaseCalls).toBe(1);
    expect(result.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    const intents = ledger.entries[0]?.intents ?? [];
    expect(intents.map((entry) => [entry.accountId, entry.delta, entry.frozenDelta])).toEqual([
      ['10', -500n, -500n],
      ['11', 500n, 0n],
    ]);
    expect(intents.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
  });

  it('preserves listing inventory arithmetic and rejects drift', () => {
    expect(
      isValidListingInvariant({
        listedCoins: '10000',
        availableCoins: '0',
        reservedCoins: '3000',
        filledCoins: '0',
        cancelledCoins: '7000',
      }),
    ).toBe(true);
    expect(
      isValidListingInvariant({ listedCoins: '10000', availableCoins: '1', reservedCoins: '0', filledCoins: '0', cancelledCoins: '0' }),
    ).toBe(false);
  });
});
