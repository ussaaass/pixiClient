import {
  type MockPaymentEventDto,
  type MockPaymentOrderDto,
  type MockPaymentScenarioResultDto,
} from '@gameing/contracts/mock-payment';
import { AdminApiClient } from '../admin-api-client.js';
import type { MockPaymentRepositoryPort } from './mock-payment-application';

export class RemoteMockPaymentAdapter implements MockPaymentRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listOrders(): Promise<MockPaymentOrderDto[]> {
    return this.client.get<MockPaymentOrderDto[]>('/mock-payment/orders', { pageSize: 100 });
  }

  async findOrder(orderId: string): Promise<MockPaymentOrderDto | null> {
    return this.client.get<MockPaymentOrderDto | null>(`/mock-payment/orders/${encodeURIComponent(orderId)}`);
  }

  async findOrderByRequestKey(requestKey: string): Promise<MockPaymentOrderDto | null> {
    return this.client.get<MockPaymentOrderDto | null>('/mock-payment/orders/by-request-key', { requestKey });
  }

  async saveOrder(order: MockPaymentOrderDto, requestKey: string): Promise<void> {
    await this.client.post('/mock-payment/orders', { order, requestKey });
  }

  async listEvents(): Promise<MockPaymentEventDto[]> {
    return this.client.get<MockPaymentEventDto[]>('/mock-payment/events', { pageSize: 100 });
  }

  async findEventByRequestKey(requestKey: string): Promise<MockPaymentEventDto | null> {
    return this.client.get<MockPaymentEventDto | null>('/mock-payment/events/by-request-key', { requestKey });
  }

  async findSourceEvent(orderId: string): Promise<MockPaymentEventDto | null> {
    return this.client.get<MockPaymentEventDto | null>(`/mock-payment/orders/${encodeURIComponent(orderId)}/source-event`);
  }

  async saveScenarioResult(result: MockPaymentScenarioResultDto): Promise<void> {
    await this.client.post('/mock-payment/scenarios', result);
  }

  createOrderId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-mock-order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  createEventId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-mock-event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  createProviderEventId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-mock-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
