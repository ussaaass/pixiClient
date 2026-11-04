/**
 * /me/platform-events 路由（SDD §9 第 7 步：平台事件公告读路径；
 * 替换 /platform/announcements/active stub）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §5.4（GET /me/platform-events/active 端点）+
 * §9 第 7 步（平台事件公告：game_event_instance 活跃公告读 + 公告投影
 * wire，替换公告 stub）；contracts platform-events/announcement.ts
 * （ActivePlatformAnnouncementsDataSchema：announcements:
 * PlatformAnnouncement[] maxItems=100 + cursor 可选）。
 *
 * 端点：
 * - GET /me/platform-events/active （读全部活跃公告，200；
 *   经 ActiveAnnouncementsUseCase 读 game_event_instance 活跃公告，
 *   投影为 wire DTO，脱敏最小负载；0 行 → 空列表 200）
 *
 * 注意：本路由替换 app.ts `/platform/announcements/active` stub
 * （stub 保留不删，经 app.ts 挂载真实读路由；前端依赖路径保留双挂，
 * 登记决策点：Lead 确认是否双挂新旧路径）。
 */

import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import { Type } from '@sinclair/typebox';
import type { PlatformEventsModule, Tx } from '@gameing/backend/modules/platform-events/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';

// --- 响应 schema（对齐 contracts ActivePlatformAnnouncementsDataSchema） ---

const AnnouncementSchema = Type.Object(
  {
    announcementId: Type.String({ minLength: 1, maxLength: 128 }),
    eventType: Type.String({ minLength: 1, maxLength: 64 }),
    stateVersion: Type.Integer({ minimum: 1 }),
    kind: Type.Union([Type.Literal('EFFECT'), Type.Literal('BROADCAST_ONLY')]),
    titleKey: Type.String({ minLength: 1, maxLength: 64 }),
    safeParams: Type.Record(
      Type.String(),
      Type.Union([Type.String({ maxLength: 120 }), Type.Number({ minimum: -1000000000, maximum: 1000000000 })]),
    ),
    scope: Type.Array(
      Type.Union([
        Type.Object({ type: Type.Literal('GLOBAL_HALL') }, { additionalProperties: false }),
        Type.Object(
          { type: Type.Literal('GAME_HALL'), gameKey: Type.String({ minLength: 1, maxLength: 64 }) },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            type: Type.Literal('DIFFICULTY_HALL'),
            gameKey: Type.String({ minLength: 1, maxLength: 64 }),
            difficultyKey: Type.String({ minLength: 1, maxLength: 64 }),
          },
          { additionalProperties: false },
        ),
        Type.Object({ type: Type.Literal('GAME_SESSION') }, { additionalProperties: false }),
      ]),
      { minItems: 1, maxItems: 16 },
    ),
    startsAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
    expiresAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  },
  { additionalProperties: true }, // 允许 clickAction / publicActorLabel 可选扩展
);

const ActiveAnnouncementsResponseSchema = Type.Object(
  {
    announcements: Type.Array(AnnouncementSchema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  },
  { additionalProperties: false },
);

// --- 工具 ---

function requireUserId(state: AuthState): string {
  const uid = state.userId;
  if (uid === undefined) throw new ApiError('UNAUTHORIZED', '未认证。', { status: 401 });
  return uid;
}

// --- 路由工厂 ---

export function createPlatformEventsRoutes(module: PlatformEventsModule, identityModule: IdentityModule, _sequelize: Sequelize): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);

  const noTx: Tx = { transaction: null };

  // GET /me/platform-events/active（读全部活跃公告，200；0 行 → 空列表）
  router.get('/me/platform-events/active', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    void userId; // 读路径无用户隔离（登记决策点：Lead 确认是否需用户级公告过滤）
    const data = await module.activeAnnouncements.run(noTx);
    setSuccess(ctx, {
      message: '活跃公告列表',
      data,
      schema: ActiveAnnouncementsResponseSchema,
      status: 200,
    });
  });

  return router;
}
