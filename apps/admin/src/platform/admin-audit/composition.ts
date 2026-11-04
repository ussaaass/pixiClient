import { createAdminAuditApplication } from './admin-audit-application';
import { IndexedDbAdminAuditAdapter } from './indexeddb-admin-audit-adapter';
import { RemoteAdminAuditAdapter } from './remote-admin-audit-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAdminAuditApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAdminAuditApplication(new RemoteAdminAuditAdapter(client));
  }
  return createAdminAuditApplication(new IndexedDbAdminAuditAdapter());
}

export const localAdminAuditApplication = createAdminAuditApp({ useRemote: false });
