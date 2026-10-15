import {
  MockPaymentEventOutcome,
  MockPaymentOrderStatus,
  MockPaymentScenario,
  type MockPaymentEventDto,
  type MockPaymentChannelSnapshotDto,
  type MockPaymentOrderDto,
  type MockPaymentScenarioResultDto,
} from '@gameing/contracts/mock-payment';

export type MockPaymentScenarioValue = typeof MockPaymentScenario[keyof typeof MockPaymentScenario];
export type MockPaymentFailureCode = 'INVALID_REQUEST' | 'INVALID_AMOUNT' | 'CHANNEL_UNAVAILABLE' | 'ORDER_NOT_FOUND' | 'ORDER_TERMINAL' | 'DUPLICATE_SOURCE_MISSING' | 'REQUEST_KEY_REUSED';
export type MockPaymentResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: MockPaymentFailureCode };

const failure = <T>(code: MockPaymentFailureCode): MockPaymentResult<T> => ({ ok: false, code });

export function validateCnyAmount(raw: string): MockPaymentResult<string> {
  if (!/^(0|[1-9][0-9]{0,6})\.[0-9]{2}$/.test(raw)) return failure('INVALID_AMOUNT');
  const cents = toCents(raw);
  if (cents <= 0 || cents > 100_000_000) return failure('INVALID_AMOUNT');
  return { ok: true, value: raw };
}

export function toCents(amount: string): number {
  const [whole, fraction] = amount.split('.');
  return Number(whole) * 100 + Number(fraction);
}

export function fromCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function createPendingMockOrder(orderId: string, amountCny: string, paymentChannel: MockPaymentChannelSnapshotDto, createdAt: string): MockPaymentOrderDto {
  return { orderId, amountCny, paymentChannel: { ...paymentChannel }, status: MockPaymentOrderStatus.PENDING, source: 'LOCAL_DEMO', createdAt };
}

export function applyMockPaymentScenario(input: {
  order: MockPaymentOrderDto | null;
  scenario: MockPaymentScenarioValue;
  requestKey: string;
  eventId: string;
  providerEventId: string;
  createdAt: string;
}): MockPaymentResult<MockPaymentScenarioResultDto> {
  const { order, scenario, requestKey, eventId, providerEventId, createdAt } = input;
  if (!order) return failure('ORDER_NOT_FOUND');
  const baseEvent: Omit<MockPaymentEventDto, 'outcome' | 'receivedAmountCny' | 'message'> = {
    eventId,
    providerEventId,
    orderId: order.orderId,
    requestKey,
    scenario,
    source: 'LOCAL_DEMO',
    createdAt,
  };

  if (scenario === MockPaymentScenario.DUPLICATE) {
    if (!providerEventId) return failure('DUPLICATE_SOURCE_MISSING');
    const event: MockPaymentEventDto = {
      ...baseEvent,
      outcome: MockPaymentEventOutcome.DUPLICATE_IGNORED,
      receivedAmountCny: order.amountCny,
      message: '重复 provider event 已忽略；只记录本机模拟事件，不重复处理订单。',
    };
    return { ok: true, value: { order, event } };
  }

  if (order.status !== MockPaymentOrderStatus.PENDING) return failure('ORDER_TERMINAL');

  if (scenario === MockPaymentScenario.AMOUNT_MISMATCH) {
    const receivedAmountCny = fromCents(toCents(order.amountCny) + 1);
    const event: MockPaymentEventDto = {
      ...baseEvent,
      outcome: MockPaymentEventOutcome.REVIEW_REQUIRED,
      receivedAmountCny,
      message: `模拟实收 ¥${receivedAmountCny} 与订单金额 ¥${order.amountCny} 不符；进入本机异常复核态，不产生资产履约。`,
    };
    return { ok: true, value: { order: { ...order, status: MockPaymentOrderStatus.REVIEW_REQUIRED }, event } };
  }

  const transition = {
    [MockPaymentScenario.SUCCESS]: { status: MockPaymentOrderStatus.SIMULATED_SUCCESS, message: '本机模拟成功回调已通过场景 handler；没有调用支付渠道或钱包。' },
    [MockPaymentScenario.FAILURE]: { status: MockPaymentOrderStatus.SIMULATED_FAILURE, message: '本机模拟失败回调已记录；没有调用支付渠道或钱包。' },
    [MockPaymentScenario.TIMEOUT]: { status: MockPaymentOrderStatus.SIMULATED_TIMEOUT, message: '本机模拟超时已记录；不能据此推断支付成功。' },
  }[scenario];

  const event: MockPaymentEventDto = {
    ...baseEvent,
    outcome: MockPaymentEventOutcome.APPLIED_TO_LOCAL_ORDER,
    receivedAmountCny: order.amountCny,
    message: transition.message,
  };
  return { ok: true, value: { order: { ...order, status: transition.status }, event } };
}

export function requestMatchesOrder(amountCny: string, paymentChannelId: string, existing: MockPaymentOrderDto): boolean {
  return amountCny === existing.amountCny && paymentChannelId === existing.paymentChannel.channelId;
}

export function requestMatchesEvent(orderId: string, scenario: MockPaymentScenarioValue, existing: MockPaymentEventDto): boolean {
  return existing.orderId === orderId && existing.scenario === scenario;
}

