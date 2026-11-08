import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Koa from 'koa';
import { createAuthRoutes, parseDeviceCredentialCookie } from './auth.routes.js';
import { IdentityEndpoint } from '@gameing/contracts/identity';
import { DomainError } from '@gameing/backend/modules/identity/public';

function createModuleMock() {
  const findUserById = vi.fn();
  const upsertDevice = vi.fn();
  const run = vi.fn();
  const deviceLoginRun = vi.fn();
  const refreshRun = vi.fn();
  const anonymousDeviceRegistrationRun = vi.fn();
  return {
    module: {
      repository: { findUserById, upsertDevice },
      deviceRegister: { run },
      anonymousDeviceRegistration: { run: anonymousDeviceRegistrationRun },
      deviceLogin: { run: deviceLoginRun },
      refresh: { run: refreshRun },
    } as never,
    findUserById,
    upsertDevice,
    run,
    anonymousDeviceRegistrationRun,
    deviceLoginRun,
    refreshRun,
  };
}

describe('device credential cookie parser', () => {
  it('accepts one well-formed key.secret cookie and rejects missing, duplicate, or malformed values', () => {
    const cookie = `device=credential-key-123456.${'secret-value-0123456789abcdef'.repeat(2)}`;
    expect(parseDeviceCredentialCookie(cookie)).toEqual({
      credentialKey: 'credential-key-123456',
      secret: 'secret-value-0123456789abcdef'.repeat(2),
    });
    expect(parseDeviceCredentialCookie('')).toBeNull();
    expect(parseDeviceCredentialCookie(`${cookie}; ${cookie}`)).toBeNull();
    expect(parseDeviceCredentialCookie('device=legacy-device-code')).toBeNull();
    expect(parseDeviceCredentialCookie('device=credential-key-123456.short')).toBeNull();
  });
});

