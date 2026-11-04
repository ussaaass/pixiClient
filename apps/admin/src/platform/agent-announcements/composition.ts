import { AgentCapabilityCode, type AgentCapabilityCodeValue } from '@gameing/contracts/invite-agent';
import { createAgentAnnouncementApplication } from './agent-announcement-application';
import { IndexedDbAgentAnnouncementAdapter } from './indexeddb-agent-announcement-adapter';
import { RemoteAgentAnnouncementAdapter } from './remote-agent-announcement-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;
const grantedCapabilities = new Set<string>([AgentCapabilityCode.ANNOUNCEMENT_MANAGE]);

export function createAgentAnnouncementApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  const scopeResolver = {
    resolve(capability: AgentCapabilityCodeValue) {
      return grantedCapabilities.has(capability) ? { agentDomainId: '92001', agentUserId: '92000' } : null;
    },
  };
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAgentAnnouncementApplication(new RemoteAgentAnnouncementAdapter(client), scopeResolver);
  }
  return createAgentAnnouncementApplication(new IndexedDbAgentAnnouncementAdapter(), scopeResolver);
}

export const agentAnnouncementApplication = createAgentAnnouncementApp({ useRemote: false });
