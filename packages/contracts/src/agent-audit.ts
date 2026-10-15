import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const BigId = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const UtcTimestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
const RequestKey = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });

export const AgentAuditResultType = { SUCCESS: 1, DENIED: 2, FAILED: 3 } as const;
export const AgentAuditActionCode = {
  DOWNLINE_DETAIL_READ: 'DOWNLINE_DETAIL_READ',
  PRIVATE_MESSAGE_READ: 'PRIVATE_MESSAGE_READ',
  DATA_EXPORT: 'DATA_EXPORT',
  CONFIG_PUBLISH: 'CONFIG_PUBLISH',
  ANNOUNCEMENT_CREATE: 'ANNOUNCEMENT_CREATE',
  ANNOUNCEMENT_PUBLISH: 'ANNOUNCEMENT_PUBLISH',
  ANNOUNCEMENT_RETRACT: 'ANNOUNCEMENT_RETRACT',
} as const;
export const AgentAuditEventDtoSchema = Type.Object({
  auditId: BigId,
  agentDomainId: BigId,
  agentUserId: BigId,
  actionCode: Type.Union(Object.values(AgentAuditActionCode).map((code) => Type.Literal(code))),
  resourceType: Type.String({ minLength: 1, maxLength: 64 }),
  resourceKey: Type.String({ minLength: 1, maxLength: 160 }),
  purpose: Type.String({ minLength: 1, maxLength: 255 }),
  requestKey: RequestKey,
  resultType: Type.Union(Object.values(AgentAuditResultType).map((result) => Type.Literal(result))),
  snapshot: Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 120 }), Type.Number()])),
  createdAt: UtcTimestamp,
}, { additionalProperties: false });

export const AgentAuditQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ maxLength: 64 })),
  resultType: Type.Optional(Type.Union(Object.values(AgentAuditResultType).map((result) => Type.Literal(result)))),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false });
export const AgentAuditListResponseSchema = Type.Object({
  items: Type.Array(AgentAuditEventDtoSchema, { maxItems: 50 }),
  nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,8}$' }), Type.Null()]),
  total: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export const AgentAuditEndpoint = {
  list: { method: 'GET', path: '/api/v1/agent/audit-events', query: AgentAuditQuerySchema, response: AgentAuditListResponseSchema, successStatus: 200 },
} as const;

export type AgentAuditEventDto = Static<typeof AgentAuditEventDtoSchema>;
export type AgentAuditQueryDto = Static<typeof AgentAuditQuerySchema>;
export type AgentAuditListResponseDto = Static<typeof AgentAuditListResponseSchema>;
