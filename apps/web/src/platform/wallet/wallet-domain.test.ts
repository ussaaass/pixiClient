import { describe, expect, it } from 'vitest';
import { calculateExchangeCashFen, calculateTransferFee, createExchangeQuote, createTransferQuote, exchangeQuoteMatches, transferQuoteMatches } from './wallet-domain';

describe('wallet transfer domain rules', () => {
  it('rounds the 5% sender-paid fee upward to a whole coin', () => {
    expect(calculateTransferFee(100n, 500)).toBe(5n);
    expect(calculateTransferFee(101n, 500)).toBe(6n);
    expect(calculateTransferFee(1n, 500)).toBe(1n);
  });

  it('freezes quoted principal, fee rate and total for explicit confirmation', () => {
    const quote = createTransferQuote({ recipientUserId: '2', recipientDisplayName: '收款玩家', coins: 101n, feeRateBps: 500, quotedAt: new Date('2026-10-15T00:00:00.000Z') });
    expect(quote).toMatchObject({ coins: '101', feeCoins: '6', totalCoins: '107', feeRateBps: 500 });
    expect(transferQuoteMatches(quote, 500)).toBe(true);
    expect(transferQuoteMatches(quote, 600)).toBe(false);
  });
});

describe('wallet exchange domain rules', () => {
  it('uses integer math and rounds fractional fen down', () => {
    expect(calculateExchangeCashFen(5n, 3n, 100n)).toBe(166n);
    expect(calculateExchangeCashFen(10n, 10n, 100n)).toBe(100n);
  });

  it('snapshots the exact ratio and calculated result into a short-lived quote', () => {
    const quote = createExchangeQuote({ coins: 5n, rateCoinUnits: 3n, rateCashFen: 100n, quotedAt: new Date('2026-10-15T00:00:00.000Z') });
    expect(quote).toMatchObject({ coins: '5', cnyFen: '166', rateCoinUnits: '3', rateCashFen: '100' });
    expect(exchangeQuoteMatches(quote, 3n, 100n)).toBe(true);
    expect(exchangeQuoteMatches(quote, 10n, 100n)).toBe(false);
  });
});
