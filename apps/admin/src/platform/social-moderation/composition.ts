import { createSocialModerationApplication } from './social-moderation-application';
import { IndexedDbSocialModerationAdapter } from './indexeddb-social-moderation-adapter';
import { RemoteSocialModerationAdapter } from './remote-social-moderation-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

function createSocialModerationRepository({ useRemote = false }: { useRemote?: boolean }) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return new RemoteSocialModerationAdapter(client);
  }
  return new IndexedDbSocialModerationAdapter();
}

export function createSocialModerationApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  return createSocialModerationApplication(createSocialModerationRepository({ useRemote }));
}

// 保持既有导出名（页面/路由不改动）：LOCAL_DEMO 默认入口，REMOTE 由环境变量/参数切换。
export const localSocialModerationApplication = createSocialModerationApp({ useRemote: false });
export const localSocialModerationAdapter = createSocialModerationRepository({ useRemote: false });
