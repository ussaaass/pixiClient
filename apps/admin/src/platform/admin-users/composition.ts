import { createAdminUserApplication } from './admin-user-application';
import { LocalDemoAdminUserAdapter } from './local-demo-admin-user-adapter';
import { RemoteAdminUserAdapter } from './remote-admin-user-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

export function createAdminUserApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createAdminUserApplication(new RemoteAdminUserAdapter(client));
  }
  return createAdminUserApplication(new LocalDemoAdminUserAdapter());
}

// 保持既有导出名（页面/路由不改动）：LOCAL_DEMO 默认入口，REMOTE 由环境变量/参数切换。
export const localDemoAdminUserApplication = createAdminUserApp({ useRemote: false });
