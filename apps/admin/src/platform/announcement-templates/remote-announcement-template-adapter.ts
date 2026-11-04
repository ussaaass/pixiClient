import { type AnnouncementTemplateChangeDto, type AnnouncementTemplateDto } from '@gameing/admin-contracts/announcement-template';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { AnnouncementTemplateRepositoryPort } from './announcement-template-application';

export class RemoteAnnouncementTemplateAdapter implements AnnouncementTemplateRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async list(): Promise<AnnouncementTemplateDto[]> {
    return this.client.get<AnnouncementTemplateDto[]>('/announcement-templates', { pageSize: 100 });
  }

  async find(templateId: string): Promise<AnnouncementTemplateDto | null> {
    try {
      return await this.client.get<AnnouncementTemplateDto>(`/announcement-templates/${encodeURIComponent(templateId)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listChanges(templateId: string): Promise<AnnouncementTemplateChangeDto[]> {
    return this.client.get<AnnouncementTemplateChangeDto[]>(`/announcement-templates/${encodeURIComponent(templateId)}/changes`);
  }

  async findChangeByRequestKey(requestKey: string): Promise<AnnouncementTemplateChangeDto | null> {
    try {
      return await this.client.get<AnnouncementTemplateChangeDto>(`/announcement-templates/changes/request/${encodeURIComponent(requestKey)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async commit(template: AnnouncementTemplateDto, change: AnnouncementTemplateChangeDto): Promise<void> {
    await this.client.post('/announcement-templates', { template, change });
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-announcement-template-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
