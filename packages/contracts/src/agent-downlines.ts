import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const BigId = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const UtcTimestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });

export const AgentDownlineStatus = { ACTIVE: 1, SUSPENDED: 2, CLOSED: 3 } as const;
export const AgentDownlineStatusSchema = Type.Union(Object.values(AgentDownlineStatus).map((status) => Type.Literal(status)));

export const AgentDownlineQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(AgentDownlineStatusSchema),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false });

export const AgentDownlineDtoSchema = Type.Object({
  userId: BigId,
  displayName: Type.String({ minLength: 1, maxLength: 48 }),
  userStatus: AgentDownlineStatusSchema,
  joinedAt: UtcTimestamp,
  lastActiveAt: Type.Union([UtcTimestamp, Type.Null()]),
  directDownlineCount: Type.Integer({ minimum: 0 }),
  coinAvailable: Type.String({ pattern: '^-?(?:0|[1-9][0-9]*)$' }),
  coinFrozen: Type.String({ pattern: '^-?(?:0|[1-9][0-9]*)$' }),
  cnyAvailableFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  cnyFrozenFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
}, { additionalProperties: false });

export const AgentDownlineListResponseSchema = Type.Object({
  items: Type.Array(AgentDownlineDtoSchema, { maxItems: 50 }),
  nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,8}$' }), Type.Null()]),
  total: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const AgentDownlineActivitySchema = Type.Object({
  activityId: BigId,
  category: Type.Union([Type.Literal('ASSET_OPERATION'), Type.Literal('PAYMENT_ORDER'), Type.Literal('WITHDRAWAL'), Type.Literal('GAME_ROUND'), Type.Literal('REFERRAL_REWARD')]),
  summary: Type.String({ minLength: 1, maxLength: 120 }),
  amount: Type.String({ pattern: '^-?(?:0|[1-9][0-9]*)$' }),
  asset: Type.Union([Type.Literal('COIN'), Type.Literal('CNY_FEN'), Type.Literal('NONE')]),
  occurredAt: UtcTimestamp,
}, { additionalProperties: false });

export const AgentDownlineDetailSchema = Type.Object({
  downline: AgentDownlineDtoSchema,
  userRewardType: Type.Union([Type.Literal(1), Type.Literal(2)]),
  turnoverRemainingCoins: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  referralChain: Type.Array(Type.Object({ level: Type.Integer({ minimum: 1, maximum: 5 }), displayName: Type.String({ minLength: 1, maxLength: 48 }) }, { additionalProperties: false }), { maxItems: 5 }),
  recentActivities: Type.Array(AgentDownlineActivitySchema, { maxItems: 50 }),
}, { additionalProperties: false });

export const AgentDownlinePurpose = {
  ROUTINE_OPERATIONS_REVIEW: 'ROUTINE_OPERATIONS_REVIEW',
  ASSET_EXCEPTION_FOLLOWUP: 'ASSET_EXCEPTION_FOLLOWUP',
  PAYMENT_FOLLOWUP: 'PAYMENT_FOLLOWUP',
  GAME_DISPUTE_FOLLOWUP: 'GAME_DISPUTE_FOLLOWUP',
  SUPPORT_CASE: 'SUPPORT_CASE',
} as const;
export const AgentDownlineDetailReadRequestSchema = Type.Object({
  purposeCode: Type.Union(Object.values(AgentDownlinePurpose).map((code) => Type.Literal(code))),
  caseReference: Type.Optional(Type.String({ minLength: 3, maxLength: 80 })),
  requestKey: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }),
}, { additionalProperties: false });

export const AgentDownlineEndpoint = {
  list: { method: 'GET', path: '/api/v1/agent/downlines', query: AgentDownlineQuerySchema, response: AgentDownlineListResponseSchema, successStatus: 200 },
  detail: { method: 'POST', path: '/api/v1/agent/downlines/:userId/detail-reads', request: AgentDownlineDetailReadRequestSchema, response: AgentDownlineDetailSchema, successStatus: 200 },
} as const;

export type AgentDownlineQueryDto = Static<typeof AgentDownlineQuerySchema>;
export type AgentDownlineDto = Static<typeof AgentDownlineDtoSchema>;
export type AgentDownlineListResponseDto = Static<typeof AgentDownlineListResponseSchema>;
export type AgentDownlineDetailDto = Static<typeof AgentDownlineDetailSchema>;
export type AgentDownlineDetailReadRequestDto = Static<typeof AgentDownlineDetailReadRequestSchema>;
