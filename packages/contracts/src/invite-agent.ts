import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { RewardType } from './referral';

const BigIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const AgentDomainStatus = { PENDING_REVIEW: 1, ACTIVE: 2, SUSPENDED: 3, REVOKED: 4, WITHDRAWN: 5 } as const;
export const ReferralBindingStatus = { ACTIVE: 1 } as const;
export const AgentCapabilityCode = {
  DASHBOARD_READ: 'AGENT_DASHBOARD_READ',
  DOWNLINE_READ: 'AGENT_DOWNLINE_READ',
  GAME_CONFIG_READ: 'AGENT_GAME_CONFIG_READ',
  GAME_CONFIG_SIMULATE: 'AGENT_GAME_CONFIG_SIMULATE',
  GAME_CONFIG_PUBLISH: 'AGENT_GAME_CONFIG_PUBLISH',
  ANNOUNCEMENT_MANAGE: 'AGENT_ANNOUNCEMENT_MANAGE',
  SOCIAL_MODERATE: 'AGENT_SOCIAL_MODERATE',
  SOCIAL_READ_PRIVATE_MESSAGES: 'AGENT_SOCIAL_READ_PRIVATE_MESSAGES',
  EXPORT_READ: 'AGENT_EXPORT_READ',
} as const;
export const AgentCapabilityCodeSchema = Type.Union(Object.values(AgentCapabilityCode).map((code) => Type.Literal(code)));
export type AgentCapabilityCodeValue = typeof AgentCapabilityCode[keyof typeof AgentCapabilityCode];
export const AgentDomainAdminAction = {
  APPROVE: 'APPROVE', REJECT: 'REJECT', SUSPEND: 'SUSPEND', RESTORE: 'RESTORE', REVOKE: 'REVOKE', UPDATE_CAPABILITIES: 'UPDATE_CAPABILITIES',
} as const;

