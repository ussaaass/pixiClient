import { Value } from '@sinclair/typebox/value';
import {
  AgentAnnouncementCreateRequestSchema, AgentAnnouncementCreateResponseSchema,
  AgentAnnouncementListRequestSchema, AgentAnnouncementListResponseSchema,
  AgentAnnouncementPublishRequestSchema, AgentAnnouncementPublishResponseSchema,
  AgentAnnouncementRetractRequestSchema, AgentAnnouncementRetractResponseSchema,
  AgentAnnouncementSource, AgentAnnouncementStatus,
  type AgentAnnouncementCreateRequestDto, type AgentAnnouncementDto, type AgentAnnouncementListRequestDto,
  type AgentAnnouncementListResponseDto,
  type AgentAnnouncementPublishRequestDto, type AgentAnnouncementRetractRequestDto,
} from '@gameing/contracts/agent-announcements';
import { AgentCapabilityCode, type AgentCapabilityCodeValue } from '@gameing/contracts/invite-agent';
import { announcementStatusAt, isSafeAgentAnnouncementText, validateAnnouncementSchedule } from './agent-announcement-domain';

export interface AgentAnnouncementRepositoryPort {
  list(agentDomainId: string): Promise<AgentAnnouncementDto[]>;
  find(announcementId: string): Promise<AgentAnnouncementDto | null>;
  findAuditByRequestKey(requestKey: string): Promise<{ actionCode: string; resourceKey: string; purpose: string; snapshot: Record<string, string | number>; createdAt: string } | null>;
  create(announcement: AgentAnnouncementDto, audit: AgentAnnouncementAudit): Promise<void>;
  update(announcement: AgentAnnouncementDto, audit: AgentAnnouncementAudit): Promise<void>;
}
export interface AgentAnnouncementAudit { actionCode: string; announcement: AgentAnnouncementDto; reason: string; requestKey: string; commandHash: string; createdAt: string }
export interface AgentAnnouncementScopeResolverPort { resolve(capability: AgentCapabilityCodeValue): { agentDomainId: string; agentUserId: string } | null }
export type AgentAnnouncementFailure = 'INVALID_REQUEST' | 'SCOPE_UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_STATE' | 'REQUEST_KEY_REUSED' | 'STORAGE_FAILED';
export type AgentAnnouncementResult<T> = { ok: true; value: T } | { ok: false; code: AgentAnnouncementFailure };

