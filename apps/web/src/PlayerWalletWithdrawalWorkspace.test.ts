import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { PayoutChannelType, WithdrawalStatus } from '@gameing/contracts/wallet';
import PlayerWalletWithdrawalWorkspace from './components/PlayerWalletWithdrawalWorkspace.vue';
import type { WalletApplication } from './platform/wallet/wallet-application';

describe('player wallet withdrawal workspace', () => {
  let host: HTMLDivElement;
  let app: VueApp | undefined;

  afterEach(() => { app?.unmount(); app = undefined; host.remove(); });

  it('adds a masked demo payout account, confirms a fee quote, and can cancel a held request', async () => {
    host = document.createElement('div'); document.body.append(host);
    const createdAt = '2026-10-15T00:00:00.000Z';
    const payout = { payoutAccountId: '41', channelType: PayoutChannelType.ALIPAY, accountLabel: '支付宝 · 演练账户', maskedAccount: '•••• 1234', isDefault: true, status: 1 as const, createdAt };
    const quote = { payoutAccountId: '41', payoutAccountLabel: payout.accountLabel, maskedAccount: payout.maskedAccount, netCnyFen: '10000', feeCnyFen: '500', debitCnyFen: '10500', minimumNetCnyFen: '10000', feeRateBps: 500, payoutNotBeforeAt: '2026-10-18T00:00:00.000Z', quotedAt: createdAt, expiresAt: '2026-10-15T00:01:00.000Z' };
    const withdrawal = { withdrawalId: '42', payoutAccountId: '41', payoutAccountLabel: payout.accountLabel, maskedAccount: payout.maskedAccount, netCnyFen: '10000', feeCnyFen: '500', debitCnyFen: '10500', status: WithdrawalStatus.REQUESTED, payoutNotBeforeAt: quote.payoutNotBeforeAt, createdAt };
    const listPayoutAccounts = vi.fn(async () => [payout]);
    const createPayoutAccount = vi.fn(async () => payout);
    const quoteWithdrawal = vi.fn(async () => quote);
    const createWithdrawal = vi.fn(async () => withdrawal);
    const cancelWithdrawal = vi.fn(async () => ({ ...withdrawal, status: WithdrawalStatus.CANCELLED }));
    const listWithdrawals = vi.fn(async () => [withdrawal]);
    const completed = vi.fn();
    app = createApp(PlayerWalletWithdrawalWorkspace, {
      wallet: { listPayoutAccounts, createPayoutAccount, deletePayoutAccount: vi.fn(), quoteWithdrawal, listWithdrawals, createWithdrawal, cancelWithdrawal } as unknown as WalletApplication,
      canWithdraw: true,
      turnoverRemaining: '0',
      availableCnyFen: '20000',
      onCompleted: completed,
    });
    app.mount(host);
    await waitFor(() => listPayoutAccounts.mock.calls.length > 0);
    await setField(host.querySelector<HTMLInputElement>('.player-withdrawal-account-form input[placeholder="例如：我的支付宝"]')!, '演练账户');
    await setField(host.querySelector<HTMLInputElement>('.player-withdrawal-account-form input[placeholder="例如 test-account-1234"]')!, 'test-account-1234');
    host.querySelector<HTMLButtonElement>('.player-withdrawal-account-form button')!.click();
    await waitFor(() => createPayoutAccount.mock.calls.length === 1);
    await waitFor(() => host.querySelector('.player-withdrawal-accounts li') !== null);
    expect(createPayoutAccount).toHaveBeenCalledWith(expect.objectContaining({ channelType: PayoutChannelType.ALIPAY, accountReference: 'test-account-1234' }));

    await setField(host.querySelector<HTMLInputElement>('.player-withdrawal-request input')!, '100');
    host.querySelector<HTMLButtonElement>('.player-withdrawal-request button')!.click();
    await waitFor(() => host.querySelector('.player-withdrawal-quote') !== null);
    expect(quoteWithdrawal).toHaveBeenCalledWith({ payoutAccountId: '41', netCnyFen: '10000' });
    expect(host.querySelector('.player-withdrawal-quote')?.textContent).toContain('冻结总额¥105.00');
    host.querySelector<HTMLButtonElement>('.player-withdrawal-confirm button:last-child')!.click();
    await waitFor(() => createWithdrawal.mock.calls.length === 1);
    await waitFor(() => host.querySelector('.player-withdrawal-history button') !== null);
    expect(createWithdrawal).toHaveBeenCalledWith(expect.objectContaining({ quote, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }));
    await waitFor(() => !host.querySelector<HTMLButtonElement>('.player-withdrawal-history button')!.disabled);
    host.querySelector<HTMLButtonElement>('.player-withdrawal-history button')!.click();
    await waitFor(() => cancelWithdrawal.mock.calls.length === 1);
    await waitFor(() => completed.mock.calls.length === 2);
    expect(cancelWithdrawal).toHaveBeenCalledWith('42');
    expect(completed).toHaveBeenCalledTimes(2);
  });
});

async function setField(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('UI state did not settle in time'); await new Promise((resolve) => setTimeout(resolve, 0)); }
}
