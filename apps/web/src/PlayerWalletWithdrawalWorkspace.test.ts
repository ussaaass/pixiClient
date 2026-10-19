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
      turnoverRemaining: '0',
      availableCnyFen: '20000',
      onCompleted: completed,
    });
    app.mount(host);
    await waitFor(() => listPayoutAccounts.mock.calls.length > 0);
    host.querySelector<HTMLButtonElement>('.player-app-select-trigger')!.click();
    await nextTick();
    document.body.querySelector<HTMLButtonElement>('.player-app-select-menu [role="option"]')!.click();
    await setField(host.querySelector<HTMLInputElement>('.player-withdrawal-account-form input[placeholder="请输入收款人姓名"]')!, '演练账户');
    await setField(host.querySelector<HTMLInputElement>('.player-withdrawal-account-form input[placeholder="填写任意测试值，不要填真实账号"]')!, 'test-account-1234');
    host.querySelector<HTMLButtonElement>('.player-withdrawal-account-form button:not(.player-app-select-trigger)')!.click();
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

  it('shows the turnover restriction only after the final withdrawal submission check', async () => {
    host = document.createElement('div'); document.body.append(host);
    const payout = { payoutAccountId: '51', channelType: PayoutChannelType.ALIPAY, accountLabel: '演练收款方式', maskedAccount: '•••• 5678', isDefault: true, status: 1 as const, createdAt: '2026-10-17T00:00:00.000Z' };
    const quote = { payoutAccountId: '51', payoutAccountLabel: payout.accountLabel, maskedAccount: payout.maskedAccount, netCnyFen: '10000', feeCnyFen: '500', debitCnyFen: '10500', minimumNetCnyFen: '10000', feeRateBps: 500, payoutNotBeforeAt: '2026-10-20T00:00:00.000Z', quotedAt: '2026-10-17T00:00:00.000Z', expiresAt: '2026-10-17T00:01:00.000Z' };
    const createWithdrawal = vi.fn(async () => { throw Object.assign(new Error('TURNOVER_INCOMPLETE'), { code: 'TURNOVER_INCOMPLETE' }); });
    const manageAccounts = vi.fn();
    app = createApp(PlayerWalletWithdrawalWorkspace, {
      wallet: {
        getSummary: vi.fn(async () => ({ turnover: { remainingCoins: '2500', canTransferOrWithdraw: false } })),
        listPayoutAccounts: vi.fn(async () => [payout]), createPayoutAccount: vi.fn(), deletePayoutAccount: vi.fn(),
        quoteWithdrawal: vi.fn(async () => quote), listWithdrawals: vi.fn(async () => []), createWithdrawal,
        cancelWithdrawal: vi.fn(),
      } as unknown as WalletApplication,
      turnoverRemaining: '2500', availableCnyFen: '20000', view: 'withdraw', onManageAccounts: manageAccounts,
    });
    app.mount(host);
    await waitFor(() => host.querySelector<HTMLInputElement>('.player-withdrawal-recipient-fields label:first-child input')?.value === '支付宝');
    expect(host.querySelector<HTMLInputElement>('.player-withdrawal-recipient-fields label:first-child input')?.value).toBe('支付宝');
    expect(host.querySelector<HTMLInputElement>('.player-withdrawal-recipient-fields label:last-child input')?.value).toBe('演练收款方式');
    host.querySelector<HTMLButtonElement>('.player-withdrawal-common-picker')!.click();
    await waitFor(() => document.body.querySelector('[role="dialog"]') !== null);
    document.body.querySelector<HTMLButtonElement>('.player-withdrawal-manage-link')!.click();
    expect(manageAccounts).toHaveBeenCalledTimes(1);
    host.querySelector<HTMLButtonElement>('.player-withdrawal-common-picker')!.click();
    await waitFor(() => document.body.querySelector('.player-withdrawal-account-option') !== null);
    document.body.querySelector<HTMLButtonElement>('.player-withdrawal-account-option')!.click();
    expect(host.querySelector('.player-wallet-turnover')).toBeNull();
    expect(host.querySelector('.player-withdrawal-gate')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('.player-withdrawal-request input')?.disabled).toBe(false);
    await setField(host.querySelector<HTMLInputElement>('.player-withdrawal-request input')!, '100');
    host.querySelector<HTMLButtonElement>('.player-withdrawal-request button')!.click();
    await waitFor(() => host.querySelector('.player-withdrawal-quote') !== null);
    host.querySelector<HTMLButtonElement>('.player-withdrawal-confirm button:last-child')!.click();
    await waitFor(() => document.body.querySelector('[role="alertdialog"]') !== null);
    expect(createWithdrawal).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain('还差 2,500 金币');
  });
});

async function setField(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('UI state did not settle in time'); await new Promise((resolve) => setTimeout(resolve, 0)); }
}
