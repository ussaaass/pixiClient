import { type SystemConfigDraftDto, type SystemConfigEntryDto } from '@gameing/admin-contracts/system-config';
import { SYSTEM_CONFIG_REFERENCE_ENTRIES } from './system-config-reference-catalog';
import { AdminApiClient } from '../admin-api-client.js';
import type { SystemConfigRepositoryPort } from './system-config-application';

export class RemoteSystemConfigAdapter implements SystemConfigRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listEntries(): Promise<SystemConfigEntryDto[]> {
    const remote = await this.client.get<SystemConfigEntryDto[]>('/system-config/entries');
    return remote.length > 0 ? remote : SYSTEM_CONFIG_REFERENCE_ENTRIES.map((entry) => ({ ...entry }));
  }

  async findEntry(configKey: string): Promise<SystemConfigEntryDto | null> {
    try {
      return await this.client.get<SystemConfigEntryDto>(`/system-config/entries/${encodeURIComponent(configKey)}`);
    } catch {
      const entry = SYSTEM_CONFIG_REFERENCE_ENTRIES.find((item) => item.configKey === configKey);
      return entry ? { ...entry } : null;
    }
  }

  async listDrafts(): Promise<SystemConfigDraftDto[]> {
    return this.client.get<SystemConfigDraftDto[]>('/system-config/drafts');
  }

  async findDraft(configKey: string): Promise<SystemConfigDraftDto | null> {
    return this.client.get<SystemConfigDraftDto | null>('/system-config/drafts/by-key', { configKey });
  }

  async findDraftByRequestKey(requestKey: string): Promise<SystemConfigDraftDto | null> {
    return this.client.get<SystemConfigDraftDto | null>('/system-config/drafts/by-request-key', { requestKey });
  }

  async saveDraft(draft: SystemConfigDraftDto): Promise<void> {
    await this.client.post('/system-config/drafts', draft);
  }

  async discardDraft(configKey: string): Promise<void> {
    await this.client.post(`/system-config/drafts/${encodeURIComponent(configKey)}/discard`);
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-system-config-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
