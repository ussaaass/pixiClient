import type {
  AgentSocialConversationListResponseDto,
  AgentSocialConversationReadRequestDto,
  AgentSocialConversationReadResponseDto,
  AgentSocialModerationDecisionResponseDto,
} from '@gameing/contracts/agent-social';
import type {
  SocialModerationDecisionRequestDto,
  SocialModerationListResponseDto,
  SocialModerationQueryDto,
} from '@gameing/contracts/social';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { AgentSocialRepositoryPort } from './agent-social-application';

export class RemoteAgentSocialAdapter implements AgentSocialRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listConversations(agentDomainId: string): Promise<AgentSocialConversationListResponseDto> {
    return this.client.get<AgentSocialConversationListResponseDto>('/agent-social/conversations', { agentDomainId });
  }

  async readConversation(
    agentDomainId: string,
    agentUserId: string,
    conversationId: string,
    request: AgentSocialConversationReadRequestDto,
  ): Promise<AgentSocialConversationReadResponseDto | 'NOT_FOUND' | 'REQUEST_KEY_REUSED'> {
    try {
      return await this.client.post<AgentSocialConversationReadResponseDto>(
        `/agent-social/conversations/${encodeURIComponent(conversationId)}/detail-reads`,
        { ...request, agentDomainId, agentUserId },
      );
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return 'NOT_FOUND';
      if (error instanceof AdminApiError && error.code === 'REQUEST_KEY_REUSED') return 'REQUEST_KEY_REUSED';
      throw error;
    }
  }

  async listModerationCases(agentDomainId: string, query: SocialModerationQueryDto): Promise<SocialModerationListResponseDto> {
    const params: Record<string, string | number | undefined> = {
      agentDomainId,
      resourceType: query.resourceType,
      caseStatus: query.caseStatus,
      keyword: query.keyword,
      cursor: query.cursor,
      pageSize: query.pageSize ?? 20,
    };
    return this.client.get<SocialModerationListResponseDto>('/agent-social/moderation-cases', params);
  }

  async decideModerationCase(
    agentDomainId: string,
    agentUserId: string,
    caseId: string,
    request: SocialModerationDecisionRequestDto,
  ): Promise<AgentSocialModerationDecisionResponseDto | 'NOT_FOUND' | 'CASE_ALREADY_CLOSED' | 'REQUEST_KEY_REUSED' | 'INVALID_TRANSITION'> {
    try {
      const result = await this.client.post<AgentSocialModerationDecisionResponseDto>(
        `/agent-social/moderation-cases/${encodeURIComponent(caseId)}/decisions`,
        { ...request, agentDomainId, agentUserId },
      );
      return result;
    } catch (error) {
      if (error instanceof AdminApiError && (error.code === 'NOT_FOUND' || error.code === 'CASE_ALREADY_CLOSED' || error.code === 'REQUEST_KEY_REUSED' || error.code === 'INVALID_TRANSITION')) {
        return error.code as 'NOT_FOUND' | 'CASE_ALREADY_CLOSED' | 'REQUEST_KEY_REUSED' | 'INVALID_TRANSITION';
      }
      throw error;
    }
  }
}
