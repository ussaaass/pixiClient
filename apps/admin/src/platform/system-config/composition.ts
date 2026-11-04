import { createSystemConfigApplication } from './system-config-application';
import { IndexedDbSystemConfigAdapter } from './indexeddb-system-config-adapter';
import { RemoteSystemConfigAdapter } from './remote-system-config-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createSystemConfigApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createSystemConfigApplication(new RemoteSystemConfigAdapter(client));
  }
  return createSystemConfigApplication(new IndexedDbSystemConfigAdapter());
}

export const localSystemConfigApplication = createSystemConfigApp({ useRemote: false });
