import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { PaymentMethod } from './payment-channel';

const LocalOrderIdSchema = Type.String({ pattern: '^LOCAL-MOCK-[0-9]{6}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' });
const CnyAmountSchema = Type.String({ pattern: '^(0|[1-9][0-9]{0,6})\.[0-9]{2}$' });

export const MockPaymentScenario = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  TIMEOUT: 'TIMEOUT',
  DUPLICATE: 'DUPLICATE',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
} as const;

export const MockPaymentOrderStatus = {
  PENDING: 1,
  SIMULATED_SUCCESS: 2,
  SIMULATED_FAILURE: 3,
  SIMULATED_TIMEOUT: 4,
  REVIEW_REQUIRED: 5,
} as const;

export const MockPaymentChannelSnapshotDtoSchema = Type.Object({
  channelId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  providerCode: Type.String({ pattern: '^[a-z][a-z0-9_-]{1,31}$' }),
  providerName: Type.String({ minLength: 1, maxLength: 80 }),
  paymentMethod: Type.Union(Object.values(PaymentMethod).map((method) => Type.Literal(method))),
}, { additionalProperties: false });

export const MockPaymentEventOutcome = {
  APPLIED_TO_LOCAL_ORDER: 'APPLIED_TO_LOCAL_ORDER',
  DUPLICATE_IGNORED: 'DUPLICATE_IGNORED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
} as const;

export const MockPaymentOrderDtoSchema = Type.Object({
  orderId: LocalOrderIdSchema,
  amountCny: CnyAmountSchema,
  paymentChannel: MockPaymentChannelSnapshotDtoSchema,
  status: Type.Union(Object.values(MockPaymentOrderStatus).map((status) => Type.Literal(status))),
  source: Type.Literal('LOCAL_DEMO'),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const MockPaymentEventDtoSchema = Type.Object({
  eventId: Type.String({ minLength: 1, maxLength: 64 }),
  providerEventId: Type.String({ minLength: 1, maxLength: 64 }),
  orderId: LocalOrderIdSchema,
  requestKey: Type.String({ minLength: 1, maxLength: 64 }),
  scenario: Type.Union(Object.values(MockPaymentScenario).map((scenario) => Type.Literal(scenario))),
  outcome: Type.Union(Object.values(MockPaymentEventOutcome).map((outcome) => Type.Literal(outcome))),
  receivedAmountCny: CnyAmountSchema,
  message: Type.String({ minLength: 1, maxLength: 180 }),
  source: Type.Literal('LOCAL_DEMO'),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const CreateMockPaymentOrderRequestSchema = Type.Object({
  // Keep the transport shape broad enough for the application to return a
  // field-specific INVALID_AMOUNT result for values such as "200".
  amountCny: Type.String({ minLength: 1, maxLength: 11 }),
  paymentChannelId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  requestKey: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

export const ApplyMockPaymentScenarioRequestSchema = Type.Object({
  orderId: LocalOrderIdSchema,
  scenario: Type.Union(Object.values(MockPaymentScenario).map((scenario) => Type.Literal(scenario))),
  requestKey: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

export const MockPaymentScenarioResultDtoSchema = Type.Object({
  order: MockPaymentOrderDtoSchema,
  event: MockPaymentEventDtoSchema,
}, { additionalProperties: false });

export type MockPaymentOrderDto = Static<typeof MockPaymentOrderDtoSchema>;
export type MockPaymentChannelSnapshotDto = Static<typeof MockPaymentChannelSnapshotDtoSchema>;
export type MockPaymentEventDto = Static<typeof MockPaymentEventDtoSchema>;
export type CreateMockPaymentOrderRequestDto = Static<typeof CreateMockPaymentOrderRequestSchema>;
export type ApplyMockPaymentScenarioRequestDto = Static<typeof ApplyMockPaymentScenarioRequestSchema>;
export type MockPaymentScenarioResultDto = Static<typeof MockPaymentScenarioResultDtoSchema>;
