import { AgentCapabilityCode } from '@gameing/contracts/invite-agent';
import { createAgentAnnouncementApplication } from './agent-announcement-application';
import { IndexedDbAgentAnnouncementAdapter } from './indexeddb-agent-announcement-adapter';

const adapter = new IndexedDbAgentAnnouncementAdapter();
const grantedCapabilities = new Set<string>([AgentCapabilityCode.ANNOUNCEMENT_MANAGE]);
export const agentAnnouncementApplication = createAgentAnnouncementApplication(adapter, {
  resolve(capability) {
    return grantedCapabilities.has(capability) ? { agentDomainId: '92001', agentUserId: '92000' } : null;
  },
});
