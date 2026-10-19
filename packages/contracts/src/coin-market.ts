import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const PositiveIntegerStringSchema = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
const TimestampSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
export const CoinMarketListingStatus = { ACTIVE: 1, PAUSED: 2, COMPLETED: 3, CANCELLED: 4, SUSPENDED: 5 } as const;
export const CoinMarketPaymentMethod = { BANK_TRANSFER: 1, ALIPAY: 2, WECHAT: 3, UNION_QR: 4, DIGITAL_RMB: 5, USDT_TRC20: 6 } as const;
export const CoinMarketTradeStatus = { PAYMENT_PENDING: 1, SELLER_CONFIRMATION_PENDING: 2, DISPUTED: 3, BUYER_EVIDENCE_PENDING: 4, SELLER_EVIDENCE_PENDING: 5, PLATFORM_REVIEW: 6, RELEASED: 7, RETURNED: 8, PAYMENT_EXPIRED: 9 } as const;
export const CoinMarketErrorCode = {
  ACCESS_DISABLED: 'SOCIAL_ACCESS_DISABLED',
  TURNOVER_INCOMPLETE: 'TURNOVER_INCOMPLETE',
  INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE',
  LISTING_BELOW_MINIMUM: 'LISTING_BELOW_MINIMUM',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  LISTING_NOT_FOUND: 'LISTING_NOT_FOUND',
  LISTING_NOT_CANCELLABLE: 'LISTING_NOT_CANCELLABLE',
  LISTING_HOLD_INCONSISTENT: 'LISTING_HOLD_INCONSISTENT',
  TRADE_BELOW_MINIMUM: 'TRADE_BELOW_MINIMUM', TRADE_NOT_FOUND: 'TRADE_NOT_FOUND', TRADE_NOT_ALLOWED: 'TRADE_NOT_ALLOWED', TRADE_STATE_INVALID: 'TRADE_STATE_INVALID', TRADE_DEADLINE_PASSED: 'TRADE_DEADLINE_PASSED',
  PAYMENT_HANDLER_UNAVAILABLE: 'PAYMENT_HANDLER_UNAVAILABLE',
} as const;
const ListingStatusSchema = Type.Union(Object.values(CoinMarketListingStatus).map((value) => Type.Literal(value)));
const PaymentMethodSchema = Type.Union(Object.values(CoinMarketPaymentMethod).map((value) => Type.Literal(value)));
const TradeStatusSchema = Type.Union(Object.values(CoinMarketTradeStatus).map((value) => Type.Literal(value)));
const IdempotencyKeySchema = Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });

export const CoinMarketPriceQuoteRequestSchema = Type.Object({
  coins: PositiveIntegerStringSchema,
  priceCentsPer1000Coins: PositiveIntegerStringSchema,
}, { additionalProperties: false });

export const CoinMarketPriceQuoteDtoSchema = Type.Object({
  coins: PositiveIntegerStringSchema,
  priceCentsPer1000Coins: PositiveIntegerStringSchema,
  referenceCentsPer1000Coins: PositiveIntegerStringSchema,
  grossCents: PositiveIntegerStringSchema,
  minimumListingCoins: PositiveIntegerStringSchema,
}, { additionalProperties: false });

export const CoinMarketListingSchema = Type.Object({
  listingId: PositiveIntegerStringSchema,
  coins: PositiveIntegerStringSchema,
  availableCoins: Type.String({ pattern: '^(?:0|[1-9][0-9]{0,18})$' }),
  priceCentsPer1000Coins: PositiveIntegerStringSchema,
  referenceCentsPer1000Coins: PositiveIntegerStringSchema,
  totalCents: PositiveIntegerStringSchema,
  status: ListingStatusSchema,
  createdAt: TimestampSchema,
  sellerLabel: Type.Optional(Type.String({ maxLength: 32 })),
  paymentMethods: Type.Optional(Type.Array(PaymentMethodSchema, { minItems: 1, maxItems: 6 })),
}, { additionalProperties: false });

export const CoinMarketListingCreateRequestSchema = Type.Object({
  coins: PositiveIntegerStringSchema,
  priceCentsPer1000Coins: PositiveIntegerStringSchema,
  idempotencyKey: IdempotencyKeySchema,
  paymentMethods: Type.Array(PaymentMethodSchema, { minItems: 1, maxItems: 6 }),
  paymentInstructions: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });
export const CoinMarketListingUpdateRequestSchema = Type.Object({ action: Type.Literal('CANCEL') }, { additionalProperties: false });