describe('POST /auth/device-register', () => {
  const previousOrigin = process.env.AUTH_PUBLIC_ORIGIN;
  const previousNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.AUTH_PUBLIC_ORIGIN = 'http://127.0.0.1';
  });
  const previousRegistrationFlag = process.env.AUTH_DEVICE_REGISTER_ENABLED;
  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousOrigin === undefined) delete process.env.AUTH_PUBLIC_ORIGIN;
    else process.env.AUTH_PUBLIC_ORIGIN = previousOrigin;
    if (previousRegistrationFlag === undefined) delete process.env.AUTH_DEVICE_REGISTER_ENABLED;
    else process.env.AUTH_DEVICE_REGISTER_ENABLED = previousRegistrationFlag;
  });

  it('keeps anonymous provisioning fail-closed until explicit deployment acceptance', async () => {
    delete process.env.AUTH_DEVICE_REGISTER_ENABLED;
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      if (chunks.length) (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1', 'Idempotency-Key': 'registration-key-123456' },
      body: JSON.stringify({
        fingerprintVersion: 'v1',
        deviceCode: '0123456789abcdef0123456789abcdef',
        deviceSummary: { platform: 'web', browser: 'test' },
      }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.anonymousDeviceRegistrationRun).not.toHaveBeenCalled();
  });
  it('publishes a strict empty-body device-login contract', async () => {
    const { Value } = await import('@sinclair/typebox/value');
    const schema = IdentityEndpoint.deviceLogin.request;
    expect(Value.Check(schema, {})).toBe(true);
    expect(Value.Check(schema, { userId: '42', deviceDigestHex: 'a'.repeat(64), credentialKey: '0123456789abcdef' })).toBe(false);
    expect(Value.Check(schema, { extra: true })).toBe(false);
  });

  let server: ReturnType<Koa['listen']> | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('sets a host-only secure HttpOnly device cookie for the fixed credential expiry without exposing its secret', async () => {
    process.env.AUTH_DEVICE_REGISTER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    const mocks = createModuleMock();
    mocks.anonymousDeviceRegistrationRun.mockResolvedValue({
      sessionResult: {
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresAt: '2026-11-08T13:00:00.000Z',
        user: { userId: '42', displayName: 'Player', roleType: 1 },
        device: { deviceId: '7', trusted: true },
        sid: 'sid-1',
        refreshToken: 'refresh-secret',
      },
      deviceCookie: 'credential-key-123456.secret-value-0123456789abcdef0123456789abcdef',
      credentialExpiresAt: '2027-02-06T12:00:00.000Z',
    });
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      if (chunks.length) (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1',
        'Idempotency-Key': 'registration-key-123456',
      },
      body: JSON.stringify({
        fingerprintVersion: 'v1',
        deviceCode: '0123456789abcdef0123456789abcdef',
        deviceSummary: { platform: 'web', browser: 'test' },
      }),
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('device='));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    if (cookie === undefined) throw new Error('expected device cookie');
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('secure');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(cookie.toLowerCase()).toContain('path=/api/v1/auth/device-login');
    expect(cookie.toLowerCase()).toContain('expires=sat, 06 feb 2027 12:00:00 gmt');
    expect(cookie.toLowerCase()).not.toContain('domain=');
    const payload = await response.text();
    expect(payload).not.toContain('secret-value-0123456789abcdef');
    expect(payload).not.toContain('refresh-secret');
    expect(mocks.anonymousDeviceRegistrationRun).toHaveBeenCalledOnce();
  });

  it('rejects client-supplied device credential fields before reading the device cookie', async () => {
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      }
      if (chunks.length) {
        (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
        ctx.body = { error: 'REQUEST_VALIDATION_FAILED' };
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');

    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1',
        cookie: `device=credential-key-123456.${'secret-value-0123456789abcdef'.repeat(2)}`,
      },
      body: JSON.stringify({ userId: '42', deviceDigestHex: 'a'.repeat(64), credentialKey: 'credential-key-123456' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.deviceLoginRun).not.toHaveBeenCalled();
  });

  it('rejects cookie-only device login when the device cookie is missing', async () => {
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');

    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://127.0.0.1' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect(mocks.deviceLoginRun).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'DEVICE_CREDENTIAL_MISSING', expectedStatus: 401, expectedCode: 'UNAUTHORIZED' },
    { code: 'DEVICE_CREDENTIAL_REVOKED', expectedStatus: 401, expectedCode: 'UNAUTHORIZED' },
    { code: 'DEVICE_CREDENTIAL_EXPIRED', expectedStatus: 401, expectedCode: 'UNAUTHORIZED' },
    { code: 'INVALID_CREDENTIALS', expectedStatus: 401, expectedCode: 'UNAUTHORIZED' },
    { code: 'AUTH_RATE_LIMITED', expectedStatus: 429, expectedCode: 'RATE_LIMITED' },
    { code: 'ACCOUNT_LOCKED', expectedStatus: 403, expectedCode: 'FORBIDDEN' },
    { code: 'UNEXPECTED_IDENTITY_CODE', expectedStatus: 500, expectedCode: 'INTERNAL_ERROR' },
  ])('maps $code to a safe HTTP failure', async ({ code, expectedStatus, expectedCode }) => {
    const mocks = createModuleMock();
    mocks.deviceLoginRun.mockRejectedValue(new DomainError(code, 'must not leak secret detail'));
    const app = new Koa();
    app.use(async (ctx, next) => {
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
        ctx.body = {
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : '',
        };
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');

    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1',
        cookie: `device=credential-key-123456.${'secret-value-0123456789abcdef'.repeat(2)}`,
      },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as { code: string; message: string };
    expect(response.status).toBe(expectedStatus);
    expect(payload.code).toBe(expectedCode);
    expect(payload.message).not.toContain('secret');
  });

  it('passes valid device credentials to the login use case and sets auth cookies', async () => {
    const mocks = createModuleMock();
    const session = {
      accessToken: 'access-token',
      tokenType: 'Bearer' as const,
      expiresAt: '2026-11-08T01:00:00.000Z',
      user: { userId: '42', displayName: 'Player', roleType: 1 },
      device: { deviceId: '7', trusted: true },
      sid: 'sid-1',
      refreshToken: 'refresh-1',
    };
    mocks.deviceLoginRun.mockResolvedValue(session);
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      if (chunks.length) (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await next();
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');

    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'http://127.0.0.1',
        cookie: `device=credential-key-123456.${'secret-value-0123456789abcdef'.repeat(2)}`,
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(mocks.deviceLoginRun).toHaveBeenCalledWith(
      {
        ctx: {
          deviceDigestHex: createHash('sha256').update('secret-value-0123456789abcdef'.repeat(2)).digest('hex'),
          credentialKey: 'credential-key-123456',
          principalType: 'PLAYER',
          audience: 'player',
        },
        rateLimitSubject: 'credential-key-123456',
      },
      { transaction: null },
    );
    const payload = (await response.json()) as { data: Record<string, unknown> };
    expect(payload.data).toMatchObject({ accessToken: 'access-token', user: { userId: '42' } });
    expect(payload.data).not.toHaveProperty('refreshToken');
    expect(response.headers.get('set-cookie')?.toLowerCase()).toContain('httponly');
  });

  it('rejects anonymous registration without a trusted Origin before touching storage', async () => {
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      if (chunks.length) (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
        ctx.body = { error: typeof error === 'object' && error !== null && 'code' in error ? error.code : 'UNKNOWN' };
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');

    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({
        userId: '42',
        fingerprintVersion: 'v1',
        deviceCode: '0123456789abcdef0123456789abcdef',
        deviceSummary: { platform: 'web', browser: 'test' },
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.findUserById).not.toHaveBeenCalled();
    expect(mocks.upsertDevice).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('passes refresh operationId and HttpOnly cookies to the refresh use case', async () => {
    const mocks = createModuleMock();
    const refreshed = {
      accessToken: 'access-token',
      tokenType: 'Bearer' as const,
      expiresAt: '2026-11-08T01:00:00.000Z',
      user: { userId: '42', displayName: 'Player', roleType: 1 },
      device: { deviceId: '7', trusted: true },
      sid: 'sid-next',
      refreshToken: 'refresh-next',
    };
    mocks.refreshRun.mockResolvedValue(refreshed);
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      if (chunks.length) (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await next();
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const previousOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    process.env.AUTH_PUBLIC_ORIGIN = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/refresh`, {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${address.port}`,
          cookie: 'sid=sid-old; refresh_token=refresh-old',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId: 'operation_id_123456' }),
      });
      expect(response.status).toBe(200);
      expect(mocks.refreshRun).toHaveBeenCalledWith(
        expect.objectContaining({ refreshToken: 'refresh-old', sid: 'sid-old', operationId: 'operation_id_123456' }),
        { transaction: null },
      );
      const payload = (await response.json()) as { data: Record<string, unknown> };
      expect(payload.data).not.toHaveProperty('refreshToken');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')?.toLowerCase()).toContain('httponly');
    } finally {
      if (previousOrigin === undefined) delete process.env.AUTH_PUBLIC_ORIGIN;
      else process.env.AUTH_PUBLIC_ORIGIN = previousOrigin;
    }
  });

  it('rejects missing or duplicated refresh cookies before calling the refresh use case', async () => {
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const previousOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    process.env.AUTH_PUBLIC_ORIGIN = origin;
    try {
      const missing = await fetch(`${origin}/auth/refresh`, {
        method: 'POST',
        headers: { origin, cookie: 'sid=sid-old', 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'operation_id_123456' }),
      });
      const duplicate = await fetch(`${origin}/auth/refresh`, {
        method: 'POST',
        headers: { origin, cookie: 'sid=sid-old; sid=sid-other; refresh_token=refresh-old', 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'operation_id_123456' }),
      });
      expect(missing.status).toBe(401);
      expect(duplicate.status).toBe(401);
      expect(mocks.refreshRun).not.toHaveBeenCalled();
    } finally {
      if (previousOrigin === undefined) delete process.env.AUTH_PUBLIC_ORIGIN;
      else process.env.AUTH_PUBLIC_ORIGIN = previousOrigin;
    }
  });

  it('rejects refresh with an untrusted Origin before calling the refresh use case', async () => {
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const previousOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    process.env.AUTH_PUBLIC_ORIGIN = 'https://trusted.example';
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/refresh`, {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${address.port}`,
          cookie: 'sid=sid-old; refresh_token=refresh-old',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId: 'operation_id_123456' }),
      });
      expect(response.status).toBe(403);
      expect(mocks.refreshRun).not.toHaveBeenCalled();
    } finally {
      if (previousOrigin === undefined) delete process.env.AUTH_PUBLIC_ORIGIN;
      else process.env.AUTH_PUBLIC_ORIGIN = previousOrigin;
    }
  });

  it('rejects refresh without operationId before calling the refresh use case', async () => {
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      if (chunks.length) (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      try {
        await next();
      } catch (error) {
        ctx.status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const previousOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    process.env.AUTH_PUBLIC_ORIGIN = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/auth/refresh`, {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${address.port}`,
          cookie: 'sid=sid-old; refresh_token=refresh-old',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      expect(mocks.refreshRun).not.toHaveBeenCalled();
    } finally {
      if (previousOrigin === undefined) delete process.env.AUTH_PUBLIC_ORIGIN;
      else process.env.AUTH_PUBLIC_ORIGIN = previousOrigin;
    }
  });

  it('fails closed before touching identity storage when userId is missing', async () => {
    const mocks = createModuleMock();
    const app = new Koa();
    app.use(async (ctx, next) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of ctx.req) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
      }
      if (chunks.length > 0) {
        const body = Buffer.concat(chunks).toString('utf8');
        (ctx.request as typeof ctx.request & { body?: unknown }).body = JSON.parse(body);
      }
      try {
        await next();
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
        ctx.status = status;
        ctx.body = { status, error: 'REQUEST_VALIDATION_FAILED' };
      }
    });
    const routes = createAuthRoutes(mocks.module);
    app.use(routes.routes()).use(routes.allowedMethods());
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');

    const response = await fetch(`http://127.0.0.1:${address.port}/auth/device-register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({
        fingerprintVersion: 'v1',
        deviceCode: '0123456789abcdef0123456789abcdef',
        deviceSummary: { platform: 'web', browser: 'test' },
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.findUserById).not.toHaveBeenCalled();
    expect(mocks.upsertDevice).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
