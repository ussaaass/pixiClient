import type { IDBPDatabase } from 'idb';
import type { SystemConfigDraftDto, SystemConfigEntryDto } from '@gameing/admin-contracts/system-config';
import type { SystemConfigRepositoryPort } from './system-config-application';
import { SYSTEM_CONFIG_REFERENCE_ENTRIES } from './system-config-reference-catalog';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase, type AdminDevelopmentSchema } from '../browser-development-database';

/** Browser-local draft storage; this adapter never represents effective server configuration. */
export class IndexedDbSystemConfigAdapter implements SystemConfigRepositoryPort {
  private databasePromise: Promise<IDBPDatabase<AdminDevelopmentSchema>> | undefined;

  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async listEntries(): Promise<SystemConfigEntryDto[]> {
    return SYSTEM_CONFIG_REFERENCE_ENTRIES.map((entry) => ({ ...entry }));
  }

  async findEntry(configKey: string): Promise<SystemConfigEntryDto | null> {
    const entry = SYSTEM_CONFIG_REFERENCE_ENTRIES.find((item) => item.configKey === configKey);
    return entry ? { ...entry } : null;
  }

  async listDrafts(): Promise<SystemConfigDraftDto[]> {
    return (await this.database()).getAll('system_config_drafts');
  }

  async findDraft(configKey: string): Promise<SystemConfigDraftDto | null> {
    return (await (await this.database()).get('system_config_drafts', configKey)) ?? null;
  }

  async findDraftByRequestKey(requestKey: string): Promise<SystemConfigDraftDto | null> {
    return (await (await this.database()).getFromIndex('system_config_drafts', 'by-request-key', requestKey)) ?? null;
  }

  async saveDraft(draft: SystemConfigDraftDto): Promise<void> {
    await (await this.database()).put('system_config_drafts', { ...draft });
  }

  async discardDraft(configKey: string): Promise<void> {
    await (await this.database()).delete('system_config_drafts', configKey);
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-config-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  async close(): Promise<void> {
    const database = this.databasePromise;
    this.databasePromise = undefined;
    if (database) (await database).close();
  }

  private database(): Promise<IDBPDatabase<AdminDevelopmentSchema>> {
    if (!globalThis.indexedDB) return Promise.reject(new Error('ADMIN_DRAFT_STORAGE_UNAVAILABLE'));
    if (!this.databasePromise) {
      this.databasePromise = openAdminDevelopmentDatabase(this.databaseName);
    }
    return this.databasePromise;
  }
}
