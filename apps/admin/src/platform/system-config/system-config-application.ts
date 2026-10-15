import { Value } from '@sinclair/typebox/value';
import {
  SystemConfigDraftDtoSchema,
  SystemConfigDraftRequestSchema,
  SystemConfigEntryDtoSchema,
  SystemConfigQuerySchema,
  type SystemConfigDraftDto,
  type SystemConfigDraftRequestDto,
  type SystemConfigEntryDto,
  type SystemConfigQueryDto,
} from '@gameing/admin-contracts/system-config';
import { createSystemConfigDraft, requestMatchesDraft, type SystemConfigFailureCode, type SystemConfigResult } from './system-config-domain';

export interface SystemConfigRepositoryPort {
  listEntries(): Promise<SystemConfigEntryDto[]>;
  findEntry(configKey: string): Promise<SystemConfigEntryDto | null>;
  listDrafts(): Promise<SystemConfigDraftDto[]>;
  findDraft(configKey: string): Promise<SystemConfigDraftDto | null>;
  findDraftByRequestKey(requestKey: string): Promise<SystemConfigDraftDto | null>;
  saveDraft(draft: SystemConfigDraftDto): Promise<void>;
  discardDraft(configKey: string): Promise<void>;
  createId(): string;
  now(): string;
}

function failure<T>(code: SystemConfigFailureCode): SystemConfigResult<T> {
  return { ok: false, code };
}

export interface SystemConfigApplication {
  listEntries(query: SystemConfigQueryDto): Promise<SystemConfigResult<SystemConfigEntryDto[]>>;
  listDrafts(): Promise<SystemConfigResult<SystemConfigDraftDto[]>>;
  previewDraft(request: SystemConfigDraftRequestDto): Promise<SystemConfigResult<SystemConfigDraftDto>>;
  createDraft(request: SystemConfigDraftRequestDto): Promise<SystemConfigResult<SystemConfigDraftDto>>;
  discardDraft(configKey: string): Promise<SystemConfigResult<void>>;
}

export function createSystemConfigApplication(repository: SystemConfigRepositoryPort): SystemConfigApplication {
  async function previewDraft(request: SystemConfigDraftRequestDto): Promise<SystemConfigResult<SystemConfigDraftDto>> {
    if (!Value.Check(SystemConfigDraftRequestSchema, request)) return failure('INVALID_REQUEST');
    const result = createSystemConfigDraft(await repository.findEntry(request.configKey), request, repository.createId(), repository.now());
    if (!result.ok) return result;
    return Value.Check(SystemConfigDraftDtoSchema, result.value) ? result : failure('INVALID_REQUEST');
  }

  return {
    async listEntries(query) {
      if (!Value.Check(SystemConfigQuerySchema, query)) return failure('INVALID_REQUEST');
      const entries = await repository.listEntries();
      if (!entries.every((entry) => Value.Check(SystemConfigEntryDtoSchema, entry))) return failure('INVALID_REQUEST');
      const keyword = query.keyword?.trim().toLocaleLowerCase();
      const filtered = entries.filter((entry) => {
        const matchesKeyword = !keyword || entry.configKey.toLocaleLowerCase().includes(keyword) || entry.title.toLocaleLowerCase().includes(keyword);
        const matchesType = !query.configType || entry.configType === query.configType;
        return matchesKeyword && matchesType;
      });
      return { ok: true, value: filtered };
    },

    async listDrafts() {
      const drafts = await repository.listDrafts();
      return drafts.every((draft) => Value.Check(SystemConfigDraftDtoSchema, draft))
        ? { ok: true, value: drafts }
        : failure('INVALID_REQUEST');
    },

    previewDraft,

    async createDraft(request) {
      if (!Value.Check(SystemConfigDraftRequestSchema, request)) return failure('INVALID_REQUEST');
      const existing = await repository.findDraftByRequestKey(request.requestKey);
      if (existing) return requestMatchesDraft(request, existing) ? { ok: true, value: existing } : failure('REQUEST_KEY_REUSED');
      const result = await previewDraft(request);
      if (!result.ok) return result;
      await repository.saveDraft(result.value);
      return result;
    },

    async discardDraft(configKey) {
      if (!await repository.findEntry(configKey)) return failure('CONFIG_NOT_FOUND');
      await repository.discardDraft(configKey);
      return { ok: true, value: undefined };
    },
  };
}
