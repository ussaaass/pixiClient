/**
 * /me/support + /admin/support 客服路由（SDD §5.4 support 端点）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §5.4（support 端点清单）+ §6.3（消息 outbox→Socket
 * 双端投递，先持久化后推送，断线补拉走 HTTP）。
 *
 * 端点：
 * - POST /me/support/conversations                （创建工单，201）
 * - GET  /me/support/conversations                （列出用户工单，200）
 * - POST /admin/support/conversations/:id/claim  （坐席领取，200；重放幂等）
 * - POST /support/conversations/:id/messages     （用户/坐席回复，201/200）
 * - POST /support/conversations/:id/resolve      （坐席关闭，200）
 *
 * Admin 端路由（claim/resolve）首版简化：同玩家 token + role_type 校验；
 * 完整 Admin audience 中间件归 §9 第 9 步。
 */

import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import { Value } from '@gameing/contracts/wallet';
import type { SupportModule, Tx, OutboxPort } from '@gameing/backend/modules/support/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { AdminModule, SupportAdminAction } from '@gameing/backend/modules/admin/public';
import { createAdminAuthMiddleware, type AdminAuthState } from '../infrastructure/auth/admin-auth-middleware.js';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';

// --- 请求 schema ---

const CreateTicketRequestSchema = Type.Object(
  {
    categoryType: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
    subject: Type.String({ minLength: 1, maxLength: 160 }),
    bodyText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    orderId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
    withdrawalId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);

const CreateTicketResponseSchema = Type.Object(
  {
    conversationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  },
  { additionalProperties: false },
);

const TicketListResponseSchema = Type.Object(
  {
    conversations: Type.Array(
      Type.Object(
        {
          conversationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
          categoryType: Type.Integer({ minimum: 1 }),
          subject: Type.String(),
          status: Type.Integer({ minimum: 1 }),
          lastMessageAt: Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }), Type.Null()]),
          createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
          updatedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

const ClaimResponseSchema = Type.Object(
  {
    conversationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    assignedAdminUserId: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()]),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const ReplyRequestSchema = Type.Object(
  {
    bodyText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    messageType: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)]),
    /** 坐席侧回复时指定 senderType=ADMIN=2；用户回复默认 CUSTOMER=1。 */
    senderType: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)])),
  },
  { additionalProperties: false },
);

const ReplyResponseSchema = Type.Object(
  {
    messageId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const ResolveResponseSchema = Type.Object(
  {
    conversationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    closedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  },
  { additionalProperties: false },
);

// --- 工具 ---

function getBody(ctx: Context): Record<string, unknown> {
  return (ctx as unknown as { request: { body?: Record<string, unknown> } }).request.body ?? {};
}

function requireUserId(state: AuthState): string {
  const uid = state.userId;
  if (uid === undefined) throw new ApiError('UNAUTHORIZED', '未认证。', { status: 401 });
  return uid;
}

async function submitInTx<T>(module: SupportModule, sequelize: Sequelize, fn: (tx: Tx, outbox: OutboxPort) => Promise<T>): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    const tx: Tx = { transaction };
    const outbox = await module.withTx({ transaction }, (o) => o);
    return fn(tx, outbox);
  });
}

// --- 路由工厂 ---

