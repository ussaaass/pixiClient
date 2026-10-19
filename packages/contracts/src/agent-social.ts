import { Type, type Static } from '@sinclair/typebox';
import { SocialMessageDtoSchema } from './social';
import { SocialModerationCaseDtoSchema, SocialModerationDecisionRequestSchema, SocialModerationListResponseSchema, SocialModerationQuerySchema } from './social';
import { AgentAuditEventDtoSchema } from './agent-audit';

const BigId = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const Timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });

export const AgentSocialSource = { LOCAL_DEMO: 'LOCAL_DEMO', SERVER: 'SERVER' } as const;
export const AgentSocialParticipantDtoSchema = Type.Object({ userId: BigId, displayName: Type.String({ minLength: 1, maxLength: 48 }) }, { additionalProperties: false });
export const AgentSocialConversationDtoSchema = Type.Object({
  conversationId: BigId,
  agentDomainId: BigId,
  participants: Type.Array(AgentSocialParticipantDtoSchema, { minItems: 2, maxItems: 2 }),
  messageCount: Type.Integer({ minimum: 1 }),
  lastMessageAt: Timestamp,
}, { additionalProperties: false });
export const AgentSocialConversationListRequestSchema = Type.Object({}, { additionalProperties: false });
export const AgentSocialConversationListResponseSchema = Type.Object({ conversations: Type.Array(AgentSocialConversationDtoSchema, { maxItems: 100 }), source: Type.Union([Type.Literal(AgentSocialSource.LOCAL_DEMO), Type.Literal(AgentSocialSource.SERVER)]) }, { additionalProperties: false });
export const AgentSocialConversationReadRequestSchema = Type.Object({ reason: Type.String({ minLength: 3, maxLength: 240 }), requestKey: Uuid }, { additionalProperties: false });
export const AgentSocialConversationReadResponseSchema = Type.Object({ conversation: AgentSocialConversationDtoSchema, messages: Type.Array(SocialMessageDtoSchema, { maxItems: 100 }), source: Type.Union([Type.Literal(AgentSocialSource.LOCAL_DEMO), Type.Literal(AgentSocialSource.SERVER)]) }, { additionalProperties: false });
export const AgentSocialModerationDecisionResponseSchema = Type.Object({ item: SocialModerationCaseDtoSchema, audit: AgentAuditEventDtoSchema }, { additionalProperties: false });

export const AgentSocialEndpoints = {
  conversations: { method: 'GET', path: '/api/v1/agent/social/conversations', query: AgentSocialConversationListRequestSchema, response: AgentSocialConversationListResponseSchema, successStatus: 200 },
  readConversation: { method: 'POST', path: '/api/v1/agent/social/conversations/:conversationId/detail-reads', body: AgentSocialConversationReadRequestSchema, response: AgentSocialConversationReadResponseSchema, successStatus: 200 },
  moderationCases: { method: 'GET', path: '/api/v1/agent/social/moderation-cases', query: SocialModerationQuerySchema, response: SocialModerationListResponseSchema, successStatus: 200 },
  decideModeration: { method: 'POST', path: '/api/v1/agent/social/moderation-cases/:caseId/decisions', body: SocialModerationDecisionRequestSchema, response: AgentSocialModerationDecisionResponseSchema, successStatus: 200 },
} as const;

export type AgentSocialConversationDto = Static<typeof AgentSocialConversationDtoSchema>;
export type AgentSocialConversationListRequestDto = Static<typeof AgentSocialConversationListRequestSchema>;
export type AgentSocialConversationListResponseDto = Static<typeof AgentSocialConversationListResponseSchema>;
export type AgentSocialConversationReadRequestDto = Static<typeof AgentSocialConversationReadRequestSchema>;
export type AgentSocialConversationReadResponseDto = Static<typeof AgentSocialConversationReadResponseSchema>;
export type AgentSocialModerationDecisionResponseDto = Static<typeof AgentSocialModerationDecisionResponseSchema>;
