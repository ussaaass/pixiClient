import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import {
  SocialModerationDecisionRequestSchema,
  SocialModerationDecisionResponseSchema,
  SocialModerationAuditListResponseSchema,
  SocialModerationListResponseSchema,
  SocialModerationQuerySchema,
  type SocialModerationDecisionRequestDto,
  type SocialModerationDecisionResponseDto,
  type SocialModerationAuditListResponseDto,
  type SocialModerationListResponseDto,
  type SocialModerationQueryDto,
} from '@gameing/contracts/social';
import type { SocialModerationFailureCode } from './social-moderation-domain';

export interface SocialModerationRepositoryPort {
  list(query: SocialModerationQueryDto): Promise<SocialModerationListResponseDto>;
  listAudits(caseId: string): Promise<SocialModerationAuditListResponseDto | null>;
  decide(caseId: string, reviewerAdminUserId: string, request: SocialModerationDecisionRequestDto): Promise<SocialModerationDecisionResponseDto | SocialModerationFailureCode>;
}

export type SocialModerationResult<T> = { ok: true; value: T } | { ok: false; code: SocialModerationFailureCode | 'INVALID_REQUEST' };
export interface SocialModerationApplication {
  list(query: unknown): Promise<SocialModerationResult<SocialModerationListResponseDto>>;
  listAudits(caseId: unknown): Promise<SocialModerationResult<SocialModerationAuditListResponseDto>>;
  decide(caseId: unknown, request: unknown): Promise<SocialModerationResult<SocialModerationDecisionResponseDto>>;
}

const ID_SCHEMA = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const LOCAL_REVIEWER_ADMIN_USER_ID = '90001';

export function createSocialModerationApplication(repository: SocialModerationRepositoryPort): SocialModerationApplication {
  return {
    async list(query) {
      if (!Value.Check(SocialModerationQuerySchema, query)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const value = await repository.list(query as SocialModerationQueryDto);
        return Value.Check(SocialModerationListResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async listAudits(caseId) {
      if (!Value.Check(ID_SCHEMA, caseId)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const value = await repository.listAudits(caseId);
        if (value === null) return { ok: false, code: 'NOT_FOUND' };
        return Value.Check(SocialModerationAuditListResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async decide(caseId, request) {
      if (!Value.Check(ID_SCHEMA, caseId) || !Value.Check(SocialModerationDecisionRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const typedRequest = request as SocialModerationDecisionRequestDto;
      if (typedRequest.reason.trim().length < 3) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const result = await repository.decide(caseId, LOCAL_REVIEWER_ADMIN_USER_ID, { ...typedRequest, reason: typedRequest.reason.trim() });
        if (typeof result === 'string') return { ok: false, code: result };
        return Value.Check(SocialModerationDecisionResponseSchema, result) ? { ok: true, value: result } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'WRITE_FAILED' }; }
    },
  };
}
