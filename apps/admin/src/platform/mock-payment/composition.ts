import { createMockPaymentApplication } from './mock-payment-application';
import { OfflineMockPaymentAdapter } from './offline-mock-payment-adapter';
import { localPaymentChannelApplication } from '../payment-channels/composition';
import { PaymentChannelStatus } from '@gameing/contracts/payment-channel';

export const localMockPaymentApplication = createMockPaymentApplication(new OfflineMockPaymentAdapter(), {
  async findAvailableChannel(channelId) {
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
});
