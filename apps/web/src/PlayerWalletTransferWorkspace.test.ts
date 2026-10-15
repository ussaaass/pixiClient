import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import PlayerWalletTransferWorkspace from './components/PlayerWalletTransferWorkspace.vue';
import type { WalletApplication } from './platform/wallet/wallet-application';
import type { SocialFriendsApplication } from './platform/social/friends-application';

describe('player wallet transfer workspace', () => {
  let host: HTMLDivElement;
  let app: VueApp | undefined;

  afterEach(() => { app?.unmount(); app = undefined; host.remove(); });

  it('finds by account identifier, confirms the fee quote, and emits completion after success', async () => {
    host = document.createElement('div'); document.body.append(host);
    const quote = { recipientUserId: '22', recipientDisplayName: '收款玩家', coins: '100', feeCoins: '5', totalCoins: '105', feeRateBps: 500, quotedAt: '2026-10-15T00:00:00.000Z', expiresAt: '2026-10-15T00:01:00.000Z' };
    const lookup = vi.fn(async (value: string) => value === 'friend-username' ? [{ userId: '22', displayName: '收款玩家', friendCode: 'ABCDEFGH' }] : []);
    const quoteTransfer = vi.fn(async () => quote);
    const transferCoins = vi.fn(async () => ({ operationId: '44', recipientUserId: '22', recipientDisplayName: '收款玩家', coins: '100', feeCoins: '5', totalCoins: '105', occurredAt: '2026-10-15T00:00:01.000Z' }));
    const completed = vi.fn();
    app = createApp(PlayerWalletTransferWorkspace, {
      wallet: { quoteTransfer, transferCoins } as unknown as WalletApplication,
      friends: { lookup } as unknown as SocialFriendsApplication,
      canTransfer: true,
      turnoverRemaining: '0',
      availableCoins: '1000',
      onCompleted: completed,
    });
    app.mount(host);

    await setField(host.querySelector<HTMLInputElement>('.player-transfer-search input')!, 'friend-username');
    host.querySelector<HTMLButtonElement>('.player-transfer-search button')!.click();
    await waitFor(() => host.querySelector('.player-transfer-candidates') !== null);
    expect(lookup).toHaveBeenCalledWith('friend-username');
    host.querySelector<HTMLButtonElement>('.player-transfer-candidates button')!.click();
    await waitFor(() => host.querySelector('.player-transfer-amount input') !== null);
    await setField(host.querySelector<HTMLInputElement>('.player-transfer-amount input')!, '100');
    host.querySelector<HTMLButtonElement>('.player-transfer-amount button')!.click();
    await waitFor(() => host.querySelector('.player-transfer-quote') !== null);
    expect(quoteTransfer).toHaveBeenCalledWith({ recipientUserId: '22', coins: '100' });
    expect(host.querySelector('.player-transfer-quote')?.textContent).toContain('105 金币');
    host.querySelector<HTMLButtonElement>('.player-transfer-quote > button')!.click();
    await waitFor(() => completed.mock.calls.length === 1);
    expect(transferCoins).toHaveBeenCalledWith(expect.objectContaining({ quote, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已向 收款玩家 转账 100 金币');
  });
});

async function setField(element: HTMLInputElement, value: string): Promise<void> {
  element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('UI state did not settle in time'); await new Promise((resolve) => setTimeout(resolve, 0)); }
}
