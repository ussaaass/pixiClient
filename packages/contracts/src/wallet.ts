import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const WalletAssetType = { COIN: 1, CNY_BALANCE: 2 } as const;
export const WalletActivityType = { WELCOME_GIFT: 1, TRANSFER_SENT: 2, TRANSFER_RECEIVED: 3, CURRENCY_EXCHANGE: 4, PAYMENT_PURCHASE: 5, COIN_MARKET_HOLD: 6, COIN_MARKET_RELEASE: 7 } as const;
export const PayoutChannelType = { ALIPAY: 1, WECHAT_PAY: 2, BANK_TRANSFER: 3, UNIONPAY_QR: 4, DIGITAL_CNY: 5 } as const;
export const WithdrawalStatus = { REQUESTED: 1, REVIEWING: 2, APPROVED: 3, PAYING: 4, SUCCEEDED: 5, REJECTED: 6, CANCELLED: 7, PAYMENT_UNKNOWN: 8, FAILED: 9 } as const;
export const WalletErrorCode = { TRANSFER_NOT_FOUND: 'TRANSFER_NOT_FOUND', RECIPIENT_NOT_FOUND: 'RECIPIENT_NOT_FOUND', SELF_TRANSFER: 'SELF_TRANSFER', INVALID_TRANSFER_AMOUNT: 'INVALID_TRANSFER_AMOUNT', TURNOVER_INCOMPLETE: 'TURNOVER_INCOMPLETE', INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE', TRANSFER_QUOTE_EXPIRED: 'TRANSFER_QUOTE_EXPIRED', TRANSFER_QUOTE_CHANGED: 'TRANSFER_QUOTE_CHANGED', EXCHANGE_NOT_AVAILABLE: 'EXCHANGE_NOT_AVAILABLE', EXCHANGE_QUOTE_EXPIRED: 'EXCHANGE_QUOTE_EXPIRED', EXCHANGE_QUOTE_CHANGED: 'EXCHANGE_QUOTE_CHANGED', INVALID_EXCHANGE_AMOUNT: 'INVALID_EXCHANGE_AMOUNT', INSUFFICIENT_EXCHANGE_BALANCE: 'INSUFFICIENT_EXCHANGE_BALANCE', PAYOUT_ACCOUNT_NOT_FOUND: 'PAYOUT_ACCOUNT_NOT_FOUND', PAYOUT_ACCOUNT_IN_USE: 'PAYOUT_ACCOUNT_IN_USE', INVALID_PAYOUT_ACCOUNT: 'INVALID_PAYOUT_ACCOUNT', WITHDRAWAL_CONFIG_INVALID: 'WITHDRAWAL_CONFIG_INVALID', WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID: 'WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID', WITHDRAWAL_QUOTE_EXPIRED: 'WITHDRAWAL_QUOTE_EXPIRED', WITHDRAWAL_QUOTE_CHANGED: 'WITHDRAWAL_QUOTE_CHANGED', WITHDRAWAL_NOT_FOUND: 'WITHDRAWAL_NOT_FOUND', WITHDRAWAL_NOT_CANCELLABLE: 'WITHDRAWAL_NOT_CANCELLABLE', IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED', WALLET_STORAGE_UNAVAILABLE: 'WALLET_STORAGE_UNAVAILABLE' } as const;
const WalletAssetTypeSchema = Type.Union([Type.Literal(WalletAssetType.COIN), Type.Literal(WalletAssetType.CNY_BALANCE)]);
export const WalletActivityCursorSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z~[1-9][0-9]{0,19}$' });

