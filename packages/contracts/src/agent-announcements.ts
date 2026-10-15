import { Type, type Static } from '@sinclair/typebox';

const Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const BigId = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const Timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });

export const AgentAnnouncementStatus = { DRAFT: 1, SCHEDULED: 2, ACTIVE: 3, RETRACTED: 4, EXPIRED: 5 } as const;
export const AgentAnnouncementSource = { LOCAL_DEMO: 'LOCAL_DEMO', SERVER: 'SERVER' } as const;

export const AgentAnnouncementDtoSchema = Type.Object({
  announcementId: Uuid,
  agentDomainId: BigId,
  title: Type.String({ minLength: 2, maxLength: 60 }),
  body: Type.String({ minLength: 4, maxLength: 240 }),
  status: Type.Union(Object.values(AgentAnnouncementStatus).map((status) => Type.Literal(status))),
  startsAt: Type.Union([Timestamp, Type.Null()]),
  expiresAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  source: Type.Union([Type.Literal(AgentAnnouncementSource.LOCAL_DEMO), Type.Literal(AgentAnnouncementSource.SERVER)]),
}, { additionalProperties: false });

export const AgentAnnouncementListRequestSchema = Type.Object({ status: Type.Optional(Type.Union(Object.values(AgentAnnouncementStatus).map((status) => Type.Literal(status)))) }, { additionalProperties: false });
export const AgentAnnouncementListResponseSchema = Type.Object({ items: Type.Array(AgentAnnouncementDtoSchema, { maxItems: 100 }), source: Type.Union([Type.Literal(AgentAnnouncementSource.LOCAL_DEMO), Type.Literal(AgentAnnouncementSource.SERVER)]) }, { additionalProperties: false });
export const AgentAnnouncementCreateRequestSchema = Type.Object({ title: Type.String({ minLength: 2, maxLength: 60 }), body: Type.String({ minLength: 4, maxLength: 240 }), reason: Type.String({ minLength: 3, maxLength: 240 }), requestKey: Uuid }, { additionalProperties: false });
export const AgentAnnouncementCreateResponseSchema = Type.Object({ announcement: AgentAnnouncementDtoSchema, source: Type.Union([Type.Literal(AgentAnnouncementSource.LOCAL_DEMO), Type.Literal(AgentAnnouncementSource.SERVER)]) }, { additionalProperties: false });
export const AgentAnnouncementPublishRequestSchema = Type.Object({ announcementId: Uuid, startsAt: Timestamp, expiresAt: Timestamp, reason: Type.String({ minLength: 3, maxLength: 240 }), requestKey: Uuid }, { additionalProperties: false });
export const AgentAnnouncementPublishResponseSchema = AgentAnnouncementCreateResponseSchema;
export const AgentAnnouncementRetractRequestSchema = Type.Object({ announcementId: Uuid, reason: Type.String({ minLength: 3, maxLength: 240 }), requestKey: Uuid }, { additionalProperties: false });
export const AgentAnnouncementRetractResponseSchema = AgentAnnouncementCreateResponseSchema;

export const AgentAnnouncementEndpoints = {
  list: { method: 'GET', path: '/api/v1/agent/announcements', query: AgentAnnouncementListRequestSchema, response: AgentAnnouncementListResponseSchema, successStatus: 200 },
  create: { method: 'POST', path: '/api/v1/agent/announcements', body: AgentAnnouncementCreateRequestSchema, response: AgentAnnouncementCreateResponseSchema, successStatus: 201 },
  publish: { method: 'POST', path: '/api/v1/agent/announcements/:announcementId/publish', body: AgentAnnouncementPublishRequestSchema, response: AgentAnnouncementPublishResponseSchema, successStatus: 200 },
  retract: { method: 'POST', path: '/api/v1/agent/announcements/:announcementId/retract', body: AgentAnnouncementRetractRequestSchema, response: AgentAnnouncementRetractResponseSchema, successStatus: 200 },
} as const;

export type AgentAnnouncementDto = Static<typeof AgentAnnouncementDtoSchema>;
export type AgentAnnouncementListRequestDto = Static<typeof AgentAnnouncementListRequestSchema>;
export type AgentAnnouncementListResponseDto = Static<typeof AgentAnnouncementListResponseSchema>;
export type AgentAnnouncementCreateRequestDto = Static<typeof AgentAnnouncementCreateRequestSchema>;
export type AgentAnnouncementCreateResponseDto = Static<typeof AgentAnnouncementCreateResponseSchema>;
export type AgentAnnouncementPublishRequestDto = Static<typeof AgentAnnouncementPublishRequestSchema>;
export type AgentAnnouncementPublishResponseDto = Static<typeof AgentAnnouncementPublishResponseSchema>;
export type AgentAnnouncementRetractRequestDto = Static<typeof AgentAnnouncementRetractRequestSchema>;
export type AgentAnnouncementRetractResponseDto = Static<typeof AgentAnnouncementRetractResponseSchema>;
