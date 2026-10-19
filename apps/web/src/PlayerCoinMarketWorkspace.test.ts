import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import type { CoinMarketApplication } from './platform/coin-market/coin-market-application';
import PlayerCoinMarketWorkspace from './components/PlayerCoinMarketWorkspace.vue';

describe('player coin market price preview', () => {
  let host: HTMLDivElement;
  let app: VueApp | undefined;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host.remove();
  });

  it('requests the authenticated API application and displays reference and seller prices separately', async () => {
    let submitted: { coins: string; priceCentsPer1000Coins: string } | undefined;
    const application: CoinMarketApplication = {
      async quotePrice(request) {
        submitted = request;
        return { ok: true, value: { coins: request.coins, priceCentsPer1000Coins: request.priceCentsPer1000Coins, referenceCentsPer1000Coins: '10000', grossCents: '12000', minimumListingCoins: '1000' } };
      },
      async myListings() { return { ok: true, value: [] }; },
      async createListing() { return { ok: false, code: 'UNEXPECTED' }; },
      async cancelListing() { return { ok: false, code: 'UNEXPECTED' }; },
      async publicListings() { return { ok: true, value: { items: [], nextCursor: null, minimumTradeCoins: '1000' } }; },
      async myTrades() { return { ok: true, value: [] }; },
      async createTrade() { return { ok: false, code: 'UNEXPECTED' }; },
      async tradeCommand() { return { ok: false, code: 'UNEXPECTED' }; },
    };
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerCoinMarketWorkspace, { application, availableCoins: '1000', turnoverRemaining: '0' });
    app.mount(host);

    host.querySelector<HTMLButtonElement>('#coin-market-tab-mine')!.click();
    await nextTick();
    host.querySelector<HTMLElement>('.coin-market-sell-panel > summary')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await waitFor(() => host.querySelector('.coin-market-quote-result') !== null);

    expect(submitted).toEqual({ coins: '1000', priceCentsPer1000Coins: '12000' });
    expect(host.querySelector('.coin-market-quote-result')?.textContent).toContain('¥100.00');
    expect(host.querySelector('.coin-market-quote-result')?.textContent).toContain('¥120.00');
  });

  it('rejects malformed RMB input before calling the application', async () => {
    let called = false;
    const application: CoinMarketApplication = { async quotePrice() { called = true; return { ok: false, code: 'UNEXPECTED' }; }, async myListings() { return { ok: true, value: [] }; }, async createListing() { return { ok: false, code: 'UNEXPECTED' }; }, async cancelListing() { return { ok: false, code: 'UNEXPECTED' }; }, async publicListings() { return { ok: true, value: { items: [], nextCursor: null, minimumTradeCoins: '1000' } }; }, async myTrades() { return { ok: true, value: [] }; }, async createTrade() { return { ok: false, code: 'UNEXPECTED' }; }, async tradeCommand() { return { ok: false, code: 'UNEXPECTED' }; } };
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerCoinMarketWorkspace, { application, availableCoins: '1000', turnoverRemaining: '0' });
    app.mount(host);
    host.querySelector<HTMLButtonElement>('#coin-market-tab-mine')!.click();
    await nextTick();
    host.querySelector<HTMLElement>('.coin-market-sell-panel > summary')!.click();
    await nextTick();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="每 1000 金币的人民币挂牌价"]')!;
    input.value = '1.239';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await nextTick();
    expect(called).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('最多精确到分');
  });

  it('switches between public listings and own listings without stacking both workspaces', async () => {
    const listing = { listingId: '31', coins: '2000', availableCoins: '2000', priceCentsPer1000Coins: '12000', referenceCentsPer1000Coins: '10000', totalCents: '24000', status: 1 as const, createdAt: '2026-10-16T00:00:00.000Z', sellerLabel: '牌友', paymentMethods: [1 as const] };
    const application: CoinMarketApplication = {
      async quotePrice() { return { ok: false, code: 'UNEXPECTED' }; },
      async myListings() { return { ok: true, value: [listing] }; },
      async createListing() { return { ok: false, code: 'UNEXPECTED' }; },
      async cancelListing() { return { ok: false, code: 'UNEXPECTED' }; },
      async publicListings() { return { ok: true, value: { items: [{ ...listing, listingId: '32', sellerLabel: '另一位牌友' }], nextCursor: null, minimumTradeCoins: '1000' } }; },
      async myTrades() { return { ok: true, value: [] }; },
      async createTrade() { return { ok: false, code: 'UNEXPECTED' }; },
      async tradeCommand() { return { ok: false, code: 'UNEXPECTED' }; },
    };
    host = document.createElement('div'); document.body.append(host);
    app = createApp(PlayerCoinMarketWorkspace, { application, availableCoins: '5000', turnoverRemaining: '0' });
    app.mount(host);
    await waitFor(() => host.querySelector('#coin-market-panel-market .coin-market-listing-row') !== null);
    expect(host.querySelector('#coin-market-panel-market')?.textContent).toContain('另一位牌友');
    expect(host.querySelector('#coin-market-panel-mine')).toBeNull();
    host.querySelector<HTMLButtonElement>('#coin-market-tab-mine')!.click();
    await nextTick();
    expect(host.querySelector('#coin-market-panel-market')).toBeNull();
    expect(host.querySelector('#coin-market-panel-mine')?.textContent).toContain('挂牌管理');
    expect(host.querySelector('#coin-market-panel-mine')?.textContent).toContain('挂牌中 · 金币已冻结');
    host.querySelector<HTMLButtonElement>('#coin-market-tab-market')!.click();
    await nextTick();
    expect(host.querySelector('#coin-market-panel-market')?.getAttribute('aria-labelledby')).toBe('coin-market-tab-market');
    expect(host.querySelector('#coin-market-panel-mine')).toBeNull();
  });

  it('binds purchase quantity to the selected listing, previews payable RMB, and opens my trades after ordering', async () => {
    let purchased: { listingId: string; coins: string; paymentMethod: number } | undefined;
    const listing = { listingId: '51', coins: '5000', availableCoins: '5000', priceCentsPer1000Coins: '12000', referenceCentsPer1000Coins: '10000', totalCents: '60000', status: 1 as const, createdAt: '2026-10-16T00:00:00.000Z', sellerLabel: '演示卖家', paymentMethods: [1 as const] };
    const application: CoinMarketApplication = {
      async quotePrice() { return { ok: false, code: 'UNEXPECTED' }; }, async myListings() { return { ok: true, value: [] }; },
      async createListing() { return { ok: false, code: 'UNEXPECTED' }; }, async cancelListing() { return { ok: false, code: 'UNEXPECTED' }; },
      async publicListings() { return { ok: true, value: { items: [listing], nextCursor: null, minimumTradeCoins: '1000' } }; },
      async myTrades() { return { ok: true, value: [] }; },
      async createTrade(listingId, request) { purchased = { listingId, coins: request.coins, paymentMethod: request.paymentMethod }; return { ok: true, value: { tradeId: '61', listingId, actorRole: 'BUYER', coins: request.coins, grossCents: '30000', status: 1, paymentMethod: request.paymentMethod, paymentInstructions: '演示收款资料', paymentDeadlineAt: '2026-10-16T01:00:00.000Z', sellerDeadlineAt: null, buyerEvidenceDeadlineAt: null, sellerEvidenceDeadlineAt: null, platformDecisionDeadlineAt: null, paymentProof: null, appealReason: null, buyerEvidence: null, sellerEvidence: null, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' } }; },
      async tradeCommand() { return { ok: false, code: 'UNEXPECTED' }; },
    };
    host = document.createElement('div'); document.body.append(host);
    app = createApp(PlayerCoinMarketWorkspace, { application, availableCoins: '5000', turnoverRemaining: '0' });
    app.mount(host);
    await waitFor(() => host.querySelector('.coin-market-buy-quantity input') !== null);
    const quantity = host.querySelector<HTMLInputElement>('.coin-market-buy-quantity input')!;
    quantity.value = '2500'; quantity.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    expect(host.querySelector('.coin-market-payable')?.textContent).toContain('¥300.00');
    host.querySelector<HTMLButtonElement>('#coin-market-panel-market .coin-market-listing-row > button')!.click();
    await waitFor(() => purchased !== undefined);
    expect(purchased).toEqual({ listingId: '51', coins: '2500', paymentMethod: 1 });
    await waitFor(() => host.querySelector('#coin-market-tab-trades')?.getAttribute('aria-selected') === 'true');
    expect(host.querySelector('#coin-market-tab-trades')?.getAttribute('aria-selected')).toBe('true');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('UI state did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
