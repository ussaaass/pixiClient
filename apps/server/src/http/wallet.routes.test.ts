import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { WalletModule } from '@gameing/backend/modules/wallet/public';
import type { Sequelize } from 'sequelize';

test('wallet summary and activity routes authenticate and forward principal and cursor', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const summaryCalls: Array<{ userId: string }> = [];
  const activityCalls: Array<{ input: { userId: string }; cursor: string | undefined }> = [];
  const identityModule = {
    jwtIssuer: { verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }) },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const walletModule = {
    summary: {
      run: async (input: { userId: string }) => {
        summaryCalls.push(input);
        return {
          assets: [
            { assetType: 1, currency: 'COIN', amount: '1200', frozenAmount: '0', availableAmount: '1200', version: 1 },
            { assetType: 2, currency: 'CNY', amount: '350', frozenAmount: '0', availableAmount: '350', version: 1 },
          ],
          turnover: { remainingCoins: '0', canTransferOrWithdraw: true },
          welcomeGift: null,
        };
      },
    },
    activity: {
      run: async (input: { userId: string }, cursor?: string) => {
        activityCalls.push({ input, cursor });
        return {
          items: [
            {
              entryId: '9',
              operationId: '8',
              activityType: 1,
              assetType: 1,
              currency: 'COIN',
              delta: '100',
              balanceAfter: '1200',
              occurredAt: '2026-11-07T12:00:00.000Z',
            },
          ],
          nextCursor: null,
        };
      },
    },
  } as unknown as WalletModule;
  const app = createApp({ logger, identityModule, walletModule, sequelize: {} as Sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1/me/wallet`;

  try {
    const unauthorized = await fetch(`${baseUrl}/summary`);
    assert.equal(unauthorized.status, 401);
    assert.equal(summaryCalls.length, 0);
    assert.equal(activityCalls.length, 0);

    const headers = { authorization: 'Bearer test-token' };
    const summaryResponse = await fetch(`${baseUrl}/summary`, { headers });
    const summaryBody = (await summaryResponse.json()) as { code: string; data: { assets: unknown[]; turnover: unknown } };
    assert.equal(summaryResponse.status, 200, JSON.stringify(summaryBody));
    assert.equal(summaryBody.code, 'OK');
    assert.equal(summaryBody.data.assets.length, 2);
    assert.deepEqual(summaryCalls, [{ userId: '42' }]);

    const activityResponse = await fetch(`${baseUrl}/activity?cursor=2026-11-07T11%3A59%3A00.000Z~8`, { headers });
    const activityBody = (await activityResponse.json()) as { code: string; data: { items: unknown[]; nextCursor: string | null } };
    assert.equal(activityResponse.status, 200, JSON.stringify(activityBody));
    assert.equal(activityBody.code, 'OK');
    assert.equal(activityBody.data.items.length, 1);
    assert.equal(activityBody.data.nextCursor, null);
    assert.deepEqual(activityCalls, [{ input: { userId: '42' }, cursor: '2026-11-07T11:59:00.000Z~8' }]);
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
