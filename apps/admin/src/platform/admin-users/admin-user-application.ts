import { Value } from '@sinclair/typebox/value';
import {
  AdminUserDetailSectionResponseSchema,
  AdminUserDetailSection,
  AdminUserListResponseSchema,
  AdminUserQuerySchema,
  AdminUserSummaryDtoSchema,
  type AdminUserDetailSectionResponseDto,
  type AdminUserListResponseDto,
  type AdminUserQueryDto,
  type AdminUserSummaryDto,
} from '@gameing/admin-contracts/admin-users';

export type AdminUserFailure = 'INVALID_QUERY' | 'USER_NOT_FOUND' | 'READ_FAILED' | 'INVALID_DATA';
export type AdminUserResult<T> = { ok: true; value: T } | { ok: false; code: AdminUserFailure };

export interface AdminUserRepositoryPort {
  listSummaries(): Promise<AdminUserSummaryDto[]>;
  readSection(userId: string, section: unknown): Promise<AdminUserDetailSectionResponseDto | null>;
}

export interface AdminUserApplication {
  list(query: unknown): Promise<AdminUserResult<AdminUserListResponseDto>>;
  detail(userId: unknown, section: unknown): Promise<AdminUserResult<AdminUserDetailSectionResponseDto>>;
}

const MAX_UINT64 = '18446744073709551615';
const isId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
  && !(value.length === MAX_UINT64.length && value > MAX_UINT64);
const DETAIL_SECTIONS = new Set<string>(Object.values(AdminUserDetailSection));

export function createAdminUserApplication(repository: AdminUserRepositoryPort): AdminUserApplication {
  return {
    async list(query) {
      if (!Value.Check(AdminUserQuerySchema, query)) return { ok: false, code: 'INVALID_QUERY' };
      if ((query as AdminUserQueryDto).userId && !isId((query as AdminUserQueryDto).userId)) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const summaries = await repository.listSummaries();
        if (!summaries.every((summary) => Value.Check(AdminUserSummaryDtoSchema, summary)
          && isId(summary.userId) && (summary.parent1UserId === null || isId(summary.parent1UserId)))) return { ok: false, code: 'INVALID_DATA' };
        const typed = query as AdminUserQueryDto;
        const filtered = summaries.filter((user) => (!typed.userId || user.userId === typed.userId)
          && (!typed.username || (user.username ?? '').toLocaleLowerCase().includes(typed.username.toLocaleLowerCase()))
          && (typed.roleType === undefined || user.roleType === typed.roleType)
          && (typed.status === undefined || user.status === typed.status))
          .sort((left, right) => left.userId.localeCompare(right.userId));
        const pageSize = typed.pageSize ?? 25;
        const offset = typed.cursor ? Number(typed.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > filtered.length) return { ok: false, code: 'INVALID_QUERY' };
        const items = filtered.slice(offset, offset + pageSize);
        const nextOffset = offset + items.length;
        const response: AdminUserListResponseDto = { items, total: filtered.length, nextCursor: nextOffset < filtered.length ? String(nextOffset) : null };
        return Value.Check(AdminUserListResponseSchema, response) ? { ok: true, value: response } : { ok: false, code: 'INVALID_DATA' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async detail(userId, section) {
      if (!isId(userId) || typeof section !== 'string' || !DETAIL_SECTIONS.has(section)) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const detail = await repository.readSection(userId, section);
        if (!detail) return { ok: false, code: 'USER_NOT_FOUND' };
        return Value.Check(AdminUserDetailSectionResponseSchema, detail) ? { ok: true, value: detail } : { ok: false, code: 'INVALID_DATA' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
  };
}
