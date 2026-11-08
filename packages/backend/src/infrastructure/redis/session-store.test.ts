import { describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { RedisSessionStore, SESSION_LIFETIME, type SessionRecord } from './session-store.js';

const session: SessionRecord = {
  sessionId: 'sid-registration-test',
  userId: '42',
  principalType: 'PLAYER',
  deviceId: '7',
  tokenFamily: 'family',
  authVersion: '1',
  refreshHash: 'hash',
  rotationSeq: 0,
  absoluteExpiry: '2026-12-08T12:00:00.000Z',
  idleExpiry: '2026-11-15T12:00:00.000Z',
  expiresAt: '2026-11-15T12:00:00.000Z',
  createdAt: '2026-11-08T12:00:00.000Z',
};

function makeStore(evalResult: number) {
  const evalMock = vi.fn(async () => evalResult);
  const redis = { eval: evalMock } as never;
  return { store: RedisSessionStore.create(redis), evalMock };
}

describe('RedisSessionStore registration replay protection', () => {
  it('enforces replay revocation and idempotent create against live Redis Lua behavior', async () => {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 10371),
      password: process.env.REDIS_PASSWORD,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
    const key = `test:${suffix}`;
    const testSession = { ...session, sessionId: key, userId: suffix };
    const store = RedisSessionStore.create(redis);
    try {
      await redis.connect();
      await store.createSession(testSession, Date.parse(testSession.createdAt));
      expect(await store.getSession(key)).toEqual(testSession);
      await store.createSession(testSession, Date.parse(testSession.createdAt));
      expect(await store.getSessionsByUser(testSession.userId)).toContain(key);
      await store.revokeSession(key, testSession.userId);
      expect(await store.getSession(key)).toBeNull();
      await expect(store.createSession(testSession, Date.parse(testSession.createdAt))).rejects.toThrow(
        'cannot recreate a revoked session',
      );
    } finally {
      await redis.del(`session:${key}`, `session:revoked:${key}`, `session:user:${testSession.userId}`);
      await redis.quit();
    }
  });
  it('keeps a user index alive until all sessions expire', async () => {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 10371),
      password: process.env.REDIS_PASSWORD,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
    const userId = suffix;
    const now = Date.now();
    const longer = {
      ...session,
      sessionId: `long:${suffix}`,
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 12 * 3600_000).toISOString(),
      absoluteExpiry: new Date(now + 12 * 3600_000).toISOString(),
    };
    const shorter = {
      ...session,
      sessionId: `short:${suffix}`,
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600_000).toISOString(),
      absoluteExpiry: new Date(now + 3600_000).toISOString(),
    };
    const store = RedisSessionStore.create(redis);
    try {
      await redis.connect();
      await store.createSession(longer, now);
      const longTtl = await redis.ttl(`session:user:${userId}`);
      await store.createSession(shorter, now);
      expect(await redis.ttl(`session:user:${userId}`)).toBeGreaterThanOrEqual(longTtl - 1);
      await store.revokeUserSessions(userId);
      expect(await store.getSession(longer.sessionId)).toBeNull();
      expect(await store.getSession(shorter.sessionId)).toBeNull();
    } finally {
      await redis.del(
        `session:${longer.sessionId}`,
        `session:${shorter.sessionId}`,
        `session:revoked:${longer.sessionId}`,
        `session:revoked:${shorter.sessionId}`,
        `session:user:${userId}`,
      );
      await redis.quit();
    }
  });

  it('atomically rejects recreating a revoked sid before writing session/index keys', async () => {
    const { store, evalMock } = makeStore(-1);
    await expect(store.createSession(session, Date.parse(session.createdAt))).rejects.toThrow('cannot recreate a revoked session');
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys, sessionKey, userKey, revokedKey] = evalMock.mock.calls[0] as unknown as [
      string,
      number,
      string,
      string,
      string,
    ];
    expect(script).toContain("EXISTS', KEYS[3]");
    expect(script).toContain('indexTtl < tonumber(ARGV[2])');
    expect(numKeys).toBe(3);
    expect(sessionKey).toBe('session:sid-registration-test');
    expect(userKey).toBe('session:user:42');
    expect(revokedKey).toBe('session:revoked:sid-registration-test');
  });

  it('uses a revocation tombstone on explicit logout even if the session record is absent', async () => {
    const { store, evalMock } = makeStore(1);
    await store.revokeSession(session.sessionId, session.userId);
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys, sessionKey, userKey, revokedKey, ttl] = evalMock.mock.calls[0] as unknown as [
      string,
      number,
      string,
      string,
      string,
      string,
    ];
    expect(script).toContain("SET', KEYS[3], '1', 'EX'");
    expect(numKeys).toBe(3);
    expect(sessionKey).toBe('session:sid-registration-test');
    expect(userKey).toBe('session:user:42');
    expect(revokedKey).toBe('session:revoked:sid-registration-test');
    expect(Number(ttl)).toBeGreaterThan(0);
    expect(Number(ttl)).toBeLessThanOrEqual(SESSION_LIFETIME.absoluteMs / 1000 + 1);
  });

  it('refuses a session id collision with non-identical serialized contents', async () => {
    const { store } = makeStore(-2);
    await expect(store.createSession(session, Date.parse(session.createdAt))).rejects.toThrow('session id collision with different record');
  });
});
