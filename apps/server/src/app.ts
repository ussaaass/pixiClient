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
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { WalletModule } from '@gameing/backend/modules/wallet/public';
import type { PaymentsModule } from '@gameing/backend/modules/payments/public';
import type { RoomsModule } from '@gameing/backend/modules/rooms/public';
import type { SocialModule } from '@gameing/backend/modules/social/public';
import type { SupportModule } from '@gameing/backend/modules/support/public';
import type { ReferralModule } from '@gameing/backend/modules/referral/public';
import { createLogger, type Logger } from './infrastructure/logging/logger.js';
import { ApiError, NotFoundError } from './infrastructure/http/error-boundary.js';
import { createErrorBoundaryMiddleware } from './infrastructure/http/error-boundary.js';
import { requestIdMiddleware } from './infrastructure/http/request-context.js';
import { createRequestLoggingMiddleware } from './infrastructure/http/request-logging.js';
import { setSuccess } from './infrastructure/http/response.js';
import { createAuthRoutes, createIdentityRoutes } from './http/auth.routes.js';
import { createWalletRoutes } from './http/wallet.routes.js';
import { createPaymentsRoutes } from './http/payments.routes.js';
import { createRoomsRoutes } from './http/rooms.routes.js';
import { createSocialRoutes } from './http/social.routes.js';
import { createSupportRoutes } from './http/support.routes.js';
import { createReferralRoutes } from './http/referral.routes.js';
import type { Sequelize } from 'sequelize';

/**
 * 服务端应用装配（composition root）。
 *
 * 当前提供：统一 envelope、requestId 贯通、结构化日志、错误边界、
 * JSON body parser、health 路由、游戏目录只读路由、identity auth/identity 路由
 * （identity 路由仅在 `options.identityModule` 装配后挂载）。
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
  /** 就绪探针依赖检查。 */
  readinessChecks?: ReadinessCheck[];
  /** identity 模块实例（装配后注入；缺省时 auth/identity 路由不挂载）。 */
  identityModule?: IdentityModule;
  /** wallet 模块实例（装配后注入；缺省时 wallet 路由不挂载；与 identityModule 共同挂载）。 */
  walletModule?: WalletModule;
  /** payments 模块实例（装配后注入；缺省时 payments 路由不挂载；与 identityModule + sequelize 共同挂载）。 */
  paymentsModule?: PaymentsModule;
  /** rooms 模块实例（装配后注入；缺省时 rooms 路由不挂载；与 identityModule + walletModule + sequelize 共同挂载）。 */
  roomsModule?: RoomsModule;
  /** social 模块实例（装配后注入；缺省时 social 路由不挂载；与 identityModule + sequelize 共同挂载）。 */
  socialModule?: SocialModule;
  /** support 模块实例（装配后注入；缺省时 support 路由不挂载；与 identityModule + sequelize 共同挂载）。 */
  supportModule?: SupportModule;
  /** referral 模块实例（装配后注入；缺省时 referral 路由不挂载；与 identityModule + sequelize 共同挂载，归因无资金操作不依赖 wallet）。 */
  referralModule?: ReferralModule;
  /** Sequelize 实例（wallet 资金用例需开事务；payments 资金用例需开事务；identity 路由不依赖）。 */
  sequelize?: Sequelize;
}

