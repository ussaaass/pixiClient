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
 * - GET  /me/identity-settings
 * - POST /me/identity/username
 * - POST /me/identity/password
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：`docs/04_domains/JWT登录与会话设计.md` §4/§5。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import Router from '@koa/router';
import { Value } from '@sinclair/typebox/value';
import type { Context } from 'koa';
import {
  IdentityEndpoint,
  IdentitySettingsResponseSchema,
  LogoutResponseSchema,
  LoginChallengeResponseSchema,
  PasswordChangedResponseSchema,
  SessionResponseSchema,
  RefreshRequestSchema,
  DeviceLoginRequestSchema,
} from '@gameing/contracts/identity';
import { DomainError, toPublicSession, type IdentityModule, type SessionResult } from '@gameing/backend/modules/identity/public';
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
    ctx.set('Cache-Control', 'no-store');
    assertSameOrigin(ctx);
    // Keep production provisioning disabled until MySQL/Redis fault-injection and browser
    // acceptance prove the complete recovery path. Enabling is an explicit deployment action.
    if (process.env.AUTH_DEVICE_REGISTER_ENABLED !== 'true') {
      throw new ApiError('IDENTITY_STORAGE_UNAVAILABLE', '匿名设备注册尚未通过部署验收。', { status: 503 });
    }
    const request = getBody(ctx);
    const endpoint = IdentityEndpoint.deviceRegister;
    if (!Value.Check(endpoint.request, request)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'device-register 请求不符合契约。', { status: 400 });
    }
    const idempotencyKey = ctx.get('Idempotency-Key');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(idempotencyKey)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'Idempotency-Key 格式无效。', { status: 400 });
    }
    let result;
    try {
      result = await module.anonymousDeviceRegistration.run({
        request: request as never,
        idempotencyKey,
        audience: 'player',
      });
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === 'IDEMPOTENCY_KEY_REUSED')
          throw new ApiError(error.code, 'Idempotency-Key 已用于不同注册请求。', { status: 409 });
        throw new ApiError(error.code, '匿名注册暂不可用，请复用原 Idempotency-Key 重试。', { status: 503 });
      }
      throw new ApiError('IDENTITY_STORAGE_UNAVAILABLE', '匿名注册暂不可用，请复用原 Idempotency-Key 重试。', { status: 503 });
    }
    setAuthCookies(ctx, result.sessionResult);
    setDeviceCookie(ctx, result.deviceCookie, result.credentialExpiresAt);
    setSuccess(ctx, {
      message: '匿名账号注册成功',
      data: toPublicSession(result.sessionResult),
      schema: SessionResponseSchema as never,
      status: endpoint.successStatus,
    });
  });

  // POST /auth/device-login
  router.post('/device-login', async (ctx: Context) => {
    const body = getBody(ctx);
    if (!Value.Check(DeviceLoginRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'device-login 请求不符合 cookie-only 契约。', { status: 400 });
    }
    const deviceCredential = parseDeviceCredentialCookie(ctx.get('Cookie'));
    if (!deviceCredential) {
      throw new ApiError('UNAUTHORIZED', '设备凭证无效。', { status: 401 });
    }
    let result: SessionResult;
    try {
      result = await module.deviceLogin.run(
        {
          ctx: {
            deviceDigestHex: createHash('sha256').update(deviceCredential.secret, 'utf8').digest('hex'),
            credentialKey: deviceCredential.credentialKey,
            principalType: 'PLAYER',
            audience: 'player',
          },
          rateLimitSubject: deviceCredential.credentialKey,
        },
        { transaction: null },
      );
    } catch (error) {
      if (error instanceof DomainError) throw mapDeviceLoginError(error);
      throw error;
    }
    setAuthCookies(ctx, result);
    setSuccess(ctx, {
      message: '设备登录成功',
      data: toPublicSession(result),
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
        data: toPublicSession(result.response),
        schema: SessionResponseSchema as never,
        status: IdentityEndpoint.passwordLogin.successStatus,
      });
    }
  });

  // POST /auth/refresh（HttpOnly Cookie 双值：sid + refresh token）
  router.post('/refresh', async (ctx: Context) => {
    ctx.set('Cache-Control', 'no-store');
    assertSameOrigin(ctx);
    const cookies = parseAuthCookies(ctx.get('Cookie'));
    if (!cookies.refreshToken || !cookies.sid) {
      throw new ApiError('REFRESH_INVALID', 'refresh token / sid cookie 缺失。', {
        status: 401,
      });
    }
    const refreshRequest = getBody(ctx);
    if (!Value.Check(RefreshRequestSchema, refreshRequest)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '刷新请求格式非法。', { status: 400 });
    }
    const operationId = refreshRequest.operationId as string;
    const result = await module.refresh.run(
      {
        refreshToken: cookies.refreshToken,
        sid: cookies.sid,
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
      data: toPublicSession(result),
      schema: SessionResponseSchema as never,
      status: IdentityEndpoint.refresh.successStatus,
    });
  });

  // POST /auth/logout（需已认证会话）
  router.post('/logout', createPlayerAuthMiddleware(module), async (ctx) => {
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
  });

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
      data: toPublicSession(result),
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
  const router = new Router({ prefix: '/me' });
  const auth = createPlayerAuthMiddleware(module);

  // GET /me/identity-settings
  router.get('/identity-settings', auth, async (ctx) => {
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
  router.post('/identity/username', auth, async (ctx) => {
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
  router.post('/identity/password', auth, async (ctx) => {
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

function mapDeviceLoginError(error: DomainError): ApiError {
  // Collapse credential-specific denials to avoid leaking key existence/status to an unauthenticated caller.
  if (
    error.code === 'DEVICE_CREDENTIAL_MISSING' ||
    error.code === 'DEVICE_CREDENTIAL_REVOKED' ||
    error.code === 'DEVICE_CREDENTIAL_EXPIRED' ||
    error.code === 'INVALID_CREDENTIALS'
  ) {
    return new ApiError('UNAUTHORIZED', '设备凭证无效。', { status: 401, cause: error });
  }
  if (error.code === 'AUTH_RATE_LIMITED') {
    return new ApiError('RATE_LIMITED', '请求过于频繁，请稍后重试。', { status: 429, retryable: true, cause: error });
  }
  if (error.code === 'ACCOUNT_LOCKED') {
    return new ApiError('FORBIDDEN', '账号当前不可用。', { status: 403, cause: error });
  }
  return new ApiError('INTERNAL_ERROR', '服务暂时不可用，请稍后重试。', { status: 500, cause: error });
}

export function parseDeviceCredentialCookie(header: string): { credentialKey: string; secret: string } | null {
  let cookieValue: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== 'device') continue;
    if (cookieValue !== undefined) return null;
    cookieValue = part.slice(separator + 1).trim();
  }
  if (!cookieValue) return null;
  const delimiter = cookieValue.indexOf('.');
  if (delimiter < 0 || delimiter !== cookieValue.lastIndexOf('.')) return null;
  const credentialKey = cookieValue.slice(0, delimiter);
  const secret = cookieValue.slice(delimiter + 1);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(credentialKey) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
  return { credentialKey, secret };
}

export function parseAuthCookies(header: string): { sid: string | null; refreshToken: string | null } {
  const values = new Map<string, string>();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== 'sid' && name !== 'refresh_token') continue;
    if (values.has(name)) return { sid: null, refreshToken: null };
    values.set(name, part.slice(separator + 1).trim());
  }
  return { sid: values.get('sid') || null, refreshToken: values.get('refresh_token') || null };
}

function assertSameOrigin(ctx: Context): void {
  const origin = ctx.get('Origin');
  // Proxy-facing deployments must configure the canonical external origin explicitly;
  // never derive a security decision from an untrusted Host/X-Forwarded-* header.
  const expected = process.env.AUTH_PUBLIC_ORIGIN;
  if (!expected || !origin || !safeEqual(origin, expected)) {
    throw new ApiError('UNAUTHORIZED', '刷新请求 Origin 校验失败。', { status: 403 });
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function setDeviceCookie(ctx: Context, value: string, expiresAt: string): void {
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) throw new ApiError('IDENTITY_STORAGE_UNAVAILABLE', '设备凭证到期时间无效。', { status: 503 });
  const maxAge = Math.max(0, expiryMs - Date.now());
  ctx.set('Cache-Control', 'no-store');
  ctx.cookies.set('device', value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1/auth/device-login',
    maxAge,
    expires: new Date(expiryMs),
  });
}

function setAuthCookies(ctx: Context, result: SessionResult): void {
  ctx.set('Cache-Control', 'no-store');
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/api/v1',
    maxAge: 7 * 24 * 3600 * 1000,
  };
  ctx.cookies.set('sid', result.sid, options);
  ctx.cookies.set('refresh_token', result.refreshToken, options);
}

function clearAuthCookies(ctx: Context): void {
  const options = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 0, path: '/api/v1' };
  ctx.cookies.set('sid', '', options);
  ctx.cookies.set('refresh_token', '', options);
}
