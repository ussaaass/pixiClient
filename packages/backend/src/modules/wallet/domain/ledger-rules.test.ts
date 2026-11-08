import { describe, expect, it } from 'vitest';
import type { WalletExchangeQuoteDto, WalletTransferQuoteDto } from '@gameing/contracts/wallet';
import {
  assertAvailableBalance,
  assertConservation,
  assertExchangeAmountPositive,
  assertVersionNotConflicted,
  checkExchangeQuote,
  checkTransferQuote,
  checkTurnoverGate,
  parseCnyToCoinRatio,
  requestHashOf,
  TRANSFER_FEE_BPS,
} from './ledger-rules.js';
import { W } from './errors.js';
import type { LedgerPost } from '../ports/wallet-repository.js';

const now = new Date('2026-11-07T12:00:00.000Z');

function transferQuote(overrides: Partial<WalletTransferQuoteDto> = {}): WalletTransferQuoteDto {
  return {
    recipientUserId: '2',
    recipientDisplayName: 'Recipient',
    coins: '1000',
    feeCoins: '50',
    totalCoins: '1050',
    feeRateBps: TRANSFER_FEE_BPS,
    quotedAt: '2026-11-07T12:00:00.000Z',
    expiresAt: '2026-11-07T12:05:00.000Z',
    ...overrides,
  };
}

function exchangeQuote(overrides: Partial<WalletExchangeQuoteDto> = {}): WalletExchangeQuoteDto {
  return {
    coins: '1000',
    cnyFen: '10000',
    rateCoinUnits: '10',
    rateCashFen: '100',
    quotedAt: '2026-11-07T12:00:00.000Z',
    expiresAt: '2026-11-07T12:05:00.000Z',
    ...overrides,
  };
}

describe('wallet ledger rules', () => {
  it('parses positive integer CNY-to-coin ratios and rejects malformed inputs', () => {
    expect(parseCnyToCoinRatio('1:10')).toEqual({ rateCoinUnits: 10n, rateCashFen: 100n });
    expect(parseCnyToCoinRatio('12:345')).toEqual({ rateCoinUnits: 345n, rateCashFen: 1200n });
    expect(parseCnyToCoinRatio('0:10')).toBeNull();
    for (const invalid of [null, undefined, '', '1:0', '01:10', '1:010', '1.5:10', '-1:10', '1234567890:1', '1:1234567890']) {
      expect(parseCnyToCoinRatio(invalid)).toBeNull();
    }
  });

  it('hashes stable serialized request payloads with SHA-256', () => {
    const first = requestHashOf({ userId: '1', amount: '100' });
    const same = requestHashOf({ userId: '1', amount: '100' });
    const different = requestHashOf({ userId: '1', amount: '101' });
    expect(first).toHaveLength(32);
    expect(first).toEqual(same);
    expect(first).not.toEqual(different);
  });

  it('checks transfer quote expiration before matching the current fee', () => {
    expect(checkTransferQuote(transferQuote(), now)).toBe('OK');
    expect(checkTransferQuote(transferQuote({ expiresAt: now.toISOString() }), now)).toBe(W.TRANSFER_QUOTE_EXPIRED);
    expect(checkTransferQuote(transferQuote({ feeRateBps: TRANSFER_FEE_BPS + 1 }), now)).toBe(W.TRANSFER_QUOTE_CHANGED);
  });

  it('checks exchange quote expiration and current rate', () => {
    const rate = { rateCoinUnits: 10n, rateCashFen: 100n };
    expect(checkExchangeQuote(exchangeQuote(), rate, now)).toBe('OK');
    expect(checkExchangeQuote(exchangeQuote({ expiresAt: now.toISOString() }), rate, now)).toBe(W.EXCHANGE_QUOTE_EXPIRED);
    expect(checkExchangeQuote(exchangeQuote(), { rateCoinUnits: 20n, rateCashFen: 100n }, now)).toBe(W.EXCHANGE_QUOTE_CHANGED);
  });

  it('requires ledger posts to conserve the expected net value', () => {
    const balanced = [
      { accountId: '1', amount: -100n },
      { accountId: '2', amount: 100n },
    ] as LedgerPost[];
    expect(() => assertConservation(balanced, 0n)).not.toThrow();
    expect(() => assertConservation(balanced, 1n)).toThrow(expect.objectContaining({ code: W.WALLET_STORAGE_UNAVAILABLE }));
  });

  it('rejects a zero-row optimistic version update as retryable storage conflict', () => {
    expect(() => assertVersionNotConflicted(1, '7')).not.toThrow();
    expect(() => assertVersionNotConflicted(0, '7')).toThrow(
      expect.objectContaining({
        code: W.WALLET_STORAGE_UNAVAILABLE,
        retryable: true,
      }),
    );
  });

  it('enforces available balance after frozen funds and positive exchange result', () => {
    expect(() => assertAvailableBalance(1000n, 200n, 800n)).not.toThrow();
    expect(() => assertAvailableBalance(1000n, 200n, 801n)).toThrow(expect.objectContaining({ code: W.INSUFFICIENT_AVAILABLE_BALANCE }));
    expect(() => assertExchangeAmountPositive(1n)).not.toThrow();
    expect(() => assertExchangeAmountPositive(0n)).toThrow(expect.objectContaining({ code: W.INVALID_EXCHANGE_AMOUNT }));
    expect(() => assertExchangeAmountPositive(-1n)).toThrow(expect.objectContaining({ code: W.INVALID_EXCHANGE_AMOUNT }));
  });

  it('allows missing or zero turnover and blocks positive or malformed requirements', () => {
    expect(checkTurnoverGate(null)).toBe(true);
    expect(checkTurnoverGate(undefined)).toBe(true);
    expect(checkTurnoverGate('0')).toBe(true);
    expect(checkTurnoverGate('1')).toBe(false);
    expect(checkTurnoverGate('invalid')).toBe(false);
  });
});
