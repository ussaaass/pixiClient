import type { AgentDomainDto, InviteLinkDto, ReferralInviteePageDto, ReferralRewardPageDto } from '@gameing/contracts/invite-agent';

export interface InviteAgentGateway {
  getInviteLink(): Promise<InviteLinkDto | null>;
  issueInviteLink(): Promise<InviteLinkDto>;
  listInvitees(cursor?: string): Promise<ReferralInviteePageDto>;
  listRewards(cursor?: string): Promise<ReferralRewardPageDto>;
  getAgentDomain(): Promise<AgentDomainDto | null>;
  applyAgentDomain(): Promise<AgentDomainDto>;
  withdrawAgentDomain(): Promise<{ withdrawn: boolean }>;
}

export interface InviteAgentApplication extends InviteAgentGateway {}

export function createInviteAgentApplication(gateway: InviteAgentGateway): InviteAgentApplication {
  return {
    getInviteLink: () => gateway.getInviteLink(),
    issueInviteLink: () => gateway.issueInviteLink(),
    listInvitees: (cursor) => gateway.listInvitees(cursor),
    listRewards: (cursor) => gateway.listRewards(cursor),
    getAgentDomain: () => gateway.getAgentDomain(),
    applyAgentDomain: () => gateway.applyAgentDomain(),
    withdrawAgentDomain: () => gateway.withdrawAgentDomain(),
  };
}
