import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SocialModerationDecisionRequestSchema, SocialModerationListResponseSchema, SocialModerationQuerySchema, type SocialModerationDecisionRequestDto, type SocialModerationListResponseDto, type SocialModerationQueryDto } from '@gameing/contracts/social';
import {
  AgentSocialConversationListRequestSchema, AgentSocialConversationListResponseSchema,
  AgentSocialConversationReadRequestSchema, AgentSocialConversationReadResponseSchema,
  AgentSocialModerationDecisionResponseSchema,
  type AgentSocialConversationListResponseDto,
  type AgentSocialConversationReadRequestDto, type AgentSocialConversationReadResponseDto,
  type AgentSocialModerationDecisionResponseDto,
} from '@gameing/contracts/agent-social';
import { AgentCapabilityCode, type AgentCapabilityCodeValue } from '@gameing/contracts/invite-agent';

export interface AgentSocialRepositoryPort {
  listConversations(agentDomainId: string): Promise<AgentSocialConversationListResponseDto>;
  readConversation(agentDomainId: string, agentUserId: string, conversationId: string, request: AgentSocialConversationReadRequestDto): Promise<AgentSocialConversationReadResponseDto | 'NOT_FOUND' | 'REQUEST_KEY_REUSED'>;
  listModerationCases(agentDomainId: string, query: SocialModerationQueryDto): Promise<SocialModerationListResponseDto>;
  decideModerationCase(agentDomainId: string, agentUserId: string, caseId: string, request: SocialModerationDecisionRequestDto): Promise<AgentSocialModerationDecisionResponseDto | 'NOT_FOUND' | 'CASE_ALREADY_CLOSED' | 'REQUEST_KEY_REUSED' | 'INVALID_TRANSITION'>;
}
export interface AgentSocialScopeResolverPort { resolve(capability: AgentCapabilityCodeValue): { agentDomainId: string; agentUserId: string } | null }
export type AgentSocialFailure = 'INVALID_REQUEST' | 'SCOPE_UNAVAILABLE' | 'NOT_FOUND' | 'REQUEST_KEY_REUSED' | 'CASE_ALREADY_CLOSED' | 'INVALID_TRANSITION' | 'STORAGE_FAILED';
export type AgentSocialResult<T> = { ok: true; value: T } | { ok: false; code: AgentSocialFailure };

export function createAgentSocialApplication(repository: AgentSocialRepositoryPort, scopeResolver: AgentSocialScopeResolverPort) {
  return {
    async list(query: unknown): Promise<AgentSocialResult<AgentSocialConversationListResponseDto>> {
      if (!Value.Check(AgentSocialConversationListRequestSchema, query)) return { ok: false, code: 'INVALID_REQUEST' };
      const scope = scopeResolver.resolve(AgentCapabilityCode.SOCIAL_READ_PRIVATE_MESSAGES);
      if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
      try {
        const value = await repository.listConversations(scope.agentDomainId);
        return Value.Check(AgentSocialConversationListResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'STORAGE_FAILED' }; }
    },
    async read(conversationId: unknown, request: unknown): Promise<AgentSocialResult<AgentSocialConversationReadResponseDto>> {
      if (!Value.Check(AgentSocialConversationDtoIdSchema, conversationId) || !Value.Check(AgentSocialConversationReadRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const input = request as AgentSocialConversationReadRequestDto;
      const normalizedRequest = { ...input, reason: input.reason.trim() };
      if (normalizedRequest.reason.length < 3) return { ok: false, code: 'INVALID_REQUEST' };
      const scope = scopeResolver.resolve(AgentCapabilityCode.SOCIAL_READ_PRIVATE_MESSAGES);
      if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
      try {
        const value = await repository.readConversation(scope.agentDomainId, scope.agentUserId, conversationId, normalizedRequest);
        if (value === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND' };
        if (value === 'REQUEST_KEY_REUSED') return { ok: false, code: value };
        return Value.Check(AgentSocialConversationReadResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'STORAGE_FAILED' }; }
    },
    async listModeration(query: unknown): Promise<AgentSocialResult<SocialModerationListResponseDto>> {
      if (!Value.Check(SocialModerationQuerySchema, query)) return { ok: false, code: 'INVALID_REQUEST' };
      const scope = scopeResolver.resolve(AgentCapabilityCode.SOCIAL_MODERATE);
      if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
      try {
        const value = await repository.listModerationCases(scope.agentDomainId, query as SocialModerationQueryDto);
        return Value.Check(SocialModerationListResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'STORAGE_FAILED' }; }
    },
    async decideModeration(caseId: unknown, request: unknown): Promise<AgentSocialResult<AgentSocialModerationDecisionResponseDto>> {
      if (!Value.Check(AgentSocialConversationDtoIdSchema, caseId) || !Value.Check(SocialModerationDecisionRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const input = request as SocialModerationDecisionRequestDto;
      const normalized = { ...input, reason: input.reason.trim() };
      if (normalized.reason.length < 3) return { ok: false, code: 'INVALID_REQUEST' };
      const scope = scopeResolver.resolve(AgentCapabilityCode.SOCIAL_MODERATE);
      if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
      try {
        const result = await repository.decideModerationCase(scope.agentDomainId, scope.agentUserId, caseId, normalized);
        if (typeof result === 'string') return { ok: false, code: result };
        return Value.Check(AgentSocialModerationDecisionResponseSchema, result) ? { ok: true, value: result } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'STORAGE_FAILED' }; }
    },
  };
}

const AgentSocialConversationDtoIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
