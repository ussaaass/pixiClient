import type {
  AgentDownlineDetailDto,
  AgentDownlineDetailReadRequestDto,
  AgentDownlineListResponseDto,
  AgentDownlineQueryDto,
} from '@gameing/contracts/agent-downlines';
import type { AgentAuditListResponseDto, AgentAuditQueryDto } from '@gameing/contracts/agent-audit';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { AgentDownlineReadRepositoryPort } from './agent-downlines-application';
import type { AgentAuditReadRepositoryPort } from './agent-audit-application';

export class RemoteAgentDownlineAdapter implements AgentDownlineReadRepositoryPort, AgentAuditReadRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async list(query: AgentDownlineQueryDto): Promise<AgentDownlineListResponseDto> {
    const params: Record<string, string | number | undefined> = {
      keyword: query.keyword,
      status: query.status,
      cursor: query.cursor,
      pageSize: query.pageSize ?? 20,
    };
    return this.client.get<AgentDownlineListResponseDto>('/agent-downlines', params);
  }

  async readDetail(userId: string, request: AgentDownlineDetailReadRequestDto): Promise<AgentDownlineDetailDto | null> {
    try {
      return await this.client.post<AgentDownlineDetailDto>(`/agent-downlines/${encodeURIComponent(userId)}/detail-reads`, request);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listAuditEvents(query: AgentAuditQueryDto): Promise<AgentAuditListResponseDto> {
    const params: Record<string, string | number | undefined> = {
      keyword: query.keyword,
      resultType: query.resultType,
      cursor: query.cursor,
      pageSize: query.pageSize ?? 20,
    };
    return this.client.get<AgentAuditListResponseDto>('/agent-audit-events', params);
  }
}
