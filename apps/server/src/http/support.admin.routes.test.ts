import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { SupportModule } from '@gameing/backend/modules/support/public';
import type { AdminModule } from '@gameing/backend/modules/admin/public';
import type { Sequelize } from 'sequelize';

test('support claim uses Admin audience and Admin principal, not player auth', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const verifyCalls: Array<{ token: string; options: unknown }> = [];
  const claimCalls: unknown[] = [];
  const transactionCalls: unknown[] = [];
  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async (token: string, options: unknown) => {
        verifyCalls.push({ token, options });
        return { userId: '90001', sid: 'admin-sid', deviceId: 'admin-device', authVersion: '3' };
      },
    },
    sessionPort: { getSession: async () => ({ authVersion: '3' }) },
  } as unknown as IdentityModule;
  const supportModule = {
    withTx: async (_scope: unknown, callback: (outbox: unknown) => unknown) => callback({}),
    ticketClaim: {
      run: async (input: unknown) => {
        claimCalls.push(input);
        return { conversationId: '77', assignedAdminUserId: '90001', status: 'WAITING_SUPPORT', inserted: true };
      },
    },
  } as unknown as SupportModule;
  const adminModule = {} as AdminModule;
  const sequelize = {
    transaction: async (callback: (tx: unknown) => unknown) => {
      transactionCalls.push(true);
      return callback({ transaction: 'admin-tx' });
    },
  } as unknown as Sequelize;
  const app = createApp({ logger, identityModule, supportModule, adminModule, sequelize });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/admin/support/conversations/77/claim`;

  try {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer admin-token' } });
    const body = (await response.json()) as { code: string; data: unknown };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.code, 'OK');
    assert.deepEqual(verifyCalls, [{ token: 'admin-token', options: { audience: 'admin' } }]);
    assert.equal(transactionCalls.length, 1);
    assert.deepEqual(claimCalls[0], {
      conversationId: '77',
      adminUserId: '90001',
      adminRoleType: 4,
      tx: { transaction: { transaction: 'admin-tx' } },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('player audience cannot access the Admin support claim route', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const verifyCalls: unknown[] = [];
  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async (_token: string, options: unknown) => {
        verifyCalls.push(options);
        throw new Error('wrong audience');
      },
    },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const supportModule = {} as SupportModule;
  const adminModule = {} as AdminModule;
  const app = createApp({ logger, identityModule, supportModule, adminModule, sequelize: {} as Sequelize });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/admin/support/conversations/77/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer player-token' },
    });
    const body = (await response.json()) as { code: string };
    assert.equal(response.status, 401, JSON.stringify(body));
    assert.equal(body.code, 'AD_ADMIN_UNAUTHORIZED');
    assert.deepEqual(verifyCalls, [{ audience: 'admin' }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