export const WalletAssetSummarySchema = Type.Object({
  assetType: WalletAssetTypeSchema,
  currency: Type.Union([Type.Literal('COIN'), Type.Literal('CNY')]),
  amount: Type.String({ pattern: '^-?(?:0|[1-9][0-9]*)$' }),
  frozenAmount: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  availableAmount: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const WalletActivityItemSchema = Type.Object({
  entryId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  operationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  activityType: Type.Union(Object.values(WalletActivityType).map((value) => Type.Literal(value))),
  assetType: WalletAssetTypeSchema,
  currency: Type.Union([Type.Literal('COIN'), Type.Literal('CNY')]),
  delta: Type.String({ pattern: '^-?(?:0|[1-9][0-9]*)$' }),
  balanceAfter: Type.String({ pattern: '^-?(?:0|[1-9][0-9]*)$' }),
  occurredAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  counterpartyLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
  transferCoins: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  feeCoins: Type.Optional(Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' })),
  exchangeCoins: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  exchangeCnyFen: Type.Optional(Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' })),
  purchaseOrderNo: Type.Optional(Type.String({ minLength: 8, maxLength: 48 })),
  purchaseAmountCnyFen: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
  frozenDelta: Type.Optional(Type.String({ pattern: '^-?(?:0|[1-9][0-9]*)$' })),
}, { additionalProperties: false });

const PositiveCoinsSchema = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
const IdempotencyKeySchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const PayoutChannelTypeSchema = Type.Union(Object.values(PayoutChannelType).map((value) => Type.Literal(value)));
export const PayoutAccountSchema = Type.Object({ payoutAccountId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), channelType: PayoutChannelTypeSchema, accountLabel: Type.String({ minLength: 1, maxLength: 48 }), maskedAccount: Type.String({ minLength: 3, maxLength: 32 }), isDefault: Type.Boolean(), status: Type.Literal(1), createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) }, { additionalProperties: false });
export const PayoutAccountListSchema = Type.Array(PayoutAccountSchema);
export const CreatePayoutAccountRequestSchema = Type.Object({ channelType: PayoutChannelTypeSchema, accountLabel: Type.String({ minLength: 1, maxLength: 48 }), accountReference: Type.String({ minLength: 4, maxLength: 128 }), idempotencyKey: IdempotencyKeySchema }, { additionalProperties: false });
export const WithdrawalQuoteRequestSchema = Type.Object({ payoutAccountId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), netCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }) }, { additionalProperties: false });
export const WithdrawalQuoteSchema = Type.Object({ payoutAccountId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), payoutAccountLabel: Type.String({ minLength: 1, maxLength: 48 }), maskedAccount: Type.String({ minLength: 3, maxLength: 32 }), netCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }), feeCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]{0,11})$' }), debitCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,12}$' }), minimumNetCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }), feeRateBps: Type.Integer({ minimum: 0, maximum: 10000 }), payoutNotBeforeAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }), quotedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }), expiresAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) }, { additionalProperties: false });
export const WithdrawalSchema = Type.Object({ withdrawalId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), payoutAccountId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), payoutAccountLabel: Type.String({ minLength: 1, maxLength: 48 }), maskedAccount: Type.String({ minLength: 3, maxLength: 32 }), netCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }), feeCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]{0,11})$' }), debitCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,12}$' }), status: Type.Union(Object.values(WithdrawalStatus).map((value) => Type.Literal(value))), payoutNotBeforeAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }), createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) }, { additionalProperties: false });
export const WithdrawalListSchema = Type.Array(WithdrawalSchema, { maxItems: 50 });
export const CreateWithdrawalRequestSchema = Type.Object({ quote: WithdrawalQuoteSchema, idempotencyKey: IdempotencyKeySchema }, { additionalProperties: false });
export const WalletTransferQuoteRequestSchema = Type.Object({ recipientUserId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), coins: PositiveCoinsSchema }, { additionalProperties: false });
export const WalletTransferQuoteSchema = Type.Object({ recipientUserId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), recipientDisplayName: Type.String({ minLength: 1, maxLength: 48 }), coins: PositiveCoinsSchema, feeCoins: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }), totalCoins: PositiveCoinsSchema, feeRateBps: Type.Integer({ minimum: 0, maximum: 10000 }), quotedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }), expiresAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) }, { additionalProperties: false });
export const WalletTransferRequestSchema = Type.Object({ quote: WalletTransferQuoteSchema, idempotencyKey: IdempotencyKeySchema }, { additionalProperties: false });
export const WalletTransferResultSchema = Type.Object({ operationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), recipientUserId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), recipientDisplayName: Type.String({ minLength: 1, maxLength: 48 }), coins: PositiveCoinsSchema, feeCoins: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }), totalCoins: PositiveCoinsSchema, occurredAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) }, { additionalProperties: false });
export const WalletExchangeQuoteRequestSchema = Type.Object({ coins: PositiveCoinsSchema }, { additionalProperties: false });
export const WalletExchangeQuoteSchema = Type.Object({ coins: PositiveCoinsSchema, cnyFen: Type.String({ pattern: '^[1-9][0-9]*$' }), rateCoinUnits: Type.String({ pattern: '^[1-9][0-9]*$' }), rateCashFen: Type.String({ pattern: '^[1-9][0-9]*$' }), quotedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }), expiresAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) }, { additionalProperties: false });
export const WalletExchangeRequestSchema = Type.Object({ quote: WalletExchangeQuoteSchema, idempotencyKey: IdempotencyKeySchema }, { additionalProperties: false });
export const WalletExchangeResultSchema = Type.Object({ operationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), coins: PositiveCoinsSchema, cnyFen: Type.String({ pattern: '^[1-9][0-9]*$' }), occurredAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }) }, { additionalProperties: false });

export const WalletActivityResponseSchema = Type.Object({
  items: Type.Array(WalletActivityItemSchema, { maxItems: 50 }),
  nextCursor: Type.Union([WalletActivityCursorSchema, Type.Null()]),
}, { additionalProperties: false });

