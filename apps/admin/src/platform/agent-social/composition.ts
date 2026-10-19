import { AgentCapabilityCode } from '@gameing/contracts/invite-agent';
import { createAgentSocialApplication } from './agent-social-application';
import { IndexedDbAgentSocialAdapter } from './indexeddb-agent-social-adapter';

const adapter = new IndexedDbAgentSocialAdapter();
const grantedCapabilities = new Set<string>([AgentCapabilityCode.SOCIAL_READ_PRIVATE_MESSAGES, AgentCapabilityCode.SOCIAL_MODERATE]);
export const agentSocialApplication = createAgentSocialApplication(adapter, {
  resolve(capability) {
    return grantedCapabilities.has(capability) ? { agentDomainId: '92001', agentUserId: '92000' } : null;
  },
});
