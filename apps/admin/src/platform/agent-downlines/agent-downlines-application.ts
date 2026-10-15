import { Value } from '@sinclair/typebox/value';
import {
  AgentDownlineDetailSchema,
  AgentDownlineListResponseSchema,
  AgentDownlineDetailReadRequestSchema,
  AgentDownlineQuerySchema,
  type AgentDownlineDetailDto,
  type AgentDownlineDetailReadRequestDto,
  type AgentDownlineListResponseDto,
  type AgentDownlineQueryDto,
} from '@gameing/contracts/agent-downlines';

export type AgentDownlineReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: 'INVALID_QUERY' | 'NOT_FOUND' | 'INVALID_RESPONSE' | 'READ_FAILED' };

export interface AgentDownlineReadRepositoryPort {
  list(query: AgentDownlineQueryDto): Promise<AgentDownlineListResponseDto>;
  readDetail(userId: string, request: AgentDownlineDetailReadRequestDto): Promise<AgentDownlineDetailDto | null>;
}

export interface AgentDownlineReadApplication {
  list(query: AgentDownlineQueryDto): Promise<AgentDownlineReadResult<AgentDownlineListResponseDto>>;
  detail(userId: string, request: AgentDownlineDetailReadRequestDto): Promise<AgentDownlineReadResult<AgentDownlineDetailDto>>;
}

export function createAgentDownlineReadApplication(repository: AgentDownlineReadRepositoryPort): AgentDownlineReadApplication {
  return {
    async list(query) {
      if (!Value.Check(AgentDownlineQuerySchema, query)) return { ok: false, code: 'INVALID_QUERY' };
      const keyword = query.keyword?.trim();
      const normalized: AgentDownlineQueryDto = {
        ...(keyword ? { keyword } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        pageSize: query.pageSize ?? 20,
      };
      try {
        const value = await repository.list(normalized);
        if (!Value.Check(AgentDownlineListResponseSchema, value)) return { ok: false, code: 'INVALID_RESPONSE' };
        return { ok: true, value };
      } catch {
        return { ok: false, code: 'READ_FAILED' };
      }
    },
    async detail(userId, request) {
      if (!/^[1-9][0-9]{0,19}$/.test(userId)) return { ok: false, code: 'NOT_FOUND' };
      if (!Value.Check(AgentDownlineDetailReadRequestSchema, request)) return { ok: false, code: 'INVALID_QUERY' };
      if (request.purposeCode === 'SUPPORT_CASE' && (request.caseReference?.trim().length ?? 0) < 3) return { ok: false, code: 'INVALID_QUERY' };
      if (request.purposeCode !== 'SUPPORT_CASE' && request.caseReference) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const value = await repository.readDetail(userId, request);
        if (!value) return { ok: false, code: 'NOT_FOUND' };
        if (!Value.Check(AgentDownlineDetailSchema, value)) return { ok: false, code: 'INVALID_RESPONSE' };
        return { ok: true, value };
      } catch {
        return { ok: false, code: 'READ_FAILED' };
      }
    },
  };
}
