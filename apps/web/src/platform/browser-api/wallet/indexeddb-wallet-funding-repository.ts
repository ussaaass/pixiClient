import { FundingChannelStatus, FundingErrorCode, FundingOrderStatus, FundingPaymentMethod, OrderType, type CreateFundingOrderRequestDto, type FundingChannelDto, type FundingOrderDto, type SimulateFundingPaymentRequestDto } from '@gameing/contracts/wallet-funding';
import type { LocalAssetAccount, LocalAssetEntry, LocalAssetOperation, LocalOrder } from '../database';
import type { BrowserDevelopmentDatabase } from '../database';
import type { WalletFundingRepository } from '../../../wallet-funding/wallet-funding-application';
import { LOCAL_FUNDING_CHANNELS } from './local-funding-channels';
import { calculatePurchaseCoins, DEFAULT_EXCHANGE_RATE_CASH_FEN, DEFAULT_EXCHANGE_RATE_COIN_UNITS } from '../../wallet/wallet-domain';
import { LocalAssetType, LocalAssetOperationType } from './indexeddb-wallet-repository';

const SYSTEM_USER_SETTING = 'wallet:system-user-id';
const RATE_SETTING = 'system_config:cny_to_coin_ratio';
const SYSTEM_ROLE_TYPE = 8;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

function parseExchangeRate(value: unknown): { coins: bigint; fen: bigint } {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$/.test(value)) return { coins: DEFAULT_EXCHANGE_RATE_COIN_UNITS, fen: DEFAULT_EXCHANGE_RATE_CASH_FEN };
  const [yuan, coins] = value.split(':');
  return { coins: BigInt(coins!), fen: BigInt(yuan!) * 100n };
}

function parseUsdtRate(value: unknown): { display: string; micros: bigint } {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}(?:\.[0-9]{1,6})?$/.test(value)) return { display: '6.7', micros: 6_700_000n };
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  return { display: value, micros };
}

function parseUsdtWindowMinutes(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value)) return 15;
  const minutes = Number(value);
  return minutes >= 1 && minutes <= 1440 ? minutes : 15;
}

function displayUsdtAmount(milli: string): string {
  const amount = BigInt(milli);
  return `${(amount / 1000n).toString()}.${(amount % 1000n).toString().padStart(3, '0')}`;
}

function toDto(order: LocalOrder): FundingOrderDto {
  const channel = LOCAL_FUNDING_CHANNELS.find((item) => item.channelId === order.channelId);
  return {
    orderId: order.orderId,
    orderNo: order.orderNo,
    channelId: order.channelId,
    channelName: order.channelName,
    paymentMethod: channel?.paymentMethod ?? order.paymentMethod,
    amountCnyFen: order.amountCnyFen,
    creditCoins: order.creditCoins,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    ...(order.paymentMethod === FundingPaymentMethod.USDT_TRON && order.usdtAmountMilli && order.usdtRateCnyPerUsdt && order.depositAddress && order.expiresAt ? {
      usdtInvoice: {
        amountUsdtMilli: order.usdtAmountMilli,
        displayAmountUsdt: displayUsdtAmount(order.usdtAmountMilli),
        rateCnyPerUsdt: order.usdtRateCnyPerUsdt,
        depositAddress: order.depositAddress,
        expiresAt: order.expiresAt,
      },
    } : {}),
  };
}

export class IndexedDbWalletFundingRepository implements WalletFundingRepository {
  constructor(private readonly database: BrowserDevelopmentDatabase) {}

  async listChannels(): Promise<FundingChannelDto[]> {
    return LOCAL_FUNDING_CHANNELS.map((channel) => ({ ...channel }));
  }

