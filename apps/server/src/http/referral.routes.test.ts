import assert from 'node:assert/strict';
import { test } from 'node:test';
import Koa from 'koa';
import Router from '@koa/router';
import { createReferralRoutes } from './referral.routes.js';
import { createErrorBoundaryMiddleware } from '../infrastructure/http/error-boundary.js';
import { requestIdMiddleware } from '../infrastructure/http/request-context.js';
import { createLogger, createMemorySink } from '../infrastructure/logging/logger.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { ReferralModule } from '@gameing/backend/modules/referral/public';
import type { Sequelize } from 'sequelize';

test('public referral attribution candidate enforces its shared request schema', async () => {
  const logger = createLogger({ level: 'debug', sink: createMemorySink().sink, base: { service: 'gameing-hall-api' } });
  const identityModule = {} as IdentityModule;
  const referralRouter = createReferralRoutes({} as ReferralModule, identityModule, {} as Sequelize);
  const apiRouter = new Router({ prefix: '/api/v1' });
  apiRouter.use(referralRouter.routes(), referralRouter.allowedMethods());
  const app = new Koa();
  app.use(async (ctx, next) => {
    if (ctx.is('application/json')) {
      const chunks: Buffer[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      (ctx as unknown as { request: { body?: unknown } }).request.body = raw ? JSON.parse(raw) : {};
    }
    await next();
  });
  app.use(requestIdMiddleware);
  app.use(createErrorBoundaryMiddleware(logger));
  app.use(apiRouter.routes());
  app.use(apiRouter.allowedMethods());
  const testServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => testServer.once('listening', resolve));
  const address = testServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/v1/public/referral-attribution/candidate`;

  try {
    const accepted = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteCode: 'ABCDEFGH' }),
    });
    const acceptedBody = (await accepted.json()) as { code: string; data: unknown };
    assert.equal(accepted.status, 200, JSON.stringify(acceptedBody));
    assert.equal(acceptedBody.code, 'OK');
    assert.deepEqual(acceptedBody.data, { captured: false, expiresAt: null });

    for (const invalidBody of [{}, { inviteCode: 'short' }, { inviteCode: 'abcdefgh' }, { inviteCode: 'ABCDEFGH', extra: true }]) {
      const rejected = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invalidBody),
      });
      const rejectedBody = (await rejected.json()) as { code: string };
      assert.equal(rejected.status, 400, `Expected schema rejection for ${JSON.stringify(invalidBody)}; received ${rejected.status}`);
      assert.equal(rejectedBody.code, 'REQUEST_VALIDATION_FAILED');
    }
  } finally {
    await new Promise<void>((resolve, reject) => testServer.close((error) => (error ? reject(error) : resolve())));
  }
});
