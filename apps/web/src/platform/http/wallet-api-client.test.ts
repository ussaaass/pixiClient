import { describe, expect, it, vi } from 'vitest';
import { WalletEndpoint } from '@gameing/contracts/wallet';
import { createApiClient } from './api-client';

const successEnvelope = (data: unknown) => ({
  requestId: 'response-request-1',
  code: 'OK',
  message: 'OK',
  data,
  serverNow: '2026-11-07T12:00:00.000Z',
});

const walletSummary = {
  assets: [
    { assetType: 1, currency: 'COIN', amount: '12500', frozenAmount: '500', availableAmount: '12000', version: 3 },
    { assetType: 2, currency: 'CNY', amount: '2500', frozenAmount: '0', availableAmount: '2500', version: 2 },
  ],
  turnover: { remainingCoins: '0', canTransferOrWithdraw: true },
  welcomeGift: { coins: '1000', turnoverRequirement: '5000' },
};

const walletActivity = {
  items: [
    {
      entryId: '987654321',
      operationId: '123456789',
      activityType: 2,
      assetType: 1,
      currency: 'COIN',
      delta: '-1050',
      balanceAfter: '12500',
      occurredAt: '2026-11-07T11:59:00.000Z',
      counterpartyLabel: 'Player 42',
      transferCoins: '1000',
      feeCoins: '50',
    },
  ],
  nextCursor: '2026-11-07T11:59:00.000Z~987654321',
};

describe('createApiClient wallet read endpoints', () => {
  it('sends wallet summary GET path with Bearer auth and returns schema-valid envelope data', async () => {
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(walletSummary)), { status: 200 }));
    const client = createApiClient(fetchPort);

    await expect(client.walletSummary('wallet-access-token')).resolves.toEqual(walletSummary);

    expect(fetchPort).toHaveBeenCalledTimes(1);
    const [path, init] = fetchPort.mock.calls[0]!;
    expect(path).toBe(WalletEndpoint.summary.path);
    expect(init).toMatchObject({ method: WalletEndpoint.summary.method, credentials: 'include' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer wallet-access-token');
    expect(new Headers(init?.headers).get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('sends wallet activity GET path with Bearer auth and encodes the cursor', async () => {
    const cursor = '2026-11-07T11:59:00.000Z~987654321';
    const fetchPort = vi.fn().mockResolvedValue(new Response(JSON.stringify(successEnvelope(walletActivity)), { status: 200 }));
    const client = createApiClient(fetchPort);

    await expect(client.walletActivity('wallet-access-token', cursor)).resolves.toEqual(walletActivity);

    expect(fetchPort).toHaveBeenCalledTimes(1);
    const [path, init] = fetchPort.mock.calls[0]!;
    expect(path).toBe(`${WalletEndpoint.activity.path}?cursor=${encodeURIComponent(cursor)}`);
    expect(init).toMatchObject({ method: WalletEndpoint.activity.method, credentials: 'include' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer wallet-access-token');
    expect(new Headers(init?.headers).get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('omits the activity cursor query when no cursor is provided', async () => {
    const fetchPort = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(successEnvelope({ items: [], nextCursor: null })), { status: 200 }));
    const client = createApiClient(fetchPort);

    await expect(client.walletActivity('wallet-access-token')).resolves.toEqual({ items: [], nextCursor: null });

    expect(fetchPort.mock.calls[0]?.[0]).toBe(WalletEndpoint.activity.path);
  });

  it.each([
    [
      'summary',
      () =>
        createApiClient(
          vi
            .fn()
            .mockResolvedValue(
              new Response(
                JSON.stringify(successEnvelope({ ...walletSummary, turnover: { remainingCoins: '-1', canTransferOrWithdraw: true } })),
                { status: 200 },
              ),
            ),
        ).walletSummary('wallet-access-token'),
    ],
    [
      'activity',
      () =>
        createApiClient(
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify(successEnvelope({ items: [{ ...walletActivity.items[0], entryId: '0' }], nextCursor: null })), {
              status: 200,
            }),
          ),
        ).walletActivity('wallet-access-token'),
    ],
  ])('rejects a successful response with invalid %s schema data', async (_label, request) => {
    await expect(request()).rejects.toMatchObject({ status: 200, code: 'INVALID_API_RESPONSE' });
  });

  it('rejects a malformed success envelope for wallet summary', async () => {
    const fetchPort = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ...successEnvelope(walletSummary), unexpected: true }), { status: 200 }));
    const client = createApiClient(fetchPort);

    await expect(client.walletSummary('wallet-access-token')).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_API_RESPONSE',
    });
  });
});