export const InviteLinkDtoSchema = Type.Object({
  inviteCode: Type.String({ pattern: '^[A-Z0-9]{8,16}$' }),
  url: Type.String({ minLength: 1, maxLength: 2048 }),
  expiresAt: UtcTimestampSchema,
}, { additionalProperties: false });
const ReferralCursorSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z~[1-9][0-9]{0,19}$' });
export const ReferralInviteeDtoSchema = Type.Object({
  userLabel: Type.String({ minLength: 1, maxLength: 48 }),
  boundAt: UtcTimestampSchema,
  rewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
}, { additionalProperties: false });
export const ReferralInviteePageDtoSchema = Type.Object({
  items: Type.Array(ReferralInviteeDtoSchema, { maxItems: 20 }),
  totalCount: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  nextCursor: Type.Union([ReferralCursorSchema, Type.Null()]),
}, { additionalProperties: false });
export const ReferralRewardDtoSchema = Type.Object({
  rewardId: BigIdSchema,
  sourceUserLabel: Type.String({ minLength: 1, maxLength: 48 }),
  paidAt: UtcTimestampSchema,
  paidAmountCnyFen: Type.String({ pattern: '^[1-9][0-9]*$' }),
  rateBps: Type.Integer({ minimum: 0, maximum: 10000 }),
  rewardCnyFen: Type.String({ pattern: '^[1-9][0-9]*$' }),
  state: Type.Union([Type.Literal('FROZEN'), Type.Literal('AVAILABLE'), Type.Literal('PAID')]),
  releaseAt: Type.Union([UtcTimestampSchema, Type.Null()]),
}, { additionalProperties: false });
export const ReferralRewardPageDtoSchema = Type.Object({
  items: Type.Array(ReferralRewardDtoSchema, { maxItems: 20 }),
  rewardType: Type.Union([Type.Literal(RewardType.RECHARGE_REBATE), Type.Literal(RewardType.CUSTOMER_LOSS_REBATE)]),
  totalRewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  frozenRewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  availableRewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  nextCursor: Type.Union([ReferralCursorSchema, Type.Null()]),
}, { additionalProperties: false });
export const AgentDomainDtoSchema = Type.Object({
  userId: BigIdSchema,
  status: Type.Union([Type.Literal(AgentDomainStatus.PENDING_REVIEW), Type.Literal(AgentDomainStatus.ACTIVE), Type.Literal(AgentDomainStatus.SUSPENDED), Type.Literal(AgentDomainStatus.REVOKED), Type.Literal(AgentDomainStatus.WITHDRAWN)]),
  appliedAt: UtcTimestampSchema,
  capabilities: Type.Array(AgentCapabilityCodeSchema, { maxItems: 9, uniqueItems: true }),
}, { additionalProperties: false });
export const AgentDomainAdminActionRequestSchema = Type.Object({
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  userId: BigIdSchema,
  action: Type.Union(Object.values(AgentDomainAdminAction).map((action) => Type.Literal(action))),
  capabilities: Type.Array(AgentCapabilityCodeSchema, { maxItems: 9, uniqueItems: true }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { additionalProperties: false });
export const AgentDomainAdminActionResponseSchema = Type.Object({
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  agentDomain: AgentDomainDtoSchema,
}, { additionalProperties: false });
export const ApplyAgentDomainRequestSchema = Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false });
export const CaptureInviteAttributionRequestSchema = Type.Object({ inviteCode: Type.String({ pattern: '^[A-Z0-9]{8,16}$' }) }, { additionalProperties: false });
export const CaptureInviteAttributionResponseSchema = Type.Object({ captured: Type.Boolean(), expiresAt: Type.Union([UtcTimestampSchema, Type.Null()]) }, { additionalProperties: false });
export const InviteAgentEndpoint = {
  captureAttribution: { method: 'POST', path: '/api/v1/public/referral-attribution/candidate', request: CaptureInviteAttributionRequestSchema, response: CaptureInviteAttributionResponseSchema, successStatus: 200 },
  inviteLink: { method: 'GET', path: '/api/v1/me/invite-link', response: Type.Union([InviteLinkDtoSchema, Type.Null()]), successStatus: 200 },
  issueInviteLink: { method: 'POST', path: '/api/v1/me/invite-link', request: Type.Object({}, { additionalProperties: false }), response: InviteLinkDtoSchema, successStatus: 201 },
  invitees: { method: 'GET', path: '/api/v1/me/referrals/direct-invitees', response: ReferralInviteePageDtoSchema, successStatus: 200 },
  rewards: { method: 'GET', path: '/api/v1/me/referrals/rewards', response: ReferralRewardPageDtoSchema, successStatus: 200 },
  agentDomain: { method: 'GET', path: '/api/v1/me/agent-domain', response: Type.Union([AgentDomainDtoSchema, Type.Null()]), successStatus: 200 },
  applyAgentDomain: { method: 'POST', path: '/api/v1/me/agent-domain/application', request: ApplyAgentDomainRequestSchema, response: AgentDomainDtoSchema, successStatus: 201 },
  withdrawAgentDomain: { method: 'DELETE', path: '/api/v1/me/agent-domain/application', response: Type.Object({ withdrawn: Type.Boolean() }, { additionalProperties: false }), successStatus: 200 },
} as const;
export const AdminAgentDomainEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/agent-domains', response: Type.Array(AgentDomainDtoSchema), successStatus: 200 },
  action: { method: 'POST', path: '/api/v1/admin/agent-domains/:userId/action', request: AgentDomainAdminActionRequestSchema, response: AgentDomainAdminActionResponseSchema, successStatus: 200 },
} as const;

export type InviteLinkDto = Static<typeof InviteLinkDtoSchema>;
export type ReferralInviteeDto = Static<typeof ReferralInviteeDtoSchema>;
export type ReferralInviteePageDto = Static<typeof ReferralInviteePageDtoSchema>;
export type ReferralRewardDto = Static<typeof ReferralRewardDtoSchema>;
export type ReferralRewardPageDto = Static<typeof ReferralRewardPageDtoSchema>;
export type AgentDomainDto = Static<typeof AgentDomainDtoSchema>;
export type AgentDomainAdminActionRequestDto = Static<typeof AgentDomainAdminActionRequestSchema>;
export type AgentDomainAdminActionResponseDto = Static<typeof AgentDomainAdminActionResponseSchema>;
export type ApplyAgentDomainRequestDto = Static<typeof ApplyAgentDomainRequestSchema>;
export type CaptureInviteAttributionRequestDto = Static<typeof CaptureInviteAttributionRequestSchema>;
export type CaptureInviteAttributionResponseDto = Static<typeof CaptureInviteAttributionResponseSchema>;
