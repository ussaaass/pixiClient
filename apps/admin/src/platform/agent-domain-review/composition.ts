import { createAgentDomainReviewApplication, createLocalAgentDomainDemoApplication } from './agent-domain-review-application';
import { IndexedDbAgentDomainReviewAdapter } from './indexeddb-agent-domain-review-adapter';
import { RemoteAgentDomainReviewAdapter } from './remote-agent-domain-review-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAgentDomainReviewApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  const adapter = remote
    ? new RemoteAgentDomainReviewAdapter(new AdminApiClient({
        base: adminApiBase ?? '/admin-api/v1',
        getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
      }))
    : new IndexedDbAgentDomainReviewAdapter();
  return {
    ...createAgentDomainReviewApplication(adapter),
    ...createLocalAgentDomainDemoApplication(adapter),
  };
}

export const localAgentDomainReviewApplication = createAgentDomainReviewApp({ useRemote: false });