export function createApp(options: CreateAppOptions = {}): Koa {
  const logger = options.logger ?? createLogger({ base: { service: 'gameing-hall-api' } });
  const readinessChecks = options.readinessChecks ?? [];
  const identityModule = options.identityModule;
  const walletModule = options.walletModule;
  const paymentsModule = options.paymentsModule;
  const roomsModule = options.roomsModule;
  const socialModule = options.socialModule;
  const supportModule = options.supportModule;
  const referralModule = options.referralModule;
  const sequelize = options.sequelize;

  const app = new Koa();
  app.use(createJsonBodyParser());

  // 中间件顺序很关键：
  // 访问日志必须包在错误边界**外层**，这样错误边界把业务码写进 ctx.state 之后，
  // 日志的 finally 才能读到最终的 status 与 code，而不是笼统的 "ERROR"。
  app.use(requestIdMiddleware);
  app.use(createRequestLoggingMiddleware(logger));
  app.use(createErrorBoundaryMiddleware(logger));

  const router = new Router({ prefix: '/api/v1' });

  // --- health 路由（始终挂载） ---
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

  // --- 游戏目录只读路由（P0 stub，platform-events / game 模块落地后替换） ---
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
    if (!item) {
      throw new ApiError(GameErrorCode.GAME_NOT_FOUND, '未找到此游戏。');
    }
    const hall = item.difficultyHalls.find((entry) => entry.difficultyKey === ctx.params.difficultyKey && entry.enabled);
    if (!hall) {
      throw new ApiError(GameErrorCode.GAME_DIFFICULTY_NOT_FOUND, '未找到此难度厅。');
    }
    const ready = item.entryMode === 'LOCAL_PRACTICE' && item.game.isPlayable;
    setSuccess(ctx, {
      message: '难度准入检查完成',
      data: {
        gameKey: ctx.params.gameKey,
        difficultyKey: hall.difficultyKey,
        availability: ready ? ('READY' as const) : ('MODULE_UNAVAILABLE' as const),
        source: 'LOCAL_DEMO' as const,
        message: ready ? '本地练习可用；不扣金币、不进行真实结算。' : '该游戏模块尚未接入，当前不会扣除资产或创建游戏局。',
      },
      schema: GamePreflightResponseSchema,
      status: GameExperienceEndpoint.preflight.successStatus,
    });
  });

  // --- identity 路由（仅在模块装配后挂载） ---
  if (identityModule) {
    const authRouter = createAuthRoutes(identityModule);
    router.use(authRouter.routes(), authRouter.allowedMethods());

    const identityRouter = createIdentityRoutes(identityModule);
    router.use(identityRouter.routes(), identityRouter.allowedMethods());
  }

  // --- wallet 路由（identity + wallet 模块装配后挂载） ---
  if (identityModule && walletModule && sequelize) {
    const walletRouter = createWalletRoutes(walletModule, identityModule, sequelize);
    router.use(walletRouter.routes(), walletRouter.allowedMethods());
  }

  // --- payments 路由（identity + payments + sequelize 模块装配后挂载） ---
  if (identityModule && paymentsModule && sequelize) {
    const paymentsRouter = createPaymentsRoutes(paymentsModule, identityModule, sequelize);
    router.use(paymentsRouter.routes(), paymentsRouter.allowedMethods());
  }

  // --- rooms 路由（identity + rooms + sequelize 模块装配后挂载） ---
  if (identityModule && roomsModule && sequelize) {
    const roomsRouter = createRoomsRoutes(roomsModule, identityModule, sequelize);
    router.use(roomsRouter.routes(), roomsRouter.allowedMethods());
  }

  // --- social 路由（identity + social + sequelize 模块装配后挂载；社交无资金操作，无需 wallet） ---
  if (identityModule && socialModule && sequelize) {
    const socialRouter = createSocialRoutes(socialModule, identityModule, sequelize);
    router.use(socialRouter.routes(), socialRouter.allowedMethods());
  }

  // --- support 路由（identity + support + sequelize 模块装配后挂载；客服无资金操作，无需 wallet） ---
  if (identityModule && supportModule && sequelize) {
    const supportRouter = createSupportRoutes(supportModule, identityModule, sequelize);
    router.use(supportRouter.routes(), supportRouter.allowedMethods());
  }

  // --- referral 路由（identity + referral + sequelize 模块装配后挂载；归因无资金操作，不依赖 wallet） ---
  if (identityModule && referralModule && sequelize) {
    const referralRouter = createReferralRoutes(referralModule, identityModule, sequelize);
    router.use(referralRouter.routes(), referralRouter.allowedMethods());
  }

  app.use(router.routes());
  app.use(router.allowedMethods());

  // 兜底 404：路径未匹配任何路由时，Koa 默认返回纯文本 "Not Found"，
  // 与"所有 JSON API 都用同一 envelope"的约定冲突。这里统一转成失败 envelope。
  app.use(() => {
    throw new NotFoundError();
  });

  return app;
}

/** 简单 JSON body parser（不依赖第三方包；MIME 校验 + 64 KB 大小限制）。 */
function createJsonBodyParser(): Koa.Middleware {
  return async (ctx, next) => {
    if (ctx.is('application/json')) {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of ctx.req) {
        totalBytes += (chunk as Buffer).length;
        if (totalBytes > 64 * 1024) {
          ctx.status = 413;
          ctx.body = {
            requestId: ctx.state.requestId ?? '',
            code: 'PAYLOAD_TOO_LARGE',
            message: '请求体过大。',
            data: null,
            serverNow: new Date().toISOString(),
          };
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        (ctx as unknown as { request: { body?: unknown } }).request.body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        ctx.status = 400;
        ctx.body = {
          requestId: ctx.state.requestId ?? '',
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'JSON 解析失败。',
          data: null,
          serverNow: new Date().toISOString(),
        };
        return;
      }
    } else {
      (ctx as unknown as { request: { body?: unknown } }).request.body = {};
    }
    await next();
  };
}
