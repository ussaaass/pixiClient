/**
 * /api/v1/auth + /api/v1/me/identity/* 路由（SDD §5.1 auth.routes.ts + identity.routes.ts）。
 *
 * auth 端点（匿名 / 会话）：
 * - POST /auth/device-register
 * - POST /auth/device-login
 * - POST /auth/password-login
 * - POST /auth/refresh
 * - POST /auth/logout
 * - POST /auth/recovery
 *
 * 身份设置端点（需玩家认证中间件）：
 * - GET  /me/identity/settings
 * - POST /me/identity/username
 * - POST /me/identity/password
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：`docs/04_domains/JWT登录与会话设计.md` §4/§5。
 */

import { createHash } from 'node:crypto';
import Router from '@koa/router';
import type { Context } from 'koa';
import {
  IdentityEndpoint,
  IdentitySettingsResponseSchema,
  LogoutResponseSchema,
  LoginChallengeResponseSchema,
  PasswordChangedResponseSchema,
  SessionResponseSchema,
} from '@gameing/contracts/identity';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';

/** 读取 ctx.request.body（经 app.ts 的 JSON body parser 注入；缺失时返回空对象）。 */
function getBody(ctx: Context): Record<string, unknown> {
  return (ctx as unknown as { request: { body?: Record<string, unknown> } }).request.body ?? {};
}

// ------------------------------------------------------------------
// auth 路由组（匿名，挂载 /auth 前缀）
// ------------------------------------------------------------------

export function createAuthRoutes(module: IdentityModule): Router {
  const router = new Router({ prefix: '/auth' });

  // POST /auth/device-register
  router.post('/device-register', async (ctx: Context) => {
    const request = getBody(ctx);
    if (!request.deviceCode || !request.fingerprintVersion) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'deviceCode / fingerprintVersion 必填。', {
        status: 400,
      });
    }
    // device-register：路由层负责解析 user/device 两行（upsert device）再调用例。
    // 本版本要求请求携带 userId（App 端由设备凭证上下文推导，Web 端首访由邀请码/匿名会话关联）。
    const userId = (request.userId as string) ?? '';
    if (!userId) {
      throw new ApiError(
        'REQUEST_VALIDATION_FAILED',
        'userId 必填（本版本需显式传入；后续 App 端由设备凭证推导）。',
        { status: 400 },
      );
    }
    const user = await module.repository.findUserById(userId, { transaction: null });
    if (user === null) {
      throw new ApiError('USER_NOT_FOUND', '用户不存在。', { status: 404 });
    }
    // upsert device 行（首版简化：fingerprintHash 用 sha256(deviceCode) 代替完整指纹向量，
    // platformType=1（WEB）；后续补全真实指纹采集）。
    const fingerprintHash = createHash('sha256')
      .update(`${request.fingerprintVersion}:${request.deviceCode}`)
      .digest();
    const device = await module.repository.upsertDevice(
      {
        userId,
        fingerprintHash,
        deviceDigest: new Uint8Array(0),
        credentialKey: request.deviceCode as string,
        credentialSecretHash: null,
        credentialStatus: 1, // ACTIVE
        credentialExpiresAt: null,
        credentialRevokedAt: null,
        platformType: 1, // WEB
        lastSeenAt: new Date(),
      },
      { transaction: null },
    );
    const result = await module.deviceRegister.run(
      {
        request: request as never,
        principalType: 'PLAYER',
        audience: 'player',
        user,
        device,
      },
      { transaction: null },
    );
    setAuthCookies(ctx, result);
    setSuccess(ctx, {
      message: '设备注册成功',
      data: result,
      schema: SessionResponseSchema as never,
      status: IdentityEndpoint.deviceRegister.successStatus,
    });
  });

  // POST /auth/device-login
  router.post('/device-login', async (ctx: Context) => {
    const body = getBody(ctx);
    if (!body.userId || !body.deviceDigestHex || !body.credentialKey) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'userId / deviceDigestHex / credentialKey 均为必填。', {
        status: 400,
      });
    }
    const result = await module.deviceLogin.run(
      {
        ctx: {
          userId: body.userId as string,
          deviceDigestHex: body.deviceDigestHex as string,
          credentialKey: body.credentialKey as string,
          principalType: 'PLAYER',
          audience: 'player',
        },
      },
      { transaction: null },
    );
    setAuthCookies(ctx, result);
    setSuccess(ctx, {
      message: '设备登录成功',
      data: result,
      schema: SessionResponseSchema as never,
      status: IdentityEndpoint.deviceLogin.successStatus,
    });
  });

  // POST /auth/password-login
  router.post('/password-login', async (ctx: Context) => {
    const request = getBody(ctx);
    if (!request.identifier || !request.password) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'identifier / password 必填。', {
        status: 400,
      });
    }
    const result = await module.passwordLogin.run(
      {
        request: request as never,
        ctx: {
          deviceId: null,
          principalType: 'PLAYER',
          audience: 'player',
        },
      },
      { transaction: null },
    );
    if (result.kind === 'CHALLENGE') {
      setSuccess(ctx, {
        message: '需要 TOTP 二次验证',
        data: result.response,
        schema: LoginChallengeResponseSchema as never,
        status: 200,
      });
    } else {
      setAuthCookies(ctx, result.response);
      setSuccess(ctx, {
        message: '登录成功',
        data: result.response,
        schema: SessionResponseSchema as never,
        status: IdentityEndpoint.passwordLogin.successStatus,
      });
    }
  });

  // POST /auth/refresh（HttpOnly Cookie 双值：sid + refresh token）
  router.post('/refresh', async (ctx: Context) => {
    const cookie = ctx.get('Cookie');
    const refreshMatch = cookie.match(/refresh_token=([^;]+)/);
    const sidMatch = cookie.match(/sid=([^;]+)/);
    if (!refreshMatch?.[1] || !sidMatch?.[1]) {
      throw new ApiError('REFRESH_INVALID', 'refresh token / sid cookie 缺失。', {
        status: 401,
      });
    }
    const operationId = (getBody(ctx).operationId as string) ?? '';
    const result = await module.refresh.run(
      {
        refreshToken: refreshMatch[1],
        sid: sidMatch[1],
        operationId,
        ctx: {
          principalType: 'PLAYER',
          audience: 'player',
        },
      },
      { transaction: null },
    );
    setAuthCookies(ctx, result);
    setSuccess(ctx, {
      message: '会话已刷新',
      data: result,
      schema: SessionResponseSchema as never,
      status: IdentityEndpoint.refresh.successStatus,
    });
  });

  // POST /auth/logout（需已认证会话）
  router.post(
    '/logout',
    createPlayerAuthMiddleware(module),
    async (ctx) => {
      const state = ctx.state as AuthState;
      if (!state.sid || !state.userId) {
        throw new ApiError('UNAUTHORIZED', '会话上下文缺失。', { status: 401 });
      }
      const result = await module.logout.run(
        {
          sid: state.sid,
          userId: state.userId,
          deviceId: state.deviceId ?? null,
        },
        { transaction: null },
      );
      clearAuthCookies(ctx);
      setSuccess(ctx, {
        message: '已登出',
        data: result,
        schema: LogoutResponseSchema as never,
        status: IdentityEndpoint.logout.successStatus,
      });
    },
  );

  // POST /auth/recovery
  router.post('/recovery', async (ctx: Context) => {
    const request = getBody(ctx);
    if (!request.credentialId || !request.recoverySecret) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'credentialId / recoverySecret 必填。', {
        status: 400,
      });
    }
    const result = await module.recovery.run(
      {
        request: request as never,
        ctx: {
          principalType: 'PLAYER',
          audience: 'player',
          deviceId: null,
        },
      },
      { transaction: null },
    );
    setAuthCookies(ctx, result);
    setSuccess(ctx, {
      message: '账号恢复成功',
      data: result,
      schema: SessionResponseSchema as never,
      status: IdentityEndpoint.recovery.successStatus,
    });
  });

  return router;
}

