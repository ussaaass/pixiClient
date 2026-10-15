import { randomUUID } from 'node:crypto';
import Koa from 'koa';
import Router from '@koa/router';
import { HealthResponseSchema } from '@gameing/contracts/health';
import { ActivePlatformAnnouncementsResponseSchema } from '@gameing/contracts/platform-events/announcement';
import { Value } from '@sinclair/typebox/value';

export function createApp(): Koa {
  const app = new Koa();
  const router = new Router({ prefix: '/api/v1' });

  router.get('/health/live', (ctx) => {
    const response = {
      requestId: randomUUID(),
      code: 'OK' as const,
      message: '服务进程正常',
      data: { status: 'live' as const, service: 'gameing-hall-api' as const },
      serverNow: new Date().toISOString(),
    };

    if (!Value.Check(HealthResponseSchema, response)) {
      throw new Error('Health response violates the shared contract');
    }

    ctx.status = 200;
    ctx.body = response;
  });

  router.get('/platform/announcements/active', (ctx) => {
    const response = {
      requestId: randomUUID(),
      code: 'OK' as const,
      message: '当前没有可展示的公告',
      data: { announcements: [] },
      serverNow: new Date().toISOString(),
    };

    if (!Value.Check(ActivePlatformAnnouncementsResponseSchema, response)) {
      throw new Error('Active announcement response violates the shared contract');
    }

    ctx.status = 200;
    ctx.body = response;
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}
