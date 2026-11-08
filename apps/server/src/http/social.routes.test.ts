import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { SocialModule } from '@gameing/backend/modules/social/public';
import type { Sequelize } from 'sequelize';

test('social message history authenticates and forwards principal and cursor', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const calls: Array<{ input: Record<string, unknown>; tx: Record<string, unknown> }> = [];
  const identityModule = {
    jwtIssuer: { verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }) },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const socialModule = {
    messageList: {
      run: async (input: Record<string, unknown>, tx: Record<string, unknown>) => {
        calls.push({ input, tx });
        return {
          messages: [
            {
              messageId: '11',
              messageNo: '13',
              senderUserId: '42',
              bodyText: 'Hello',
              messageType: 1,
              status: 1,
              createdAt: '2026-11-07T12:00:00.000Z',
            },
          ],
          hasMore: false,
        };
      },
    },
  } as unknown as SocialModule;
  const app = createApp({ logger, identityModule, socialModule, sequelize: {} as Sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/me/social/conversations/77/messages`;

  try {
    const unauthorized = await fetch(`${url}?afterMessageNo=12`);
    const unauthorizedBody = (await unauthorized.json()) as { code: string };
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedBody.code, 'UNAUTHORIZED');
    assert.equal(calls.length, 0);

    const response = await fetch(`${url}?afterMessageNo=12`, { headers: { authorization: 'Bearer test-token' } });
    const body = (await response.json()) as {
      code: string;
      data: { messages: Array<{ messageId: string; messageNo: string; bodyText: string | null }>; hasMore: boolean };
    };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.code, 'OK');
    assert.deepEqual(body.data, {
      messages: [
        {
          messageId: '11',
          messageNo: '13',
          senderUserId: '42',
          bodyText: 'Hello',
          messageType: 1,
          status: 1,
          createdAt: '2026-11-07T12:00:00.000Z',
        },
      ],
      hasMore: false,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.input, { userId: '42', conversationId: '77', afterMessageNo: '12' });
    assert.deepEqual(calls[0]?.tx, { transaction: null });
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
