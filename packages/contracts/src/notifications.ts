import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const NotificationSource = {
  ANNOUNCEMENT: 'ANNOUNCEMENT',
  WALLET: 'WALLET',
  SUPPORT: 'SUPPORT',
  SOCIAL_FRIEND_REQUEST: 'SOCIAL_FRIEND_REQUEST',
} as const;

export const NotificationAction = {
  OPEN_ANNOUNCEMENT: 'OPEN_ANNOUNCEMENT',
  OPEN_WALLET: 'OPEN_WALLET',
  OPEN_SUPPORT: 'OPEN_SUPPORT',
  OPEN_FRIENDS: 'OPEN_FRIENDS',
} as const;

const TimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' });
const SourceSchema = Type.Union(Object.values(NotificationSource).map((value) => Type.Literal(value)));
const ActionSchema = Type.Union(Object.values(NotificationAction).map((value) => Type.Literal(value)));

export const NotificationSummaryItemSchema = Type.Object({
  itemId: Type.String({ minLength: 3, maxLength: 160 }),
  source: SourceSchema,
  sourceId: Type.String({ minLength: 1, maxLength: 80 }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  summary: Type.String({ minLength: 1, maxLength: 240 }),
  occurredAt: TimestampSchema,
  action: ActionSchema,
}, { additionalProperties: false });

export const NotificationSummaryResponseSchema = Type.Object({
  items: Type.Array(NotificationSummaryItemSchema, { maxItems: 100 }),
  unavailableSources: Type.Array(SourceSchema, { maxItems: 4 }),
}, { additionalProperties: false });

export type NotificationSummaryItemDto = Static<typeof NotificationSummaryItemSchema>;
export type NotificationSummaryResponseDto = Static<typeof NotificationSummaryResponseSchema>;
