import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import {
  SupportDeskActionRequestSchema,
  SupportDeskDetailResponseSchema,
  SupportDeskListResponseSchema,
  SupportDeskQuerySchema,
  SupportDeskReplyRequestSchema,
  type SupportDeskActionRequestDto,
  type SupportDeskDetailResponseDto,
  type SupportDeskListResponseDto,
  type SupportDeskQueryDto,
  type SupportDeskReplyRequestDto,
} from '@gameing/contracts/support';
import type { SupportDeskFailureCode } from './support-desk-domain';

export interface SupportDeskRepositoryPort {
  list(query: SupportDeskQueryDto): Promise<SupportDeskListResponseDto>;
  detail(conversationId: string): Promise<SupportDeskDetailResponseDto | null>;
  claim(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | SupportDeskFailureCode>;
  reply(conversationId: string, actorUserId: string, request: SupportDeskReplyRequestDto): Promise<SupportDeskDetailResponseDto | SupportDeskFailureCode>;
  resolve(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | SupportDeskFailureCode>;
  reopen(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | SupportDeskFailureCode>;
}

export type SupportDeskResult<T> = { ok: true; value: T } | { ok: false; code: SupportDeskFailureCode | 'INVALID_REQUEST' };
export interface SupportDeskApplication {
  list(query: unknown): Promise<SupportDeskResult<SupportDeskListResponseDto>>;
  detail(conversationId: unknown): Promise<SupportDeskResult<SupportDeskDetailResponseDto>>;
  claim(conversationId: unknown, request: unknown): Promise<SupportDeskResult<SupportDeskDetailResponseDto>>;
  reply(conversationId: unknown, request: unknown): Promise<SupportDeskResult<SupportDeskDetailResponseDto>>;
  resolve(conversationId: unknown, request: unknown): Promise<SupportDeskResult<SupportDeskDetailResponseDto>>;
  reopen(conversationId: unknown, request: unknown): Promise<SupportDeskResult<SupportDeskDetailResponseDto>>;
}

const ACTOR_USER_ID = '90001'; // fixed actor for the isolated LOCAL_DEMO workspace only
const ID_SCHEMA = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });

export function createSupportDeskApplication(repository: SupportDeskRepositoryPort): SupportDeskApplication {
  const run = async (action: () => Promise<SupportDeskDetailResponseDto | null | SupportDeskFailureCode>): Promise<SupportDeskResult<SupportDeskDetailResponseDto>> => {
    try {
      const result = await action();
      if (result === null) return { ok: false, code: 'NOT_FOUND' };
      if (typeof result === 'string') return { ok: false, code: result };
      return Value.Check(SupportDeskDetailResponseSchema, result) ? { ok: true, value: result } : { ok: false, code: 'INVALID_REQUEST' };
    } catch {
      return { ok: false, code: 'WRITE_FAILED' };
    }
  };

  return {
    async list(query) {
      if (!Value.Check(SupportDeskQuerySchema, query)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const value = await repository.list(query as SupportDeskQueryDto);
        return Value.Check(SupportDeskListResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async detail(conversationId) {
      if (!Value.Check(ID_SCHEMA, conversationId)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const value = await repository.detail(conversationId);
        if (value === null) return { ok: false, code: 'NOT_FOUND' };
        return Value.Check(SupportDeskDetailResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async claim(conversationId, request) {
      if (!Value.Check(ID_SCHEMA, conversationId) || !Value.Check(SupportDeskActionRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      return run(() => repository.claim(conversationId, ACTOR_USER_ID, (request as SupportDeskActionRequestDto).requestKey));
    },
    async reply(conversationId, request) {
      if (!Value.Check(ID_SCHEMA, conversationId) || !Value.Check(SupportDeskReplyRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      return run(() => repository.reply(conversationId, ACTOR_USER_ID, request as SupportDeskReplyRequestDto));
    },
    async resolve(conversationId, request) {
      if (!Value.Check(ID_SCHEMA, conversationId) || !Value.Check(SupportDeskActionRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      return run(() => repository.resolve(conversationId, ACTOR_USER_ID, (request as SupportDeskActionRequestDto).requestKey));
    },
    async reopen(conversationId, request) {
      if (!Value.Check(ID_SCHEMA, conversationId) || !Value.Check(SupportDeskActionRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      return run(() => repository.reopen(conversationId, ACTOR_USER_ID, (request as SupportDeskActionRequestDto).requestKey));
    },
  };
}
