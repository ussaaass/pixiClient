import { createMockPaymentApplication } from './mock-payment-application';
import { OfflineMockPaymentAdapter } from './offline-mock-payment-adapter';
import { RemoteMockPaymentAdapter } from './remote-mock-payment-adapter.js';
import { localPaymentChannelApplication } from '../payment-channels/composition';
import { PaymentChannelStatus } from '@gameing/contracts/payment-channel';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;

const channelReader = {
  async findAvailableChannel(channelId: string) {
    const result = await localPaymentChannelApplication.list({ status: PaymentChannelStatus.ACTIVE });
    if (!result.ok) return null;
    const channel = result.value.items.find((item) => item.channelId === channelId);
    return channel ? {
      channelId: channel.channelId,
      providerCode: channel.providerCode,
      providerName: channel.providerName,
      paymentMethod: channel.paymentMethod,
    } : null;
  },
};

export function createMockPaymentApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  if (remote) {
    const client = new AdminApiClient({
      base: adminApiBase ?? '/admin-api/v1',
      getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
    });
    return createMockPaymentApplication(new RemoteMockPaymentAdapter(client), channelReader);
  }
  return createMockPaymentApplication(new OfflineMockPaymentAdapter(), channelReader);
}

export const localMockPaymentApplication = createMockPaymentApp({ useRemote: false });