export const CoinMarketListingPageSchema = Type.Object({ items: Type.Array(CoinMarketListingSchema, { maxItems: 20 }), nextCursor: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]), minimumTradeCoins: PositiveIntegerStringSchema }, { additionalProperties: false });
export const CoinMarketTradeSchema = Type.Object({
  tradeId: PositiveIntegerStringSchema, listingId: PositiveIntegerStringSchema, actorRole: Type.Union([Type.Literal('BUYER'), Type.Literal('SELLER')]),
  coins: PositiveIntegerStringSchema, grossCents: PositiveIntegerStringSchema, status: TradeStatusSchema, paymentMethod: PaymentMethodSchema,
  paymentInstructions: Type.String({ maxLength: 2000 }), paymentDeadlineAt: TimestampSchema, sellerDeadlineAt: Type.Union([TimestampSchema, Type.Null()]),
  buyerEvidenceDeadlineAt: Type.Union([TimestampSchema, Type.Null()]), sellerEvidenceDeadlineAt: Type.Union([TimestampSchema, Type.Null()]),
  platformDecisionDeadlineAt: Type.Union([TimestampSchema, Type.Null()]), paymentProof: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
  appealReason: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
  buyerEvidence: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]), sellerEvidence: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}, { additionalProperties: false });
export const CoinMarketTradeCreateRequestSchema = Type.Object({ coins: PositiveIntegerStringSchema, paymentMethod: PaymentMethodSchema, idempotencyKey: IdempotencyKeySchema }, { additionalProperties: false });
export const CoinMarketTradeTextRequestSchema = Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false });
export const CoinMarketTradeListSchema = Type.Array(CoinMarketTradeSchema, { maxItems: 100 });

export const CoinMarketListingListSchema = Type.Array(CoinMarketListingSchema, { maxItems: 100 });

export const CoinMarketEndpoint = {
  priceQuote: {
    method: 'POST',
    path: '/api/v1/coin-market/price-quotes',
    request: CoinMarketPriceQuoteRequestSchema,
    response: CoinMarketPriceQuoteDtoSchema,
    successStatus: 200,
  },
  listings: { method: 'GET', path: '/api/v1/coin-market/listings', response: CoinMarketListingPageSchema, successStatus: 200 },
  myListings: { method: 'GET', path: '/api/v1/me/coin-market/listings', response: CoinMarketListingListSchema, successStatus: 200 },
  createListing: { method: 'POST', path: '/api/v1/coin-market/listings', request: CoinMarketListingCreateRequestSchema, response: CoinMarketListingSchema, successStatus: 201 },
  updateListing: { method: 'PATCH', path: '/api/v1/coin-market/listings/:listingId', request: CoinMarketListingUpdateRequestSchema, response: CoinMarketListingSchema, successStatus: 200 },
  createTrade: { method: 'POST', path: '/api/v1/coin-market/listings/:listingId/trades', request: CoinMarketTradeCreateRequestSchema, response: CoinMarketTradeSchema, successStatus: 201 },
  myTrades: { method: 'GET', path: '/api/v1/me/coin-market/trades', response: CoinMarketTradeListSchema, successStatus: 200 },
  paymentProof: { method: 'POST', path: '/api/v1/me/coin-market/trades/:tradeId/payment-proof', request: CoinMarketTradeTextRequestSchema, response: CoinMarketTradeSchema, successStatus: 200 },
  appeal: { method: 'POST', path: '/api/v1/me/coin-market/trades/:tradeId/appeals', request: CoinMarketTradeTextRequestSchema, response: CoinMarketTradeSchema, successStatus: 200 },
  buyerEvidence: { method: 'POST', path: '/api/v1/me/coin-market/trades/:tradeId/buyer-evidence', request: CoinMarketTradeTextRequestSchema, response: CoinMarketTradeSchema, successStatus: 200 },
  sellerEvidence: { method: 'POST', path: '/api/v1/me/coin-market/trades/:tradeId/seller-evidence', request: CoinMarketTradeTextRequestSchema, response: CoinMarketTradeSchema, successStatus: 200 },
  confirmReceipt: { method: 'POST', path: '/api/v1/me/coin-market/trades/:tradeId/confirm-receipt', response: CoinMarketTradeSchema, successStatus: 200 },
} as const;

export type CoinMarketPriceQuoteRequestDto = Static<typeof CoinMarketPriceQuoteRequestSchema>;
export type CoinMarketPriceQuoteDto = Static<typeof CoinMarketPriceQuoteDtoSchema>;
export type CoinMarketListingDto = Static<typeof CoinMarketListingSchema>;
export type CoinMarketListingCreateRequestDto = Static<typeof CoinMarketListingCreateRequestSchema>;
export type CoinMarketListingUpdateRequestDto = Static<typeof CoinMarketListingUpdateRequestSchema>;
export type CoinMarketPaymentMethodValue = typeof CoinMarketPaymentMethod[keyof typeof CoinMarketPaymentMethod];
export type CoinMarketTradeDto = Static<typeof CoinMarketTradeSchema>;
export type CoinMarketTradeCreateRequestDto = Static<typeof CoinMarketTradeCreateRequestSchema>;
export type CoinMarketTradeTextRequestDto = Static<typeof CoinMarketTradeTextRequestSchema>;
export type CoinMarketListingPageDto = Static<typeof CoinMarketListingPageSchema>;