  async listOrders(userId: string): Promise<FundingOrderDto[]> {
    const range = IDBKeyRange.bound([userId, ''], [userId, '\uffff']);
    const rows = (await this.database.getAllFromIndex('orders', 'by-user-created', range))
      .filter((order) => order.orderType === OrderType.WALLET_COIN_PURCHASE)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (BigInt(b.orderId) > BigInt(a.orderId) ? 1 : -1))
      .slice(0, 50);
    const now = new Date();
    const expired = rows.filter((order) => order.status === FundingOrderStatus.PENDING_PAYMENT && order.expiresAt && Date.parse(order.expiresAt) <= now.getTime());
    if (expired.length) {
      const transaction = this.database.transaction('orders', 'readwrite');
      for (const order of expired) await transaction.store.put({ ...order, status: FundingOrderStatus.EXPIRED });
      await transaction.done;
    }
    return rows.map((order) => expired.includes(order) ? toDto({ ...order, status: FundingOrderStatus.EXPIRED }) : toDto(order));
  }

  async createOrder(userId: string, request: CreateFundingOrderRequestDto): Promise<FundingOrderDto> {
    const channel = LOCAL_FUNDING_CHANNELS.find((item) => item.channelId === request.channelId && item.status === FundingChannelStatus.ENABLED);
    if (!channel) throw new Error(FundingErrorCode.FUNDING_CHANNEL_UNAVAILABLE);
    const transaction = this.database.transaction(['settings', 'orders'], 'readwrite');
    const orders = transaction.objectStore('orders');
    const previous = await orders.index('by-idempotency-key').get(request.idempotencyKey);
    if (previous) {
      if (previous.userId !== userId || previous.channelId !== request.channelId || previous.amountCnyFen !== request.amountCnyFen) {
        await transaction.done;
        throw new Error(FundingErrorCode.FUNDING_IDEMPOTENCY_KEY_REUSED);
      }
      await transaction.done;
      return toDto(previous);
    }
    const settings = transaction.objectStore('settings');
    const rate = parseExchangeRate((await settings.get(RATE_SETTING))?.value);
    const amountCnyFen = BigInt(request.amountCnyFen);
    const creditCoins = calculatePurchaseCoins(amountCnyFen, rate.coins, rate.fen);
    if (creditCoins <= 0n || creditCoins > MAX_SIGNED_BIGINT) {
      transaction.abort();
      await transaction.done.catch(() => undefined);
      throw new Error(FundingErrorCode.INVALID_ORDER_AMOUNT);
    }
    const idSetting = await settings.get('next-id');
    const orderId = typeof idSetting?.value === 'string' ? BigInt(idSetting.value) : 1n;
    await settings.put({ key: 'next-id', value: (orderId + 1n).toString() });
    const createdAt = new Date().toISOString();
    let usdtFields: Pick<LocalOrder, 'usdtAmountMilli' | 'usdtRateCnyPerUsdt' | 'depositAddress' | 'expiresAt'> = {};
    if (channel.paymentMethod === FundingPaymentMethod.USDT_TRON) {
      const usdtRate = parseUsdtRate((await settings.get('system_config:fx.usdt_cny_rate'))?.value);
      const windowMinutes = parseUsdtWindowMinutes((await settings.get('system_config:usdt.deposit_window_minutes'))?.value);
      // Round the CNY conversion down to one decimal USDT, then reserve a unique
      // increasing thousandth suffix within the configured payment window.
      const baseTenths = amountCnyFen * 100_000n / usdtRate.micros;
      if (baseTenths <= 0n) {
        transaction.abort(); await transaction.done.catch(() => undefined);
        throw new Error(FundingErrorCode.INVALID_ORDER_AMOUNT);
      }
      const allocationKey = `wallet:usdt-invoice:${baseTenths}`;
      const allocation = await settings.get(allocationKey);
      const expiryMs = Date.parse(allocation?.value && typeof allocation.value === 'object' && 'expiresAt' in allocation.value ? String(allocation.value.expiresAt) : '');
      const activeAllocation = Number.isFinite(expiryMs) && expiryMs > Date.parse(createdAt);
      const suffix = activeAllocation && allocation?.value && typeof allocation.value === 'object' && 'nextSuffix' in allocation.value
        ? Number(allocation.value.nextSuffix)
        : 10;
      if (!Number.isInteger(suffix) || suffix < 10 || suffix > 999) {
        transaction.abort(); await transaction.done.catch(() => undefined);
        throw new Error(FundingErrorCode.USDT_INVOICE_CAPACITY_REACHED);
      }
      const expiresAt = activeAllocation ? new Date(expiryMs).toISOString() : new Date(Date.parse(createdAt) + windowMinutes * 60_000).toISOString();
      const amountUsdtMilli = (baseTenths * 100n + BigInt(suffix)).toString();
      await settings.put({ key: allocationKey, value: { nextSuffix: suffix + 1, expiresAt } });
      usdtFields = {
        usdtAmountMilli: amountUsdtMilli,
        usdtRateCnyPerUsdt: usdtRate.display,
        depositAddress: `LOCAL-TRON-NOT-AN-ADDRESS-${orderId.toString()}`,
        expiresAt,
      };
    }
    const order: LocalOrder = {
      orderId: orderId.toString(),
      orderNo: `LG${createdAt.slice(0, 10).replaceAll('-', '')}${orderId.toString().padStart(12, '0')}`,
      userId,
      orderType: OrderType.WALLET_COIN_PURCHASE,
      channelId: channel.channelId,
      channelName: channel.displayName,
      paymentMethod: channel.paymentMethod,
      amountCnyFen: amountCnyFen.toString(),
      creditCoins: creditCoins.toString(),
      rateCoinUnits: rate.coins.toString(),
      rateCashFen: rate.fen.toString(),
      status: FundingOrderStatus.PENDING_PAYMENT,
      ...usdtFields,
      idempotencyKey: request.idempotencyKey,
      createdAt,
      paidAt: null,
    };
    await orders.put(order);
    await transaction.done;
    return toDto(order);
  }

  async simulatePayment(userId: string, request: SimulateFundingPaymentRequestDto): Promise<FundingOrderDto> {
    const transaction = this.database.transaction(['settings', 'orders', 'users', 'asset_accounts', 'asset_operations', 'asset_entries'], 'readwrite');
    const orders = transaction.objectStore('orders');
    const order = await orders.get(request.orderId);
    if (!order || order.userId !== userId || order.orderType !== OrderType.WALLET_COIN_PURCHASE) {
      transaction.abort(); await transaction.done.catch(() => undefined);
      throw new Error(FundingErrorCode.FUNDING_ORDER_NOT_FOUND);
    }
    const paymentAmountMatches = order.paymentMethod === FundingPaymentMethod.USDT_TRON
      ? 'paidAmountUsdtMilli' in request && request.paidAmountUsdtMilli === order.usdtAmountMilli
      : 'paidAmountCnyFen' in request && request.paidAmountCnyFen === order.amountCnyFen;
    if (order.status === FundingOrderStatus.PAID && order.paidEventId === request.paymentEventId && paymentAmountMatches) {
      await transaction.done;
      return toDto(order);
    }
    if (order.status !== FundingOrderStatus.PENDING_PAYMENT) {
      transaction.abort(); await transaction.done.catch(() => undefined);
      throw new Error(FundingErrorCode.FUNDING_ORDER_NOT_PAYABLE);
    }
    if (order.paymentMethod === FundingPaymentMethod.USDT_TRON && order.expiresAt && Date.parse(order.expiresAt) <= Date.now()) {
      await orders.put({ ...order, status: FundingOrderStatus.EXPIRED });
      await transaction.done;
      throw new Error(FundingErrorCode.FUNDING_ORDER_EXPIRED);
    }
    if (!paymentAmountMatches) {
      transaction.abort(); await transaction.done.catch(() => undefined);
      throw new Error(FundingErrorCode.FUNDING_ORDER_AMOUNT_MISMATCH);
    }
    const users = transaction.objectStore('users');
    const player = await users.get(userId);
    if (!player || player.roleType === SYSTEM_ROLE_TYPE || player.status !== 'ACTIVE') {
      transaction.abort(); await transaction.done.catch(() => undefined);
      throw new Error(FundingErrorCode.FUNDING_ORDER_NOT_PAYABLE);
    }
    const settings = transaction.objectStore('settings');
    const allocateId = async (): Promise<bigint> => {
      const current = await settings.get('next-id');
      const next = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
      await settings.put({ key: 'next-id', value: (next + 1n).toString() });
      return next;
    };
    const now = new Date().toISOString();
    const existingSystemId = (await settings.get(SYSTEM_USER_SETTING))?.value;
    let systemUserId: string;
    if (typeof existingSystemId === 'string') systemUserId = existingSystemId;
    else {
      systemUserId = (await allocateId()).toString();
      await users.put({ userId: systemUserId, displayName: '系统账户', roleType: SYSTEM_ROLE_TYPE, status: 'ACTIVE', authVersion: 1 });
      await settings.put({ key: SYSTEM_USER_SETTING, value: systemUserId });
    }
    const accounts = transaction.objectStore('asset_accounts');
    const playerAccountId = `${userId}:${LocalAssetType.COIN}`;
    const systemAccountId = `${systemUserId}:${LocalAssetType.COIN}`;
    const systemCashAccountId = `${systemUserId}:${LocalAssetType.CNY_BALANCE}`;
    const playerAccount = await accounts.get(playerAccountId) ?? { accountId: playerAccountId, userId, assetType: LocalAssetType.COIN, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    const systemAccount = await accounts.get(systemAccountId) ?? { accountId: systemAccountId, userId: systemUserId, assetType: LocalAssetType.COIN, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    const systemCashAccount = await accounts.get(systemCashAccountId) ?? { accountId: systemCashAccountId, userId: systemUserId, assetType: LocalAssetType.CNY_BALANCE, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    const coins = BigInt(order.creditCoins);
    const paidFen = BigInt(order.amountCnyFen);
    const nextPlayer = BigInt(playerAccount.amount) + coins;
    const nextSystemCoin = BigInt(systemAccount.amount) - coins;
    const nextSystemCash = BigInt(systemCashAccount.amount) + paidFen;
    if (nextPlayer > MAX_SIGNED_BIGINT || nextSystemCoin < -MAX_SIGNED_BIGINT || nextSystemCash > MAX_SIGNED_BIGINT) {
      transaction.abort(); await transaction.done.catch(() => undefined);
      throw new Error(FundingErrorCode.FUNDING_ORDER_NOT_PAYABLE);
    }
    const operationId = (await allocateId()).toString();
    const eventOperation: LocalAssetOperation = { operationId, idempotencyKey: `funding:${order.orderId}`, operationType: LocalAssetOperationType.COIN_PURCHASE, status: 1, createdAt: now, extra: { userId, orderId: order.orderId, orderNo: order.orderNo, paymentEventId: request.paymentEventId, amountCnyFen: paidFen.toString(), creditCoins: coins.toString(), rateCoinUnits: order.rateCoinUnits, rateCashFen: order.rateCashFen, source: 'LOCAL_BROWSER_SERVER' } };
    const playerEntryId = (await allocateId()).toString();
    const systemCoinEntryId = (await allocateId()).toString();
    const systemCashEntryId = (await allocateId()).toString();
    const entries: LocalAssetEntry[] = [
      { entryId: playerEntryId, operationId, accountId: playerAccountId, delta: coins.toString(), balanceAfter: nextPlayer.toString(), createdAt: now },
      { entryId: systemCoinEntryId, operationId, accountId: systemAccountId, delta: (-coins).toString(), balanceAfter: nextSystemCoin.toString(), createdAt: now },
      { entryId: systemCashEntryId, operationId, accountId: systemCashAccountId, delta: paidFen.toString(), balanceAfter: nextSystemCash.toString(), createdAt: now },
    ];
    await accounts.put({ ...playerAccount, amount: nextPlayer.toString(), version: playerAccount.version + 1 });
    await accounts.put({ ...systemAccount, amount: nextSystemCoin.toString(), version: systemAccount.version + 1 });
    await accounts.put({ ...systemCashAccount, amount: nextSystemCash.toString(), version: systemCashAccount.version + 1 });
    await transaction.objectStore('asset_operations').put(eventOperation);
    for (const entry of entries) await transaction.objectStore('asset_entries').put(entry);
    const paidOrder: LocalOrder = { ...order, status: FundingOrderStatus.PAID, paidEventId: request.paymentEventId, paidAt: now };
    await orders.put(paidOrder);
    await transaction.done;
    return toDto(paidOrder);
  }
}
