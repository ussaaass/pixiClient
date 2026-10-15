import { WalletErrorCode, type WalletExchangeQuoteDto, type WalletTransferQuoteDto, type WithdrawalQuoteDto } from '@gameing/contracts/wallet';
import { FundingErrorCode } from '@gameing/contracts/wallet-funding';

export const DEFAULT_COIN_TRANSFER_FEE_BPS = 500;
export const DEFAULT_TRANSFER_QUOTE_TTL_SECONDS = 60;
export const DEFAULT_EXCHANGE_RATE_COIN_UNITS = 10n;
export const DEFAULT_EXCHANGE_RATE_CASH_FEN = 100n;
export const DEFAULT_WITHDRAWAL_FEE_BPS = 500;
export const DEFAULT_MINIMUM_WITHDRAWAL_COINS = 1_000n;
export const DEFAULT_WITHDRAWAL_DELAY_HOURS = 72;

/** Converts a CNY payment snapshot to whole game coins; partial coins are rejected. */
export function calculatePurchaseCoins(amountCnyFen: bigint, rateCoinUnits: bigint, rateCashFen: bigint): bigint {
  if (amountCnyFen <= 0n || rateCoinUnits <= 0n || rateCashFen <= 0n) throw new Error(FundingErrorCode.INVALID_ORDER_AMOUNT);
  const numerator = amountCnyFen * rateCoinUnits;
  if (numerator % rateCashFen !== 0n) throw new Error(FundingErrorCode.INVALID_ORDER_AMOUNT);
  return numerator / rateCashFen;
}

export function calculateTransferFee(coins: bigint, feeRateBps: number): bigint {
  return (coins * BigInt(feeRateBps) + 9_999n) / 10_000n;
}

export function createTransferQuote(input: {
  recipientUserId: string;
  recipientDisplayName: string;
  coins: bigint;
  feeRateBps: number;
  quotedAt: Date;
  ttlSeconds?: number;
}): WalletTransferQuoteDto {
  const feeCoins = calculateTransferFee(input.coins, input.feeRateBps);
  return {
    recipientUserId: input.recipientUserId,
    recipientDisplayName: input.recipientDisplayName,
    coins: input.coins.toString(),
    feeCoins: feeCoins.toString(),
    totalCoins: (input.coins + feeCoins).toString(),
    feeRateBps: input.feeRateBps,
    quotedAt: input.quotedAt.toISOString(),
    expiresAt: new Date(input.quotedAt.getTime() + (input.ttlSeconds ?? DEFAULT_TRANSFER_QUOTE_TTL_SECONDS) * 1000).toISOString(),
  };
}

export function transferQuoteMatches(quote: WalletTransferQuoteDto, feeRateBps: number): boolean {
  const coins = BigInt(quote.coins);
  const fee = calculateTransferFee(coins, feeRateBps);
  return quote.feeRateBps === feeRateBps && quote.feeCoins === fee.toString() && quote.totalCoins === (coins + fee).toString();
}

export function calculateExchangeCashFen(coins: bigint, rateCoinUnits: bigint, rateCashFen: bigint): bigint {
  if (coins <= 0n || rateCoinUnits <= 0n || rateCashFen <= 0n) throw new Error('INVALID_EXCHANGE_AMOUNT');
  return (coins * rateCashFen) / rateCoinUnits;
}

export function createExchangeQuote(input: {
  coins: bigint;
  rateCoinUnits: bigint;
  rateCashFen: bigint;
  quotedAt: Date;
  ttlSeconds?: number;
}): WalletExchangeQuoteDto {
  const cnyFen = calculateExchangeCashFen(input.coins, input.rateCoinUnits, input.rateCashFen);
  if (cnyFen <= 0n) throw new Error('INVALID_EXCHANGE_AMOUNT');
  return {
    coins: input.coins.toString(),
    cnyFen: cnyFen.toString(),
    rateCoinUnits: input.rateCoinUnits.toString(),
    rateCashFen: input.rateCashFen.toString(),
    quotedAt: input.quotedAt.toISOString(),
    expiresAt: new Date(input.quotedAt.getTime() + (input.ttlSeconds ?? DEFAULT_TRANSFER_QUOTE_TTL_SECONDS) * 1000).toISOString(),
  };
}

export function exchangeQuoteMatches(quote: WalletExchangeQuoteDto, rateCoinUnits: bigint, rateCashFen: bigint): boolean {
  return quote.rateCoinUnits === rateCoinUnits.toString()
    && quote.rateCashFen === rateCashFen.toString()
    && quote.cnyFen === calculateExchangeCashFen(BigInt(quote.coins), rateCoinUnits, rateCashFen).toString();
}

export function calculateWithdrawalFee(netCnyFen: bigint, feeRateBps: number): bigint {
  return (netCnyFen * BigInt(feeRateBps) + 9_999n) / 10_000n;
}

export function createWithdrawalQuote(input: {
  payoutAccountId: string;
  payoutAccountLabel: string;
  maskedAccount: string;
  netCnyFen: bigint;
  feeRateBps: number;
  minimumNetCnyFen: bigint;
  quotedAt: Date;
  ttlSeconds?: number;
}): WithdrawalQuoteDto {
  if (input.minimumNetCnyFen <= 0n || input.netCnyFen <= 0n) throw new Error(WalletErrorCode.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID);
  if (input.netCnyFen < input.minimumNetCnyFen || input.netCnyFen % input.minimumNetCnyFen !== 0n) throw new Error(WalletErrorCode.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID);
  const feeCnyFen = calculateWithdrawalFee(input.netCnyFen, input.feeRateBps);
  return {
    payoutAccountId: input.payoutAccountId,
    payoutAccountLabel: input.payoutAccountLabel,
    maskedAccount: input.maskedAccount,
    netCnyFen: input.netCnyFen.toString(),
    feeCnyFen: feeCnyFen.toString(),
    debitCnyFen: (input.netCnyFen + feeCnyFen).toString(),
    minimumNetCnyFen: input.minimumNetCnyFen.toString(),
    feeRateBps: input.feeRateBps,
    payoutNotBeforeAt: new Date(input.quotedAt.getTime() + DEFAULT_WITHDRAWAL_DELAY_HOURS * 3_600_000).toISOString(),
    quotedAt: input.quotedAt.toISOString(),
    expiresAt: new Date(input.quotedAt.getTime() + (input.ttlSeconds ?? DEFAULT_TRANSFER_QUOTE_TTL_SECONDS) * 1000).toISOString(),
  };
}

export function withdrawalQuoteMatches(quote: WithdrawalQuoteDto, feeRateBps: number, minimumNetCnyFen: bigint): boolean {
  const net = BigInt(quote.netCnyFen);
  const fee = calculateWithdrawalFee(net, feeRateBps);
  return quote.feeRateBps === feeRateBps
    && quote.minimumNetCnyFen === minimumNetCnyFen.toString()
    && net >= minimumNetCnyFen
    && net % minimumNetCnyFen === 0n
    && quote.feeCnyFen === fee.toString()
    && quote.debitCnyFen === (net + fee).toString();
}
