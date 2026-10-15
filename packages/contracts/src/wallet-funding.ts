import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const FundingPaymentMethod = { ALIPAY: 1, WECHAT: 2, BANK_TRANSFER: 3, UNIONPAY_QR: 4, DIGITAL_CNY: 5, USDT_TRON: 6 } as const;
export const FundingChannelStatus = { ENABLED: 1 } as const;
export const FundingOrderStatus = { PENDING_PAYMENT: 1, PAID: 2, FAILED: 3, CANCELLED: 4, EXPIRED: 5 } as const;
export const OrderType = { WALLET_COIN_PURCHASE: 1 } as const;
export const FundingErrorCode = { INVALID_ORDER_AMOUNT: 'INVALID_ORDER_AMOUNT', FUNDING_CHANNEL_UNAVAILABLE: 'FUNDING_CHANNEL_UNAVAILABLE', FUNDING_ORDER_NOT_FOUND: 'FUNDING_ORDER_NOT_FOUND', FUNDING_ORDER_NOT_PAYABLE: 'FUNDING_ORDER_NOT_PAYABLE', FUNDING_ORDER_EXPIRED: 'FUNDING_ORDER_EXPIRED', FUNDING_ORDER_AMOUNT_MISMATCH: 'FUNDING_ORDER_AMOUNT_MISMATCH', FUNDING_IDEMPOTENCY_KEY_REUSED: 'FUNDING_IDEMPOTENCY_KEY_REUSED', USDT_INVOICE_CAPACITY_REACHED: 'USDT_INVOICE_CAPACITY_REACHED' } as const;

const IdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const KeySchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const DateTimeSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
const FundingPaymentMethodSchema = Type.Union(Object.values(FundingPaymentMethod).map((value) => Type.Literal(value)));
const FundingOrderStatusSchema = Type.Union(Object.values(FundingOrderStatus).map((value) => Type.Literal(value)));
const UsdtInvoiceSchema = Type.Object({
  amountUsdtMilli: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }),
  displayAmountUsdt: Type.String({ pattern: '^[1-9][0-9]{0,8}\\.[0-9]{3}$' }),
  rateCnyPerUsdt: Type.String({ pattern: '^[1-9][0-9]{0,4}(?:\\.[0-9]{1,6})?$' }),
  depositAddress: Type.String({ minLength: 8, maxLength: 128 }),
  expiresAt: DateTimeSchema,
}, { additionalProperties: false });

export const FundingChannelDtoSchema = Type.Object({
  channelId: Type.String({ minLength: 1, maxLength: 64 }),
  displayName: Type.String({ minLength: 1, maxLength: 80 }),
  paymentMethod: FundingPaymentMethodSchema,
  sortOrder: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  status: Type.Literal(FundingChannelStatus.ENABLED),
}, { additionalProperties: false });
export const FundingChannelListResponseSchema = Type.Array(FundingChannelDtoSchema, { maxItems: 50 });

export const CreateFundingOrderRequestSchema = Type.Object({
  channelId: Type.String({ minLength: 1, maxLength: 64 }),
  amountCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }),
  idempotencyKey: KeySchema,
}, { additionalProperties: false });
export const FundingOrderDtoSchema = Type.Object({
  orderId: IdSchema,
  orderNo: Type.String({ minLength: 8, maxLength: 48 }),
  channelId: Type.String({ minLength: 1, maxLength: 64 }),
  channelName: Type.String({ minLength: 1, maxLength: 80 }),
  paymentMethod: FundingPaymentMethodSchema,
  amountCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }),
  creditCoins: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
  status: FundingOrderStatusSchema,
  createdAt: DateTimeSchema,
  paidAt: Type.Union([DateTimeSchema, Type.Null()]),
  usdtInvoice: Type.Optional(UsdtInvoiceSchema),
}, { additionalProperties: false });
export const FundingOrderListResponseSchema = Type.Array(FundingOrderDtoSchema, { maxItems: 50 });
export const SimulateFundingPaymentRequestSchema = Type.Union([
  Type.Object({ orderId: IdSchema, paidAmountCnyFen: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }), paymentEventId: Type.String({ minLength: 8, maxLength: 128 }) }, { additionalProperties: false }),
  Type.Object({ orderId: IdSchema, paidAmountUsdtMilli: Type.String({ pattern: '^[1-9][0-9]{0,11}$' }), paymentEventId: Type.String({ minLength: 8, maxLength: 128 }) }, { additionalProperties: false }),
]);

export const WalletFundingEndpoint = {
  channels: { method: 'GET', path: '/api/v1/me/payment-channels', response: FundingChannelListResponseSchema, successStatus: 200 },
  orders: { method: 'GET', path: '/api/v1/me/wallet/orders', response: FundingOrderListResponseSchema, successStatus: 200 },
  createOrder: { method: 'POST', path: '/api/v1/me/wallet/orders', request: CreateFundingOrderRequestSchema, response: FundingOrderDtoSchema, successStatus: 201 },
} as const;
/** Browser-only simulator contract; production route registries must not include this object. */
export const WalletFundingDevelopmentEndpoint = {
  simulatePayment: { method: 'POST', path: '/api/v1/dev/me/wallet/orders/simulate-payment', request: SimulateFundingPaymentRequestSchema, response: FundingOrderDtoSchema, successStatus: 200 },
} as const;

export type FundingChannelDto = Static<typeof FundingChannelDtoSchema>;
export type CreateFundingOrderRequestDto = Static<typeof CreateFundingOrderRequestSchema>;
export type FundingOrderDto = Static<typeof FundingOrderDtoSchema>;
export type SimulateFundingPaymentRequestDto = Static<typeof SimulateFundingPaymentRequestSchema>;
