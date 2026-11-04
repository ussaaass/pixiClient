import { AgentCapabilityCode, type AgentCapabilityCodeValue } from '@gameing/contracts/invite-agent';
import { createAgentSocialApplication } from './agent-social-application';
import { IndexedDbAgentSocialAdapter } from './indexeddb-agent-social-adapter';
import { RemoteAgentSocialAdapter } from './remote-agent-social-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;
const grantedCapabilities = new Set<string>([AgentCapabilityCode.SOCIAL_READ_PRIVATE_MESSAGES, AgentCapabilityCode.SOCIAL_MODERATE]);

export function createAgentSocialApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  const scopeResolver = {
    resolve(capability: AgentCapabilityCodeValue) {
      return grantedCapabilities.has(capability) ? { agentDomainId: '92001', agentUserId: '92000' } : null;
    },
  };
  const repository = remote
    ? new RemoteAgentSocialAdapter(new AdminApiClient({
        base: adminApiBase ?? '/admin-api/v1',
        getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
      }))
    : new IndexedDbAgentSocialAdapter();
  return createAgentSocialApplication(repository, scopeResolver);
}

export const agentSocialApplication = createAgentSocialApp({ useRemote: false });
