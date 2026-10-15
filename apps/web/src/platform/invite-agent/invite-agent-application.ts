import type { AgentDomainDto, InviteLinkDto } from '@gameing/contracts/invite-agent';

export interface InviteAgentGateway {
  getInviteLink(): Promise<InviteLinkDto | null>;
  issueInviteLink(): Promise<InviteLinkDto>;
  getAgentDomain(): Promise<AgentDomainDto | null>;
  applyAgentDomain(): Promise<AgentDomainDto>;
  withdrawAgentDomain(): Promise<{ withdrawn: boolean }>;
}

export interface InviteAgentApplication extends InviteAgentGateway {}

export function createInviteAgentApplication(gateway: InviteAgentGateway): InviteAgentApplication {
  return {
    getInviteLink: () => gateway.getInviteLink(),
    issueInviteLink: () => gateway.issueInviteLink(),
    getAgentDomain: () => gateway.getAgentDomain(),
    applyAgentDomain: () => gateway.applyAgentDomain(),
    withdrawAgentDomain: () => gateway.withdrawAgentDomain(),
  };
}
