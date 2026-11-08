import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { PaymentsModule } from '@gameing/backend/modules/payments/public';
import type { Sequelize } from 'sequelize';

const orderDto = {
  orderId: '91',
  orderNo: 'FUND-20261107-00091',
  channelId: 'ali-main',
  channelName: 'Alipay Main',
  paymentMethod: 1,
  amountCnyFen: '1000',
  creditCoins: '1000',
  status: 1,
  createdAt: '2026-11-07T12:00:00.000Z',
  paidAt: null,
};

const validRequest = {
  channelId: 'ali-main',
  amountCnyFen: '1000',
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
};

test('payment channels and funding orders authenticate, scope lists to the principal, and honor create idempotency', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const listCalls: Array<{ userId: string; limit: number }> = [];
  const createCalls: Array<{ userId: string; request: unknown; tx: unknown }> = [];
  const transactionCalls: unknown[] = [];
  let inserted = true;

  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async (token: string) => ({
        userId: token === 'other-token' ? '77' : '42',
        sid: `sid-${token}`,
        deviceId: 'device-1',
        authVersion: '1',
      }),
    },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const paymentsModule = {
    channels: {
      listEnabledChannelsByMethod: async () => [
        { id: 'channel-row-1', channelCode: 'ali-main', methodType: 1, priority: 5, displayName: 'Alipay Main', providerType: 3 },
      ],
    },
    orders: {
      listByUser: async (userId: string, limit: number) => {
        listCalls.push({ userId, limit });
        return [orderDto];
      },
    },
    orderCreate: {
      createOrder: async (input: { userId: string; request: unknown; tx: unknown }) => {
        createCalls.push(input);
        return { inserted, dto: orderDto };
      },
    },
    withTx: async (scope: { transaction: unknown }, fn: (outbox: unknown) => unknown) => fn({ transaction: scope.transaction }),
  } as unknown as PaymentsModule;
  const sequelize = {
    transaction: async (fn: (transaction: unknown) => Promise<unknown>) => {
      const transaction = { marker: 'fake-transaction' };
      transactionCalls.push(transaction);
      return fn(transaction);
    },
  } as unknown as Sequelize;
  const app = createApp({ logger, identityModule, paymentsModule, sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1/me`;

  try {
    const unauthorizedChannels = await fetch(`${baseUrl}/payment-channels`);
    assert.equal(unauthorizedChannels.status, 401);
    assert.equal((await unauthorizedChannels.json()).code, 'UNAUTHORIZED');
    const unauthorizedOrders = await fetch(`${baseUrl}/wallet/orders`);
    assert.equal(unauthorizedOrders.status, 401);
    assert.equal((await unauthorizedOrders.json()).code, 'UNAUTHORIZED');
    const unauthorizedCreate = await fetch(`${baseUrl}/wallet/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest),
    });
    assert.equal(unauthorizedCreate.status, 401);
    assert.equal(createCalls.length, 0);

    const headers = { authorization: 'Bearer test-token' };
    const channelsResponse = await fetch(`${baseUrl}/payment-channels`, { headers });
    const channelsBody = (await channelsResponse.json()) as {
      requestId: string;
      code: string;
      message: string;
      data: unknown[];
      serverNow: string;
    };
    assert.equal(channelsResponse.status, 200);
    assert.equal(channelsBody.code, 'OK');
    assert.equal(typeof channelsBody.requestId, 'string');
    assert.equal(typeof channelsBody.serverNow, 'string');
    assert.equal(channelsBody.message, '可用充值渠道');
    assert.deepEqual(channelsBody.data, [{ channelId: 'ali-main', displayName: 'Alipay Main', paymentMethod: 1, sortOrder: 5, status: 1 }]);

    const ordersResponse = await fetch(`${baseUrl}/wallet/orders`, { headers });
    const ordersBody = (await ordersResponse.json()) as { code: string; data: unknown[] };
    assert.equal(ordersResponse.status, 200);
    assert.equal(ordersBody.code, 'OK');
    assert.deepEqual(ordersBody.data, [orderDto]);
    assert.deepEqual(listCalls, [{ userId: '42', limit: 50 }]);

    const forgedPrincipalResponse = await fetch(`${baseUrl}/wallet/orders?userId=77`, { headers });
    assert.equal(forgedPrincipalResponse.status, 200);
    assert.deepEqual(listCalls.at(-1), { userId: '42', limit: 50 });

    const forgedQueryResponse = await fetch(`${baseUrl}/wallet/orders?userId=77`, { headers });
    assert.equal(forgedQueryResponse.status, 200);
    assert.deepEqual(listCalls.at(-1), { userId: '42', limit: 50 });

    const otherUserResponse = await fetch(`${baseUrl}/wallet/orders`, { headers: { authorization: 'Bearer other-token' } });
    assert.equal(otherUserResponse.status, 200);
    assert.deepEqual(listCalls.at(-1), { userId: '77', limit: 50 });

    const invalidResponse = await fetch(`${baseUrl}/wallet/orders`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validRequest, amountCnyFen: '0', userId: '77' }),
    });
    const invalidBody = (await invalidResponse.json()) as { code: string };
    assert.equal(invalidResponse.status, 400);
    assert.equal(invalidBody.code, 'REQUEST_VALIDATION_FAILED');
    assert.equal(createCalls.length, 0);
    assert.equal(transactionCalls.length, 0);

    const createResponse = await fetch(`${baseUrl}/wallet/orders`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(validRequest),
    });
    const createBody = (await createResponse.json()) as { code: string; data: unknown };
    assert.equal(createResponse.status, 201);
    assert.equal(createBody.code, 'OK');
    assert.deepEqual(createBody.data, orderDto);

    inserted = false;
    const replayResponse = await fetch(`${baseUrl}/wallet/orders`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(validRequest),
    });
    const replayBody = (await replayResponse.json()) as { code: string; data: unknown };
    assert.equal(replayResponse.status, 200);
    assert.equal(replayBody.code, 'OK');
    assert.deepEqual(replayBody.data, orderDto);
    assert.equal(createCalls.length, 2);
    assert.ok(createCalls.every((call) => call.userId === '42'));
    assert.ok(createCalls.every((call) => JSON.stringify(call.request) === JSON.stringify(validRequest)));
    assert.equal(transactionCalls.length, 2);
    assert.deepEqual(
      createCalls.map((call) => call.tx),
      transactionCalls.map((transaction) => ({ transaction })),
    );
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
