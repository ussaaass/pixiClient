import { createAnnouncementTemplateApplication } from './announcement-template-application';
import { IndexedDbAnnouncementTemplateAdapter } from './indexeddb-announcement-template-adapter';
import { RemoteAnnouncementTemplateAdapter } from './remote-announcement-template-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAnnouncementTemplateApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAnnouncementTemplateApplication(new RemoteAnnouncementTemplateAdapter(client));
  }
  return createAnnouncementTemplateApplication(new IndexedDbAnnouncementTemplateAdapter());
}

export const localAnnouncementTemplateApplication = createAnnouncementTemplateApp({ useRemote: false });
