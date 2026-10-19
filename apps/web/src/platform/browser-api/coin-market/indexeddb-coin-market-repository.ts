import { CoinMarketErrorCode, CoinMarketListingStatus, CoinMarketPaymentMethod, CoinMarketTradeStatus, type CoinMarketListingCreateRequestDto, type CoinMarketListingDto, type CoinMarketTradeCreateRequestDto, type CoinMarketTradeDto, type CoinMarketTradeTextRequestDto } from '@gameing/contracts/coin-market';
import type { BrowserDevelopmentDatabase, LocalAssetAccount, LocalAssetEntry, LocalAssetHold, LocalAssetOperation, LocalCoinMarketListing, LocalCoinMarketTrade, LocalSetting } from '../database';
import { quoteCoinMarketPrice } from '../../coin-market/coin-market-pricing';
import { LocalAssetHoldStatus, LocalAssetOperationStatus, LocalAssetOperationType, LocalAssetType } from '../wallet/local-asset-constants';
import { ensureLocalDemoSocialUsers, LOCAL_DEMO_SOCIAL_USERS } from '../social/local-demo-social-seed';

const LISTING_HOLD_TYPE = 'COIN_MARKET_LISTING' as const;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

function configInteger(value: unknown, fallback: bigint): bigint {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) ? BigInt(value) : fallback;
}

function toDto(listing: LocalCoinMarketListing): CoinMarketListingDto {
  return {
    listingId: listing.listingId,
    coins: listing.coins,
    availableCoins: listing.availableCoins,
    priceCentsPer1000Coins: listing.priceCentsPer1000Coins,
    referenceCentsPer1000Coins: listing.referenceCentsPer1000Coins,
    totalCents: listing.totalCents,
    status: listing.status,
    createdAt: listing.createdAt,
    ...(listing.sellerLabel ? { sellerLabel: listing.sellerLabel } : { sellerLabel: '集市卖家' }),
    paymentMethods: listing.paymentMethods ?? [],
  };
}
function tradeDto(trade: LocalCoinMarketTrade, actorRole: 'BUYER' | 'SELLER'): CoinMarketTradeDto {
  const { buyerUserId: _buyerUserId, sellerUserId: _sellerUserId, idempotencyKey: _idempotencyKey, ...publicTrade } = trade;
  return { ...publicTrade, actorRole };
}

async function allocateId(settings: { get(key: 'next-id'): Promise<LocalSetting | undefined>; put(value: LocalSetting): Promise<unknown> }): Promise<string> {
  const current = await settings.get('next-id');
  const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
  await settings.put({ key: 'next-id', value: (id + 1n).toString() });
  return id.toString();
}
function abort(transaction: { abort(): void; done: Promise<unknown> }, code: string): never {
  void transaction.done.catch(() => undefined);
  transaction.abort();
  throw new Error(code);
}

async function transactionDone(transaction: { done: Promise<unknown> }): Promise<void> {
  await transaction.done;
}

export class IndexedDbCoinMarketRepository {
  constructor(private readonly database: BrowserDevelopmentDatabase) {}

  async listMine(userId: string): Promise<CoinMarketListingDto[]> {
    await this.ensureDemoOwnListing(userId);
    const rows = await this.database.getAllFromIndex('coin_market_listings', 'by-seller-created', IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toDto);
  }

  private async ensureDemoOwnListing(userId: string): Promise<void> {
    if (!import.meta.env.DEV) return;
    const seedKey = `local-demo-own-market-listing:v1:${userId}`;
    if (await this.database.get('settings', seedKey)) return;
    const transaction = this.database.transaction(['settings', 'coin_market_listings'], 'readwrite');
    const settings = transaction.objectStore('settings');
    const listings = transaction.objectStore('coin_market_listings');
    const existing = await listings.index('by-seller-created').getAll(IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    if (!existing.length) {
      const now = new Date().toISOString();
      const listingId = await allocateId(settings);
      const preview: LocalCoinMarketListing = {
        listingId, sellerUserId: userId, sellerLabel: '本机样例 · 不涉及资产', idempotencyKey: `local-demo-own-market-listing:v1:${userId}`,
        coins: '5000', availableCoins: '0', priceCentsPer1000Coins: '12000', referenceCentsPer1000Coins: '10000', totalCents: '60000',
        assetHoldId: listingId, paymentMethods: [CoinMarketPaymentMethod.BANK_TRANSFER], paymentInstructions: '本机只读页面样例，不是收款资料。',
        reservedCoins: '0', soldCoins: '0', status: CoinMarketListingStatus.CANCELLED, createdAt: now, updatedAt: now,
      };
      await listings.add(preview);
    }
    await settings.put({ key: seedKey, value: true });
    await transaction.done;
  }

  async listPublic(cursor?: string): Promise<{ items: CoinMarketListingDto[]; nextCursor: string | null; minimumTradeCoins: string }> {
    await this.ensureDemoListings();
    await this.reconcileDeadlines();
    const all = (await this.database.getAll('coin_market_listings')).filter((row) => row.status === CoinMarketListingStatus.ACTIVE && BigInt(row.availableCoins) > 0n)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.listingId.localeCompare(a.listingId));
    const after = cursor ? all.filter((row) => `${row.createdAt}~${row.listingId}` < cursor) : all;
    const page = after.slice(0, 21);
    const items = page.slice(0, 20).map(toDto);
    const last = page.length > 20 ? page[19] : undefined;
    const setting = await this.database.get('settings', 'system_config:coin_market.minimum_trade_coins');
    return { items, nextCursor: last ? `${last.createdAt}~${last.listingId}` : null, minimumTradeCoins: configInteger(setting?.value, 1_000n).toString() };
  }

