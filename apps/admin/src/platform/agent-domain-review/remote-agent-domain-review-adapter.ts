import type { AgentDomainDto } from '@gameing/contracts/invite-agent';
import type { AgentDomainReviewAuditDto } from '@gameing/admin-contracts/agent-domain-review';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { AgentDomainReviewRepositoryPort, LocalAgentDomainDemoRepositoryPort } from './agent-domain-review-application';

export class RemoteAgentDomainReviewAdapter implements AgentDomainReviewRepositoryPort, LocalAgentDomainDemoRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listDomains(): Promise<AgentDomainDto[]> {
    return this.client.get<AgentDomainDto[]>('/agent-domain-reviews', { pageSize: 100 });
  }

  async listAudits(userId: string): Promise<AgentDomainReviewAuditDto[]> {
    return this.client.get<AgentDomainReviewAuditDto[]>(`/agent-domain-reviews/users/${encodeURIComponent(userId)}/audits`);
  }

  async findDomain(userId: string): Promise<AgentDomainDto | null> {
    try {
      return await this.client.get<AgentDomainDto>(`/agent-domain-reviews/users/${encodeURIComponent(userId)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findAuditByRequestKey(requestKey: string): Promise<AgentDomainReviewAuditDto | null> {
    try {
      return await this.client.get<AgentDomainReviewAuditDto>(`/agent-domain-reviews/audits/request/${encodeURIComponent(requestKey)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async commitReview(domain: AgentDomainDto, audit: AgentDomainReviewAuditDto): Promise<void> {
    await this.client.post(`/agent-domain-reviews/users/${encodeURIComponent(domain.userId)}/review`, { domain, audit });
  }

  async createLocalDemoApplication(domain: AgentDomainDto): Promise<void> {
    await this.client.post('/agent-domain-reviews/applications', { domain });
  }

  createUserId(): string {
    return this.createId();
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-agent-domain-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
