import { Value } from '@sinclair/typebox/value';
import {
  ApplyMockPaymentScenarioRequestSchema,
  CreateMockPaymentOrderRequestSchema,
  MockPaymentChannelSnapshotDtoSchema,
  MockPaymentEventDtoSchema,
  MockPaymentOrderDtoSchema,
  MockPaymentScenarioResultDtoSchema,
  MockPaymentScenario,
  type ApplyMockPaymentScenarioRequestDto,
  type CreateMockPaymentOrderRequestDto,
  type MockPaymentEventDto,
  type MockPaymentOrderDto,
  type MockPaymentChannelSnapshotDto,
  type MockPaymentScenarioResultDto,
} from '@gameing/contracts/mock-payment';
import {
  applyMockPaymentScenario,
  createPendingMockOrder,
  requestMatchesEvent,
  requestMatchesOrder,
  validateCnyAmount,
  type MockPaymentFailureCode,
  type MockPaymentResult,
} from './mock-payment-domain';

export interface MockPaymentRepositoryPort {
  listOrders(): Promise<MockPaymentOrderDto[]>;
  findOrder(orderId: string): Promise<MockPaymentOrderDto | null>;
  findOrderByRequestKey(requestKey: string): Promise<MockPaymentOrderDto | null>;
  saveOrder(order: MockPaymentOrderDto, requestKey: string): Promise<void>;
  listEvents(): Promise<MockPaymentEventDto[]>;
  findEventByRequestKey(requestKey: string): Promise<MockPaymentEventDto | null>;
  findSourceEvent(orderId: string): Promise<MockPaymentEventDto | null>;
  saveScenarioResult(result: MockPaymentScenarioResultDto): Promise<void>;
  createOrderId(): string;
  createEventId(): string;
  createProviderEventId(): string;
  now(): string;
}

export interface MockPaymentChannelReaderPort {
  findAvailableChannel(channelId: string): Promise<MockPaymentChannelSnapshotDto | null>;
}

function failure<T>(code: MockPaymentFailureCode): MockPaymentResult<T> {
  return { ok: false, code };
}

export interface MockPaymentApplication {
  listOrders(): Promise<MockPaymentResult<MockPaymentOrderDto[]>>;
  listEvents(): Promise<MockPaymentResult<MockPaymentEventDto[]>>;
  createOrder(request: CreateMockPaymentOrderRequestDto): Promise<MockPaymentResult<MockPaymentOrderDto>>;
  applyScenario(request: ApplyMockPaymentScenarioRequestDto): Promise<MockPaymentResult<MockPaymentScenarioResultDto>>;
}

export function createMockPaymentApplication(repository: MockPaymentRepositoryPort, channels: MockPaymentChannelReaderPort): MockPaymentApplication {
  return {
    async listOrders() {
      const orders = await repository.listOrders();
      return orders.every((order) => Value.Check(MockPaymentOrderDtoSchema, order))
        ? { ok: true, value: orders }
        : failure('INVALID_REQUEST');
    },

    async listEvents() {
      const events = await repository.listEvents();
      return events.every((event) => Value.Check(MockPaymentEventDtoSchema, event))
        ? { ok: true, value: events }
        : failure('INVALID_REQUEST');
    },

    async createOrder(request) {
      if (!Value.Check(CreateMockPaymentOrderRequestSchema, request)) return failure('INVALID_REQUEST');
      const amount = validateCnyAmount(request.amountCny);
      if (!amount.ok) return amount;
      const existing = await repository.findOrderByRequestKey(request.requestKey);
      if (existing) return requestMatchesOrder(amount.value, request.paymentChannelId, existing) ? { ok: true, value: existing } : failure('REQUEST_KEY_REUSED');
      const paymentChannel = await channels.findAvailableChannel(request.paymentChannelId);
      if (!paymentChannel || !Value.Check(MockPaymentChannelSnapshotDtoSchema, paymentChannel)) return failure('CHANNEL_UNAVAILABLE');
      const order = createPendingMockOrder(repository.createOrderId(), amount.value, paymentChannel, repository.now());
      if (!Value.Check(MockPaymentOrderDtoSchema, order)) return failure('INVALID_REQUEST');
      await repository.saveOrder(order, request.requestKey);
      return { ok: true, value: order };
    },

    async applyScenario(request) {
      if (!Value.Check(ApplyMockPaymentScenarioRequestSchema, request)) return failure('INVALID_REQUEST');
      const existingEvent = await repository.findEventByRequestKey(request.requestKey);
      if (existingEvent) {
        if (!requestMatchesEvent(request.orderId, request.scenario, existingEvent)) return failure('REQUEST_KEY_REUSED');
        const existingOrder = await repository.findOrder(existingEvent.orderId);
        return existingOrder ? { ok: true, value: { order: existingOrder, event: existingEvent } } : failure('ORDER_NOT_FOUND');
      }

      const order = await repository.findOrder(request.orderId);
      const sourceEvent = request.scenario === MockPaymentScenario.DUPLICATE ? await repository.findSourceEvent(request.orderId) : null;
      const result = applyMockPaymentScenario({
        order,
        scenario: request.scenario,
        requestKey: request.requestKey,
        eventId: repository.createEventId(),
        providerEventId: sourceEvent?.providerEventId ?? (request.scenario === MockPaymentScenario.DUPLICATE ? '' : repository.createProviderEventId()),
        createdAt: repository.now(),
      });
      if (!result.ok) return result;
      if (!Value.Check(MockPaymentScenarioResultDtoSchema, result.value)) return failure('INVALID_REQUEST');
      await repository.saveScenarioResult(result.value);
      return result;
    },
  };
}
