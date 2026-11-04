import {
  type CreatePaymentChannelRequestDto,
  type PaymentChannelChangeDto,
  type PaymentChannelDto,
} from '@gameing/contracts/payment-channel';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { PaymentChannelRepositoryPort } from './payment-channel-application';

export class RemotePaymentChannelAdapter implements PaymentChannelRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listChannels(): Promise<PaymentChannelDto[]> {
    return this.client.get<PaymentChannelDto[]>('/payment-channels', { pageSize: 100 });
  }

  async findChannel(channelId: string): Promise<PaymentChannelDto | null> {
    try {
      return await this.client.get<PaymentChannelDto>(`/payment-channels/${encodeURIComponent(channelId)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findProviderByCode(providerCode: string) {
    try {
      const channels = await this.client.get<PaymentChannelDto[]>('/payment-channels/by-provider', { providerCode });
      const provider = channels.find((channel) => channel.providerCode === providerCode);
      return provider ? { providerCode: provider.providerCode, providerName: provider.providerName, providerType: provider.providerType } : null;
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findByProviderMethod(providerCode: string, paymentMethod: PaymentChannelDto['paymentMethod']): Promise<PaymentChannelDto | null> {
    try {
      const channels = await this.client.get<PaymentChannelDto[]>('/payment-channels/by-provider-method', { providerCode, paymentMethod });
      return channels[0] ?? null;
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findChangeByRequestKey(requestKey: string): Promise<PaymentChannelChangeDto | null> {
    try {
      return await this.client.get<PaymentChannelChangeDto>(`/payment-channels/changes/request/${encodeURIComponent(requestKey)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listChanges(channelId: string): Promise<PaymentChannelChangeDto[]> {
    return this.client.get<PaymentChannelChangeDto[]>(`/payment-channels/${encodeURIComponent(channelId)}/changes`);
  }

  async commit(channel: PaymentChannelDto, change: PaymentChannelChangeDto): Promise<void> {
    if (change.previous === null) {
      const request = {
        providerCode: change.next.providerCode,
        providerName: change.next.providerName,
        providerType: change.next.providerType,
        paymentMethod: change.next.paymentMethod,
        sortOrder: change.next.sortOrder,
        reason: change.reason,
        requestKey: change.requestKey,
      } satisfies CreatePaymentChannelRequestDto;
      await this.client.post('/payment-channels', request);
      return;
    }
    await this.client.patch(`/payment-channels/${encodeURIComponent(channel.channelId)}`, {
      providerName: channel.providerName,
      sortOrder: channel.sortOrder,
      status: channel.status,
      reason: change.reason,
      requestKey: change.requestKey,
    });
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-payment-change-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  createChannelId(): string {
    const random = new Uint32Array(1);
    globalThis.crypto.getRandomValues(random);
    return `${Date.now()}${String((random[0] ?? 1) % 1_000_000).padStart(6, '0')}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
