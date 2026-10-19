import type { CoinMarketListingCreateRequestDto, CoinMarketListingDto, CoinMarketListingPageDto, CoinMarketPriceQuoteDto, CoinMarketPriceQuoteRequestDto, CoinMarketTradeCreateRequestDto, CoinMarketTradeDto, CoinMarketTradeTextRequestDto } from '@gameing/contracts/coin-market';

export type CoinMarketApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string };

export interface CoinMarketApplication {
  quotePrice(request: CoinMarketPriceQuoteRequestDto): Promise<CoinMarketApplicationResult<CoinMarketPriceQuoteDto>>;
  myListings(): Promise<CoinMarketApplicationResult<CoinMarketListingDto[]>>;
  createListing(request: CoinMarketListingCreateRequestDto): Promise<CoinMarketApplicationResult<CoinMarketListingDto>>;
  cancelListing(listingId: string): Promise<CoinMarketApplicationResult<CoinMarketListingDto>>;
  publicListings(cursor?: string): Promise<CoinMarketApplicationResult<CoinMarketListingPageDto>>;
  myTrades(): Promise<CoinMarketApplicationResult<CoinMarketTradeDto[]>>;
  createTrade(listingId: string, request: CoinMarketTradeCreateRequestDto): Promise<CoinMarketApplicationResult<CoinMarketTradeDto>>;
  tradeCommand(action: 'paymentProof' | 'appeal' | 'buyerEvidence' | 'sellerEvidence' | 'confirmReceipt', tradeId: string, request?: CoinMarketTradeTextRequestDto): Promise<CoinMarketApplicationResult<CoinMarketTradeDto>>;
}

export function createCoinMarketApplication(
  ports: {
    quote: (request: CoinMarketPriceQuoteRequestDto) => Promise<CoinMarketPriceQuoteDto>;
    myListings: () => Promise<CoinMarketListingDto[]>;
    createListing: (request: CoinMarketListingCreateRequestDto) => Promise<CoinMarketListingDto>;
    cancelListing: (listingId: string) => Promise<CoinMarketListingDto>;
    publicListings: (cursor?: string) => Promise<CoinMarketListingPageDto>;
    myTrades: () => Promise<CoinMarketTradeDto[]>;
    createTrade: (listingId: string, request: CoinMarketTradeCreateRequestDto) => Promise<CoinMarketTradeDto>;
    tradeCommand: (action: 'paymentProof' | 'appeal' | 'buyerEvidence' | 'sellerEvidence' | 'confirmReceipt', tradeId: string, request?: CoinMarketTradeTextRequestDto) => Promise<CoinMarketTradeDto>;
  },
): CoinMarketApplication {
  async function safely<T>(operation: () => Promise<T>): Promise<CoinMarketApplicationResult<T>> {
    try { return { ok: true, value: await operation() }; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return { ok: false, code: error.code };
      return { ok: false, code: error instanceof Error ? error.message : 'COIN_MARKET_REQUEST_FAILED' };
    }
  }
  return {
    quotePrice: (request) => safely(() => ports.quote(request)),
    myListings: () => safely(ports.myListings),
    createListing: (request) => safely(() => ports.createListing(request)),
    cancelListing: (listingId) => safely(() => ports.cancelListing(listingId)),
    publicListings: (cursor) => safely(() => ports.publicListings(cursor)),
    myTrades: () => safely(ports.myTrades),
    createTrade: (listingId, request) => safely(() => ports.createTrade(listingId, request)),
    tradeCommand: (action, tradeId, request) => safely(() => ports.tradeCommand(action, tradeId, request)),
  };
}

/** Converts a user-entered RMB amount to integer fen without floating point. */
export function parseCoinMarketRmbToFen(value: string): string | undefined {
  const normalized = value.trim();
  const match = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,2}))?$/.exec(normalized);
  if (!match) return undefined;
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const fen = BigInt(match[1]!) * 100n + BigInt(fraction || '0');
  return fen > 0n ? fen.toString() : undefined;
}
