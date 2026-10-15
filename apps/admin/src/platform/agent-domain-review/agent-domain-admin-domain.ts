import {
  AgentDomainAdminAction,
  AgentDomainStatus,
  type AgentDomainDto,
  type AgentDomainAdminActionRequestDto,
} from '@gameing/contracts/invite-agent';

export type AgentDomainTransitionFailure = 'REJECT_CANNOT_GRANT_CAPABILITIES' | 'DOMAIN_STATE_CONFLICT' | 'INVALID_REQUEST';
export type AgentDomainTransition = { readonly ok: true; readonly value: AgentDomainDto } | { readonly ok: false; readonly code: AgentDomainTransitionFailure };

const allowedFrom: Record<AgentDomainAdminActionRequestDto['action'], readonly AgentDomainDto['status'][]> = {
  APPROVE: [AgentDomainStatus.PENDING_REVIEW],
  REJECT: [AgentDomainStatus.PENDING_REVIEW],
  SUSPEND: [AgentDomainStatus.ACTIVE],
  RESTORE: [AgentDomainStatus.SUSPENDED],
  REVOKE: [AgentDomainStatus.ACTIVE, AgentDomainStatus.SUSPENDED],
  UPDATE_CAPABILITIES: [AgentDomainStatus.ACTIVE],
};

export function transitionAgentDomain(current: AgentDomainDto, request: AgentDomainAdminActionRequestDto): AgentDomainTransition {
  if (request.action === AgentDomainAdminAction.REJECT && request.capabilities.length > 0) {
    return { ok: false, code: 'REJECT_CANNOT_GRANT_CAPABILITIES' };
  }
  const assignsCapabilities = request.action === AgentDomainAdminAction.APPROVE || request.action === AgentDomainAdminAction.UPDATE_CAPABILITIES;
  if (!assignsCapabilities && request.capabilities.length > 0) return { ok: false, code: 'INVALID_REQUEST' };
  if (!allowedFrom[request.action].includes(current.status)) return { ok: false, code: 'DOMAIN_STATE_CONFLICT' };

  const nextStatus: AgentDomainDto['status'] = {
    APPROVE: AgentDomainStatus.ACTIVE,
    REJECT: AgentDomainStatus.REVOKED,
    SUSPEND: AgentDomainStatus.SUSPENDED,
    RESTORE: AgentDomainStatus.ACTIVE,
    REVOKE: AgentDomainStatus.REVOKED,
    UPDATE_CAPABILITIES: AgentDomainStatus.ACTIVE,
  }[request.action];
  const nextCapabilities = assignsCapabilities
    ? [...request.capabilities]
    : request.action === AgentDomainAdminAction.REVOKE ? [] : [...current.capabilities];
  return { ok: true, value: { ...current, status: nextStatus, capabilities: nextCapabilities } };
}
