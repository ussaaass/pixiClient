import { PayoutChannelType, WalletActivityType, WalletErrorCode, WithdrawalStatus, type CreatePayoutAccountRequestDto, type CreateWithdrawalRequestDto, type PayoutAccountDto, type WalletActivityCursorDto, type WalletActivityResponseDto, type WalletExchangeQuoteDto, type WalletExchangeQuoteRequestDto, type WalletExchangeRequestDto, type WalletExchangeResultDto, type WalletSummaryResponseDto, type WalletTransferQuoteDto, type WalletTransferQuoteRequestDto, type WalletTransferRequestDto, type WalletTransferResultDto, type WithdrawalDto, type WithdrawalQuoteDto, type WithdrawalQuoteRequestDto } from '@gameing/contracts/wallet';
import type { LocalAssetAccount, LocalAssetEntry, LocalAssetOperation, LocalPayoutAccount, LocalTurnoverState, LocalWithdrawal } from '../database';
import { openBrowserDevelopmentDatabase, type BrowserDevelopmentDatabase } from '../database';
import { sha256 } from '../crypto';
import { createExchangeQuote, createTransferQuote, createWithdrawalQuote, DEFAULT_COIN_TRANSFER_FEE_BPS, DEFAULT_EXCHANGE_RATE_CASH_FEN, DEFAULT_EXCHANGE_RATE_COIN_UNITS, DEFAULT_MINIMUM_WITHDRAWAL_COINS, DEFAULT_TRANSFER_QUOTE_TTL_SECONDS, DEFAULT_WITHDRAWAL_FEE_BPS, exchangeQuoteMatches, transferQuoteMatches, withdrawalQuoteMatches } from '../../wallet/wallet-domain';

export const LocalAssetType = { COIN: 1, CNY_BALANCE: 2 } as const;
export const LocalAssetOperationType = { INITIAL_GIFT: 1, COIN_TRANSFER: 2, COIN_EXCHANGE: 3, COIN_PURCHASE: 4 } as const;
const SYSTEM_ROLE_TYPE = 8;
const DEFAULT_GIFT_COINS = 1_000n;
const DEFAULT_TURNOVER_MULTIPLIER = 5;
const SYSTEM_USER_SETTING = 'wallet:system-user-id';
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

function positiveConfig(value: unknown, fallback: bigint): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return fallback;
  return BigInt(value);
}

function multiplierConfig(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) return DEFAULT_TURNOVER_MULTIPLIER;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_TURNOVER_MULTIPLIER;
}

function transferFeeRateConfig(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,4})$/.test(value)) return DEFAULT_COIN_TRANSFER_FEE_BPS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 10_000 ? parsed : DEFAULT_COIN_TRANSFER_FEE_BPS;
}

function transferQuoteTtlConfig(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value)) return DEFAULT_TRANSFER_QUOTE_TTL_SECONDS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 600 ? parsed : DEFAULT_TRANSFER_QUOTE_TTL_SECONDS;
}

function exchangeRateConfig(value: unknown): { rateCoinUnits: bigint; rateCashFen: bigint } {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$/.test(value)) return { rateCoinUnits: DEFAULT_EXCHANGE_RATE_COIN_UNITS, rateCashFen: DEFAULT_EXCHANGE_RATE_CASH_FEN };
  const [cashYuan, coins] = value.split(':');
  return { rateCoinUnits: BigInt(coins!), rateCashFen: BigInt(cashYuan!) * 100n };
}
function minimumWithdrawalFen(minimumCoins: bigint, rate: { rateCoinUnits: bigint; rateCashFen: bigint }): bigint {
  const fenNumerator = minimumCoins * rate.rateCashFen;
  if (fenNumerator % rate.rateCoinUnits !== 0n) throw new Error(WalletErrorCode.WITHDRAWAL_CONFIG_INVALID);
  return fenNumerator / rate.rateCoinUnits;
}

function exchangeResult(operation: LocalAssetOperation): WalletExchangeResultDto {
  const extra = operation.extra;
  if (operation.operationType !== LocalAssetOperationType.COIN_EXCHANGE || !extra?.coins || !extra.cnyFen) throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE);
  return { operationId: operation.operationId, coins: extra.coins, cnyFen: extra.cnyFen, occurredAt: operation.createdAt };
}

function transferResult(operation: LocalAssetOperation): WalletTransferResultDto {
  const extra = operation.extra;
  if (operation.operationType !== LocalAssetOperationType.COIN_TRANSFER || !extra?.recipientUserId || !extra.recipientDisplayName || !extra.coins || extra.feeCoins === undefined || !extra.totalCoins) throw new Error(WalletErrorCode.TRANSFER_NOT_FOUND);
  return { operationId: operation.operationId, recipientUserId: extra.recipientUserId, recipientDisplayName: extra.recipientDisplayName, coins: extra.coins, feeCoins: extra.feeCoins, totalCoins: extra.totalCoins, occurredAt: operation.createdAt };
}

function abortWrite(transaction: { abort(): void; done: Promise<unknown> }): void {
  const done = transaction.done;
  transaction.abort();
  void done.catch(() => undefined);
}

const payoutChannelLabels: Record<number, string> = { [PayoutChannelType.ALIPAY]: '支付宝', [PayoutChannelType.WECHAT_PAY]: '微信支付', [PayoutChannelType.BANK_TRANSFER]: '银行卡转账', [PayoutChannelType.UNIONPAY_QR]: '银联二维码', [PayoutChannelType.DIGITAL_CNY]: '数字人民币' };
function accountDto(account: LocalPayoutAccount): PayoutAccountDto {
  return { payoutAccountId: account.payoutAccountId, channelType: account.channelType, accountLabel: account.accountLabel, maskedAccount: account.maskedAccount, isDefault: account.isDefault, status: account.status, createdAt: account.createdAt };
}
function withdrawalDto(withdrawal: LocalWithdrawal): WithdrawalDto {
  const { userId: _userId, idempotencyKey: _idempotencyKey, ...dto } = withdrawal;
  return dto;
}
function percentRateBpsConfig(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?$/.test(value)) return fallback;
  const [whole, fraction = ''] = value.split('.');
  const hundredths = BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2));
  return hundredths <= 10_000n ? Number(hundredths) : fallback;
}

