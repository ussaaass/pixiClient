import { Value } from '@sinclair/typebox/value';
import {
  AgentCapabilityCode,
  AgentDomainDtoSchema,
  AgentDomainAdminActionRequestSchema,
  AgentDomainAdminActionResponseSchema,
  AgentDomainStatus,
  type AgentDomainDto,
  type AgentDomainAdminActionRequestDto,
  type AgentDomainAdminActionResponseDto,
} from '@gameing/contracts/invite-agent';
import {
  AgentDomainReviewAuditDtoSchema,
  AgentDomainReviewAuditSource,
  type AgentDomainReviewAuditDto,
} from '@gameing/admin-contracts/agent-domain-review';
import { transitionAgentDomain } from './agent-domain-admin-domain';

export type AgentDomainReviewFailureCode = 'INVALID_REQUEST' | 'REASON_REQUIRED' | 'REJECT_CANNOT_GRANT_CAPABILITIES' | 'DOMAIN_NOT_FOUND' | 'DOMAIN_STATE_CONFLICT' | 'REQUEST_KEY_REUSED';
export type AgentDomainReviewResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: AgentDomainReviewFailureCode };

export interface AgentDomainReviewRepositoryPort {
  listDomains(): Promise<AgentDomainDto[]>;
  listAudits(userId: string): Promise<AgentDomainReviewAuditDto[]>;
  findDomain(userId: string): Promise<AgentDomainDto | null>;
  findAuditByRequestKey(requestKey: string): Promise<AgentDomainReviewAuditDto | null>;
  commitReview(domain: AgentDomainDto, audit: AgentDomainReviewAuditDto): Promise<void>;
  createId(): string;
  now(): string;
}

export interface LocalAgentDomainDemoRepositoryPort {
  createLocalDemoApplication(domain: AgentDomainDto): Promise<void>;
  createUserId(): string;
  now(): string;
}

export interface AgentDomainReviewApplication {
  listDomains(): Promise<AgentDomainReviewResult<AgentDomainDto[]>>;
  listAudits(userId: string): Promise<AgentDomainReviewResult<AgentDomainReviewAuditDto[]>>;
  execute(request: AgentDomainAdminActionRequestDto): Promise<AgentDomainReviewResult<AgentDomainAdminActionResponseDto>>;
}

export interface LocalAgentDomainDemoApplication {
  createLocalDemoApplication(): Promise<AgentDomainReviewResult<AgentDomainDto>>;
}

export type AgentDomainReviewWorkspaceApplication = AgentDomainReviewApplication & LocalAgentDomainDemoApplication;

const registeredCapabilities = new Set<string>(Object.values(AgentCapabilityCode));
const failure = <T>(code: AgentDomainReviewFailureCode): AgentDomainReviewResult<T> => ({ ok: false, code });

function sameRequest(request: AgentDomainAdminActionRequestDto, audit: AgentDomainReviewAuditDto): boolean {
  return request.userId === audit.userId
    && request.action === audit.action
    && request.reason.trim() === audit.reason
    && [...request.capabilities].sort().join('|') === [...audit.nextCapabilities].sort().join('|');
}

export function createLocalAgentDomainDemoApplication(repository: LocalAgentDomainDemoRepositoryPort): LocalAgentDomainDemoApplication {
  return {
    async createLocalDemoApplication() {
      const appliedAt = repository.now();
      const domain: AgentDomainDto = {
        userId: repository.createUserId(),
        status: AgentDomainStatus.PENDING_REVIEW,
        appliedAt,
        capabilities: [],
      };
      if (!Value.Check(AgentDomainDtoSchema, domain)) return failure('INVALID_REQUEST');
      await repository.createLocalDemoApplication(domain);
      return { ok: true, value: domain };
    },
  };
}

export function createAgentDomainReviewApplication(repository: AgentDomainReviewRepositoryPort): AgentDomainReviewApplication {
  return {
    async listDomains() {
      const domains = await repository.listDomains();
      return domains.every((domain) => Value.Check(AgentDomainDtoSchema, domain))
        ? { ok: true, value: domains }
        : failure('INVALID_REQUEST');
    },

    async listAudits(userId) {
      const audits = await repository.listAudits(userId);
      return audits.every((audit) => Value.Check(AgentDomainReviewAuditDtoSchema, audit))
        ? { ok: true, value: audits }
        : failure('INVALID_REQUEST');
    },

    async execute(request) {
      if (!Value.Check(AgentDomainAdminActionRequestSchema, request)) return failure('INVALID_REQUEST');
      const normalizedRequest = { ...request, reason: request.reason.trim() };
      if (normalizedRequest.reason.length < 3) return failure('REASON_REQUIRED');
      if (normalizedRequest.capabilities.some((capability) => !registeredCapabilities.has(capability))) return failure('INVALID_REQUEST');
      const duplicate = await repository.findAuditByRequestKey(normalizedRequest.requestKey);
      if (duplicate) {
        return sameRequest(normalizedRequest, duplicate)
          ? { ok: true, value: { requestKey: duplicate.requestKey, agentDomain: duplicate.resultingDomain } }
          : failure('REQUEST_KEY_REUSED');
      }

      const current = await repository.findDomain(normalizedRequest.userId);
      if (!current) return failure('DOMAIN_NOT_FOUND');
      const transition = transitionAgentDomain(current, normalizedRequest);
      if (!transition.ok) return failure(transition.code);
      const nextDomain = transition.value;
      const audit: AgentDomainReviewAuditDto = {
        auditId: repository.createId(),
        userId: current.userId,
        requestKey: normalizedRequest.requestKey,
        action: normalizedRequest.action,
        previousStatus: current.status,
        nextStatus: nextDomain.status,
        previousCapabilities: [...current.capabilities],
        nextCapabilities: [...nextDomain.capabilities],
        reason: normalizedRequest.reason,
        source: AgentDomainReviewAuditSource.LOCAL_DEMO,
        resultingDomain: nextDomain,
        createdAt: repository.now(),
      };
      if (!Value.Check(AgentDomainReviewAuditDtoSchema, audit)) return failure('INVALID_REQUEST');
      const response: AgentDomainAdminActionResponseDto = { requestKey: normalizedRequest.requestKey, agentDomain: nextDomain };
      if (!Value.Check(AgentDomainAdminActionResponseSchema, response)) return failure('INVALID_REQUEST');
      try {
        await repository.commitReview(nextDomain, audit);
      } catch (error) {
        const committed = await repository.findAuditByRequestKey(normalizedRequest.requestKey);
        if (committed) {
          return sameRequest(normalizedRequest, committed)
            ? { ok: true, value: { requestKey: committed.requestKey, agentDomain: committed.resultingDomain } }
            : failure('REQUEST_KEY_REUSED');
        }
        throw error;
      }
      return { ok: true, value: response };
    },
  };
}
