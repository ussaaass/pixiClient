import { createSupportDeskApplication } from './support-desk-application';
import { IndexedDbSupportDeskAdapter } from './indexeddb-support-desk-adapter';
import { RemoteSupportDeskAdapter } from './remote-support-desk-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

function createSupportDeskRepository({ useRemote = false }: { useRemote?: boolean }) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return new RemoteSupportDeskAdapter(client);
  }
  return new IndexedDbSupportDeskAdapter();
}

export function createSupportDeskApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  return createSupportDeskApplication(createSupportDeskRepository({ useRemote }));
}

// 保持既有导出名（页面/路由不改动）：LOCAL_DEMO 默认入口，REMOTE 由环境变量/参数切换。
export const localSupportDeskApplication = createSupportDeskApp({ useRemote: false });
export const localSupportDeskAdapter = createSupportDeskRepository({ useRemote: false });