  private async ensureDemoListings(): Promise<void> {
    if (import.meta.env.MODE === 'test') return;
    await ensureLocalDemoSocialUsers(this.database);
    const seedKey = 'local-demo-coin-market:seed:v1';
    if (await this.database.get('settings', seedKey)) {
      const rows = await this.database.getAll('coin_market_listings');
      for (const demo of LOCAL_DEMO_SOCIAL_USERS.slice(0, 3)) {
        for (const row of rows.filter((listing) => listing.sellerUserId === demo.userId && !listing.sellerLabel?.startsWith('演示 · '))) {
          await this.database.put('coin_market_listings', { ...row, sellerLabel: `演示 · ${demo.displayName}` });
        }
      }
      return;
    }
    const now = new Date().toISOString();
    const systemSettingKey = 'wallet:system-user-id';
    const transaction = this.database.transaction(['users', 'settings', 'asset_accounts', 'asset_operations', 'asset_entries', 'turnover_states'], 'readwrite');
    const users = transaction.objectStore('users');
    const settings = transaction.objectStore('settings');
    const accounts = transaction.objectStore('asset_accounts');
    const operations = transaction.objectStore('asset_operations');
    const entries = transaction.objectStore('asset_entries');
    const systemIdValue = (await settings.get(systemSettingKey))?.value;
    let systemUserId = typeof systemIdValue === 'string' ? systemIdValue : '';
    if (!systemUserId) {
      systemUserId = await allocateId(settings);
      await users.put({ userId: systemUserId, displayName: '系统账户', roleType: 8, status: 'ACTIVE', authVersion: 1 });
      await settings.put({ key: systemSettingKey, value: systemUserId });
    }
    const systemAccountId = `${systemUserId}:${LocalAssetType.COIN}`;
    const systemAccount = await accounts.get(systemAccountId) ?? { accountId: systemAccountId, userId: systemUserId, assetType: LocalAssetType.COIN, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    let systemCoins = BigInt(systemAccount.amount);
    for (const [index, demo] of LOCAL_DEMO_SOCIAL_USERS.slice(0, 3).entries()) {
      const user = await users.get(demo.userId);
      if (!user) continue;
      const accountId = `${demo.userId}:${LocalAssetType.COIN}`;
      const account = await accounts.get(accountId) ?? { accountId, userId: demo.userId, assetType: LocalAssetType.COIN, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
      const initialCoins = 30_000n;
      if (BigInt(account.amount) < initialCoins) {
        const delta = initialCoins - BigInt(account.amount);
        const operationId = await allocateId(settings);
        const playerEntryId = await allocateId(settings);
        const systemEntryId = await allocateId(settings);
        const nextSystem = systemCoins - delta;
        await operations.add({ operationId, idempotencyKey: `local-demo-market-initial:${demo.userId}`, operationType: LocalAssetOperationType.INITIAL_GIFT, status: LocalAssetOperationStatus.RECORDED, createdAt: now, extra: { source: 'LOCAL_DEMO_FIXTURE', sellerUserId: demo.userId } });
        await entries.add({ entryId: playerEntryId, operationId, accountId, delta: delta.toString(), balanceAfter: initialCoins.toString(), createdAt: now });
        await entries.add({ entryId: systemEntryId, operationId, accountId: systemAccountId, delta: (-delta).toString(), balanceAfter: nextSystem.toString(), createdAt: now });
        await accounts.put({ ...account, amount: initialCoins.toString(), version: account.version + 1 });
        systemCoins = nextSystem;
      }
      if (!await transaction.objectStore('turnover_states').get(demo.userId)) await transaction.objectStore('turnover_states').put({ userId: demo.userId, remainingCoins: '0', updatedAt: now });
      void index;
    }
    await accounts.put({ ...systemAccount, amount: systemCoins.toString(), version: systemAccount.version + 1 });
    await transaction.done;

    const offers = [
      { seller: LOCAL_DEMO_SOCIAL_USERS[0]!, coins: '12000', price: '10800', methods: [CoinMarketPaymentMethod.ALIPAY, CoinMarketPaymentMethod.BANK_TRANSFER] },
      { seller: LOCAL_DEMO_SOCIAL_USERS[1]!, coins: '8000', price: '11500', methods: [CoinMarketPaymentMethod.WECHAT, CoinMarketPaymentMethod.UNION_QR] },
      { seller: LOCAL_DEMO_SOCIAL_USERS[2]!, coins: '20000', price: '12100', methods: [CoinMarketPaymentMethod.DIGITAL_RMB, CoinMarketPaymentMethod.BANK_TRANSFER] },
    ];
    for (const [index, offer] of offers.entries()) {
      await this.create(offer.seller.userId, {
        coins: offer.coins,
        priceCentsPer1000Coins: offer.price,
        idempotencyKey: `local-demo-market-seed-v1-${index + 1}`,
        paymentMethods: offer.methods,
        paymentInstructions: '本地演示收款资料：此为虚构挂牌，不可用于真实转账。',
      });
      const row = await this.database.getFromIndex('coin_market_listings', 'by-seller-idempotency', [offer.seller.userId, `local-demo-market-seed-v1-${index + 1}`]);
      if (row && !row.sellerLabel) await this.database.put('coin_market_listings', { ...row, sellerLabel: `演示 · ${offer.seller.displayName}` });
    }
    await this.database.put('settings', { key: seedKey, value: true });
  }

  async create(userId: string, input: CoinMarketListingCreateRequestDto): Promise<CoinMarketListingDto> {
    const transaction = this.database.transaction(['users', 'settings', 'asset_accounts', 'asset_operations', 'asset_entries', 'asset_holds', 'coin_market_listings', 'turnover_states'], 'readwrite');
    const listings = transaction.objectStore('coin_market_listings');
    const prior = await listings.index('by-seller-idempotency').get([userId, input.idempotencyKey]);
    if (prior) {
      if (prior.sellerUserId !== userId || prior.coins !== input.coins || prior.priceCentsPer1000Coins !== input.priceCentsPer1000Coins) abort(transaction, CoinMarketErrorCode.IDEMPOTENCY_KEY_REUSED);
      await transactionDone(transaction);
      return toDto(prior);
    }

    const users = transaction.objectStore('users');
    const user = await users.get(userId);
    if (!user || user.status !== 'ACTIVE') abort(transaction, 'WALLET_USER_NOT_ELIGIBLE');
    const settings = transaction.objectStore('settings');
    const ratioRecord = await settings.get('system_config:cny_to_coin_ratio');
    const minimumRecord = await settings.get('system_config:coin_market.minimum_listing_coins');
    const ratio = typeof ratioRecord?.value === 'string' && /^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$/.test(ratioRecord.value) ? ratioRecord.value.split(':') : ['1', '10'];
    const reference = { rateCashFen: BigInt(ratio[0]!) * 100n, rateCoinUnits: BigInt(ratio[1]!) };
    const quote = quoteCoinMarketPrice({ coins: input.coins, priceCentsPer1000Coins: input.priceCentsPer1000Coins }, reference);
    const minimumCoins = configInteger(minimumRecord?.value, 1_000n);
    if (BigInt(input.coins) < minimumCoins) abort(transaction, CoinMarketErrorCode.LISTING_BELOW_MINIMUM);
    if (BigInt(input.coins) > MAX_SIGNED_BIGINT) abort(transaction, CoinMarketErrorCode.AMOUNT_OUT_OF_RANGE);
    const turnover = await transaction.objectStore('turnover_states').get(userId);
    if (BigInt(turnover?.remainingCoins ?? '0') > 0n) abort(transaction, CoinMarketErrorCode.TURNOVER_INCOMPLETE);

    const accountId = `${userId}:${LocalAssetType.COIN}`;
    const accounts = transaction.objectStore('asset_accounts');
    const account = await accounts.get(accountId);
    const coins = BigInt(input.coins);
    if (!account || BigInt(account.amount) - BigInt(account.frozenAmount) < coins) abort(transaction, CoinMarketErrorCode.INSUFFICIENT_AVAILABLE_BALANCE);

    const now = new Date().toISOString();
    const listingId = await allocateId(settings);
    const operationId = await allocateId(settings);
    const holdId = await allocateId(settings);
    const entryId = await allocateId(settings);
    const listing: LocalCoinMarketListing = {
      listingId, sellerUserId: userId, idempotencyKey: input.idempotencyKey, coins: input.coins,
      availableCoins: input.coins, priceCentsPer1000Coins: input.priceCentsPer1000Coins,
      referenceCentsPer1000Coins: quote.referenceCentsPer1000Coins, totalCents: quote.grossCents,
      assetHoldId: holdId, paymentMethods: [...new Set(input.paymentMethods)], paymentInstructions: input.paymentInstructions.trim(), reservedCoins: '0', soldCoins: '0', status: CoinMarketListingStatus.ACTIVE, createdAt: now, updatedAt: now,
    };
    const hold: LocalAssetHold = {
      holdId, userId, accountId, businessType: LISTING_HOLD_TYPE, businessId: listingId,
      initialAmount: input.coins, remainingAmount: input.coins, consumedAmount: '0', releasedAmount: '0',
      status: LocalAssetHoldStatus.ACTIVE, createdAt: now, updatedAt: now,
    };
    const operation: LocalAssetOperation = {
      operationId, idempotencyKey: `coin-market-listing-create:${listingId}`, operationType: LocalAssetOperationType.COIN_MARKET_LISTING_HOLD, status: LocalAssetOperationStatus.RECORDED, createdAt: now,
      extra: { listingId, assetHoldId: holdId, userId, coins: input.coins, action: 'HOLD' },
    };
    const entry: LocalAssetEntry = { entryId, operationId, accountId, delta: '0', frozenDelta: input.coins, balanceAfter: account.amount, createdAt: now };
    await accounts.put({ ...account, frozenAmount: (BigInt(account.frozenAmount) + coins).toString(), version: account.version + 1 });
    await transaction.objectStore('asset_holds').add(hold);
    await listings.add(listing);
    await transaction.objectStore('asset_operations').add(operation);
    await transaction.objectStore('asset_entries').add(entry);
    await transactionDone(transaction);
    return toDto(listing);
  }

  async createTrade(buyerUserId: string, listingId: string, input: CoinMarketTradeCreateRequestDto): Promise<CoinMarketTradeDto> {
    await this.reconcileDeadlines();
    const tx = this.database.transaction(['users', 'settings', 'coin_market_listings', 'coin_market_trades'], 'readwrite');
    const listings = tx.objectStore('coin_market_listings');
    const trades = tx.objectStore('coin_market_trades');
    const prior = await trades.index('by-idempotency-key').get([buyerUserId, input.idempotencyKey]);
    if (prior) {
      if (prior.listingId !== listingId || prior.coins !== input.coins || prior.paymentMethod !== input.paymentMethod) abort(tx, CoinMarketErrorCode.IDEMPOTENCY_KEY_REUSED);
      await transactionDone(tx); return tradeDto(prior, 'BUYER');
    }
    const listing = await listings.get(listingId);
    if (!listing || listing.status !== CoinMarketListingStatus.ACTIVE || listing.sellerUserId === buyerUserId) abort(tx, CoinMarketErrorCode.LISTING_NOT_FOUND);
    const buyer = await tx.objectStore('users').get(buyerUserId);
    if (!buyer || buyer.status !== 'ACTIVE') abort(tx, CoinMarketErrorCode.TRADE_NOT_ALLOWED);
    const minimum = configInteger((await tx.objectStore('settings').get('system_config:coin_market.minimum_trade_coins'))?.value, 1_000n);
    const coins = BigInt(input.coins);
    if (coins < minimum) abort(tx, CoinMarketErrorCode.TRADE_BELOW_MINIMUM);
    if (!listing.paymentMethods?.includes(input.paymentMethod)) abort(tx, CoinMarketErrorCode.TRADE_NOT_ALLOWED);
    if (input.paymentMethod === CoinMarketPaymentMethod.USDT_TRC20) abort(tx, CoinMarketErrorCode.PAYMENT_HANDLER_UNAVAILABLE);
    if (coins > BigInt(listing.availableCoins)) abort(tx, CoinMarketErrorCode.INSUFFICIENT_AVAILABLE_BALANCE);
    const now = new Date().toISOString();
    const tradeId = await allocateId(tx.objectStore('settings'));
    const grossCents = ((BigInt(listing.priceCentsPer1000Coins) * coins + 999n) / 1000n).toString();
    const trade: LocalCoinMarketTrade = { tradeId, listingId, buyerUserId, sellerUserId: listing.sellerUserId, coins: coins.toString(), grossCents, status: CoinMarketTradeStatus.PAYMENT_PENDING, paymentMethod: input.paymentMethod, paymentInstructions: listing.paymentInstructions, paymentDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), sellerDeadlineAt: null, buyerEvidenceDeadlineAt: null, sellerEvidenceDeadlineAt: null, platformDecisionDeadlineAt: null, paymentProof: null, appealReason: null, buyerEvidence: null, sellerEvidence: null, idempotencyKey: input.idempotencyKey, createdAt: now, updatedAt: now };
    await listings.put({ ...listing, availableCoins: (BigInt(listing.availableCoins) - coins).toString(), reservedCoins: (BigInt(listing.reservedCoins ?? '0') + coins).toString(), updatedAt: now });
    await trades.add(trade);
    await transactionDone(tx);
    return tradeDto(trade, 'BUYER');
  }

  async listTrades(userId: string): Promise<CoinMarketTradeDto[]> {
    await this.reconcileDeadlines();
    const [buyer, seller] = await Promise.all([
      this.database.getAllFromIndex('coin_market_trades', 'by-buyer-created', IDBKeyRange.bound([userId, ''], [userId, '\uffff'])),
      this.database.getAllFromIndex('coin_market_trades', 'by-seller-created', IDBKeyRange.bound([userId, ''], [userId, '\uffff'])),
    ]);
    return [...new Map([...buyer, ...seller].map((trade) => [trade.tradeId, trade])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((trade) => tradeDto(trade, trade.buyerUserId === userId ? 'BUYER' : 'SELLER'));
  }

  async submitPaymentProof(userId: string, tradeId: string, input: CoinMarketTradeTextRequestDto): Promise<CoinMarketTradeDto> { return this.command(userId, tradeId, 'BUYER', input.text, CoinMarketTradeStatus.PAYMENT_PENDING); }
  async appeal(userId: string, tradeId: string, input: CoinMarketTradeTextRequestDto): Promise<CoinMarketTradeDto> {
    const trade = await this.getTrade(userId, tradeId);
    if (trade.sellerUserId !== userId || trade.status !== CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING) throw new Error(CoinMarketErrorCode.TRADE_STATE_INVALID);
    if (trade.sellerDeadlineAt && trade.sellerDeadlineAt <= new Date().toISOString()) throw new Error(CoinMarketErrorCode.TRADE_DEADLINE_PASSED);
    const now = new Date().toISOString();
    const updated = { ...trade, status: CoinMarketTradeStatus.DISPUTED, appealReason: input.text.trim(), buyerEvidenceDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), updatedAt: now };
    await this.database.put('coin_market_trades', updated);
    return tradeDto(updated, 'SELLER');
  }
  async submitBuyerEvidence(userId: string, tradeId: string, input: CoinMarketTradeTextRequestDto): Promise<CoinMarketTradeDto> { return this.evidence(userId, tradeId, input.text, true); }
  async submitSellerEvidence(userId: string, tradeId: string, input: CoinMarketTradeTextRequestDto): Promise<CoinMarketTradeDto> { return this.evidence(userId, tradeId, input.text, false); }
  async confirmReceipt(userId: string, tradeId: string): Promise<CoinMarketTradeDto> {
    const trade = await this.getTrade(userId, tradeId);
    if (trade.sellerUserId !== userId || trade.status !== CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING) throw new Error(CoinMarketErrorCode.TRADE_STATE_INVALID);
    return this.release(trade, 'SELLER');
  }

  private async command(userId: string, tradeId: string, role: 'BUYER' | 'SELLER', text: string, expected: LocalCoinMarketTrade['status']): Promise<CoinMarketTradeDto> {
    const trade = await this.getTrade(userId, tradeId);
    if ((role === 'BUYER' ? trade.buyerUserId : trade.sellerUserId) !== userId) throw new Error(CoinMarketErrorCode.TRADE_NOT_FOUND);
    if (trade.status !== expected) throw new Error(CoinMarketErrorCode.TRADE_STATE_INVALID);
    const now = new Date().toISOString();
    if (role === 'BUYER' && trade.paymentDeadlineAt <= now) throw new Error(CoinMarketErrorCode.TRADE_DEADLINE_PASSED);
    const updated = { ...trade, status: CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING, paymentProof: text.trim(), sellerDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), updatedAt: now };
    await this.database.put('coin_market_trades', updated);
    return tradeDto(updated, role);
  }
  private async evidence(userId: string, tradeId: string, text: string, buyer: boolean): Promise<CoinMarketTradeDto> {
    const trade = await this.getTrade(userId, tradeId);
    const expected = buyer ? CoinMarketTradeStatus.DISPUTED : CoinMarketTradeStatus.SELLER_EVIDENCE_PENDING;
    if ((buyer ? trade.buyerUserId : trade.sellerUserId) !== userId || trade.status !== expected) throw new Error(CoinMarketErrorCode.TRADE_STATE_INVALID);
    const now = new Date().toISOString();
    const deadline = buyer ? trade.buyerEvidenceDeadlineAt : trade.sellerEvidenceDeadlineAt;
    if (deadline && deadline <= now) throw new Error(CoinMarketErrorCode.TRADE_DEADLINE_PASSED);
    const updated: LocalCoinMarketTrade = buyer
      ? { ...trade, status: CoinMarketTradeStatus.SELLER_EVIDENCE_PENDING, buyerEvidence: text.trim(), sellerEvidenceDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), updatedAt: now }
      : { ...trade, status: CoinMarketTradeStatus.PLATFORM_REVIEW, sellerEvidence: text.trim(), platformDecisionDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), updatedAt: now };
    await this.database.put('coin_market_trades', updated); return tradeDto(updated, buyer ? 'BUYER' : 'SELLER');
  }
  private async getTrade(userId: string, tradeId: string): Promise<LocalCoinMarketTrade> {
    const trade = await this.database.get('coin_market_trades', tradeId);
    if (!trade || (trade.buyerUserId !== userId && trade.sellerUserId !== userId)) throw new Error(CoinMarketErrorCode.TRADE_NOT_FOUND);
    return trade;
  }
  private async release(trade: LocalCoinMarketTrade, actorRole: 'BUYER' | 'SELLER'): Promise<CoinMarketTradeDto> {
    const tx = this.database.transaction(['settings', 'asset_accounts', 'asset_entries', 'asset_operations', 'asset_holds', 'coin_market_listings', 'coin_market_trades'], 'readwrite');
    const trades = tx.objectStore('coin_market_trades'); const stored = await trades.get(trade.tradeId);
    if (!stored || stored.status !== CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING) abort(tx, CoinMarketErrorCode.TRADE_STATE_INVALID);
    const listingStore = tx.objectStore('coin_market_listings'); const listing = await listingStore.get(trade.listingId);
    const holdStore = tx.objectStore('asset_holds'); const hold = listing ? await holdStore.get(listing.assetHoldId) : undefined;
    const accounts = tx.objectStore('asset_accounts'); const sellerAccount = hold ? await accounts.get(hold.accountId) : undefined;
    const buyerAccountId = `${trade.buyerUserId}:${LocalAssetType.COIN}`; const buyerAccount = await accounts.get(buyerAccountId);
    if (!listing || !hold || !sellerAccount || !buyerAccount || BigInt(hold.remainingAmount) < BigInt(trade.coins) || BigInt(sellerAccount.frozenAmount) < BigInt(trade.coins)) abort(tx, CoinMarketErrorCode.LISTING_HOLD_INCONSISTENT);
    const settings = tx.objectStore('settings'); const operationId = await allocateId(settings); const outId = await allocateId(settings); const inId = await allocateId(settings); const now = new Date().toISOString(); const amount = BigInt(trade.coins);
    await accounts.put({ ...sellerAccount, amount: (BigInt(sellerAccount.amount) - amount).toString(), frozenAmount: (BigInt(sellerAccount.frozenAmount) - amount).toString(), version: sellerAccount.version + 1 });
    await accounts.put({ ...buyerAccount, amount: (BigInt(buyerAccount.amount) + amount).toString(), version: buyerAccount.version + 1 });
    await tx.objectStore('asset_operations').add({ operationId, idempotencyKey: `coin-market-trade-release:${trade.tradeId}`, operationType: LocalAssetOperationType.COIN_MARKET_TRADE_RELEASE, status: LocalAssetOperationStatus.RECORDED, createdAt: now, extra: { tradeId: trade.tradeId, listingId: trade.listingId, coins: trade.coins } });
    await tx.objectStore('asset_entries').add({ entryId: outId, operationId, accountId: sellerAccount.accountId, delta: `-${trade.coins}`, frozenDelta: `-${trade.coins}`, balanceAfter: (BigInt(sellerAccount.amount) - amount).toString(), createdAt: now });
    await tx.objectStore('asset_entries').add({ entryId: inId, operationId, accountId: buyerAccountId, delta: trade.coins, balanceAfter: (BigInt(buyerAccount.amount) + amount).toString(), createdAt: now });
    await holdStore.put({ ...hold, remainingAmount: (BigInt(hold.remainingAmount) - amount).toString(), consumedAmount: (BigInt(hold.consumedAmount) + amount).toString(), status: BigInt(hold.remainingAmount) === amount ? LocalAssetHoldStatus.CONSUMED : hold.status, updatedAt: now });
    await listingStore.put({ ...listing, reservedCoins: (BigInt(listing.reservedCoins) - amount).toString(), soldCoins: (BigInt(listing.soldCoins) + amount).toString(), status: BigInt(listing.availableCoins) === 0n && BigInt(listing.reservedCoins) === amount ? CoinMarketListingStatus.COMPLETED : listing.status, updatedAt: now });
    const updated = { ...stored, status: CoinMarketTradeStatus.RELEASED, updatedAt: now }; await trades.put(updated); await transactionDone(tx); return tradeDto(updated, actorRole);
  }
  private async reconcileDeadlines(): Promise<void> {
    const now = new Date().toISOString();
    const trades = await this.database.getAll('coin_market_trades');
    for (const trade of trades) {
      if (trade.status === CoinMarketTradeStatus.PAYMENT_PENDING && trade.paymentDeadlineAt <= now) { await this.expirePayment(trade); continue; }
      if (trade.status === CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING && trade.sellerDeadlineAt && trade.sellerDeadlineAt <= now) { await this.release(trade, 'SELLER'); continue; }
      if ((trade.status === CoinMarketTradeStatus.DISPUTED || trade.status === CoinMarketTradeStatus.BUYER_EVIDENCE_PENDING) && trade.buyerEvidenceDeadlineAt && trade.buyerEvidenceDeadlineAt <= now) {
        const updated = { ...trade, status: CoinMarketTradeStatus.PLATFORM_REVIEW, platformDecisionDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), updatedAt: now }; await this.database.put('coin_market_trades', updated);
      } else if (trade.status === CoinMarketTradeStatus.SELLER_EVIDENCE_PENDING && trade.sellerEvidenceDeadlineAt && trade.sellerEvidenceDeadlineAt <= now) {
        const updated = { ...trade, status: CoinMarketTradeStatus.PLATFORM_REVIEW, platformDecisionDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), updatedAt: now }; await this.database.put('coin_market_trades', updated);
      }
    }
  }
  private async expirePayment(trade: LocalCoinMarketTrade): Promise<void> {
    const tx = this.database.transaction(['settings', 'asset_accounts', 'asset_entries', 'asset_operations', 'asset_holds', 'coin_market_listings', 'coin_market_trades'], 'readwrite');
    const trades = tx.objectStore('coin_market_trades'); const stored = await trades.get(trade.tradeId);
    if (!stored || stored.status !== CoinMarketTradeStatus.PAYMENT_PENDING || stored.paymentDeadlineAt > new Date().toISOString()) { await transactionDone(tx); return; }
    const listings = tx.objectStore('coin_market_listings'); const listing = await listings.get(stored.listingId);
    const holds = tx.objectStore('asset_holds'); const hold = listing ? await holds.get(listing.assetHoldId) : undefined;
    const accounts = tx.objectStore('asset_accounts'); const account = hold ? await accounts.get(hold.accountId) : undefined;
    const amount = BigInt(stored.coins);
    if (!listing || !hold || !account || BigInt(listing.reservedCoins ?? '0') < amount || BigInt(hold.remainingAmount) < amount || BigInt(account.frozenAmount) < amount) abort(tx, CoinMarketErrorCode.LISTING_HOLD_INCONSISTENT);
    const settings = tx.objectStore('settings'); const now = new Date().toISOString(); const operationId = await allocateId(settings); const entryId = await allocateId(settings);
    const restoreToListing = listing.status !== CoinMarketListingStatus.CANCELLED;
    const operation: LocalAssetOperation = { operationId, idempotencyKey: `coin-market-trade-expire:${stored.tradeId}`, operationType: LocalAssetOperationType.COIN_MARKET_LISTING_RELEASE, status: LocalAssetOperationStatus.RECORDED, createdAt: now, extra: { tradeId: stored.tradeId, listingId: listing.listingId, coins: stored.coins, action: restoreToListing ? 'UNRESERVE' : 'RELEASE' } };
    await tx.objectStore('asset_operations').add(operation);
    await tx.objectStore('asset_entries').add({ entryId, operationId, accountId: account.accountId, delta: '0', frozenDelta: restoreToListing ? '0' : `-${stored.coins}`, balanceAfter: account.amount, createdAt: now });
    if (!restoreToListing) {
      const remaining = BigInt(hold.remainingAmount) - amount;
      await accounts.put({ ...account, frozenAmount: (BigInt(account.frozenAmount) - amount).toString(), version: account.version + 1 });
      await holds.put({ ...hold, remainingAmount: remaining.toString(), releasedAmount: (BigInt(hold.releasedAmount) + amount).toString(), status: remaining === 0n ? LocalAssetHoldStatus.RELEASED : LocalAssetHoldStatus.ACTIVE, updatedAt: now });
    }
    await listings.put({ ...listing, availableCoins: restoreToListing ? (BigInt(listing.availableCoins) + amount).toString() : listing.availableCoins, reservedCoins: (BigInt(listing.reservedCoins) - amount).toString(), updatedAt: now });
    await trades.put({ ...stored, status: CoinMarketTradeStatus.PAYMENT_EXPIRED, updatedAt: now });
    await transactionDone(tx);
  }

  async cancel(userId: string, listingId: string): Promise<CoinMarketListingDto> {
    const transaction = this.database.transaction(['settings', 'asset_accounts', 'asset_operations', 'asset_entries', 'asset_holds', 'coin_market_listings'], 'readwrite');
    const listings = transaction.objectStore('coin_market_listings');
    const listing = await listings.get(listingId);
    if (!listing || listing.sellerUserId !== userId) abort(transaction, CoinMarketErrorCode.LISTING_NOT_FOUND);
    if (listing.status === CoinMarketListingStatus.CANCELLED) {
      await transactionDone(transaction);
      return toDto(listing);
    }
    if (listing.status !== CoinMarketListingStatus.ACTIVE) abort(transaction, CoinMarketErrorCode.LISTING_NOT_CANCELLABLE);
    const hold = await transaction.objectStore('asset_holds').get(listing.assetHoldId);
    const releasable = BigInt(listing.availableCoins);
    if (!hold || hold.status !== LocalAssetHoldStatus.ACTIVE || BigInt(hold.remainingAmount) < releasable) abort(transaction, CoinMarketErrorCode.LISTING_HOLD_INCONSISTENT);
    const accounts = transaction.objectStore('asset_accounts');
    const account = await accounts.get(hold.accountId);
    if (!account || BigInt(account.frozenAmount) < releasable) abort(transaction, CoinMarketErrorCode.LISTING_HOLD_INCONSISTENT);
    const settings = transaction.objectStore('settings');
    const operationId = await allocateId(settings);
    const entryId = await allocateId(settings);
    const now = new Date().toISOString();
    const operation: LocalAssetOperation = { operationId, idempotencyKey: `coin-market-listing-cancel:${listingId}`, operationType: LocalAssetOperationType.COIN_MARKET_LISTING_RELEASE, status: LocalAssetOperationStatus.RECORDED, createdAt: now, extra: { listingId, assetHoldId: hold.holdId, userId, coins: listing.availableCoins, action: 'RELEASE' } };
    const entry: LocalAssetEntry = { entryId, operationId, accountId: account.accountId, delta: '0', frozenDelta: `-${listing.availableCoins}`, balanceAfter: account.amount, createdAt: now };
    const updatedListing = { ...listing, availableCoins: '0', status: CoinMarketListingStatus.CANCELLED, updatedAt: now };
    await accounts.put({ ...account, frozenAmount: (BigInt(account.frozenAmount) - releasable).toString(), version: account.version + 1 });
    const remaining = BigInt(hold.remainingAmount) - releasable;
    await transaction.objectStore('asset_holds').put({ ...hold, remainingAmount: remaining.toString(), releasedAmount: (BigInt(hold.releasedAmount) + releasable).toString(), status: remaining === 0n ? LocalAssetHoldStatus.RELEASED : LocalAssetHoldStatus.ACTIVE, updatedAt: now });
    await listings.put(updatedListing);
    await transaction.objectStore('asset_operations').add(operation);
    await transaction.objectStore('asset_entries').add(entry);
    await transactionDone(transaction);
    return toDto(updatedListing);
  }
}