export function createAgentAnnouncementApplication(repository: AgentAnnouncementRepositoryPort, scopeResolver: AgentAnnouncementScopeResolverPort, clock: () => Date = () => new Date()) {
  async function resolveScope() {
    return scopeResolver.resolve(AgentCapabilityCode.ANNOUNCEMENT_MANAGE);
  }
  async function list(query: unknown): Promise<AgentAnnouncementResult<AgentAnnouncementListResponseDto>> {
    if (!Value.Check(AgentAnnouncementListRequestSchema, query)) return { ok: false, code: 'INVALID_REQUEST' };
    const scope = await resolveScope();
    if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
    try {
      const now = clock();
      const rows = await repository.list(scope.agentDomainId);
      const items = rows.map((row) => ({ ...row, status: row.status === AgentAnnouncementStatus.DRAFT || row.status === AgentAnnouncementStatus.RETRACTED ? row.status : Date.parse(row.expiresAt ?? '') <= now.getTime() ? AgentAnnouncementStatus.EXPIRED : Date.parse(row.startsAt ?? '') > now.getTime() ? AgentAnnouncementStatus.SCHEDULED : AgentAnnouncementStatus.ACTIVE })).filter((row) => query.status === undefined || row.status === query.status);
      const response = { items, source: AgentAnnouncementSource.LOCAL_DEMO };
      return Value.Check(AgentAnnouncementListResponseSchema, response) ? { ok: true, value: response } : { ok: false, code: 'INVALID_REQUEST' };
    } catch { return { ok: false, code: 'STORAGE_FAILED' }; }
  }
  async function create(request: unknown): Promise<AgentAnnouncementResult<AgentAnnouncementDto>> {
    if (!Value.Check(AgentAnnouncementCreateRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
    const input = request as AgentAnnouncementCreateRequestDto;
    if (!isSafeAgentAnnouncementText(input.title, input.body)) return { ok: false, code: 'INVALID_REQUEST' };
    const scope = await resolveScope();
    if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
    try {
      const replay = await repository.findAuditByRequestKey(input.requestKey);
      const commandHash = await fingerprint({ title: input.title.trim(), body: input.body.trim(), reason: input.reason.trim() });
      if (replay) {
        if (replay.actionCode !== 'ANNOUNCEMENT_CREATE' || replay.purpose !== input.reason.trim() || replay.snapshot.commandHash !== commandHash) return { ok: false, code: 'REQUEST_KEY_REUSED' };
        const announcement = await repository.find(replay.resourceKey);
        return announcement && announcement.agentDomainId === scope.agentDomainId ? { ok: true, value: announcement } : { ok: false, code: 'NOT_FOUND' };
      }
      const now = clock().toISOString();
      const announcement: AgentAnnouncementDto = { announcementId: crypto.randomUUID(), agentDomainId: scope.agentDomainId, title: input.title.trim(), body: input.body.trim(), status: AgentAnnouncementStatus.DRAFT, startsAt: null, expiresAt: null, createdAt: now, updatedAt: now, source: AgentAnnouncementSource.LOCAL_DEMO };
      if (!Value.Check(AgentAnnouncementCreateResponseSchema, { announcement, source: AgentAnnouncementSource.LOCAL_DEMO })) return { ok: false, code: 'INVALID_REQUEST' };
      await repository.create(announcement, { actionCode: 'ANNOUNCEMENT_CREATE', announcement, reason: input.reason.trim(), requestKey: input.requestKey, commandHash, createdAt: now });
      return { ok: true, value: announcement };
    } catch (error) { return { ok: false, code: error instanceof Error && error.message === 'REQUEST_KEY_REUSED' ? 'REQUEST_KEY_REUSED' : 'STORAGE_FAILED' }; }
  }
  async function publish(request: unknown): Promise<AgentAnnouncementResult<AgentAnnouncementDto>> {
    if (!Value.Check(AgentAnnouncementPublishRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
    const input = request as AgentAnnouncementPublishRequestDto;
    const now = clock();
    if (!validateAnnouncementSchedule(input.startsAt, input.expiresAt, now)) return { ok: false, code: 'INVALID_REQUEST' };
    const scope = await resolveScope();
    if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
    return transition('ANNOUNCEMENT_PUBLISH', input.announcementId, input.reason, input.requestKey, await fingerprint({ announcementId: input.announcementId, startsAt: input.startsAt, expiresAt: input.expiresAt, reason: input.reason.trim() }), scope.agentDomainId, (row) => ({ ...row, status: Date.parse(input.startsAt) > now.getTime() ? AgentAnnouncementStatus.SCHEDULED : AgentAnnouncementStatus.ACTIVE, startsAt: input.startsAt, expiresAt: input.expiresAt, updatedAt: now.toISOString() }));
  }
  async function retract(request: unknown): Promise<AgentAnnouncementResult<AgentAnnouncementDto>> {
    if (!Value.Check(AgentAnnouncementRetractRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
    const input = request as AgentAnnouncementRetractRequestDto;
    const scope = await resolveScope();
    if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
    return transition('ANNOUNCEMENT_RETRACT', input.announcementId, input.reason, input.requestKey, await fingerprint({ announcementId: input.announcementId, reason: input.reason.trim() }), scope.agentDomainId, (row) => ({ ...row, status: AgentAnnouncementStatus.RETRACTED, updatedAt: clock().toISOString() }));
  }
  async function transition(actionCode: string, announcementId: string, reason: string, requestKey: string, commandHash: string, agentDomainId: string, change: (row: AgentAnnouncementDto) => AgentAnnouncementDto): Promise<AgentAnnouncementResult<AgentAnnouncementDto>> {
    try {
      const replay = await repository.findAuditByRequestKey(requestKey);
      if (replay) {
        if (replay.actionCode !== actionCode || replay.resourceKey !== announcementId || replay.purpose !== reason.trim() || replay.snapshot.commandHash !== commandHash) return { ok: false, code: 'REQUEST_KEY_REUSED' };
        const announcement = await repository.find(announcementId);
        return announcement && announcement.agentDomainId === agentDomainId ? { ok: true, value: announcement } : { ok: false, code: 'NOT_FOUND' };
      }
      const current = await repository.find(announcementId);
      if (!current || current.agentDomainId !== agentDomainId) return { ok: false, code: 'NOT_FOUND' };
      const status = announcementStatusAt(current, clock());
      if (actionCode === 'ANNOUNCEMENT_PUBLISH' && status !== AgentAnnouncementStatus.DRAFT) return { ok: false, code: 'INVALID_STATE' };
      if (actionCode === 'ANNOUNCEMENT_RETRACT' && status !== AgentAnnouncementStatus.ACTIVE && status !== AgentAnnouncementStatus.SCHEDULED) return { ok: false, code: 'INVALID_STATE' };
      const now = clock().toISOString();
      const announcement = change(current);
      if (!Value.Check(AgentAnnouncementCreateResponseSchema, { announcement, source: AgentAnnouncementSource.LOCAL_DEMO })) return { ok: false, code: 'INVALID_REQUEST' };
      await repository.update(announcement, { actionCode, announcement, reason: reason.trim(), requestKey, commandHash, createdAt: now });
      return { ok: true, value: announcement };
    } catch (error) { return { ok: false, code: error instanceof Error && error.message === 'REQUEST_KEY_REUSED' ? 'REQUEST_KEY_REUSED' : 'STORAGE_FAILED' }; }
  }
  return { list, create, publish, retract };
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
