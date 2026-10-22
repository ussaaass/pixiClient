import { Type } from '@sinclair/typebox';
import { HealthDataSchema } from '@gameing/contracts/health';
import { ActivePlatformAnnouncementsDataSchema } from '@gameing/contracts/platform-events/announcement';
import { GameCatalogEndpoint, GameCatalogListResponseSchema } from '@gameing/contracts/game-catalog';
import {
  GameExperienceDtoSchema,
  GameExperienceEndpoint,
  GameExperienceListResponseSchema,
  GamePreflightResponseSchema,
} from '@gameing/contracts/game-experience';
import { LOBBY_GAME_EXPERIENCE_REFERENCE, LOBBY_GAME_REFERENCE } from '@gameing/contracts/lobby-game-reference';
import { GameErrorCode } from '@gameing/contracts/common/api-errors';
import Koa from 'koa';
import Router from '@koa/router';
import { createLogger, type Logger } from './infrastructure/logging/logger.js';
import { ApiError, NotFoundError } from './infrastructure/http/error-boundary.js';
import { createErrorBoundaryMiddleware } from './infrastructure/http/error-boundary.js';
import { requestIdMiddleware } from './infrastructure/http/request-context.js';
import { createRequestLoggingMiddleware } from './infrastructure/http/request-logging.js';
import { setSuccess } from './infrastructure/http/response.js';

/**
 * 服务端应用装配（composition root）。
 *
 * 当前 P0 阶段提供：统一 envelope、requestId 贯通、结构化日志、错误边界、
 * `/health/live` 与 `/health/ready` 探活，以及已有的游戏目录只读路由。
 * 数据库、Redis、Socket 与业务 handler 在后续阶段接入。
 */

/** 就绪探针报告的单个依赖项状态。 */
export const ReadinessReportSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
    service: Type.Literal('gameing-hall-api'),
    checks: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 64 }),
          ready: Type.Boolean(),
          detail: Type.Optional(Type.String({ maxLength: 256 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
    serverNow: Type.String({
      pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
    }),
  },
  { additionalProperties: false },
);

export interface ReadinessCheck {
  name: string;
  /** 返回 null 表示就绪；返回字符串表示未就绪的原因（安全的、不含敏感信息的描述）。 */
  probe: () => Promise<string | null>;
}

export interface CreateAppOptions {
  logger?: Logger;
  /** 就绪探针依赖检查。P0 阶段默认为空数组（进程本身即为唯一依赖）。 */
  readinessChecks?: ReadinessCheck[];
}

export function createApp(options: CreateAppOptions = {}): Koa {
  const logger = options.logger ?? createLogger({ base: { service: 'gameing-hall-api' } });
  const readinessChecks = options.readinessChecks ?? [];

  const app = new Koa();

  // 中间件顺序很关键：
  // 访问日志必须包在错误边界**外层**，这样错误边界把业务码写进 ctx.state 之后，
  // 日志的 finally 才能读到最终的 status 与 code，而不是笼统的 "ERROR"。
  app.use(requestIdMiddleware);
  app.use(createRequestLoggingMiddleware(logger));
  app.use(createErrorBoundaryMiddleware(logger));

  const router = new Router({ prefix: '/api/v1' });

  router.get('/health/live', (ctx) => {
    setSuccess(ctx, {
      message: '服务进程正常',
      data: { status: 'live' as const, service: 'gameing-hall-api' as const },
      schema: HealthDataSchema,
    });
  });

  router.get('/health/ready', async (ctx) => {
    const checks = await Promise.all(
      readinessChecks.map(async (check) => {
        try {
          const detail = await check.probe();
          return detail === null ? { name: check.name, ready: true } : { name: check.name, ready: false, detail };
        } catch (error) {
          // 探针自身抛错也视为"未就绪"，但只暴露安全的异常名，不回显原始 message。
          return {
            name: check.name,
            ready: false,
            detail: error instanceof Error ? error.name : 'UnknownError',
          };
        }
      }),
    );

    const ready = checks.every((check) => check.ready);
    const data = {
      status: ready ? ('ready' as const) : ('not_ready' as const),
      service: 'gameing-hall-api' as const,
      checks,
      serverNow: new Date().toISOString(),
    };

    ctx.status = ready ? 200 : 503;
    ctx.body = {
      requestId: ctx.state.requestId,
      code: ready ? ('OK' as const) : ('SERVICE_UNAVAILABLE' as const),
      message: ready ? '服务已就绪' : '服务依赖未就绪',
      data,
      serverNow: data.serverNow,
    };
  });

  router.get('/platform/announcements/active', (ctx) => {
    setSuccess(ctx, {
      message: '当前没有可展示的公告',
      data: { announcements: [] },
      schema: ActivePlatformAnnouncementsDataSchema,
    });
  });

  router.get('/games', (ctx) => {
    setSuccess(ctx, {
      message: '游戏目录',
      data: LOBBY_GAME_REFERENCE,
      schema: GameCatalogListResponseSchema,
      status: GameCatalogEndpoint.list.successStatus,
    });
  });

  router.get('/games/experience', (ctx) => {
    setSuccess(ctx, {
      message: '游戏玩法与难度配置',
      data: LOBBY_GAME_EXPERIENCE_REFERENCE,
      schema: GameExperienceListResponseSchema,
      status: GameExperienceEndpoint.list.successStatus,
    });
  });

  router.get('/games/:gameKey/experience', (ctx) => {
    const item = LOBBY_GAME_EXPERIENCE_REFERENCE.find((entry) => entry.game.gameKey === ctx.params.gameKey);
    if (!item) {
      throw new ApiError(GameErrorCode.GAME_NOT_FOUND, '未找到此游戏。');
    }
    setSuccess(ctx, {
      message: '游戏玩法详情',
      data: item,
      schema: GameExperienceDtoSchema,
      status: GameExperienceEndpoint.detail.successStatus,
    });
  });

  router.get('/games/:gameKey/difficulties/:difficultyKey/preflight', (ctx) => {
    const item = LOBBY_GAME_EXPERIENCE_REFERENCE.find((entry) => entry.game.gameKey === ctx.params.gameKey);
    const hall = item?.difficultyHalls.find((entry) => entry.difficultyKey === ctx.params.difficultyKey && entry.enabled);
    if (!item || !hall) {
      throw new ApiError(GameErrorCode.GAME_DIFFICULTY_NOT_FOUND, '未找到此难度厅。');
    }
    const ready = item.entryMode === 'LOCAL_PRACTICE' && item.game.isPlayable;
    setSuccess(ctx, {
      message: '难度准入检查完成',
      data: {
        gameKey: item.game.gameKey,
        difficultyKey: hall.difficultyKey,
        availability: ready ? ('READY' as const) : ('MODULE_UNAVAILABLE' as const),
        source: 'LOCAL_DEMO' as const,
        message: ready ? '本地练习可用；不扣金币、不进行真实结算。' : '该游戏模块尚未接入，当前不会扣除资产或创建游戏局。',
      },
      schema: GamePreflightResponseSchema,
      status: GameExperienceEndpoint.preflight.successStatus,
    });
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  // 兜底 404：路径未匹配任何路由时，Koa 默认返回纯文本 "Not Found"，
  // 与"所有 JSON API 都用同一 envelope"的约定冲突。这里统一转成失败 envelope。
  app.use(() => {
    throw new NotFoundError();
  });

  return app;
}
