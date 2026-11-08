import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { SupportModule } from '@gameing/backend/modules/support/public';
import type { Sequelize } from 'sequelize';

test('support conversation list authenticates and scopes the query to the principal user', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const calls: Array<{ userId: string; tx: unknown }> = [];
  const identityModule = {
    jwtIssuer: { verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }) },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const supportModule = {
    ticketList: {
      run: async (input: { userId: string; tx: unknown }) => {
        calls.push(input);
        return {
          conversations: [
            {
              conversationId: '10',
              categoryType: 1,
              subject: 'Account access',
              status: 1,
              lastMessageAt: null,
              createdAt: '2026-11-07T12:00:00.000Z',
              updatedAt: '2026-11-07T12:00:00.000Z',
            },
          ],
        };
      },
    },
  } as unknown as SupportModule;
  const sequelize = {} as Sequelize;
  const app = createApp({ logger, identityModule, supportModule, sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/me/support/conversations`;

  try {
    const unauthorized = await fetch(url);
    const unauthorizedBody = (await unauthorized.json()) as { code: string };
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedBody.code, 'UNAUTHORIZED');
    assert.equal(calls.length, 0);

    const response = await fetch(url, { headers: { authorization: 'Bearer test-token' } });
    const body = (await response.json()) as {
      code: string;
      data: { conversations: Array<{ conversationId: string; subject: string }> };
    };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.code, 'OK');
    assert.deepEqual(body.data.conversations, [
      {
        conversationId: '10',
        categoryType: 1,
        subject: 'Account access',
        status: 1,
        lastMessageAt: null,
        createdAt: '2026-11-07T12:00:00.000Z',
        updatedAt: '2026-11-07T12:00:00.000Z',
      },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.userId, '42');
    assert.equal((calls[0]?.tx as { transaction: unknown }).transaction, null);
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
