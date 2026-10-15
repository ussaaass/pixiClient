import { Value } from '@sinclair/typebox/value';
import {
  AnnouncementTemplateChangeDtoSchema,
  AnnouncementTemplateDtoSchema,
  AnnouncementTemplateQuerySchema,
  AnnouncementTemplateSaveRequestSchema,
  AnnouncementTemplateSource,
  AnnouncementTemplateStatus,
  type AnnouncementTemplateChangeDto,
  type AnnouncementTemplateDto,
  type AnnouncementTemplateQueryDto,
  type AnnouncementTemplateSaveRequestDto,
} from '@gameing/admin-contracts/announcement-template';
import { validateAnnouncementTemplate } from './announcement-template-domain';

export type AnnouncementTemplateFailure = 'INVALID_REQUEST' | 'NOT_FOUND' | 'REQUEST_KEY_REUSED' | 'READ_FAILED' | 'WRITE_FAILED';
export type AnnouncementTemplateResult<T> = { ok: true; value: T } | { ok: false; code: AnnouncementTemplateFailure };

export interface AnnouncementTemplateRepositoryPort {
  list(): Promise<AnnouncementTemplateDto[]>;
  find(templateId: string): Promise<AnnouncementTemplateDto | null>;
  listChanges(templateId: string): Promise<AnnouncementTemplateChangeDto[]>;
  findChangeByRequestKey(requestKey: string): Promise<AnnouncementTemplateChangeDto | null>;
  commit(template: AnnouncementTemplateDto, change: AnnouncementTemplateChangeDto): Promise<void>;
  createId(): string;
  now(): string;
}

export interface AnnouncementTemplateApplication {
  list(query: unknown): Promise<AnnouncementTemplateResult<AnnouncementTemplateDto[]>>;
  listChanges(templateId: unknown): Promise<AnnouncementTemplateResult<AnnouncementTemplateChangeDto[]>>;
  save(request: unknown): Promise<AnnouncementTemplateResult<AnnouncementTemplateDto>>;
}

function sameRequest(request: AnnouncementTemplateSaveRequestDto, change: AnnouncementTemplateChangeDto): boolean {
  return change.previous?.templateId === (request.templateId ?? undefined)
    && change.next.eventType === request.eventType
    && change.next.titlePattern === request.titlePattern
    && change.next.messagePattern === request.messagePattern
    && change.reason === request.reason;
}

export function createAnnouncementTemplateApplication(repository: AnnouncementTemplateRepositoryPort): AnnouncementTemplateApplication {
  return {
    async list(query) {
      if (!Value.Check(AnnouncementTemplateQuerySchema, query)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const records = await repository.list();
        if (!records.every((record) => Value.Check(AnnouncementTemplateDtoSchema, record))) return { ok: false, code: 'INVALID_REQUEST' };
        const typed = query as AnnouncementTemplateQueryDto;
        const keyword = typed.keyword?.trim().toLocaleLowerCase();
        return { ok: true, value: records.filter((record) => (!typed.eventType || record.eventType === typed.eventType)
          && (!keyword || `${record.eventType} ${record.titlePattern} ${record.messagePattern}`.toLocaleLowerCase().includes(keyword)))
          .sort((left, right) => left.eventType.localeCompare(right.eventType) || right.updatedAt.localeCompare(left.updatedAt)) };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async listChanges(templateId) {
      if (typeof templateId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(templateId)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        if (!await repository.find(templateId)) return { ok: false, code: 'NOT_FOUND' };
        const changes = await repository.listChanges(templateId);
        return changes.every((change) => Value.Check(AnnouncementTemplateChangeDtoSchema, change))
          ? { ok: true, value: changes.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) }
          : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async save(request) {
      if (!Value.Check(AnnouncementTemplateSaveRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const input = request as AnnouncementTemplateSaveRequestDto;
      const normalized = { ...input, titlePattern: input.titlePattern.trim(), messagePattern: input.messagePattern.trim(), reason: input.reason.trim() };
      if (!Value.Check(AnnouncementTemplateSaveRequestSchema, normalized) || !validateAnnouncementTemplate(normalized)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const replay = await repository.findChangeByRequestKey(normalized.requestKey);
        if (replay) {
          return sameRequest(normalized, replay) ? { ok: true, value: replay.next } : { ok: false, code: 'REQUEST_KEY_REUSED' };
        }
        const previous = normalized.templateId ? await repository.find(normalized.templateId) : null;
        if (normalized.templateId && !previous) return { ok: false, code: 'NOT_FOUND' };
        const now = repository.now();
        const template: AnnouncementTemplateDto = {
          templateId: previous?.templateId ?? repository.createId(), eventType: normalized.eventType,
          titlePattern: normalized.titlePattern, messagePattern: normalized.messagePattern, status: AnnouncementTemplateStatus.DRAFT, updatedAt: now,
        };
        const change: AnnouncementTemplateChangeDto = {
          changeId: repository.createId(), requestKey: normalized.requestKey, templateId: template.templateId,
          previous, next: template, reason: normalized.reason, source: AnnouncementTemplateSource.LOCAL_DEMO, createdAt: now,
        };
        if (!Value.Check(AnnouncementTemplateDtoSchema, template) || !Value.Check(AnnouncementTemplateChangeDtoSchema, change)) return { ok: false, code: 'INVALID_REQUEST' };
        try {
          await repository.commit(template, change);
        } catch {
          const committed = await repository.findChangeByRequestKey(normalized.requestKey);
          if (committed) return sameRequest(normalized, committed) ? { ok: true, value: committed.next } : { ok: false, code: 'REQUEST_KEY_REUSED' };
          return { ok: false, code: 'WRITE_FAILED' };
        }
        return { ok: true, value: template };
      } catch { return { ok: false, code: 'WRITE_FAILED' }; }
    },
  };
}
