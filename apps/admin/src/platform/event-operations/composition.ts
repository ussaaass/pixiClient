import { createAdminEventOperationsApplication } from './event-operations-application';
import { IndexedDbAdminEventWorkspaceAdapter } from './indexeddb-event-operations-adapter';
import { RemoteEventOperationsAdapter } from './remote-event-operations-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAdminEventOperationsApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAdminEventOperationsApplication(new RemoteEventOperationsAdapter(client));
  }
  return createAdminEventOperationsApplication(new IndexedDbAdminEventWorkspaceAdapter());
}

export const localAdminEventOperations = createAdminEventOperationsApp({ useRemote: false });
