import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { AgentCapabilityCodeSchema, AgentDomainAdminAction, AgentDomainAdminActionRequestSchema, AgentDomainAdminActionResponseSchema, AgentDomainDtoSchema } from '@gameing/contracts/invite-agent';

export const AgentDomainReviewAuditSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;

export const AgentDomainReviewAuditDtoSchema = Type.Object({
  auditId: Type.String({ minLength: 1, maxLength: 128 }),
  userId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  action: Type.Union(Object.values(AgentDomainAdminAction).map((action) => Type.Literal(action))),
  previousStatus: Type.Integer({ minimum: 1, maximum: 5 }),
  nextStatus: Type.Integer({ minimum: 1, maximum: 5 }),
  previousCapabilities: Type.Array(AgentCapabilityCodeSchema, { maxItems: 9, uniqueItems: true }),
  nextCapabilities: Type.Array(AgentCapabilityCodeSchema, { maxItems: 9, uniqueItems: true }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  source: Type.Union([Type.Literal(AgentDomainReviewAuditSource.LOCAL_DEMO), Type.Literal(AgentDomainReviewAuditSource.SERVER)]),
  resultingDomain: AgentDomainDtoSchema,
  createdAt: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' }),
}, { additionalProperties: false });

export type AgentDomainReviewAuditDto = Static<typeof AgentDomainReviewAuditDtoSchema>;
export { AgentDomainAdminActionRequestSchema, AgentDomainAdminActionResponseSchema };
