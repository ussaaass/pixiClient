import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponseDto } from '@gameing/contracts/identity';
import { ApiRequestError } from '../http/api-client.js';
import { BrowserPlayerIdentityAdapter } from './player-identity-adapter.js';

const operationIdKey = 'gameing-hall.pending-refresh-operation-id';

const session: SessionResponseDto = {
  accessToken: 'old-access-token',
  tokenType: 'Bearer',
  expiresAt: '2026-11-08T01:00:00.000Z',
  user: { userId: '123', displayName: 'Player', roleType: 1 },
  device: { deviceId: '456', trusted: true },
};

const refreshedSession: SessionResponseDto = {
  ...session,
  accessToken: 'new-access-token',
};

const success = (data: unknown) =>
  new Response(
    JSON.stringify({
      requestId: 'refresh-request-1',
      code: 'OK',
      message: 'OK',
      data,
      serverNow: '2026-11-08T00:00:00.000Z',
    }),
    { status: 200 },
  );

describe('BrowserPlayerIdentityAdapter refresh operation ID', () => {
  afterEach(() => {
    localStorage.removeItem(operationIdKey);
    vi.restoreAllMocks();
  });

  it('reuses a valid persisted operation ID and clears it after refresh succeeds', async () => {
    const refreshBodies: unknown[] = [];
    const fetchPort = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshBodies.push(JSON.parse(String(init?.body)) as unknown);
      return success(refreshedSession);
    });
    localStorage.setItem(operationIdKey, 'persisted-operation-123');
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    identity.acceptSession(session);
    localStorage.setItem(operationIdKey, 'persisted-operation-123');

    await expect(
      identity.withValidAccessToken(async (accessToken) => {
        if (accessToken === session.accessToken) throw new ApiRequestError(401, 'ACCESS_TOKEN_INVALID', 'expired');
        return 'authorized';
      }),
    ).resolves.toBe('authorized');

    expect(refreshBodies).toEqual([{ operationId: 'persisted-operation-123' }]);
    expect(localStorage.getItem(operationIdKey)).toBeNull();
  });

  it('creates a fresh operation ID for a later refresh after success', async () => {
    const refreshBodies: unknown[] = [];
    const fetchPort = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshBodies.push(JSON.parse(String(init?.body)) as unknown);
      return success(refreshedSession);
    });
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    identity.acceptSession(session);
    let shouldExpire = true;
    const expiredAccessOperation = async (_accessToken: string) => {
      if (shouldExpire) {
        shouldExpire = false;
        throw new ApiRequestError(401, 'ACCESS_TOKEN_INVALID', 'expired');
      }
      return 'authorized';
    };

    await expect(identity.withValidAccessToken(expiredAccessOperation)).resolves.toBe('authorized');
    const firstOperationId = (refreshBodies[0] as { operationId: string }).operationId;
    shouldExpire = true;
    await expect(identity.withValidAccessToken(expiredAccessOperation)).resolves.toBe('authorized');
    const secondOperationId = (refreshBodies[1] as { operationId: string }).operationId;

    expect(firstOperationId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(secondOperationId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(secondOperationId).not.toBe(firstOperationId);
  });

  it('clears pending operation ID when logout succeeds', async () => {
    localStorage.setItem(operationIdKey, 'pending-operation-123456');
    const fetchPort = vi.fn().mockResolvedValue(success({ loggedOut: true }));
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    identity.acceptSession(session);
    localStorage.setItem(operationIdKey, 'pending-operation-123456');

    await identity.logout();

    expect(localStorage.getItem(operationIdKey)).toBeNull();
    expect(identity.currentSession).toBeUndefined();
  });

  it('clears pending operation ID when refresh returns 401 and invalidates the session', async () => {
    localStorage.setItem(operationIdKey, 'pending-operation-123456');
    const fetchPort = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requestId: 'refresh-request-1',
          code: 'REFRESH_INVALID',
          message: 'invalid',
          data: null,
          serverNow: '2026-11-08T00:00:00.000Z',
        }),
        { status: 401 },
      ),
    );
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    identity.acceptSession(session);
    localStorage.setItem(operationIdKey, 'pending-operation-123456');

    await expect(
      identity.withValidAccessToken(async () => {
        throw new ApiRequestError(401, 'ACCESS_TOKEN_INVALID', 'expired');
      }),
    ).rejects.toMatchObject({ status: 401, code: 'SESSION_REVOKED' });

    expect(localStorage.getItem(operationIdKey)).toBeNull();
    expect(identity.currentSession).toBeUndefined();
  });

  it('reuses the operation ID after a transport failure and clears it after refresh succeeds', async () => {
    const refreshBodies: unknown[] = [];
    let refreshAttempt = 0;
    const fetchPort = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshAttempt += 1;
      refreshBodies.push(JSON.parse(String(init?.body)) as unknown);
      if (refreshAttempt === 1) throw new TypeError('network unavailable');
      return success(refreshedSession);
    });
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    identity.acceptSession(session);
    const expiredAccessOperation = async (accessToken: string) => {
      if (accessToken === session.accessToken) throw new ApiRequestError(401, 'ACCESS_TOKEN_INVALID', 'expired');
      return 'authorized';
    };

    await expect(identity.withValidAccessToken(expiredAccessOperation)).rejects.toThrow('network unavailable');
    const pendingOperationId = localStorage.getItem(operationIdKey);
    expect(pendingOperationId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);

    await expect(identity.withValidAccessToken(expiredAccessOperation)).resolves.toBe('authorized');
    expect(refreshBodies).toEqual([{ operationId: pendingOperationId }, { operationId: pendingOperationId }]);
    expect(localStorage.getItem(operationIdKey)).toBeNull();
    expect(identity.currentSession?.accessToken).toBe('new-access-token');
  });
});
