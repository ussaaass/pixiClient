import { randomUUID } from 'node:crypto';
import Koa from 'koa';
import Router from '@koa/router';
import { HealthResponseSchema } from '@gameing/contracts/health';
import { ActivePlatformAnnouncementsResponseSchema } from '@gameing/contracts/platform-events/announcement';
import { Value } from '@sinclair/typebox/value';
import { GameCatalogEndpoint, GameCatalogListResponseSchema } from '@gameing/contracts/game-catalog';
import { GameExperienceDtoSchema, GameExperienceEndpoint, GameExperienceListResponseSchema, GamePreflightResponseSchema } from '@gameing/contracts/game-experience';
import { LOBBY_GAME_EXPERIENCE_REFERENCE, LOBBY_GAME_REFERENCE } from '@gameing/contracts/lobby-game-reference';

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

  router.get('/games', (ctx) => {
    const response = { requestId: randomUUID(), code: 'OK' as const, message: '游戏目录', data: LOBBY_GAME_REFERENCE, serverNow: new Date().toISOString() };
    if (!Value.Check(GameCatalogListResponseSchema, response.data)) throw new Error('Game catalog violates the shared contract');
    ctx.status = GameCatalogEndpoint.list.successStatus;
    ctx.body = response;
  });

  router.get('/games/experience', (ctx) => {
    const response = { requestId: randomUUID(), code: 'OK' as const, message: '游戏玩法与难度配置', data: LOBBY_GAME_EXPERIENCE_REFERENCE, serverNow: new Date().toISOString() };
    if (!Value.Check(GameExperienceListResponseSchema, response.data)) throw new Error('Game experience data violates the shared contract');
    ctx.status = GameExperienceEndpoint.list.successStatus;
    ctx.body = response;
  });

  router.get('/games/:gameKey/experience', (ctx) => {
    const item = LOBBY_GAME_EXPERIENCE_REFERENCE.find((entry) => entry.game.gameKey === ctx.params.gameKey);
    if (!item) {
      ctx.status = 404;
      ctx.body = { requestId: randomUUID(), code: 'GAME_NOT_FOUND', message: '未找到此游戏。', data: null, serverNow: new Date().toISOString() };
      return;
    }
    if (!Value.Check(GameExperienceDtoSchema, item)) throw new Error('Game experience violates the shared contract');
    ctx.status = GameExperienceEndpoint.detail.successStatus;
    ctx.body = { requestId: randomUUID(), code: 'OK', message: '游戏玩法详情', data: item, serverNow: new Date().toISOString() };
  });

  router.get('/games/:gameKey/difficulties/:difficultyKey/preflight', (ctx) => {
    const item = LOBBY_GAME_EXPERIENCE_REFERENCE.find((entry) => entry.game.gameKey === ctx.params.gameKey);
    const hall = item?.difficultyHalls.find((entry) => entry.difficultyKey === ctx.params.difficultyKey && entry.enabled);
    if (!item || !hall) {
      ctx.status = 404;
      ctx.body = { requestId: randomUUID(), code: 'GAME_DIFFICULTY_NOT_FOUND', message: '未找到此难度厅。', data: null, serverNow: new Date().toISOString() };
      return;
    }
    const ready = item.entryMode === 'LOCAL_PRACTICE' && item.game.isPlayable;
    const data = { gameKey: item.game.gameKey, difficultyKey: hall.difficultyKey, availability: ready ? 'READY' as const : 'MODULE_UNAVAILABLE' as const, source: 'LOCAL_DEMO' as const, message: ready ? '本地练习可用；不扣金币、不进行真实结算。' : '该游戏模块尚未接入，当前不会扣除资产或创建游戏局。' };
    if (!Value.Check(GamePreflightResponseSchema, data)) throw new Error('Game preflight violates the shared contract');
    ctx.status = GameExperienceEndpoint.preflight.successStatus;
    ctx.body = { requestId: randomUUID(), code: 'OK', message: '难度准入检查完成', data, serverNow: new Date().toISOString() };
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}
