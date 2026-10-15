import type { SystemConfigDraftDto, SystemConfigEntryDto } from '@gameing/admin-contracts/system-config';
import type { SystemConfigRepositoryPort } from './system-config-application';
import { SYSTEM_CONFIG_REFERENCE_ENTRIES } from './system-config-reference-catalog';

/** Isolated in-memory adapter for deterministic application tests. */
export class OfflineSystemConfigAdapter implements SystemConfigRepositoryPort {
  private readonly entries = SYSTEM_CONFIG_REFERENCE_ENTRIES;
  private readonly drafts = new Map<string, SystemConfigDraftDto>();
  private readonly requests = new Map<string, SystemConfigDraftDto>();
  private nextId = 9_000_000_000_000_000_001n;

  async listEntries(): Promise<SystemConfigEntryDto[]> {
    return this.entries.map((entry) => ({ ...entry }));
  }

  async findEntry(configKey: string): Promise<SystemConfigEntryDto | null> {
    const entry = this.entries.find((item) => item.configKey === configKey);
    return entry ? { ...entry } : null;
  }

  async listDrafts(): Promise<SystemConfigDraftDto[]> {
    return [...this.drafts.values()].map((draft) => ({ ...draft }));
  }

  async findDraft(configKey: string): Promise<SystemConfigDraftDto | null> {
    const draft = this.drafts.get(configKey);
    return draft ? { ...draft } : null;
  }

  async findDraftByRequestKey(requestKey: string): Promise<SystemConfigDraftDto | null> {
    const draft = this.requests.get(requestKey);
    return draft ? { ...draft } : null;
  }

  async saveDraft(draft: SystemConfigDraftDto): Promise<void> {
    const previous = this.drafts.get(draft.configKey);
    if (previous) this.requests.delete(previous.requestKey);
    const copy = { ...draft };
    this.drafts.set(copy.configKey, copy);
    this.requests.set(copy.requestKey, copy);
  }

  async discardDraft(configKey: string): Promise<void> {
    const draft = this.drafts.get(configKey);
    if (draft) this.requests.delete(draft.requestKey);
    this.drafts.delete(configKey);
  }

  createId(): string {
    const id = this.nextId.toString();
    this.nextId += 1n;
    return id;
  }

  now(): string {
    return new Date().toISOString();
  }
}
