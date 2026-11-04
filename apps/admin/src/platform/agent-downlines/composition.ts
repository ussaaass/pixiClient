import { createAgentDownlineReadApplication } from './agent-downlines-application';
import { createAgentAuditReadApplication } from './agent-audit-application';
import { OfflineAgentDownlineAdapter } from './offline-agent-downline-adapter';
import { RemoteAgentDownlineAdapter } from './remote-agent-downline-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAgentDownlinesApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  const adapter = remote
    ? new RemoteAgentDownlineAdapter(new AdminApiClient({
        base: adminApiBase ?? '/admin-api/v1',
        getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
      }))
    : new OfflineAgentDownlineAdapter();
  return {
    downlineRead: createAgentDownlineReadApplication(adapter),
    auditRead: createAgentAuditReadApplication(adapter),
  };
}

const { downlineRead, auditRead } = createAgentDownlinesApp({ useRemote: false });
export const agentDownlineReadApplication = downlineRead;
export const agentAuditReadApplication = auditRead;
