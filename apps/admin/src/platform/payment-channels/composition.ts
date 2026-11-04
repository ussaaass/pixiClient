import { IndexedDbPaymentChannelAdapter } from './indexeddb-payment-channel-adapter';
import { RemotePaymentChannelAdapter } from './remote-payment-channel-adapter.js';
import { createPaymentChannelApplication } from './payment-channel-application';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

function createPaymentChannelRepository({ useRemote = false }: { useRemote?: boolean }) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return new RemotePaymentChannelAdapter(client);
  }
  return new IndexedDbPaymentChannelAdapter();
}

export function createPaymentChannelApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  return createPaymentChannelApplication(createPaymentChannelRepository({ useRemote }));
}

// 保持既有导出名（页面/路由不改动）：LOCAL_DEMO 默认入口，REMOTE 由环境变量/参数切换。
export const localPaymentChannelAdapter = createPaymentChannelRepository({ useRemote: false });
export const localPaymentChannelApplication = createPaymentChannelApplication(localPaymentChannelAdapter);
