import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from './app.js';
import { createLogger, createMemorySink } from './infrastructure/logging/logger.js';
import { ApiError } from './infrastructure/http/error-boundary.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { IdentityEndpoint } from '@gameing/contracts/identity';
import type { RoomsModule } from '@gameing/backend/modules/rooms/public';
import type { Sequelize } from 'sequelize';

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;
let sink: ReturnType<typeof createMemorySink>;

before(async () => {
  sink = createMemorySink();
  const logger = createLogger({ level: 'debug', sink: sink.sink, base: { service: 'gameing-hall-api' } });
  const app = createApp({ logger });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('health endpoint returns the shared success envelope', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/live`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.code, 'OK');
  assert.equal(typeof body.requestId, 'string');
  assert.equal(typeof body.serverNow, 'string');
  assert.deepEqual(body.data, { status: 'live', service: 'gameing-hall-api' });
});

test('active platform announcement feed returns a shared empty snapshot instead of 404', async () => {
  const response = await fetch(`${baseUrl}/api/v1/platform/announcements/active`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.code, 'OK');
  assert.equal(typeof body.requestId, 'string');
  assert.equal(typeof body.serverNow, 'string');
  assert.deepEqual(body.data, { announcements: [] });
});

test('game directory, gameplay and difficulty preflight use shared API envelopes', async () => {
  const directoryResponse = await fetch(`${baseUrl}/api/v1/games`);
  const directory = (await directoryResponse.json()) as { data: Array<{ gameKey: string }> };
  const experienceResponse = await fetch(`${baseUrl}/api/v1/games/experience`);
  const experiences = (await experienceResponse.json()) as {
    data: Array<{ game: { gameKey: string }; difficultyHalls: unknown[]; subhallBackgroundAssetId: string; subhallBackgroundUrl: string }>;
  };
  const mahjongResponse = await fetch(`${baseUrl}/api/v1/games/mahjong-hule-2/experience`);
  const mahjong = (await mahjongResponse.json()) as { data: { title: string; gameplay: Array<{ body: string }> } };
  const preflightResponse = await fetch(`${baseUrl}/api/v1/games/slot5/difficulties/entry/preflight`);
  const preflight = (await preflightResponse.json()) as { data: { availability: string; message: string } };

  assert.equal(directoryResponse.status, 200);
  assert.equal(experienceResponse.status, 200);
  assert.equal(mahjongResponse.status, 200);
  assert.equal(preflightResponse.status, 200);
  assert.equal(directory.data.length, 8);
  assert.equal(experiences.data.length, 8);
  assert.ok(experiences.data.every((item) => item.difficultyHalls.length === 3));
  assert.equal(new Set(experiences.data.map((item) => item.subhallBackgroundAssetId)).size, 8);
  assert.ok(experiences.data.every((item) => item.subhallBackgroundUrl.startsWith('/assets/game-subhalls/')));
  assert.equal(mahjong.data.title, '麻将胡了 2');
  assert.match(mahjong.data.gameplay[0]!.body, /2000 ways/);
  assert.equal(preflight.data.availability, 'MODULE_UNAVAILABLE');
  assert.match(preflight.data.message, /不会扣除资产/);
});

test('identity settings route matches the shared contract path and requires player auth', async () => {
  const seenUserIds: string[] = [];
  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }),
    },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
    identitySettings: {
      getSettings: async (ctx: { userId: string }) => {
        seenUserIds.push(ctx.userId);
        return {
          username: null,
          email: null,
          phone: null,
          passwordConfigured: false,
          totpEnabled: false,
          recoveryCredential: { available: false, expiresAt: null },
        };
      },
    },
  } as unknown as IdentityModule;
  const app = createApp({ identityModule });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;

  try {
    const canonicalPath = IdentityEndpoint.identitySettings.path.replace('/api/v1', '');
    const unauthorized = await fetch(`${base}${canonicalPath}`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${base}${canonicalPath}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const body = (await response.json()) as { code: string; data: { username: null; recoveryCredential: { available: boolean } } };
    assert.equal(response.status, 200);
    assert.equal(body.code, 'OK');
    assert.equal(body.data.username, null);
    assert.equal(body.data.recoveryCredential.available, false);
    assert.deepEqual(seenUserIds, ['42']);

    const previousPath = await fetch(`${base}/me/identity/settings`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(previousPath.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test('settlement route authenticates, forwards user identity, and rejects non-members', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const seen: Array<{ userId: string; roundId: string; fencingToken?: string }> = [];
  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }),
    },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const roomsModule = {
    roundSettle: {
      run: async (input: { userId: string; roundId: string; fencingToken?: string }) => {
        seen.push(input);
        const { RoomDomainError, R } = await import('@gameing/backend/modules/rooms/public');
        if (input.fencingToken === '4') {
          return { roundId: input.roundId, settlementId: '20', players: [{ userId: input.userId, water: '0', foul: false }], replay: true };
        }
        throw new RoomDomainError(input.fencingToken === undefined ? R.FENCING_CONFLICT : R.ROUND_PLAYER_NOT_FOUND, 'rejected');
      },
    },
  } as unknown as RoomsModule;
  const sequelize = {
    transaction: async (callback: (transaction: Record<string, never>) => Promise<unknown>) => callback({}),
  } as unknown as Sequelize;
  const app = createApp({ logger, identityModule, roomsModule, sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/rounds/10/settlement`;

  try {
    const forbidden = await fetch(`${url}?fencingToken=3`, { headers: { authorization: 'Bearer test-token' } });
    const forbiddenBody = (await forbidden.json()) as { code: string };
    assert.equal(forbidden.status, 403);
    assert.equal(forbiddenBody.code, 'FORBIDDEN');
    assert.equal(seen[0]?.userId, '42');
    assert.equal(seen[0]?.roundId, '10');
    assert.equal(seen[0]?.fencingToken, '3');

    const conflict = await fetch(url, { headers: { authorization: 'Bearer test-token' } });
    const conflictBody = (await conflict.json()) as { code: string };
    assert.equal(conflict.status, 409);
    assert.equal(conflictBody.code, 'FENCING_CONFLICT');
    assert.equal(seen[1]?.userId, '42');
    assert.equal(seen[1]?.fencingToken, undefined);

    const invalidQuery = await fetch(`${url}?fencingToken=4&fencingToken=5`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(invalidQuery.status, 400);
    assert.equal(seen.length, 2);

    const replay = await fetch(`${url}?fencingToken=4`, { headers: { authorization: 'Bearer test-token' } });
    const replayBody = (await replay.json()) as { code: string; data: { replay: boolean; settlementId: string } };
    assert.equal(replay.status, 200);
    assert.equal(replayBody.code, 'OK');
    assert.equal(replayBody.data.replay, true);
    assert.equal(replayBody.data.settlementId, '20');
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});

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
        rulesSnapshot: {}, fencingToken: '4', players: [1, 2, 3, 4].map((seatNo) => ({ userId: String(seatNo), roundPlayerId: String(30 + seatNo), seatNo, status: 2, submissionSnapshot: null, netCoinDelta: null })), events: [], nextCursor: input.afterSeq ?? '0',
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

test('room lifecycle business errors preserve shared code and HTTP status', async () => {
  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async () => ({ userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' }),
    },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const roomsModule = {
    roomJoin: {
      run: async () => {
        const { RoomDomainError, R } = await import('@gameing/backend/modules/rooms/public');
        throw new RoomDomainError(R.ROOM_FULL, 'not exposed');
      },
    },
  } as unknown as RoomsModule;
  const sequelize = {
    transaction: async (callback: (transaction: Record<string, never>) => Promise<unknown>) => callback({}),
  } as unknown as Sequelize;
  const app = createApp({ identityModule, roomsModule, sequelize });
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/rooms/10/join`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    const body = (await response.json()) as { code: string; data: unknown; message: string };
    assert.equal(response.status, 409);
    assert.equal(body.code, 'ROOM_FULL');
    assert.equal(body.data, null);
    assert.equal(body.message.includes('not exposed'), false);
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test('未知路由返回统一失败 envelope 且不泄漏内部细节', async () => {
  const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body.code, 'NOT_FOUND');
  assert.equal(body.data, null);
  assert.equal(typeof body.requestId, 'string');
  assert.equal(typeof body.message, 'string');
  assert.equal('stack' in body, false);
  assert.equal('cause' in body, false);
});

test('资源不存在使用稳定领域错误码并映射为 404', async () => {
  const response = await fetch(`${baseUrl}/api/v1/games/no-such-game/experience`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body.code, 'GAME_NOT_FOUND');
  assert.equal(body.data, null);
  assert.equal(typeof body.requestId, 'string');
});

test('requestId 在响应头与响应体中一致，且客户端可提供合规 hint', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/live`);
  const body = (await response.json()) as Record<string, unknown>;
  const headerValue = response.headers.get('x-request-id');

  assert.ok(headerValue);
  assert.equal(headerValue, body.requestId);

  const hinted = await fetch(`${baseUrl}/api/v1/health/live`, {
    headers: { 'X-Request-Id': '0c6dca6b-c1b9-4c9d-b9d3-1b39d3d302e4' },
  });
  assert.equal(hinted.headers.get('x-request-id'), '0c6dca6b-c1b9-4c9d-b9d3-1b39d3d302e4');
});

test('不合规的 requestId hint 被服务端替换，不被采信', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/live`, {
    headers: { 'X-Request-Id': 'forged-value' },
  });
  const headerValue = response.headers.get('x-request-id');

  assert.ok(headerValue);
  assert.notEqual(headerValue, 'forged-value');
  assert.match(headerValue, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('访问日志按 requestId 记录 route、status 与业务 code', async () => {
  const response = await fetch(`${baseUrl}/api/v1/games/no-such-game/experience`);
  const requestId = response.headers.get('x-request-id');
  const record = sink.records.find((item) => item.requestId === requestId && item.message === 'http_request');

  assert.ok(record, '应存在与 requestId 关联的访问日志');
  assert.equal(record.status, 404);
  assert.equal(record.code, 'GAME_NOT_FOUND');
  assert.equal(record.method, 'GET');
  assert.equal(typeof record.durationMs, 'number');
});

test('日志不会输出敏感字段', async () => {
  const localSink = createMemorySink();
  const logger = createLogger({ level: 'debug', sink: localSink.sink });
  logger.info('test', { authorization: 'Bearer secret-token', password: 'p@ss', token: 'abc' });

  const record = localSink.records[0]!;
  assert.equal(record.authorization, '[REDACTED]');
  assert.equal(record.password, '[REDACTED]');
  assert.equal(record.token, '[REDACTED]');
  assert.equal(localSink.lines[0]!.includes('secret-token'), false);
});

test('ApiError 的 status 由错误码注册表决定', () => {
  const error = new ApiError('GAME_NOT_FOUND', '未找到此游戏。');
  assert.equal(error.status, 404);
  assert.equal(error.retryable, false);

  const retryable = new ApiError('SERVICE_UNAVAILABLE', '服务暂不可用。');
  assert.equal(retryable.status, 503);
  assert.equal(retryable.retryable, true);
});
