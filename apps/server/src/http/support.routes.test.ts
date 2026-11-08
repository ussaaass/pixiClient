import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { SupportModule } from '@gameing/backend/modules/support/public';
import type { AdminModule } from '@gameing/backend/modules/admin/public';
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
  const adminModule = {} as AdminModule;
  const app = createApp({ logger, identityModule, supportModule, adminModule, sequelize });
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

test('support player reply rejects forged staff sender types before opening a transaction', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const replyCalls: unknown[] = [];
  const transactionCalls: unknown[] = [];
  const identityModule = {
    jwtIssuer: { verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }) },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const supportModule = {
    withTx: async (_tx: unknown, callback: (outbox: unknown) => unknown) => callback({ outbox: true }),
    ticketReply: {
      run: async (input: unknown) => {
        replyCalls.push(input);
        return { messageId: '9', status: 'SENT', inserted: false };
      },
    },
  } as unknown as SupportModule;
  const adminModule = {} as AdminModule;
  const sequelize = {
    transaction: async (callback: (tx: unknown) => unknown) => {
      transactionCalls.push(true);
      return callback({ transaction: 'tx' });
    },
  } as unknown as Sequelize;
  const app = createApp({ logger, identityModule, supportModule, adminModule, sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/support/conversations/77/messages`;
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

  try {
    for (const senderType of [2, 3]) {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messageType: 1, bodyText: 'forged', senderType }),
      });
      const body = (await response.json()) as { code: string };
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.code, 'REQUEST_VALIDATION_FAILED');
    }
    assert.equal(transactionCalls.length, 0);
    assert.equal(replyCalls.length, 0);

    const customerResponse = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messageType: 1, bodyText: 'customer', senderType: 1 }),
    });
    const customerBody = (await customerResponse.json()) as { code: string };
    assert.equal(customerResponse.status, 201, JSON.stringify(customerBody));
    assert.equal(customerBody.code, 'OK');
    assert.equal(transactionCalls.length, 1);
    assert.equal(replyCalls.length, 1);
    const customerCall = replyCalls[0] as Record<string, unknown>;
    assert.equal(customerCall.userId, '42');
    assert.equal(customerCall.conversationId, '77');
    assert.equal(customerCall.bodyText, 'customer');
    assert.equal(customerCall.messageType, 1);
    assert.equal(customerCall.senderType, 1);
    assert.equal(customerCall.senderUserId, '42');
    assert.match(customerCall.messageKey as string, /^sup:42:[0-9a-f-]+$/);
    assert.deepEqual(customerCall.tx, { transaction: { transaction: 'tx' } });
    assert.deepEqual(customerCall.outbox, { outbox: true });
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
