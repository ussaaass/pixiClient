import type { PaymentChannelChangeDto, PaymentChannelDto } from '@gameing/contracts/payment-channel';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { PaymentChannelRepositoryPort } from './payment-channel-application';

export class IndexedDbPaymentChannelAdapter implements PaymentChannelRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | undefined;

  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async listChannels(): Promise<PaymentChannelDto[]> {
    return (await this.database()).getAll('payment_channel_items');
  }

  async findChannel(channelId: string): Promise<PaymentChannelDto | null> {
    return (await (await this.database()).get('payment_channel_items', channelId)) ?? null;
  }

  async findProviderByCode(providerCode: string): Promise<Pick<PaymentChannelDto, 'providerCode' | 'providerName' | 'providerType'> | null> {
    const channels = await (await this.database()).getAll('payment_channel_items');
    const provider = channels.find((channel) => channel.providerCode === providerCode);
    return provider ? { providerCode: provider.providerCode, providerName: provider.providerName, providerType: provider.providerType } : null;
  }

  async findByProviderMethod(providerCode: string, paymentMethod: PaymentChannelDto['paymentMethod']): Promise<PaymentChannelDto | null> {
    return (await (await this.database()).getFromIndex('payment_channel_items', 'by-provider-method', [providerCode, paymentMethod])) ?? null;
  }

  async findChangeByRequestKey(requestKey: string): Promise<PaymentChannelChangeDto | null> {
    return (await (await this.database()).getFromIndex('payment_channel_change_snapshots', 'by-request-key', requestKey)) ?? null;
  }

  async listChanges(channelId: string): Promise<PaymentChannelChangeDto[]> {
    const changes = await (await this.database()).getAllFromIndex('payment_channel_change_snapshots', 'by-channel-created', IDBKeyRange.bound([channelId, ''], [channelId, '\uffff']));
    return changes.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async commit(channel: PaymentChannelDto, change: PaymentChannelChangeDto): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(['payment_channel_items', 'payment_channel_change_snapshots'], 'readwrite');
    const completed = transaction.done;
    try {
      await Promise.all([
        change.previous === null ? transaction.objectStore('payment_channel_items').add({ ...channel }) : transaction.objectStore('payment_channel_items').put({ ...channel }),
        transaction.objectStore('payment_channel_change_snapshots').add({ ...change }),
      ]);
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-payment-channel-change-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  createChannelId(): string {
    const random = new Uint32Array(1);
    globalThis.crypto.getRandomValues(random);
    return `${Date.now()}${String((random[0] ?? 1) % 1000000).padStart(6, '0')}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  async close(): Promise<void> {
    const database = this.databasePromise;
    this.databasePromise = undefined;
    if (database) (await database).close();
  }

  private database(): ReturnType<typeof openAdminDevelopmentDatabase> {
    this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName);
    return this.databasePromise;
  }
}