export const WalletSummaryResponseSchema = Type.Object({
  assets: Type.Array(WalletAssetSummarySchema, { minItems: 2, maxItems: 2 }),
  turnover: Type.Object({ remainingCoins: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }), canTransferOrWithdraw: Type.Boolean() }, { additionalProperties: false }),
  welcomeGift: Type.Union([Type.Object({ coins: Type.String({ pattern: '^[1-9][0-9]*$' }), turnoverRequirement: Type.String({ pattern: '^[1-9][0-9]*$' }) }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false });

export const WalletEndpoint = {
  summary: { method: 'GET', path: '/api/v1/me/wallet/summary', response: WalletSummaryResponseSchema, successStatus: 200 },
  activity: { method: 'GET', path: '/api/v1/me/wallet/activity', response: WalletActivityResponseSchema, successStatus: 200 },
  transferQuote: { method: 'POST', path: '/api/v1/me/wallet/transfers/quote', request: WalletTransferQuoteRequestSchema, response: WalletTransferQuoteSchema, successStatus: 200 },
  transfer: { method: 'POST', path: '/api/v1/me/wallet/transfers', request: WalletTransferRequestSchema, response: WalletTransferResultSchema, successStatus: 201 },
  exchangeQuote: { method: 'POST', path: '/api/v1/me/wallet/exchanges/quote', request: WalletExchangeQuoteRequestSchema, response: WalletExchangeQuoteSchema, successStatus: 200 },
  exchange: { method: 'POST', path: '/api/v1/me/wallet/exchanges', request: WalletExchangeRequestSchema, response: WalletExchangeResultSchema, successStatus: 201 },
  payoutAccounts: { method: 'GET', path: '/api/v1/me/wallet/payout-accounts', response: PayoutAccountListSchema, successStatus: 200 },
  createPayoutAccount: { method: 'POST', path: '/api/v1/me/wallet/payout-accounts', request: CreatePayoutAccountRequestSchema, response: PayoutAccountSchema, successStatus: 201 },
  deletePayoutAccount: { method: 'DELETE', path: '/api/v1/me/wallet/payout-accounts/:payoutAccountId', response: Type.Object({ deleted: Type.Boolean() }, { additionalProperties: false }), successStatus: 200 },
  withdrawalQuote: { method: 'POST', path: '/api/v1/me/wallet/withdrawals/quote', request: WithdrawalQuoteRequestSchema, response: WithdrawalQuoteSchema, successStatus: 200 },
  withdrawals: { method: 'GET', path: '/api/v1/me/wallet/withdrawals', response: WithdrawalListSchema, successStatus: 200 },
  createWithdrawal: { method: 'POST', path: '/api/v1/me/wallet/withdrawals', request: CreateWithdrawalRequestSchema, response: WithdrawalSchema, successStatus: 201 },
  cancelWithdrawal: { method: 'POST', path: '/api/v1/me/wallet/withdrawals/:withdrawalId/cancel', response: WithdrawalSchema, successStatus: 200 },
} as const;

export type WalletAssetSummaryDto = Static<typeof WalletAssetSummarySchema>;
export type WalletSummaryResponseDto = Static<typeof WalletSummaryResponseSchema>;
export type WalletActivityItemDto = Static<typeof WalletActivityItemSchema>;
export type WalletActivityResponseDto = Static<typeof WalletActivityResponseSchema>;
export type WalletActivityCursorDto = Static<typeof WalletActivityCursorSchema>;
export type WalletTransferQuoteRequestDto = Static<typeof WalletTransferQuoteRequestSchema>;
export type WalletTransferQuoteDto = Static<typeof WalletTransferQuoteSchema>;
export type WalletTransferRequestDto = Static<typeof WalletTransferRequestSchema>;
export type WalletTransferResultDto = Static<typeof WalletTransferResultSchema>;
export type WalletExchangeQuoteRequestDto = Static<typeof WalletExchangeQuoteRequestSchema>;
export type WalletExchangeQuoteDto = Static<typeof WalletExchangeQuoteSchema>;
export type WalletExchangeRequestDto = Static<typeof WalletExchangeRequestSchema>;
export type WalletExchangeResultDto = Static<typeof WalletExchangeResultSchema>;
export type PayoutAccountDto = Static<typeof PayoutAccountSchema>;
export type CreatePayoutAccountRequestDto = Static<typeof CreatePayoutAccountRequestSchema>;
export type WithdrawalQuoteRequestDto = Static<typeof WithdrawalQuoteRequestSchema>;
export type WithdrawalQuoteDto = Static<typeof WithdrawalQuoteSchema>;
export type CreateWithdrawalRequestDto = Static<typeof CreateWithdrawalRequestSchema>;
export type WithdrawalDto = Static<typeof WithdrawalSchema>;
