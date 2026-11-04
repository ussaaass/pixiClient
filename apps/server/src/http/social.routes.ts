/**
 * /api/v1/social + /me/social 社交路由（SDD §5.4 social 端点）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §5.4（social 端点清单）+ §6.3（消息 outbox→Socket 双端投递，
 * 先持久化后推送，断线补拉走 HTTP 游标）。
 *
 * 端点：
 * - POST   /social/posts                       （创建帖子，201；重放 200）
 * - POST   /social/posts/:postId/replies       （创建回复，201）
 * - POST   /me/social/conversations            （创建/查询双人会话，201/200）
 * - POST   /me/social/conversations/:id/messages （发送消息，201/200 重放）
 * - GET    /me/social/conversations/:id/messages （游标补拉，200）
 * - POST   /me/social/friendships              （好友操作，201/200）
 *
 * 断线补拉：GET /me/social/conversations/:id/messages?afterMessageNo=…（游标分页，首版 50/页）。
 * 审核/屏蔽/举报端点归 §9 第 9 步 Admin 模块。
 */

import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import { Value } from '@gameing/contracts/wallet';
import type { SocialModule, Tx, OutboxPort } from '@gameing/backend/modules/social/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';

// --- 请求 schema ---

const CreatePostRequestSchema = Type.Object(
  {
    topicKey: Type.String({ minLength: 1, maxLength: 64 }),
    title: Type.Optional(Type.String({ maxLength: 160 })),
    body: Type.Optional(Type.String()),
    assetIds: Type.Optional(Type.Array(Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), { maxItems: 20 })),
    agentDomainId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);

const CreatePostResponseSchema = Type.Object(
  {
    postId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  },
  { additionalProperties: false },
);

const CreateReplyRequestSchema = Type.Object(
  {
    body: Type.Optional(Type.String()),
    parentReplyId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
    assetIds: Type.Optional(Type.Array(Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), { maxItems: 20 })),
  },
  { additionalProperties: false },
);

const CreateReplyResponseSchema = Type.Object(
  {
    replyId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  },
  { additionalProperties: false },
);

