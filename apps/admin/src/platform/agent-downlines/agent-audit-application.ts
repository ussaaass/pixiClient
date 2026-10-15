import { Value } from '@sinclair/typebox/value';
import { AgentAuditListResponseSchema, AgentAuditQuerySchema, type AgentAuditListResponseDto, type AgentAuditQueryDto } from '@gameing/contracts/agent-audit';

export interface AgentAuditReadRepositoryPort {
  listAuditEvents(query: AgentAuditQueryDto): Promise<AgentAuditListResponseDto>;
}

export type AgentAuditReadResult = { readonly ok: true; readonly value: AgentAuditListResponseDto } | { readonly ok: false; readonly code: 'INVALID_QUERY' | 'INVALID_RESPONSE' | 'READ_FAILED' };

export function createAgentAuditReadApplication(repository: AgentAuditReadRepositoryPort) {
  return {
    async list(query: AgentAuditQueryDto): Promise<AgentAuditReadResult> {
      if (!Value.Check(AgentAuditQuerySchema, query)) return { ok: false, code: 'INVALID_QUERY' };
      const keyword = query.keyword?.trim();
      const normalized: AgentAuditQueryDto = {
        ...(keyword ? { keyword } : {}),
        ...(query.resultType !== undefined ? { resultType: query.resultType } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        pageSize: query.pageSize ?? 20,
      };
      try {
        const value = await repository.listAuditEvents(normalized);
        if (!Value.Check(AgentAuditListResponseSchema, value)) return { ok: false, code: 'INVALID_RESPONSE' };
        return { ok: true, value };
      } catch {
        return { ok: false, code: 'READ_FAILED' };
      }
    },
  };
}
