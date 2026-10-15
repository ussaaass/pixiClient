import { Value } from '@sinclair/typebox/value';
import {
  AdminAuditDtoSchema,
  AdminAuditListResponseSchema,
  AdminAuditQuerySchema,
  type AdminAuditDto,
  type AdminAuditListResponseDto,
  type AdminAuditQueryDto,
} from '@gameing/admin-contracts/admin-audit';

export type AdminAuditFailure = 'INVALID_QUERY' | 'READ_FAILED' | 'INVALID_AUDIT_DATA';
export type AdminAuditResult = { ok: true; value: AdminAuditListResponseDto } | { ok: false; code: AdminAuditFailure };

export interface AdminAuditRepositoryPort {
  listEvents(): Promise<AdminAuditDto[]>;
}

export interface AdminAuditApplication {
  list(query: unknown): Promise<AdminAuditResult>;
}

function matches(event: AdminAuditDto, query: AdminAuditQueryDto): boolean {
  const keyword = query.keyword?.trim().toLocaleLowerCase();
  const haystack = [event.adminUserId, event.adminDisplayName, event.targetUserId ?? '', event.requestId ?? '', event.actionCode, event.resourceType, event.resourceKey, event.reason].join(' ').toLocaleLowerCase();
  return (!keyword || haystack.includes(keyword))
    && (!query.adminUserId || event.adminUserId === query.adminUserId)
    && (!query.targetUserId || event.targetUserId === query.targetUserId)
    && (!query.actionCode || event.actionCode === query.actionCode)
    && (query.resultType === undefined || event.resultType === query.resultType)
    && (!query.fromCreatedAt || event.createdAt >= query.fromCreatedAt)
    && (!query.toCreatedAt || event.createdAt <= query.toCreatedAt);
}

export function createAdminAuditApplication(repository: AdminAuditRepositoryPort): AdminAuditApplication {
  return {
    async list(query): Promise<AdminAuditResult> {
      if (!Value.Check(AdminAuditQuerySchema, query)) return { ok: false, code: 'INVALID_QUERY' };
      const typed = query as AdminAuditQueryDto;
      if ((typed.fromCreatedAt && Number.isNaN(Date.parse(typed.fromCreatedAt)))
        || (typed.toCreatedAt && Number.isNaN(Date.parse(typed.toCreatedAt)))
        || (typed.fromCreatedAt && typed.toCreatedAt && typed.fromCreatedAt > typed.toCreatedAt)) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const events = await repository.listEvents();
        if (!events.every((event) => Value.Check(AdminAuditDtoSchema, event))) return { ok: false, code: 'INVALID_AUDIT_DATA' };
        const filtered = events.filter((event) => matches(event, typed)).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.auditId.localeCompare(left.auditId));
        const page = typed.page ?? 1;
        const pageSize = typed.pageSize ?? 25;
        const response: AdminAuditListResponseDto = { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize };
        return Value.Check(AdminAuditListResponseSchema, response) ? { ok: true, value: response } : { ok: false, code: 'INVALID_AUDIT_DATA' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
  };
}