const CreateConversationRequestSchema = Type.Object(
  {
    peerUserId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    agentDomainId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);

const ConversationCreatedResponseSchema = Type.Object(
  {
    conversationId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    lowUserId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    highUserId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    lastMessageNo: Type.String({ pattern: '^[0-9]{1,20}$' }),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SendMessageRequestSchema = Type.Object(
  {
    clientMessageId: Type.String({ minLength: 1, maxLength: 160 }),
    bodyText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    assetId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
    messageType: Type.Union([Type.Literal(1), Type.Literal(2)]),
  },
  { additionalProperties: false },
);

const MessageSentResponseSchema = Type.Object(
  {
    messageId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    messageNo: Type.String({ pattern: '^[0-9]{1,20}$' }),
    status: Type.String(),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const MessageListResponseSchema = Type.Object(
  {
    messages: Type.Array(
      Type.Object(
        {
          messageId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
          messageNo: Type.String({ pattern: '^[0-9]{1,20}$' }),
          senderUserId: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()]),
          bodyText: Type.Union([Type.String(), Type.Null()]),
          messageType: Type.Integer({ minimum: 1 }),
          status: Type.Integer({ minimum: 1 }),
          createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    hasMore: Type.Boolean(),
  },
  { additionalProperties: false },
);

const FriendshipRequestSchema = Type.Object(
  {
    action: Type.Union([Type.Literal('initiate'), Type.Literal('accept'), Type.Literal('reject')]),
    peerUserId: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()]),
    friendshipId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
    agentDomainId: Type.Optional(Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);

const FriendshipResponseSchema = Type.Object(
  {
    friendshipId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    status: Type.String(),
    inserted: Type.Boolean(),
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

async function submitInTx<T>(module: SocialModule, sequelize: Sequelize, fn: (tx: Tx, outbox: OutboxPort) => Promise<T>): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    const tx: Tx = { transaction };
    const outbox = await module.withTx({ transaction }, (o) => o);
    return fn(tx, outbox);
  });
}

// --- 路由工厂 ---

export function createSocialRoutes(module: SocialModule, identityModule: IdentityModule, sequelize: Sequelize): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);

  // POST /social/posts（创建帖子，201；重放 200）
  router.post('/social/posts', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(CreatePostRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx, _outbox) => {
      return module.postCreate.run({
        userId,
        agentDomainId: (body.agentDomainId as string | null) ?? null,
        topicKey: body.topicKey as string,
        title: (body.title as string) ?? null,
        body: (body.body as string) ?? null,
        assetIds: (body.assetIds as string[]) ?? [],
        postKey: `post:${userId}:${randomUUID()}`,
        tx,
      });
    });
    setSuccess(ctx, {
      message: result.inserted ? '帖子已存在（幂等重放）' : '帖子已创建',
      data: result,
      schema: CreatePostResponseSchema,
      status: result.inserted ? 200 : 201,
    });
  });

  // POST /social/posts/:postId/replies（创建回复，201）
  router.post('/social/posts/:postId/replies', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const postId = ctx.params.postId;
    if (postId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const body = getBody(ctx);
    if (!Value.Check(CreateReplyRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx) => {
      return module.postReply.run({
        userId,
        postId,
        parentReplyId: (body.parentReplyId as string | null) ?? null,
        body: (body.body as string) ?? null,
        assetIds: (body.assetIds as string[]) ?? [],
        replyKey: `reply:${userId}:${postId}:${randomUUID()}`,
        tx,
      });
    });
    setSuccess(ctx, {
      message: result.inserted ? '回复已存在（幂等重放）' : '回复已创建',
      data: result,
      schema: CreateReplyResponseSchema,
      status: result.inserted ? 200 : 201,
    });
  });

  // POST /me/social/conversations（创建/查询双人会话，201/200）
  router.post('/me/social/conversations', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(CreateConversationRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx) => {
      return module.conversationCreate.run({
        userId,
        peerUserId: body.peerUserId as string,
        agentDomainId: (body.agentDomainId as string | null) ?? null,
        tx,
      });
    });
    setSuccess(ctx, {
      message: result.inserted ? '会话已存在（幂等重放）' : '会话已创建',
      data: result,
      schema: ConversationCreatedResponseSchema,
      status: result.inserted ? 200 : 201,
    });
  });

  // POST /me/social/conversations/:id/messages（发送消息，201/200 重放）
  router.post('/me/social/conversations/:id/messages', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const conversationId = ctx.params.id;
    if (conversationId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const body = getBody(ctx);
    if (!Value.Check(SendMessageRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx, _outbox) => {
      return module.messageSend.run({
        userId,
        conversationId,
        clientMessageId: body.clientMessageId as string,
        bodyText: (body.bodyText as string | null) ?? null,
        assetId: (body.assetId as string | null) ?? null,
        messageType: body.messageType as number,
        tx,
      });
    });
    setSuccess(ctx, {
      message: result.inserted ? '消息已存在（幂等重放）' : '消息已发送',
      data: result,
      schema: MessageSentResponseSchema,
      status: result.inserted ? 200 : 201,
    });
  });

  // GET /me/social/conversations/:id/messages（游标补拉，200）
  router.get('/me/social/conversations/:id/messages', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const conversationId = ctx.params.id;
    if (conversationId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const afterMessageNo = (ctx.query.afterMessageNo as string) ?? null;
    const result = await module.messageList.run({ userId, conversationId, afterMessageNo }, { transaction: null });
    setSuccess(ctx, {
      message: '消息列表',
      data: result,
      schema: MessageListResponseSchema,
      status: 200,
    });
  });

  // POST /me/social/friendships（好友操作，201/200）
  router.post('/me/social/friendships', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(FriendshipRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const action = body.action as string;
    const result = await submitInTx(module, sequelize, async (tx) => {
      if (action === 'initiate') {
        return module.friendship.initiate({
          userId,
          peerUserId: (body.peerUserId as string) ?? '',
          agentDomainId: (body.agentDomainId as string | null) ?? null,
          tx,
        });
      } else if (action === 'accept') {
        return module.friendship.accept({
          userId,
          friendshipId: (body.friendshipId as string) ?? '',
          tx,
        });
      } else {
        return module.friendship.reject({
          userId,
          friendshipId: (body.friendshipId as string) ?? '',
          tx,
        });
      }
    });
    setSuccess(ctx, {
      message: '好友操作完成',
      data: result,
      schema: FriendshipResponseSchema,
      status: result.inserted ? 200 : 201,
    });
  });

  return router;
}