export class IndexedDbWalletRepository {
  constructor(private readonly database: BrowserDevelopmentDatabase) {}

  async listPayoutAccounts(userId: string): Promise<PayoutAccountDto[]> {
    return (await this.database.getAllFromIndex('payout_accounts', 'by-user', userId)).filter((item) => item.status === 1).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt)).map(accountDto);
  }

  async createPayoutAccount(userId: string, request: CreatePayoutAccountRequestDto): Promise<PayoutAccountDto> {
    const reference = request.accountReference.trim();
    const label = request.accountLabel.trim();
    if (!label || label.length > 48 || !/^[A-Za-z0-9_-]{4,64}$/.test(reference)) throw new Error(WalletErrorCode.INVALID_PAYOUT_ACCOUNT);
    const requestFingerprint = await sha256(`${request.channelType}:${label}:${reference}`);
    const transaction = this.database.transaction(['settings', 'payout_accounts'], 'readwrite');
    const store = transaction.objectStore('payout_accounts');
    const previous = await store.index('by-idempotency-key').get(request.idempotencyKey);
    if (previous) {
      if (previous.userId !== userId || previous.requestFingerprint !== requestFingerprint) { abortWrite(transaction); throw new Error(WalletErrorCode.IDEMPOTENCY_KEY_REUSED); }
      await transaction.done;
      return accountDto(previous);
    }
    const settings = transaction.objectStore('settings');
    const current = await settings.get('next-id');
    const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
    await settings.put({ key: 'next-id', value: (id + 1n).toString() });
    const existing = await store.index('by-user').getAll(userId);
    const now = new Date().toISOString();
    const account: LocalPayoutAccount = {
      payoutAccountId: id.toString(), userId, idempotencyKey: request.idempotencyKey, requestFingerprint, channelType: request.channelType,
      accountLabel: `${payoutChannelLabels[request.channelType]} · ${label}`.slice(0, 48),
      maskedAccount: `•••• ${reference.slice(-4)}`, isDefault: existing.length === 0,
      status: 1, createdAt: now,
    };
    await store.put(account);
    await transaction.done;
    return accountDto(account);
  }

  async deletePayoutAccount(userId: string, payoutAccountId: string): Promise<{ deleted: boolean }> {
    const transaction = this.database.transaction(['payout_accounts', 'wallet_withdrawals'], 'readwrite');
    const accounts = transaction.objectStore('payout_accounts');
    const account = await accounts.get(payoutAccountId);
    if (!account || account.userId !== userId) { await transaction.done; return { deleted: false }; }
    const linked = await transaction.objectStore('wallet_withdrawals').index('by-user-created').getAll(IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    const terminalStatuses = new Set<number>([WithdrawalStatus.CANCELLED, WithdrawalStatus.REJECTED, WithdrawalStatus.FAILED, WithdrawalStatus.SUCCEEDED]);
    if (linked.some((item) => item.payoutAccountId === payoutAccountId && !terminalStatuses.has(item.status))) {
      abortWrite(transaction); throw new Error(WalletErrorCode.PAYOUT_ACCOUNT_IN_USE);
    }
    await accounts.delete(payoutAccountId);
    const remaining = await accounts.index('by-user').getAll(userId);
    if (!remaining.some((item) => item.isDefault) && remaining[0]) await accounts.put({ ...remaining[0], isDefault: true });
    await transaction.done;
    return { deleted: true };
  }

  async quoteWithdrawal(userId: string, request: WithdrawalQuoteRequestDto): Promise<WithdrawalQuoteDto> {
    const [account, cash, turnover, settings] = await Promise.all([
      this.database.get('payout_accounts', request.payoutAccountId),
      this.database.getFromIndex('asset_accounts', 'by-user-asset', [userId, LocalAssetType.CNY_BALANCE]),
      this.database.get('turnover_states', userId),
      this.database.getAll('settings'),
    ]);
    if (!account || account.userId !== userId || account.status !== 1) throw new Error(WalletErrorCode.PAYOUT_ACCOUNT_NOT_FOUND);
    if (BigInt(turnover?.remainingCoins ?? '0') > 0n) throw new Error(WalletErrorCode.TURNOVER_INCOMPLETE);
    const config = new Map(settings.map((item) => [item.key, item.value]));
    const rate = exchangeRateConfig(config.get('system_config:cny_to_coin_ratio'));
    const minimumCoins = positiveConfig(config.get('system_config:minimum_withdrawal_coins'), DEFAULT_MINIMUM_WITHDRAWAL_COINS);
    const minimumNetCnyFen = minimumWithdrawalFen(minimumCoins, rate);
    const feeRateBps = percentRateBpsConfig(config.get('system_config:withdrawal_fee_rate_percent'), DEFAULT_WITHDRAWAL_FEE_BPS);
    const quote = createWithdrawalQuote({ payoutAccountId: account.payoutAccountId, payoutAccountLabel: account.accountLabel, maskedAccount: account.maskedAccount, netCnyFen: BigInt(request.netCnyFen), feeRateBps, minimumNetCnyFen, quotedAt: new Date() });
    const available = BigInt(cash?.amount ?? '0') - BigInt(cash?.frozenAmount ?? '0');
    if (available < BigInt(quote.debitCnyFen)) throw new Error(WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE);
    return quote;
  }

  async listWithdrawals(userId: string): Promise<WithdrawalDto[]> {
    return (await this.database.getAllFromIndex('wallet_withdrawals', 'by-user-created', IDBKeyRange.bound([userId, ''], [userId, '\uffff'])))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (BigInt(b.withdrawalId) > BigInt(a.withdrawalId) ? 1 : -1)).slice(0, 50).map(withdrawalDto);
  }

  async createWithdrawal(userId: string, request: CreateWithdrawalRequestDto): Promise<WithdrawalDto> {
    const transaction = this.database.transaction(['settings', 'asset_accounts', 'turnover_states', 'payout_accounts', 'wallet_withdrawals'], 'readwrite');
    const withdrawals = transaction.objectStore('wallet_withdrawals');
    const existing = await withdrawals.index('by-idempotency-key').get(request.idempotencyKey);
    if (existing) {
      if (existing.userId !== userId || existing.payoutAccountId !== request.quote.payoutAccountId || existing.netCnyFen !== request.quote.netCnyFen) { abortWrite(transaction); throw new Error(WalletErrorCode.IDEMPOTENCY_KEY_REUSED); }
      await transaction.done; return withdrawalDto(existing);
    }
    const accounts = transaction.objectStore('payout_accounts');
    const payout = await accounts.get(request.quote.payoutAccountId);
    const cashStore = transaction.objectStore('asset_accounts');
    const cashId = `${userId}:${LocalAssetType.CNY_BALANCE}`;
    const cash = await cashStore.get(cashId);
    const turnover = await transaction.objectStore('turnover_states').get(userId);
    const settings = transaction.objectStore('settings');
    const settingRows = await settings.getAll();
    const config = new Map(settingRows.map((item) => [item.key, item.value]));
    const rate = exchangeRateConfig(config.get('system_config:cny_to_coin_ratio'));
    const minimumCoins = positiveConfig(config.get('system_config:minimum_withdrawal_coins'), DEFAULT_MINIMUM_WITHDRAWAL_COINS);
    const minimumNetCnyFen = minimumWithdrawalFen(minimumCoins, rate);
    const feeRateBps = percentRateBpsConfig(config.get('system_config:withdrawal_fee_rate_percent'), DEFAULT_WITHDRAWAL_FEE_BPS);
    const now = new Date();
    if (!payout || payout.userId !== userId || payout.status !== 1) { abortWrite(transaction); throw new Error(WalletErrorCode.PAYOUT_ACCOUNT_NOT_FOUND); }
    if (BigInt(turnover?.remainingCoins ?? '0') > 0n) { abortWrite(transaction); throw new Error(WalletErrorCode.TURNOVER_INCOMPLETE); }
    if (request.quote.expiresAt <= now.toISOString()) { abortWrite(transaction); throw new Error(WalletErrorCode.WITHDRAWAL_QUOTE_EXPIRED); }
    if (!withdrawalQuoteMatches(request.quote, feeRateBps, minimumNetCnyFen)) { abortWrite(transaction); throw new Error(WalletErrorCode.WITHDRAWAL_QUOTE_CHANGED); }
    if (request.quote.payoutAccountId !== payout.payoutAccountId || request.quote.payoutAccountLabel !== payout.accountLabel || request.quote.maskedAccount !== payout.maskedAccount) { abortWrite(transaction); throw new Error(WalletErrorCode.WITHDRAWAL_QUOTE_CHANGED); }
    const amount = BigInt(cash?.amount ?? '0');
    const frozen = BigInt(cash?.frozenAmount ?? '0');
    const debit = BigInt(request.quote.debitCnyFen);
    if (amount - frozen < debit) { abortWrite(transaction); throw new Error(WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE); }
    const current = await settings.get('next-id');
    const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
    await settings.put({ key: 'next-id', value: (id + 1n).toString() });
    const withdrawal: LocalWithdrawal = { withdrawalId: id.toString(), userId, payoutAccountId: payout.payoutAccountId, payoutAccountLabel: payout.accountLabel, maskedAccount: payout.maskedAccount, netCnyFen: request.quote.netCnyFen, feeCnyFen: request.quote.feeCnyFen, debitCnyFen: request.quote.debitCnyFen, status: WithdrawalStatus.REQUESTED, payoutNotBeforeAt: request.quote.payoutNotBeforeAt, createdAt: now.toISOString(), idempotencyKey: request.idempotencyKey };
    await withdrawals.put(withdrawal);
    await cashStore.put({ ...cash, accountId: cashId, userId, assetType: LocalAssetType.CNY_BALANCE, amount: amount.toString(), frozenAmount: (frozen + debit).toString(), version: (cash?.version ?? 0) + 1, status: 1 });
    await transaction.done;
    return withdrawalDto(withdrawal);
  }

  async cancelWithdrawal(userId: string, withdrawalId: string): Promise<WithdrawalDto> {
    const transaction = this.database.transaction(['wallet_withdrawals', 'asset_accounts'], 'readwrite');
    const withdrawals = transaction.objectStore('wallet_withdrawals');
    const withdrawal = await withdrawals.get(withdrawalId);
    if (!withdrawal || withdrawal.userId !== userId) { abortWrite(transaction); throw new Error(WalletErrorCode.WITHDRAWAL_NOT_FOUND); }
    if (withdrawal.status === WithdrawalStatus.CANCELLED) { await transaction.done; return withdrawalDto(withdrawal); }
    if (withdrawal.status !== WithdrawalStatus.REQUESTED) { abortWrite(transaction); throw new Error(WalletErrorCode.WITHDRAWAL_NOT_CANCELLABLE); }
    const cashId = `${userId}:${LocalAssetType.CNY_BALANCE}`;
    const account = await transaction.objectStore('asset_accounts').get(cashId);
    if (!account || BigInt(account.frozenAmount) < BigInt(withdrawal.debitCnyFen)) { abortWrite(transaction); throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE); }
    const next = { ...withdrawal, status: WithdrawalStatus.CANCELLED };
    await withdrawals.put(next);
    await transaction.objectStore('asset_accounts').put({ ...account, frozenAmount: (BigInt(account.frozenAmount) - BigInt(withdrawal.debitCnyFen)).toString(), version: account.version + 1 });
    await transaction.done;
    return withdrawalDto(next);
  }

  async grantWelcomeGift(userId: string): Promise<void> {
    const transaction = this.database.transaction(
      ['users', 'settings', 'welcome_grants', 'asset_accounts', 'asset_operations', 'asset_entries', 'turnover_states'],
      'readwrite',
    );
    const allocateId = async (): Promise<string> => {
      const settings = transaction.objectStore('settings');
      const current = await settings.get('next-id');
      const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
      await settings.put({ key: 'next-id', value: (id + 1n).toString() });
      return id.toString();
    };
    const grantKey = `welcome-registration:${userId}`;
    const previousGrant = await transaction.objectStore('welcome_grants').index('by-user').get(userId);
    if (previousGrant) {
      await transaction.done;
      return;
    }
    const user = await transaction.objectStore('users').get(userId);
    if (!user || user.status !== 'ACTIVE' || user.roleType === SYSTEM_ROLE_TYPE) {
      abortWrite(transaction);
      throw new Error('WALLET_USER_NOT_ELIGIBLE');
    }

    const settings = transaction.objectStore('settings');
    const coins = positiveConfig((await settings.get('system_config:wallet.initial_gift_coins'))?.value, DEFAULT_GIFT_COINS);
    const multiplier = multiplierConfig((await settings.get('system_config:wallet.initial_gift_turnover_multiplier'))?.value);
    const required = coins * BigInt(multiplier);
    const now = new Date().toISOString();
    const existingSystemUserId = (await settings.get(SYSTEM_USER_SETTING))?.value;
    let systemUserId: string;
    if (typeof existingSystemUserId !== 'string') {
      systemUserId = await allocateId();
      await transaction.objectStore('users').put({ userId: systemUserId, displayName: '系统账户', roleType: SYSTEM_ROLE_TYPE, status: 'ACTIVE', authVersion: 1 });
      await settings.put({ key: SYSTEM_USER_SETTING, value: systemUserId });
    } else systemUserId = existingSystemUserId;
    const playerAccountId = `${userId}:${LocalAssetType.COIN}`;
    const systemAccountId = `${systemUserId}:${LocalAssetType.COIN}`;
    const accounts = transaction.objectStore('asset_accounts');
    const playerAccount = await accounts.get(playerAccountId) ?? { accountId: playerAccountId, userId, assetType: LocalAssetType.COIN, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    const systemAccount = await accounts.get(systemAccountId) ?? { accountId: systemAccountId, userId: systemUserId, assetType: LocalAssetType.COIN, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    const operationId = await allocateId();
    const idempotencyKey = grantKey;
    const operation: LocalAssetOperation = { operationId, idempotencyKey, operationType: LocalAssetOperationType.INITIAL_GIFT, status: 1, createdAt: now };
    const nextPlayerAmount = BigInt(playerAccount.amount) + coins;
    const nextSystemAmount = BigInt(systemAccount.amount) - coins;
    const nextPlayer = { ...playerAccount, amount: nextPlayerAmount.toString(), version: playerAccount.version + 1 };
    const nextSystem = { ...systemAccount, amount: nextSystemAmount.toString(), version: systemAccount.version + 1 };
    const entries = transaction.objectStore('asset_entries');
    const playerEntryId = await allocateId();
    const systemEntryId = await allocateId();
    const playerEntry: LocalAssetEntry = { entryId: playerEntryId, operationId, accountId: playerAccountId, delta: coins.toString(), balanceAfter: nextPlayerAmount.toString(), createdAt: now };
    const systemEntry: LocalAssetEntry = { entryId: systemEntryId, operationId, accountId: systemAccountId, delta: (-coins).toString(), balanceAfter: nextSystemAmount.toString(), createdAt: now };
    await accounts.put(nextPlayer);
    await accounts.put(nextSystem);
    await transaction.objectStore('asset_operations').put(operation);
    await entries.put(playerEntry);
    await entries.put(systemEntry);
    await transaction.objectStore('welcome_grants').put({ operationId, grantKey, userId, coins: coins.toString(), turnoverRequirement: required.toString(), turnoverMultiplier: multiplier, createdAt: now });
    const turnoverStore = transaction.objectStore('turnover_states');
    const turnover = await turnoverStore.get(userId) as LocalTurnoverState | undefined;
    await turnoverStore.put({ userId, remainingCoins: (BigInt(turnover?.remainingCoins ?? '0') + required).toString(), updatedAt: now });
    await transaction.done;
  }

  async quoteTransfer(userId: string, request: WalletTransferQuoteRequestDto): Promise<WalletTransferQuoteDto> {
    const [sender, recipient, settings, turnover] = await Promise.all([
      this.database.get('users', userId),
      this.database.get('users', request.recipientUserId),
      this.database.getAll('settings'),
      this.database.get('turnover_states', userId),
    ]);
    if (!sender || sender.status !== 'ACTIVE') throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE);
    if (!recipient || recipient.status !== 'ACTIVE' || recipient.roleType === SYSTEM_ROLE_TYPE) throw new Error(WalletErrorCode.RECIPIENT_NOT_FOUND);
    if (recipient.userId === sender.userId) throw new Error(WalletErrorCode.SELF_TRANSFER);
    if (BigInt(turnover?.remainingCoins ?? '0') > 0n) throw new Error(WalletErrorCode.TURNOVER_INCOMPLETE);
    const amount = BigInt(request.coins);
    if (amount <= 0n || amount > MAX_SIGNED_BIGINT) throw new Error(WalletErrorCode.INVALID_TRANSFER_AMOUNT);
    const settingsByKey = new Map(settings.map((item) => [item.key, item.value]));
    const feeRateBps = transferFeeRateConfig(settingsByKey.get('system_config:wallet.transfer.feeBps'));
    const ttlSeconds = transferQuoteTtlConfig(settingsByKey.get('system_config:wallet.transfer.quoteTtlSeconds'));
    return createTransferQuote({ recipientUserId: recipient.userId, recipientDisplayName: recipient.displayName, coins: amount, feeRateBps, quotedAt: new Date(), ttlSeconds });
  }

  async transferCoins(userId: string, request: WalletTransferRequestDto): Promise<WalletTransferResultDto> {
    const transaction = this.database.transaction(['users', 'settings', 'asset_accounts', 'asset_operations', 'asset_entries', 'turnover_states'], 'readwrite');
    const settings = transaction.objectStore('settings');
    const operations = transaction.objectStore('asset_operations');
    const previous = await operations.index('by-idempotency-key').get(request.idempotencyKey);
    if (previous) {
      const old = previous.extra;
      const quote = request.quote;
      if (previous.operationType !== LocalAssetOperationType.COIN_TRANSFER || old?.senderUserId !== userId || old?.recipientUserId !== quote.recipientUserId || old.coins !== quote.coins || old.feeCoins !== quote.feeCoins || old.feeRateBps !== String(quote.feeRateBps)) {
        abortWrite(transaction);
        throw new Error(WalletErrorCode.IDEMPOTENCY_KEY_REUSED);
      }
      const result = transferResult(previous);
      await transaction.done;
      return result;
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const quote = request.quote;
    if (Date.parse(quote.expiresAt) <= now.getTime()) { abortWrite(transaction); throw new Error(WalletErrorCode.TRANSFER_QUOTE_EXPIRED); }
    const sender = await transaction.objectStore('users').get(userId);
    const recipient = await transaction.objectStore('users').get(quote.recipientUserId);
    if (!sender || sender.status !== 'ACTIVE') { abortWrite(transaction); throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE); }
    if (!recipient || recipient.status !== 'ACTIVE' || recipient.roleType === SYSTEM_ROLE_TYPE) { abortWrite(transaction); throw new Error(WalletErrorCode.RECIPIENT_NOT_FOUND); }
    if (recipient.userId === sender.userId) { abortWrite(transaction); throw new Error(WalletErrorCode.SELF_TRANSFER); }
    const turnover = await transaction.objectStore('turnover_states').get(userId);
    if (BigInt(turnover?.remainingCoins ?? '0') > 0n) { abortWrite(transaction); throw new Error(WalletErrorCode.TURNOVER_INCOMPLETE); }
    const currentFeeRateBps = transferFeeRateConfig((await settings.get('system_config:wallet.transfer.feeBps'))?.value);
    const currentTtlSeconds = transferQuoteTtlConfig((await settings.get('system_config:wallet.transfer.quoteTtlSeconds'))?.value);
    const quotedAt = Date.parse(quote.quotedAt);
    const expiresAt = Date.parse(quote.expiresAt);
    if (quotedAt > now.getTime() || expiresAt - quotedAt !== currentTtlSeconds * 1000) { abortWrite(transaction); throw new Error(WalletErrorCode.TRANSFER_QUOTE_CHANGED); }
    if (!transferQuoteMatches(quote, currentFeeRateBps) || quote.recipientDisplayName !== recipient.displayName) { abortWrite(transaction); throw new Error(WalletErrorCode.TRANSFER_QUOTE_CHANGED); }
    const coins = BigInt(quote.coins);
    const feeCoins = BigInt(quote.feeCoins);
    const totalCoins = BigInt(quote.totalCoins);
    if (coins <= 0n || totalCoins > MAX_SIGNED_BIGINT) { abortWrite(transaction); throw new Error(WalletErrorCode.INVALID_TRANSFER_AMOUNT); }
    const accounts = transaction.objectStore('asset_accounts');
    const senderAccountId = `${sender.userId}:${LocalAssetType.COIN}`;
    const recipientAccountId = `${recipient.userId}:${LocalAssetType.COIN}`;
    const senderAccount = await accounts.get(senderAccountId);
    if (!senderAccount) { abortWrite(transaction); throw new Error(WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE); }
    const availableCoins = BigInt(senderAccount.amount) > 0n ? BigInt(senderAccount.amount) - BigInt(senderAccount.frozenAmount) : 0n;
    if (availableCoins < totalCoins) { abortWrite(transaction); throw new Error(WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE); }
    const recipientAccount = await accounts.get(recipientAccountId) ?? { accountId: recipientAccountId, userId: recipient.userId, assetType: LocalAssetType.COIN, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    const systemUserId = (await settings.get(SYSTEM_USER_SETTING))?.value;
    if (typeof systemUserId !== 'string') { abortWrite(transaction); throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE); }
    const systemAccountId = `${systemUserId}:${LocalAssetType.COIN}`;
    const systemAccount = await accounts.get(systemAccountId);
    if (!systemAccount) { abortWrite(transaction); throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE); }
    const nextRecipientBalance = BigInt(recipientAccount.amount) + coins;
    const nextSystemBalance = BigInt(systemAccount.amount) + feeCoins;
    if (nextRecipientBalance > MAX_SIGNED_BIGINT || nextSystemBalance > MAX_SIGNED_BIGINT) { abortWrite(transaction); throw new Error(WalletErrorCode.INVALID_TRANSFER_AMOUNT); }
    const allocateId = async (): Promise<string> => {
      const current = await settings.get('next-id');
      const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
      await settings.put({ key: 'next-id', value: (id + 1n).toString() });
      return id.toString();
    };
    const operationId = await allocateId();
    const operation: LocalAssetOperation = {
      operationId, idempotencyKey: request.idempotencyKey, operationType: LocalAssetOperationType.COIN_TRANSFER, status: 1, createdAt: nowIso,
      extra: { senderUserId: sender.userId, senderDisplayName: sender.displayName, recipientUserId: recipient.userId, recipientDisplayName: recipient.displayName, coins: coins.toString(), feeCoins: feeCoins.toString(), totalCoins: totalCoins.toString(), feeRateBps: String(currentFeeRateBps), quoteExpiresAt: quote.expiresAt },
    };
    const nextSenderBalance = BigInt(senderAccount.amount) - totalCoins;
    const nextSender = { ...senderAccount, amount: nextSenderBalance.toString(), version: senderAccount.version + 1 };
    const nextRecipient = { ...recipientAccount, amount: nextRecipientBalance.toString(), version: recipientAccount.version + 1 };
    const nextSystem = { ...systemAccount, amount: nextSystemBalance.toString(), version: systemAccount.version + 1 };
    const entries = transaction.objectStore('asset_entries');
    const entryRows: LocalAssetEntry[] = [
      { entryId: await allocateId(), operationId, accountId: senderAccountId, delta: (-totalCoins).toString(), balanceAfter: nextSenderBalance.toString(), createdAt: nowIso },
      { entryId: await allocateId(), operationId, accountId: recipientAccountId, delta: coins.toString(), balanceAfter: nextRecipientBalance.toString(), createdAt: nowIso },
    ];
    if (feeCoins > 0n) entryRows.push({ entryId: await allocateId(), operationId, accountId: systemAccountId, delta: feeCoins.toString(), balanceAfter: nextSystemBalance.toString(), createdAt: nowIso });
    await accounts.put(nextSender);
    await accounts.put(nextRecipient);
    if (feeCoins > 0n) await accounts.put(nextSystem);
    await operations.put(operation);
    for (const entry of entryRows) await entries.put(entry);
    await transaction.done;
    return transferResult(operation);
  }

  async quoteExchange(userId: string, request: WalletExchangeQuoteRequestDto): Promise<WalletExchangeQuoteDto> {
    const [user, account, settings, turnover] = await Promise.all([
      this.database.get('users', userId),
      this.database.getFromIndex('asset_accounts', 'by-user-asset', [userId, LocalAssetType.COIN]),
      this.database.getAll('settings'),
      this.database.get('turnover_states', userId),
    ]);
    if (!user || user.status !== 'ACTIVE') throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE);
    if (BigInt(turnover?.remainingCoins ?? '0') > 0n) throw new Error(WalletErrorCode.TURNOVER_INCOMPLETE);
    const coins = BigInt(request.coins);
    if (coins <= 0n || coins > MAX_SIGNED_BIGINT) throw new Error(WalletErrorCode.INVALID_EXCHANGE_AMOUNT);
    const availableCoins = BigInt(account?.amount ?? '0') > 0n ? BigInt(account!.amount) - BigInt(account!.frozenAmount) : 0n;
    if (availableCoins < coins) throw new Error(WalletErrorCode.INSUFFICIENT_EXCHANGE_BALANCE);
    const settingsByKey = new Map(settings.map((item) => [item.key, item.value]));
    const rate = exchangeRateConfig(settingsByKey.get('system_config:cny_to_coin_ratio'));
    const ttlSeconds = transferQuoteTtlConfig(settingsByKey.get('system_config:wallet.exchange.quoteTtlSeconds'));
    return createExchangeQuote({ coins, ...rate, quotedAt: new Date(), ttlSeconds });
  }

  async exchangeCoins(userId: string, request: WalletExchangeRequestDto): Promise<WalletExchangeResultDto> {
    const transaction = this.database.transaction(['users', 'settings', 'asset_accounts', 'asset_operations', 'asset_entries', 'turnover_states'], 'readwrite');
    const settings = transaction.objectStore('settings');
    const operations = transaction.objectStore('asset_operations');
    const previous = await operations.index('by-idempotency-key').get(request.idempotencyKey);
    if (previous) {
      const quote = request.quote;
      const old = previous.extra;
      if (previous.operationType !== LocalAssetOperationType.COIN_EXCHANGE || old?.userId !== userId || old.coins !== quote.coins || old.cnyFen !== quote.cnyFen || old.rateCoinUnits !== quote.rateCoinUnits || old.rateCashFen !== quote.rateCashFen) {
        abortWrite(transaction);
        throw new Error(WalletErrorCode.IDEMPOTENCY_KEY_REUSED);
      }
      const result = exchangeResult(previous);
      await transaction.done;
      return result;
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const quote = request.quote;
    if (Date.parse(quote.expiresAt) <= now.getTime()) { abortWrite(transaction); throw new Error(WalletErrorCode.EXCHANGE_QUOTE_EXPIRED); }
    const user = await transaction.objectStore('users').get(userId);
    if (!user || user.status !== 'ACTIVE' || user.roleType === SYSTEM_ROLE_TYPE) { abortWrite(transaction); throw new Error(WalletErrorCode.EXCHANGE_NOT_AVAILABLE); }
    const turnover = await transaction.objectStore('turnover_states').get(userId);
    if (BigInt(turnover?.remainingCoins ?? '0') > 0n) { abortWrite(transaction); throw new Error(WalletErrorCode.TURNOVER_INCOMPLETE); }
    const configuredRate = exchangeRateConfig((await settings.get('system_config:cny_to_coin_ratio'))?.value);
    const ttlSeconds = transferQuoteTtlConfig((await settings.get('system_config:wallet.exchange.quoteTtlSeconds'))?.value);
    const quotedAt = Date.parse(quote.quotedAt);
    const expiresAt = Date.parse(quote.expiresAt);
    if (quotedAt > now.getTime() || expiresAt - quotedAt !== ttlSeconds * 1000 || !exchangeQuoteMatches(quote, configuredRate.rateCoinUnits, configuredRate.rateCashFen)) {
      abortWrite(transaction); throw new Error(WalletErrorCode.EXCHANGE_QUOTE_CHANGED);
    }
    const coins = BigInt(quote.coins);
    const cnyFen = BigInt(quote.cnyFen);
    if (coins <= 0n || coins > MAX_SIGNED_BIGINT || cnyFen <= 0n || cnyFen > MAX_SIGNED_BIGINT) { abortWrite(transaction); throw new Error(WalletErrorCode.INVALID_EXCHANGE_AMOUNT); }
    const accounts = transaction.objectStore('asset_accounts');
    const coinAccountId = `${userId}:${LocalAssetType.COIN}`;
    const cashAccountId = `${userId}:${LocalAssetType.CNY_BALANCE}`;
    const coinAccount = await accounts.get(coinAccountId);
    const availableCoins = BigInt(coinAccount?.amount ?? '0') > 0n ? BigInt(coinAccount!.amount) - BigInt(coinAccount!.frozenAmount) : 0n;
    if (!coinAccount || availableCoins < coins) { abortWrite(transaction); throw new Error(WalletErrorCode.INSUFFICIENT_EXCHANGE_BALANCE); }
    const systemUserId = (await settings.get(SYSTEM_USER_SETTING))?.value;
    if (typeof systemUserId !== 'string') { abortWrite(transaction); throw new Error(WalletErrorCode.WALLET_STORAGE_UNAVAILABLE); }
    const systemCoinAccountId = `${systemUserId}:${LocalAssetType.COIN}`;
    const systemCashAccountId = `${systemUserId}:${LocalAssetType.CNY_BALANCE}`;
    const systemCoin = await accounts.get(systemCoinAccountId);
    const systemCash = await accounts.get(systemCashAccountId);
    if (!systemCoin || !systemCash || BigInt(systemCash.amount) - BigInt(systemCash.frozenAmount) < cnyFen) { abortWrite(transaction); throw new Error(WalletErrorCode.EXCHANGE_NOT_AVAILABLE); }
    const cashAccount = await accounts.get(cashAccountId) ?? { accountId: cashAccountId, userId, assetType: LocalAssetType.CNY_BALANCE, amount: '0', frozenAmount: '0', version: 1, status: 1 } satisfies LocalAssetAccount;
    const nextCoinAmount = BigInt(coinAccount.amount) - coins;
    const nextCashAmount = BigInt(cashAccount.amount) + cnyFen;
    const nextSystemCoinAmount = BigInt(systemCoin.amount) + coins;
    const nextSystemCashAmount = BigInt(systemCash.amount) - cnyFen;
    if (nextCashAmount > MAX_SIGNED_BIGINT || nextSystemCoinAmount > MAX_SIGNED_BIGINT || nextSystemCashAmount < 0n) { abortWrite(transaction); throw new Error(WalletErrorCode.INVALID_EXCHANGE_AMOUNT); }
    const allocateId = async (): Promise<string> => {
      const current = await settings.get('next-id');
      const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
      await settings.put({ key: 'next-id', value: (id + 1n).toString() });
      return id.toString();
    };
    const operationId = await allocateId();
    const operation: LocalAssetOperation = { operationId, idempotencyKey: request.idempotencyKey, operationType: LocalAssetOperationType.COIN_EXCHANGE, status: 1, createdAt: nowIso, extra: { userId, coins: coins.toString(), cnyFen: cnyFen.toString(), rateCoinUnits: configuredRate.rateCoinUnits.toString(), rateCashFen: configuredRate.rateCashFen.toString(), rounding: 'FLOOR_FEN' } };
    const accountUpdates: LocalAssetAccount[] = [
      { ...coinAccount, amount: nextCoinAmount.toString(), version: coinAccount.version + 1 },
      { ...cashAccount, amount: nextCashAmount.toString(), version: cashAccount.version + 1 },
      { ...systemCoin, amount: nextSystemCoinAmount.toString(), version: systemCoin.version + 1 },
      { ...systemCash, amount: nextSystemCashAmount.toString(), version: systemCash.version + 1 },
    ];
    const entriesStore = transaction.objectStore('asset_entries');
    const entries: LocalAssetEntry[] = [
      { entryId: await allocateId(), operationId, accountId: coinAccountId, delta: (-coins).toString(), balanceAfter: nextCoinAmount.toString(), createdAt: nowIso },
      { entryId: await allocateId(), operationId, accountId: systemCoinAccountId, delta: coins.toString(), balanceAfter: nextSystemCoinAmount.toString(), createdAt: nowIso },
      { entryId: await allocateId(), operationId, accountId: cashAccountId, delta: cnyFen.toString(), balanceAfter: nextCashAmount.toString(), createdAt: nowIso },
      { entryId: await allocateId(), operationId, accountId: systemCashAccountId, delta: (-cnyFen).toString(), balanceAfter: nextSystemCashAmount.toString(), createdAt: nowIso },
    ];
    for (const account of accountUpdates) await accounts.put(account);
    await operations.put(operation);
    for (const entry of entries) await entriesStore.put(entry);
    await transaction.done;
    return exchangeResult(operation);
  }

  async getSummary(userId: string): Promise<WalletSummaryResponseDto> {
    const [coin, cash, turnover, grant] = await Promise.all([
      this.database.getFromIndex('asset_accounts', 'by-user-asset', [userId, LocalAssetType.COIN]),
      this.database.getFromIndex('asset_accounts', 'by-user-asset', [userId, LocalAssetType.CNY_BALANCE]),
      this.database.get('turnover_states', userId),
      this.database.getFromIndex('welcome_grants', 'by-user', userId),
    ]);
    const asset = (account: LocalAssetAccount | undefined, assetType: 1 | 2, currency: 'COIN' | 'CNY') => {
      const amount = BigInt(account?.amount ?? '0');
      const frozenAmount = BigInt(account?.frozenAmount ?? '0');
      const available = amount > 0n ? (amount - frozenAmount > 0n ? amount - frozenAmount : 0n) : 0n;
      return { assetType, currency, amount: amount.toString(), frozenAmount: frozenAmount.toString(), availableAmount: available.toString(), version: account?.version ?? 1 };
    };
    const remainingCoins = turnover?.remainingCoins ?? '0';
    return {
      assets: [asset(coin, LocalAssetType.COIN, 'COIN'), asset(cash, LocalAssetType.CNY_BALANCE, 'CNY')],
      turnover: { remainingCoins, canTransferOrWithdraw: remainingCoins === '0' },
      welcomeGift: grant ? { coins: grant.coins, turnoverRequirement: grant.turnoverRequirement } : null,
    };
  }

  async getActivity(userId: string, cursor?: WalletActivityCursorDto): Promise<WalletActivityResponseDto> {
    const accounts = await Promise.all(([LocalAssetType.COIN, LocalAssetType.CNY_BALANCE] as const).map((assetType) =>
      this.database.getFromIndex('asset_accounts', 'by-user-asset', [userId, assetType]),
    ));
    const entries = (await Promise.all(accounts.filter((account) => account !== undefined).map((account) =>
      this.database.getAllFromIndex('asset_entries', 'by-account', account.accountId),
    ))).flat();
    const sorted = entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || (BigInt(right.entryId) > BigInt(left.entryId) ? 1 : BigInt(right.entryId) < BigInt(left.entryId) ? -1 : 0));
    const [cursorTime, cursorId] = cursor?.split('~') ?? [];
    const afterCursor = cursorTime && cursorId
      ? sorted.filter((entry) => entry.createdAt < cursorTime || (entry.createdAt === cursorTime && BigInt(entry.entryId) < BigInt(cursorId)))
      : sorted;
    const hasMore = afterCursor.length > 50;
    const newestFirst = afterCursor.slice(0, 50);
    const items = await Promise.all(newestFirst.map(async (entry) => {
      const [operation, account] = await Promise.all([
        this.database.get('asset_operations', entry.operationId),
        this.database.get('asset_accounts', entry.accountId),
      ]);
      if (!operation || !account) return undefined;
      if (operation.operationType === LocalAssetOperationType.COIN_TRANSFER) {
        const extra = operation.extra;
        const isSender = extra?.senderUserId === userId;
        const isRecipient = extra?.recipientUserId === userId;
        if (!isSender && !isRecipient) return undefined;
        const counterpartyLabel = isSender ? extra?.recipientDisplayName : extra?.senderDisplayName;
        return {
          entryId: entry.entryId,
          operationId: entry.operationId,
          activityType: isSender ? WalletActivityType.TRANSFER_SENT : WalletActivityType.TRANSFER_RECEIVED,
          assetType: account.assetType,
          currency: 'COIN' as const,
          delta: entry.delta,
          balanceAfter: entry.balanceAfter,
          occurredAt: entry.createdAt,
          ...(counterpartyLabel ? { counterpartyLabel } : {}),
          ...(extra?.coins ? { transferCoins: extra.coins } : {}),
          ...(extra?.feeCoins !== undefined ? { feeCoins: extra.feeCoins } : {}),
        };
      }
      if (operation.operationType === LocalAssetOperationType.COIN_EXCHANGE) {
        const extra = operation.extra;
        if (extra?.userId !== userId) return undefined;
        return {
          entryId: entry.entryId, operationId: entry.operationId,
          activityType: WalletActivityType.CURRENCY_EXCHANGE,
          assetType: account.assetType,
          currency: account.assetType === LocalAssetType.COIN ? 'COIN' as const : 'CNY' as const,
          delta: entry.delta, balanceAfter: entry.balanceAfter, occurredAt: entry.createdAt,
          ...(extra.coins ? { exchangeCoins: extra.coins } : {}), ...(extra.cnyFen ? { exchangeCnyFen: extra.cnyFen } : {}),
        };
      }
      if (operation.operationType === LocalAssetOperationType.COIN_PURCHASE) {
        const extra = operation.extra;
        if (extra?.userId !== userId || account.assetType !== LocalAssetType.COIN) return undefined;
        return {
          entryId: entry.entryId, operationId: entry.operationId,
          activityType: WalletActivityType.PAYMENT_PURCHASE,
          assetType: account.assetType,
          currency: 'COIN' as const,
          delta: entry.delta, balanceAfter: entry.balanceAfter, occurredAt: entry.createdAt,
          ...(extra.orderNo ? { purchaseOrderNo: extra.orderNo } : {}),
          ...(extra.amountCnyFen ? { purchaseAmountCnyFen: extra.amountCnyFen } : {}),
        };
      }
      if (operation.operationType !== LocalAssetOperationType.INITIAL_GIFT) return undefined;
      return {
        entryId: entry.entryId,
        operationId: entry.operationId,
        activityType: WalletActivityType.WELCOME_GIFT,
        assetType: account.assetType,
        currency: account.assetType === LocalAssetType.COIN ? 'COIN' as const : 'CNY' as const,
        delta: entry.delta,
        balanceAfter: entry.balanceAfter,
        occurredAt: entry.createdAt,
      };
    }));
    const last = newestFirst.at(-1);
    return {
      items: items.filter((item): item is NonNullable<typeof item> => item !== undefined),
      nextCursor: hasMore && last ? `${last.createdAt}~${last.entryId}` : null,
    };
  }
}