export function createSupportRoutes(
  module: SupportModule,
  identityModule: IdentityModule,
  adminModule: AdminModule,
  sequelize: Sequelize,
): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);
  const adminAuth = createAdminAuthMiddleware(identityModule, adminModule);
  const authorizeSupportAction = async (adminUserId: string, action: SupportAdminAction, tx: { transaction?: unknown }): Promise<void> => {
    const allowed = await adminModule.supportCapabilityAuthorize.run({
      adminUserId,
      action,
      tx: { transaction: tx.transaction as never },
    });
    if (!allowed) throw new ApiError('FORBIDDEN', '缺少此客服操作权限。', { status: 403 });
  };

  // POST /me/support/conversations（创建工单，201）
  router.post('/me/support/conversations', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(CreateTicketRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx, _outbox) => {
      return module.ticketCreate.run({
        userId,
        categoryType: body.categoryType as number,
        subject: body.subject as string,
        bodyText: (body.bodyText as string | null) ?? null,
        messageKey: `ticket:${userId}:${randomUUID()}`,
        orderId: (body.orderId as string | null) ?? null,
        withdrawalId: (body.withdrawalId as string | null) ?? null,
        tx,
      });
    });
    setSuccess(ctx, {
      message: '工单已创建',
      data: result,
      schema: CreateTicketResponseSchema,
      status: 201,
    });
  });

  // GET /me/support/conversations（列出用户工单，200）
  router.get('/me/support/conversations', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const result = await module.ticketList.run({ userId, tx: { transaction: null } });
    setSuccess(ctx, {
      message: '工单列表',
      data: result,
      schema: TicketListResponseSchema,
      status: 200,
    });
  });

  // POST /admin/support/conversations/:id/claim（坐席领取，200；重放幂等）
  // 首版简化：同玩家 token + role_type 校验（完整 Admin audience 中间件归 §9 第 9 步）
  router.post('/admin/support/conversations/:id/claim', adminAuth, async (ctx) => {
    const adminUserId = (ctx.state as AdminAuthState).adminUserId;
    if (adminUserId === undefined) throw new ApiError('AD_ADMIN_UNAUTHORIZED', '未认证。', { status: 401 });
    const conversationId = ctx.params.id;
    if (conversationId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const result = await submitInTx(module, sequelize, async (tx) => {
      await authorizeSupportAction(adminUserId, 'claim', tx);
      return module.ticketClaim.run({
        conversationId,
        adminUserId,
        adminRoleType: 4,
        tx,
      });
    });
    setSuccess(ctx, {
      message: result.inserted ? '坐席已领取（幂等重放）' : '坐席已领取工单',
      data: result,
      schema: ClaimResponseSchema,
      status: 200,
    });
  });

  // POST /support/conversations/:id/messages（用户/坐席回复，201/200）
  router.post('/support/conversations/:id/messages', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const conversationId = ctx.params.id;
    if (conversationId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const body = getBody(ctx);
    if (!Value.Check(ReplyRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    // Player-auth endpoint is customer-only: sender kind is server-owned and must not
    // select the staff/system authorization branch. Admin/SYSTEM messages require a
    // separately authenticated internal/Admin endpoint (not this player route).
    if (body.senderType !== undefined && body.senderType !== 1) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '用户端不允许指定客服或系统发信人类型。', { status: 400 });
    }
    const senderType = 1; // CUSTOMER=1; never trust caller to select another actor
    const result = await submitInTx(module, sequelize, async (tx, outbox) => {
      return module.ticketReply.run({
        userId,
        conversationId,
        bodyText: (body.bodyText as string | null) ?? null,
        messageKey: `sup:${userId}:${randomUUID()}`,
        messageType: (body.messageType as number) ?? 1,
        senderType,
        senderUserId: userId,
        tx,
        outbox,
      });
    });
    setSuccess(ctx, {
      message: result.inserted ? '消息已存在（幂等重放）' : '消息已发送',
      data: result,
      schema: ReplyResponseSchema,
      status: result.inserted ? 200 : 201,
    });
  });

  // POST /support/conversations/:id/resolve（坐席关闭，200）
  router.post('/support/conversations/:id/resolve', adminAuth, async (ctx) => {
    const adminUserId = (ctx.state as AdminAuthState).adminUserId;
    if (adminUserId === undefined) throw new ApiError('AD_ADMIN_UNAUTHORIZED', '未认证。', { status: 401 });
    const conversationId = ctx.params.id;
    if (conversationId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const result = await submitInTx(module, sequelize, async (tx) => {
      await authorizeSupportAction(adminUserId, 'resolve', tx);
      return module.ticketResolve.run({
        adminUserId,
        adminRoleType: 4,
        conversationId,
        tx,
      });
    });
    setSuccess(ctx, {
      message: '工单已关闭',
      data: result,
      schema: ResolveResponseSchema,
      status: 200,
    });
  });

  return router;
}
