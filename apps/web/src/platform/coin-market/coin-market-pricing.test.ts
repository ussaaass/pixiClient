import { describe, expect, it } from 'vitest';
import { CoinMarketPricingError, quoteCoinMarketPrice } from './coin-market-pricing';
import { createCoinMarketApplication, parseCoinMarketRmbToFen } from './coin-market-application';

describe('coin market price quotes', () => {
  const exchangeRate = { rateCoinUnits: 10n, rateCashFen: 100n };

  it('shows the configured exchange reference separately from the seller price', () => {
    expect(quoteCoinMarketPrice({ coins: '1000', priceCentsPer1000Coins: '12000' }, exchangeRate)).toEqual({
      coins: '1000',
      priceCentsPer1000Coins: '12000',
      referenceCentsPer1000Coins: '10000',
      grossCents: '12000',
      minimumListingCoins: '1000',
    });
  });

  it('prices partial fills proportionally and rounds charge up to one fen', () => {
    expect(quoteCoinMarketPrice({ coins: '1', priceCentsPer1000Coins: '10001' }, exchangeRate).grossCents).toBe('11');
    expect(quoteCoinMarketPrice({ coins: '500', priceCentsPer1000Coins: '12000' }, exchangeRate).grossCents).toBe('6000');
  });

  it('rejects invalid integer amounts and zero exchange rates', () => {
    expect(() => quoteCoinMarketPrice({ coins: '0', priceCentsPer1000Coins: '12000' }, exchangeRate)).toThrowError(new CoinMarketPricingError('INVALID_COIN_AMOUNT'));
    expect(() => quoteCoinMarketPrice({ coins: '1000', priceCentsPer1000Coins: '12000' }, { rateCoinUnits: 0n, rateCashFen: 100n })).toThrowError(new CoinMarketPricingError('INVALID_EXCHANGE_RATE'));
  });

  it('parses RMB input as integer fen and reports API errors as application results', async () => {
    expect(parseCoinMarketRmbToFen('120')).toBe('12000');
    expect(parseCoinMarketRmbToFen('120.5')).toBe('12050');
    expect(parseCoinMarketRmbToFen('1.239')).toBeUndefined();
    const application = createCoinMarketApplication({
      async quote() { throw new Error('SOCIAL_ACCESS_DISABLED'); },
      async myListings() { return []; },
      async createListing() { throw new Error('UNEXPECTED'); },
      async cancelListing() { throw new Error('UNEXPECTED'); },
      async publicListings() { return { items: [], nextCursor: null, minimumTradeCoins: '1000' }; },
      async myTrades() { return []; },
      async createTrade() { throw new Error('UNEXPECTED'); },
      async tradeCommand() { throw new Error('UNEXPECTED'); },
    });
    await expect(application.quotePrice({ coins: '1000', priceCentsPer1000Coins: '12000' })).resolves.toEqual({ ok: false, code: 'SOCIAL_ACCESS_DISABLED' });
  });
});
