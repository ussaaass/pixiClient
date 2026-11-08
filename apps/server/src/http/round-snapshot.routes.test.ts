import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { RoomsModule } from '@gameing/backend/modules/rooms/public';
import type { Sequelize } from 'sequelize';

test('round snapshot route authenticates, validates cursor, and returns member-authorized recovery data', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const calls: Array<{ userId: string; roundId: string; afterSeq?: string; limit?: number }> = [];
  const identityModule = {
    jwtIssuer: { verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }) },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const roomsModule = {
    roundSnapshot: async (input: { userId: string; roundId: string; afterSeq?: string; limit?: number }) => {
      calls.push(input);
      return {
        roundId: '10', roomId: '20', roundNo: '3', status: 2, handlerVersion: 'classic-v1',
        rulesSnapshot: {}, fencingToken: '4',
        players: [1, 2, 3, 4].map((seatNo) => ({ userId: String(seatNo), roundPlayerId: String(30 + seatNo), seatNo, status: 2, submissionSnapshot: null, netCoinDelta: null })),
        events: [], nextCursor: input.afterSeq ?? '0',
      };
    },
  } as unknown as RoomsModule;
  const sequelize = { transaction: async (callback: (transaction: Record<string, never>) => Promise<unknown>) => callback({}) } as unknown as Sequelize;
  const app = createApp({ logger, identityModule, roomsModule, sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/rounds/10/snapshot`;
  try {
    const unauthorized = await fetch(`${url}?afterSeq=6`);
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.length, 0);
    const invalid = await fetch(`${url}?afterSeq=06`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 0);
    const response = await fetch(`${url}?afterSeq=6&limit=25`, { headers: { authorization: 'Bearer test-token' } });
    const body = (await response.json()) as { code: string; message?: string; data: { roundId: string; nextCursor: string } };
    assert.equal(response.status, 200, body.message);
    assert.equal(body.code, 'OK');
    assert.equal(body.data.roundId, '10');
    assert.equal(body.data.nextCursor, '6');
    assert.deepEqual(calls[0], { userId: '42', roundId: '10', afterSeq: '6', limit: 25 });
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
