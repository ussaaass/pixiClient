import { createAdminGameOperationsApplication } from './admin-game-operations-application';
import { LocalDemoAdminGameOperationsAdapter } from './local-demo-admin-game-operations-adapter';
import { RemoteAdminGameOperationsAdapter } from './remote-admin-game-operations-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAdminGameOperationsApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAdminGameOperationsApplication(new RemoteAdminGameOperationsAdapter(client));
  }
  return createAdminGameOperationsApplication(new LocalDemoAdminGameOperationsAdapter());
}

export const localDemoAdminGameOperationsApplication = createAdminGameOperationsApp({ useRemote: false });
