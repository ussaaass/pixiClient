import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { FundingOrderStatus, FundingPaymentMethod, type SimulateFundingPaymentRequestDto } from '@gameing/contracts/wallet-funding';
import PlayerWalletFundingWorkspace from './components/PlayerWalletFundingWorkspace.vue';
import type { WalletFundingApplication } from './wallet-funding/wallet-funding-application';

describe('player wallet funding workspace', () => {
  let host: HTMLDivElement;
  let app: VueApp | undefined;
  afterEach(() => { app?.unmount(); app = undefined; host.remove(); });

  it('creates a recharge order, offers a local mock payment, and refreshes wallet after payment', async () => {
    host = document.createElement('div'); document.body.append(host);
    const order = { orderId: '88', orderNo: 'LG20261015000000000088', channelId: 'local-alipay', channelName: '支付宝 · 本机模拟', paymentMethod: FundingPaymentMethod.ALIPAY, amountCnyFen: '1000', creditCoins: '100', status: FundingOrderStatus.PENDING_PAYMENT, createdAt: '2026-10-15T00:00:00.000Z', paidAt: null, source: 'LOCAL_BROWSER_SERVER' as const };
    const listChannels = vi.fn(async () => [{ channelId: 'local-alipay', displayName: '支付宝 · 本机模拟', paymentMethod: FundingPaymentMethod.ALIPAY, sortOrder: 10, status: 1 as const }]);
    const listOrders = vi.fn(async () => [order]);
    const createOrder = vi.fn(async () => order);
    const simulatePayment = vi.fn(async (_input: SimulateFundingPaymentRequestDto) => ({ ...order, status: FundingOrderStatus.PAID, paidAt: '2026-10-15T00:00:01.000Z' }));
    const completed = vi.fn();
    app = createApp(PlayerWalletFundingWorkspace, { application: { listChannels, listOrders, createOrder, simulatePayment } as WalletFundingApplication, onCompleted: completed });
    app.mount(host);
    await waitFor(() => host.querySelector('.player-wallet-funding-form') !== null);

    const amount = host.querySelector<HTMLInputElement>('.player-wallet-funding-form input[placeholder="例如 10 或 10.50"]')!;
    amount.value = '10'; amount.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    host.querySelector<HTMLButtonElement>('.player-wallet-funding-form button[type="submit"]')!.click();
    await waitFor(() => createOrder.mock.calls.length === 1);
    expect(createOrder).toHaveBeenCalledWith({ channelId: 'local-alipay', amountCnyFen: '1000', idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await waitFor(() => host.textContent?.includes('支付成功后将入账 100 金币') === true);
    expect(host.textContent).toContain('支付成功后将入账 100 金币');

    await waitFor(() => host.querySelector('.player-wallet-simulate-payment') !== null);
    host.querySelector<HTMLButtonElement>('.player-wallet-simulate-payment')!.click();
    await waitFor(() => completed.mock.calls.length === 1);
    expect(simulatePayment).toHaveBeenCalledWith({ orderId: '88', paidAmountCnyFen: '1000', paymentEventId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('100 金币已写入本地账本');
  });

  it('shows the unique USDT invoice window and submits its exact local mock amount', async () => {
    host = document.createElement('div'); document.body.append(host);
    const order = {
      orderId: '89', orderNo: 'LG20261015000000000089', channelId: 'local-usdt-tron', channelName: 'USDT · TRON/TRC-20 本机演练',
      paymentMethod: FundingPaymentMethod.USDT_TRON, amountCnyFen: '10000', creditCoins: '1000', status: FundingOrderStatus.PENDING_PAYMENT,
      createdAt: '2026-10-15T00:00:00.000Z', paidAt: null,
      usdtInvoice: { amountUsdtMilli: '14910', displayAmountUsdt: '14.910', rateCnyPerUsdt: '6.7', depositAddress: 'LOCAL-TRON-NOT-AN-ADDRESS-89', expiresAt: '2026-10-15T00:15:00.000Z' },
    };
    const channels = [
      { channelId: 'local-alipay', displayName: '支付宝 · 本机模拟', paymentMethod: FundingPaymentMethod.ALIPAY, sortOrder: 10, status: 1 as const },
      { channelId: 'local-usdt-tron', displayName: order.channelName, paymentMethod: FundingPaymentMethod.USDT_TRON, sortOrder: 60, status: 1 as const },
    ];
    const listChannels = vi.fn(async () => channels);
    const listOrders = vi.fn(async () => [order]);
    const createOrder = vi.fn(async () => order);
    const simulatePayment = vi.fn(async (_input: SimulateFundingPaymentRequestDto) => ({ ...order, status: FundingOrderStatus.PAID, paidAt: '2026-10-15T00:00:01.000Z' }));
    const completed = vi.fn();
    app = createApp(PlayerWalletFundingWorkspace, { application: { listChannels, listOrders, createOrder, simulatePayment } as WalletFundingApplication, onCompleted: completed });
    app.mount(host);
    await waitFor(() => host.querySelector('.player-wallet-funding-form') !== null);
    host.querySelector<HTMLInputElement>('.player-wallet-channel-picker input[value="local-usdt-tron"]')!.click(); await nextTick();
    const amount = host.querySelector<HTMLInputElement>('.player-wallet-funding-form input[placeholder="例如 10 或 10.50"]')!;
    amount.value = '100'; amount.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    host.querySelector<HTMLButtonElement>('.player-wallet-funding-form button[type="submit"]')!.click();
    await waitFor(() => createOrder.mock.calls.length === 1);
    expect(createOrder).toHaveBeenCalledWith({ channelId: 'local-usdt-tron', amountCnyFen: '10000', idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await waitFor(() => host.textContent?.includes('订单已创建') === true && !host.textContent?.includes('正在读取支付方式和订单…'));
    expect(host.querySelector('.player-wallet-order-main')?.textContent).toContain('14.910 USDT');
    expect(host.textContent).toContain('本机演练标识，非 TRON 地址');
    expect(host.textContent).toContain('错额或超时请联系客服');
    expect(host.textContent).toContain('本机模拟链上到账');
    host.querySelector<HTMLButtonElement>('.player-wallet-simulate-payment')!.click();
    await waitFor(() => completed.mock.calls.length === 1);
    expect(simulatePayment).toHaveBeenCalledWith({ orderId: '89', paidAmountUsdtMilli: '14910', paymentEventId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('provides a direct customer-service path for an expired USDT order', async () => {
    host = document.createElement('div'); document.body.append(host);
    const order = {
      orderId: '90', orderNo: 'LG20261015000000000090', channelId: 'local-usdt-tron', channelName: 'USDT · TRON/TRC-20 本机演练',
      paymentMethod: FundingPaymentMethod.USDT_TRON, amountCnyFen: '10000', creditCoins: '1000', status: FundingOrderStatus.EXPIRED,
      createdAt: '2026-10-15T00:00:00.000Z', paidAt: null,
      usdtInvoice: { amountUsdtMilli: '14910', displayAmountUsdt: '14.910', rateCnyPerUsdt: '6.7', depositAddress: 'LOCAL-TRON-NOT-AN-ADDRESS-90', expiresAt: '2026-10-15T00:15:00.000Z' },
    };
    const contactSupport = vi.fn();
    app = createApp(PlayerWalletFundingWorkspace, { application: { listChannels: async () => [], listOrders: async () => [order], createOrder: vi.fn(), simulatePayment: vi.fn() } as WalletFundingApplication, onContactSupport: contactSupport });
    app.mount(host);
    await waitFor(() => host.querySelector<HTMLButtonElement>('button.player-wallet-simulate-payment') !== null);
    host.querySelector<HTMLButtonElement>('button.player-wallet-simulate-payment')!.click();
    expect(contactSupport).toHaveBeenCalledOnce();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('UI state did not settle in time'); await new Promise((resolve) => setTimeout(resolve, 0)); }
}
