import { createAdminReferralApplication } from './admin-referral-application';
import { createIndexedDbAdminReferralRepository } from './indexeddb-admin-referral-adapter';
import { RemoteAdminReferralAdapter } from './remote-admin-referral-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAdminReferralApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAdminReferralApplication(new RemoteAdminReferralAdapter(client));
  }
  return createAdminReferralApplication(createIndexedDbAdminReferralRepository());
}

export const localDemoAdminReferralApplication = createAdminReferralApp({ useRemote: false });
