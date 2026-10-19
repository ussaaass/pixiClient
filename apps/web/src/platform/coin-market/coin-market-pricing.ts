import type { CoinMarketPriceQuoteDto, CoinMarketPriceQuoteRequestDto } from '@gameing/contracts/coin-market';

const MAX_BIGINT = 9_223_372_036_854_775_807n;

export type CoinExchangeRate = { readonly rateCoinUnits: bigint; readonly rateCashFen: bigint };
export type CoinMarketPricingErrorCode = 'INVALID_COIN_AMOUNT' | 'INVALID_MARKET_PRICE' | 'INVALID_EXCHANGE_RATE' | 'AMOUNT_OUT_OF_RANGE';

export class CoinMarketPricingError extends Error {
  constructor(readonly code: CoinMarketPricingErrorCode) {
    super(code);
    this.name = 'CoinMarketPricingError';
  }
}

/**
 * Prices a partial fill against the listing's RMB fen price per 1,000 coins.
 * The seller's quote is rounded up to a fen; the informational exchange value
 * follows the wallet's floor-credit rule and is never used as the transaction price.
 */
export function quoteCoinMarketPrice(
  request: CoinMarketPriceQuoteRequestDto,
  exchangeRate: CoinExchangeRate,
  minimumListingCoins = '1000',
): CoinMarketPriceQuoteDto {
  if (!/^[1-9][0-9]{0,18}$/.test(request.coins)) throw new CoinMarketPricingError('INVALID_COIN_AMOUNT');
  if (!/^[1-9][0-9]{0,18}$/.test(request.priceCentsPer1000Coins)) throw new CoinMarketPricingError('INVALID_MARKET_PRICE');
  if (!/^[1-9][0-9]{0,18}$/.test(minimumListingCoins)) throw new CoinMarketPricingError('INVALID_MARKET_PRICE');
  if (exchangeRate.rateCoinUnits <= 0n || exchangeRate.rateCashFen <= 0n) throw new CoinMarketPricingError('INVALID_EXCHANGE_RATE');

  const coins = BigInt(request.coins);
  const price = BigInt(request.priceCentsPer1000Coins);
  if (coins > MAX_BIGINT) throw new CoinMarketPricingError('AMOUNT_OUT_OF_RANGE');
  const grossCents = ceilDiv(price * coins, 1000n);
  const referenceCents = (1000n * exchangeRate.rateCashFen) / exchangeRate.rateCoinUnits;
  if (grossCents > MAX_BIGINT || referenceCents <= 0n || referenceCents > MAX_BIGINT) {
    throw new CoinMarketPricingError('AMOUNT_OUT_OF_RANGE');
  }

  return {
    coins: coins.toString(),
    priceCentsPer1000Coins: price.toString(),
    referenceCentsPer1000Coins: referenceCents.toString(),
    grossCents: grossCents.toString(),
    minimumListingCoins,
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n || denominator <= 0n) throw new CoinMarketPricingError('INVALID_MARKET_PRICE');
  return (numerator + denominator - 1n) / denominator;
}
