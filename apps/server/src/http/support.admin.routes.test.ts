import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { SupportModule } from '@gameing/backend/modules/support/public';
import type { AdminModule } from '@gameing/backend/modules/admin/public';
import type { Sequelize } from 'sequelize';

function createHttpFixture(input: { allowed: boolean; action: 'claim' | 'resolve' }) {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const verifyCalls: unknown[] = [];
  const authorizationCalls: unknown[] = [];
  const commandCalls: unknown[] = [];
  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async (_token: string, options: unknown) => {
        verifyCalls.push(options);
        return { userId: '90001', sid: 'admin-sid', deviceId: 'admin-device', authVersion: '3' };
      },
    },
    sessionPort: { getSession: async () => ({ authVersion: '3' }) },
  } as unknown as IdentityModule;
  const supportModule = {
    withTx: async (_scope: unknown, callback: (outbox: unknown) => unknown) => callback({}),
    ticketClaim: {
      run: async (command: unknown) => {
        commandCalls.push(command);
        return { conversationId: '77', assignedAdminUserId: '90001', status: 'WAITING_SUPPORT', inserted: true };
      },
    },
    ticketResolve: {
      run: async (command: unknown) => {
        commandCalls.push(command);
        return { conversationId: '77', status: 'CLOSED' };
      },
    },
  } as unknown as SupportModule;
  const adminModule = {
    supportCapabilityAuthorize: {
      run: async (command: unknown) => {
        authorizationCalls.push(command);
        return input.allowed;
      },
    },
  } as unknown as AdminModule;
  const transactionCalls: unknown[] = [];
  const sequelize = {
    transaction: async (callback: (tx: unknown) => unknown) => {
      transactionCalls.push(true);
      return callback({ transaction: 'admin-tx' });
    },
  } as unknown as Sequelize;
  return {
    app: createApp({ logger, identityModule, supportModule, adminModule, sequelize }),
    verifyCalls,
    authorizationCalls,
    commandCalls,
    transactionCalls,
  };
}

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: ReturnType<ReturnType<typeof createApp>['listen']>) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('support claim requires Admin audience and passes Admin principal into capability check and command', async () => {
  const fixture = createHttpFixture({ allowed: true, action: 'claim' });
  const { server, baseUrl } = await listen(fixture.app);
  try {
    const response = await fetch(`${baseUrl}/api/v1/admin/support/conversations/77/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token' },
    });
    const body = (await response.json()) as { code: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.code, 'OK');
    assert.deepEqual(fixture.verifyCalls, [{ audience: 'admin' }]);
    assert.deepEqual(fixture.authorizationCalls, [
      { adminUserId: '90001', action: 'claim', tx: { transaction: { transaction: 'admin-tx' } } },
    ]);
    assert.equal(fixture.transactionCalls.length, 1);
    assert.deepEqual(fixture.commandCalls[0], {
      conversationId: '77',
      adminUserId: '90001',
      adminRoleType: 4,
      tx: { transaction: { transaction: 'admin-tx' } },
    });
  } finally {
    await close(server);
  }
});

test('Support claim and resolve reject missing capability before command mutation', async () => {
  for (const action of ['claim', 'resolve'] as const) {
    const fixture = createHttpFixture({ allowed: false, action });
    const { server, baseUrl } = await listen(fixture.app);
    const route = action === 'claim' ? '/api/v1/admin/support/conversations/77/claim' : '/api/v1/support/conversations/77/resolve';
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token' },
      });
      const body = (await response.json()) as { code: string };
      assert.equal(response.status, 403, JSON.stringify(body));
      assert.equal(body.code, 'FORBIDDEN');
      assert.equal(fixture.commandCalls.length, 0);
      assert.deepEqual(fixture.authorizationCalls, [{ adminUserId: '90001', action, tx: { transaction: { transaction: 'admin-tx' } } }]);
    } finally {
      await close(server);
    }
  }
});

test('player audience cannot access Admin support claim route', async () => {
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
  const adminModule = { supportCapabilityAuthorize: { run: async () => true } } as unknown as AdminModule;
  const app = createApp({ logger, identityModule, supportModule, adminModule, sequelize: {} as Sequelize });
  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/api/v1/admin/support/conversations/77/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer player-token' },
    });
    const body = (await response.json()) as { code: string };
    assert.equal(response.status, 401, JSON.stringify(body));
    assert.equal(body.code, 'AD_ADMIN_UNAUTHORIZED');
    assert.deepEqual(verifyCalls, [{ audience: 'admin' }]);
  } finally {
    await close(server);
  }
});
