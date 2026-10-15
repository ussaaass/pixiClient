import {
  MockPaymentEventOutcome,
  type MockPaymentEventDto,
  type MockPaymentOrderDto,
  type MockPaymentScenarioResultDto,
} from '@gameing/contracts/mock-payment';
import type { MockPaymentRepositoryPort } from './mock-payment-application';

/** Volatile LOCAL_DEMO store. It never calls a provider, wallet, payment API, or persistent storage. */
export class OfflineMockPaymentAdapter implements MockPaymentRepositoryPort {
  private readonly orders = new Map<string, MockPaymentOrderDto>();
  private readonly orderRequestKeys = new Map<string, string>();
  private readonly events: MockPaymentEventDto[] = [];
  private readonly eventRequestKeys = new Map<string, MockPaymentEventDto>();
  private orderSequence = 0;
  private eventSequence = 0;
  private providerEventSequence = 0;

  async listOrders(): Promise<MockPaymentOrderDto[]> {
    return [...this.orders.values()].map((order) => ({ ...order }));
  }

  async findOrder(orderId: string): Promise<MockPaymentOrderDto | null> {
    const order = this.orders.get(orderId);
    return order ? { ...order } : null;
  }

  async findOrderByRequestKey(requestKey: string): Promise<MockPaymentOrderDto | null> {
    const orderId = this.orderRequestKeys.get(requestKey);
    return orderId ? this.findOrder(orderId) : null;
  }

  async saveOrder(order: MockPaymentOrderDto, requestKey: string): Promise<void> {
    this.orders.set(order.orderId, { ...order });
    this.orderRequestKeys.set(requestKey, order.orderId);
  }

  async listEvents(): Promise<MockPaymentEventDto[]> {
    return this.events.map((event) => ({ ...event }));
  }

  async findEventByRequestKey(requestKey: string): Promise<MockPaymentEventDto | null> {
    const event = this.eventRequestKeys.get(requestKey);
    return event ? { ...event } : null;
  }

  async findSourceEvent(orderId: string): Promise<MockPaymentEventDto | null> {
    const event = [...this.events].reverse().find((item) => item.orderId === orderId && item.outcome !== MockPaymentEventOutcome.DUPLICATE_IGNORED);
    return event ? { ...event } : null;
  }

  async saveScenarioResult(result: MockPaymentScenarioResultDto): Promise<void> {
    this.orders.set(result.order.orderId, { ...result.order });
    this.events.push({ ...result.event });
    this.eventRequestKeys.set(result.event.requestKey, { ...result.event });
  }

  createOrderId(): string {
    this.orderSequence += 1;
    return `LOCAL-MOCK-${String(this.orderSequence).padStart(6, '0')}`;
  }

  createEventId(): string {
    this.eventSequence += 1;
    return `LOCAL-EVENT-${String(this.eventSequence).padStart(6, '0')}`;
  }

  createProviderEventId(): string {
    this.providerEventSequence += 1;
    return `LOCAL-PROVIDER-${String(this.providerEventSequence).padStart(6, '0')}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
