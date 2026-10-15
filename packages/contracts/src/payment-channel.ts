import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const BigIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const TimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const PaymentMethod = {
  ALIPAY: 1,
  WECHAT: 2,
  BANK_TRANSFER: 3,
  UNIONPAY_QR: 4,
  DIGITAL_CNY: 5,
  USDT_TRON: 6,
} as const;

export const PaymentProviderType = { AGGREGATOR: 1, TRON_SELF_HOSTED: 2 } as const;
export const PaymentChannelStatus = { ACTIVE: 1, DISABLED: 2, MAINTENANCE: 3 } as const;
export const PaymentChannelSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;

export const PaymentChannelDtoSchema = Type.Object({
  channelId: BigIdSchema,
  providerCode: Type.String({ pattern: '^[a-z][a-z0-9-]{1,47}$' }),
  providerName: Type.String({ minLength: 2, maxLength: 80 }),
  providerType: Type.Union([Type.Literal(PaymentProviderType.AGGREGATOR), Type.Literal(PaymentProviderType.TRON_SELF_HOSTED)]),
  paymentMethod: Type.Union(Object.values(PaymentMethod).map((method) => Type.Literal(method))),
  sortOrder: Type.Integer({ minimum: 0, maximum: 1000000 }),
  status: Type.Union([Type.Literal(PaymentChannelStatus.ACTIVE), Type.Literal(PaymentChannelStatus.DISABLED), Type.Literal(PaymentChannelStatus.MAINTENANCE)]),
  source: Type.Union([Type.Literal(PaymentChannelSource.LOCAL_DEMO), Type.Literal(PaymentChannelSource.SERVER)]),
  updatedAt: TimestampSchema,
}, { additionalProperties: false });

export const PaymentChannelQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ maxLength: 80 })),
  paymentMethod: Type.Optional(Type.Union(Object.values(PaymentMethod).map((method) => Type.Literal(method)))),
  status: Type.Optional(Type.Union([Type.Literal(PaymentChannelStatus.ACTIVE), Type.Literal(PaymentChannelStatus.DISABLED), Type.Literal(PaymentChannelStatus.MAINTENANCE)])),
}, { additionalProperties: false });

export const CreatePaymentChannelRequestSchema = Type.Object({
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  providerCode: Type.String({ pattern: '^[a-z][a-z0-9-]{1,47}$' }),
  providerName: Type.String({ minLength: 2, maxLength: 80 }),
  providerType: Type.Union([Type.Literal(PaymentProviderType.AGGREGATOR), Type.Literal(PaymentProviderType.TRON_SELF_HOSTED)]),
  paymentMethod: Type.Union(Object.values(PaymentMethod).map((method) => Type.Literal(method))),
  sortOrder: Type.Integer({ minimum: 0, maximum: 1000000 }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { additionalProperties: false });

export const UpdatePaymentChannelRequestSchema = Type.Object({
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  channelId: BigIdSchema,
  providerName: Type.String({ minLength: 2, maxLength: 80 }),
  sortOrder: Type.Integer({ minimum: 0, maximum: 1000000 }),
  status: Type.Union([Type.Literal(PaymentChannelStatus.ACTIVE), Type.Literal(PaymentChannelStatus.DISABLED), Type.Literal(PaymentChannelStatus.MAINTENANCE)]),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { additionalProperties: false });

export const PaymentChannelChangeDtoSchema = Type.Object({
  changeId: Type.String({ minLength: 1, maxLength: 128 }),
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  channelId: BigIdSchema,
  previous: Type.Union([PaymentChannelDtoSchema, Type.Null()]),
  next: PaymentChannelDtoSchema,
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  source: Type.Literal(PaymentChannelSource.LOCAL_DEMO),
  createdAt: TimestampSchema,
}, { additionalProperties: false });

export const PaymentChannelWorkspaceSchema = Type.Object({
  source: Type.Union([Type.Literal(PaymentChannelSource.LOCAL_DEMO), Type.Literal(PaymentChannelSource.SERVER)]),
  items: Type.Array(PaymentChannelDtoSchema, { maxItems: 500 }),
}, { additionalProperties: false });

export const AdminPaymentChannelEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/payment-channels', query: PaymentChannelQuerySchema, successStatus: 200 },
  create: { method: 'POST', path: '/api/v1/admin/payment-channels', request: CreatePaymentChannelRequestSchema, response: PaymentChannelDtoSchema, successStatus: 201 },
  update: { method: 'PATCH', path: '/api/v1/admin/payment-channels/:channelId', request: UpdatePaymentChannelRequestSchema, response: PaymentChannelDtoSchema, successStatus: 200 },
} as const;

export type PaymentChannelDto = Static<typeof PaymentChannelDtoSchema>;
export type PaymentChannelQueryDto = Static<typeof PaymentChannelQuerySchema>;
export type CreatePaymentChannelRequestDto = Static<typeof CreatePaymentChannelRequestSchema>;
export type UpdatePaymentChannelRequestDto = Static<typeof UpdatePaymentChannelRequestSchema>;
export type PaymentChannelChangeDto = Static<typeof PaymentChannelChangeDtoSchema>;
export type PaymentChannelWorkspace = Static<typeof PaymentChannelWorkspaceSchema>;
