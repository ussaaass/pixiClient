import { createGameCatalogApplication } from './game-catalog-application';
import { IndexedDbGameCatalogAdapter } from './indexeddb-game-catalog-adapter';
import { RemoteGameCatalogAdapter } from './remote-game-catalog-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createGameCatalogApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createGameCatalogApplication(new RemoteGameCatalogAdapter(client));
  }
  return createGameCatalogApplication(new IndexedDbGameCatalogAdapter());
}

export const localGameCatalogApplication = createGameCatalogApp({ useRemote: false });