// ------------------------------------------------------------------
// me/identity 路由组（需玩家认证中间件）
// ------------------------------------------------------------------

export function createIdentityRoutes(module: IdentityModule): Router {
  const router = new Router({ prefix: '/me/identity' });
  const auth = createPlayerAuthMiddleware(module);

  // GET /me/identity/settings
  router.get('/settings', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const result = await module.identitySettings.getSettings(
      { userId: state.userId ?? '', sessionKey: state.sid ?? null, deviceId: state.deviceId ?? null },
      { transaction: null },
    );
    setSuccess(ctx, {
      message: '身份设置快照',
      data: result,
      schema: IdentitySettingsResponseSchema as never,
      status: IdentityEndpoint.identitySettings.successStatus,
    });
  });

  // POST /me/identity/username
  router.post('/username', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const body = getBody(ctx);
    if (!body.username) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'username 必填。', { status: 400 });
    }
    const result = await module.identitySettings.setUsername(
      body as never,
      { userId: state.userId ?? '', sessionKey: state.sid ?? null, deviceId: state.deviceId ?? null },
      { transaction: null },
    );
    setSuccess(ctx, {
      message: '用户名已更新',
      data: result,
      schema: IdentitySettingsResponseSchema as never,
      status: 200,
    });
  });

  // POST /me/identity/password
  router.post('/password', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const body = getBody(ctx);
    if (!body.newPassword) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'newPassword 必填。', { status: 400 });
    }
    const result = await module.identitySettings.changePassword(
      body as never,
      { userId: state.userId ?? '', sessionKey: state.sid ?? null, deviceId: state.deviceId ?? null },
      { transaction: null },
    );
    setSuccess(ctx, {
      message: '密码已更新，所有设备会话已撤销。',
      data: result,
      schema: PasswordChangedResponseSchema as never,
      status: 200,
    });
  });

  return router;
}

// ------------------------------------------------------------------
// HttpOnly Cookie 助手（§2 浏览器端约定）
// ------------------------------------------------------------------

function setAuthCookies(ctx: Context, result: { accessToken: string; expiresAt: string }): void {
  // access token 通过 envelope 响应传递（客户端存内存）；
  // sid 走 HttpOnly Cookie（浏览器端无法读明文 refresh token，仅存会话标识）。
  const sid = (result as unknown as { sid?: string }).sid;
  const maxAgeMs = 7 * 24 * 3600 * 1000; // 空闲 7 天（§1 建议）
  ctx.cookie('sid', String(sid ?? ''), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1',
    maxAge: maxAgeMs,
  });
}

function clearAuthCookies(ctx: Context): void {
  ctx.cookies.set('sid', '', { httpOnly: true, maxAge: 0, path: '/api/v1' });
  ctx.cookies.set('refresh_token', '', { httpOnly: true, maxAge: 0, path: '/api/v1' });
}
