import assert from 'node:assert/strict';
import { test } from 'node:test';
import Koa from 'koa';
import Router from '@koa/router';
import { createPlatformEventsRoutes } from './platform-events.routes.js';
import { createErrorBoundaryMiddleware } from '../infrastructure/http/error-boundary.js';
import { requestIdMiddleware } from '../infrastructure/http/request-context.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { PlatformEventsModule } from '@gameing/backend/modules/platform-events/public';
import type { Sequelize } from 'sequelize';

test('active platform announcements route authenticates and returns the use-case contract', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const runCalls: Array<{ transaction: unknown }> = [];
  const identityModule = {
    jwtIssuer: {
      verifyAccessToken: async (token: string) => {
        assert.equal(token, 'test-token');
        return { userId: '42', sid: 'sid-1', deviceId: 'device-1', authVersion: '1' };
      },
    },
    sessionPort: { getSession: async () => ({ authVersion: '1' }) },
  } as unknown as IdentityModule;
  const platformEventsModule = {
    activeAnnouncements: {
      run: async (tx: { transaction: unknown }) => {
        runCalls.push(tx);
        return { announcements: [], nextCursor: null };
      },
    },
  } as unknown as PlatformEventsModule;
  const apiRouter = new Router({ prefix: '/api/v1' });
  const platformEventsRouter = createPlatformEventsRoutes(platformEventsModule, identityModule, {} as Sequelize);
  apiRouter.use(platformEventsRouter.routes(), platformEventsRouter.allowedMethods());
  const app = new Koa();
  app.use(requestIdMiddleware);
  app.use(createErrorBoundaryMiddleware(logger));
  app.use(apiRouter.routes());
  app.use(apiRouter.allowedMethods());

  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/me/platform-events/active`;

  try {
    const unauthorized = await fetch(url);
    const unauthorizedBody = (await unauthorized.json()) as { code: string };
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedBody.code, 'UNAUTHORIZED');
    assert.equal(runCalls.length, 0);

    const response = await fetch(url, { headers: { authorization: 'Bearer test-token' } });
    const body = (await response.json()) as { code: string; data: { announcements: unknown[]; nextCursor: string | null } };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.code, 'OK');
    assert.deepEqual(body.data, { announcements: [], nextCursor: null });
    assert.deepEqual(runCalls, [{ transaction: null }]);
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
