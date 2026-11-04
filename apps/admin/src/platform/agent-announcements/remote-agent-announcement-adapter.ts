import { type AgentAnnouncementDto, type AgentAnnouncementListResponseDto } from '@gameing/contracts/agent-announcements';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { AgentAnnouncementAudit, AgentAnnouncementRepositoryPort } from './agent-announcement-application';

export class RemoteAgentAnnouncementAdapter implements AgentAnnouncementRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async list(agentDomainId: string): Promise<AgentAnnouncementDto[]> {
    const response = await this.client.get<AgentAnnouncementListResponseDto>('/agent-announcements', { agentDomainId, pageSize: 100 });
    return response.items;
  }

  async find(announcementId: string): Promise<AgentAnnouncementDto | null> {
    try {
      return await this.client.get<AgentAnnouncementDto>(`/agent-announcements/${encodeURIComponent(announcementId)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findAuditByRequestKey(requestKey: string) {
    try {
      return await this.client.get<{ actionCode: string; resourceKey: string; purpose: string; snapshot: Record<string, string | number>; createdAt: string }>(
        `/agent-announcements/audits/request/${encodeURIComponent(requestKey)}`,
      );
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async create(announcement: AgentAnnouncementDto, audit: AgentAnnouncementAudit): Promise<void> {
    await this.client.post('/agent-announcements', { announcement, audit });
  }

  async update(announcement: AgentAnnouncementDto, audit: AgentAnnouncementAudit): Promise<void> {
    await this.client.patch(`/agent-announcements/${encodeURIComponent(announcement.announcementId)}`, { announcement, audit });
  }
}
