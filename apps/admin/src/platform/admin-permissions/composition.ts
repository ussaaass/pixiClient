import { createAdminPermissionApplication } from './admin-permission-application';
import { IndexedDbAdminPermissionAdapter } from './indexeddb-admin-permission-adapter';
import { RemoteAdminPermissionAdapter } from './remote-admin-permission-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAdminPermissionApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAdminPermissionApplication(new RemoteAdminPermissionAdapter(client));
  }
  return createAdminPermissionApplication(new IndexedDbAdminPermissionAdapter());
}

export const localAdminPermissionApplication = createAdminPermissionApp({ useRemote: false });
