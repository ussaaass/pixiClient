import { describe, expect, it } from 'vitest';
import { MockPaymentEventOutcome, MockPaymentOrderStatus, MockPaymentScenario } from '@gameing/contracts/mock-payment';
import { createMockPaymentApplication } from './mock-payment-application';
import { OfflineMockPaymentAdapter } from './offline-mock-payment-adapter';

function setup() {
  const adapter = new OfflineMockPaymentAdapter();
  const channelSnapshots = {
    '1': { channelId: '1', providerCode: 'mock_agg', providerName: 'Mock Aggregator', paymentMethod: 1 },
    '2': { channelId: '2', providerCode: 'mock_agg_2', providerName: 'Second Aggregator', paymentMethod: 2 },
  } as const;
  return { adapter, application: createMockPaymentApplication(adapter, { async findAvailableChannel(id) { return channelSnapshots[id as keyof typeof channelSnapshots] ?? null; } }) };
}

const createOrderRequest = (amountCny: string, requestKey: string, paymentChannelId = '1') => ({ amountCny, paymentChannelId, requestKey });

describe('LOCAL_DEMO Mock Payment use cases', () => {
  it('creates a local-only test order and rejects invalid money strings', async () => {
    const { application } = setup();
    expect(await application.createOrder(createOrderRequest('0.00', 'order-invalid'))).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    expect(await application.createOrder(createOrderRequest('200', 'order-invalid-2'))).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    expect(await application.createOrder(createOrderRequest('200.00', 'order-no-channel', '9'))).toMatchObject({ ok: false, code: 'CHANNEL_UNAVAILABLE' });
    const order = await application.createOrder(createOrderRequest('200.00', 'order-valid'));
    expect(order).toMatchObject({ ok: true, value: { orderId: 'LOCAL-MOCK-000001', amountCny: '200.00', paymentChannel: { channelId: '1', providerName: 'Mock Aggregator' }, status: MockPaymentOrderStatus.PENDING, source: 'LOCAL_DEMO' } });
  });

  it('binds an order to one immutable channel snapshot and rejects changed-channel idempotent replay', async () => {
    const { application } = setup();
    const initial = await application.createOrder(createOrderRequest('20.00', 'same-request'));
    expect(initial.ok).toBe(true);
    expect(await application.createOrder(createOrderRequest('20.00', 'same-request', '2'))).toMatchObject({ ok: false, code: 'REQUEST_KEY_REUSED' });
  });

  it('models success, idempotent provider replay, and duplicate request rejection without external settlement', async () => {
    const { application, adapter } = setup();
    const order = await application.createOrder(createOrderRequest('200.00', 'order-1'));
    if (!order.ok) throw new Error('expected test order');
    const request = { orderId: order.value.orderId, scenario: MockPaymentScenario.SUCCESS, requestKey: 'scenario-success' } as const;
    const first = await application.applyScenario(request);
    const replay = await application.applyScenario(request);
    expect(first).toMatchObject({ ok: true, value: { order: { status: MockPaymentOrderStatus.SIMULATED_SUCCESS, source: 'LOCAL_DEMO' }, event: { outcome: MockPaymentEventOutcome.APPLIED_TO_LOCAL_ORDER, source: 'LOCAL_DEMO' } } });
    expect(replay).toEqual(first);
    expect(await adapter.listEvents()).toHaveLength(1);
    expect(await application.applyScenario({ ...request, requestKey: 'scenario-other' })).toMatchObject({ ok: false, code: 'ORDER_TERMINAL' });
  });

  it('replays the original provider event ID once and prevents another state transition', async () => {
    const { application } = setup();
    const order = await application.createOrder(createOrderRequest('12.50', 'order-2'));
    if (!order.ok) throw new Error('expected test order');
    await application.applyScenario({ orderId: order.value.orderId, scenario: MockPaymentScenario.SUCCESS, requestKey: 'success-2' });
    const duplicate = await application.applyScenario({ orderId: order.value.orderId, scenario: MockPaymentScenario.DUPLICATE, requestKey: 'duplicate-2' });
    expect(duplicate).toMatchObject({ ok: true, value: { order: { status: MockPaymentOrderStatus.SIMULATED_SUCCESS }, event: { outcome: MockPaymentEventOutcome.DUPLICATE_IGNORED } } });
    if (!duplicate.ok) throw new Error('expected duplicate event');
    const events = await application.listEvents();
    expect(events.ok && events.value[0]?.providerEventId).toBe(duplicate.value.event.providerEventId);
    expect(events.ok && events.value).toHaveLength(2);
  });

  it('records an amount mismatch as review and cannot convert it into a simulated success', async () => {
    const { application } = setup();
    const order = await application.createOrder(createOrderRequest('25.00', 'order-3'));
    if (!order.ok) throw new Error('expected test order');
    const mismatch = await application.applyScenario({ orderId: order.value.orderId, scenario: MockPaymentScenario.AMOUNT_MISMATCH, requestKey: 'mismatch-3' });
    expect(mismatch).toMatchObject({ ok: true, value: { order: { status: MockPaymentOrderStatus.REVIEW_REQUIRED }, event: { outcome: MockPaymentEventOutcome.REVIEW_REQUIRED, receivedAmountCny: '25.01' } } });
    expect(await application.applyScenario({ orderId: order.value.orderId, scenario: MockPaymentScenario.SUCCESS, requestKey: 'success-after-mismatch' })).toMatchObject({ ok: false, code: 'ORDER_TERMINAL' });
  });

  it('allows failure and timeout as distinct local terminal outcomes', async () => {
    for (const [scenario, expected] of [[MockPaymentScenario.FAILURE, MockPaymentOrderStatus.SIMULATED_FAILURE], [MockPaymentScenario.TIMEOUT, MockPaymentOrderStatus.SIMULATED_TIMEOUT]] as const) {
      const { application } = setup();
      const order = await application.createOrder(createOrderRequest('9.99', `order-${scenario}`));
      if (!order.ok) throw new Error('expected test order');
      expect(await application.applyScenario({ orderId: order.value.orderId, scenario, requestKey: `event-${scenario}` })).toMatchObject({ ok: true, value: { order: { status: expected }, event: { source: 'LOCAL_DEMO' } } });
    }
  });
});
