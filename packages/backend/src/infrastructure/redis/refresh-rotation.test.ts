import { Redis } from 'ioredis';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RefreshRotationStore } from './refresh-rotation.js';

describe('Redis refresh rotation Lua integration', { skip: process.env.REDIS_ROTATION_TEST !== '1' }, () => {
  const sid = `rotation-test-${process.pid}-${Date.now()}`;
  const userId = '900000000000000001';
  const nowMs = Date.now();
  const absoluteExpiry = new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString();
  const initialIdle = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  const sessionKey = `session:${sid}`;
  const replayKey = `session:replay:${sid}`;
  const userKey = `session:user:${userId}`;
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 10371),
    password: process.env.REDIS_PASSWORD,
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  const store = new RefreshRotationStore(redis);

  before(async () => {
    await redis.connect();
    await store.load();
  });
  after(async () => {
    if (redis.status !== 'wait') {
      await redis.del(sessionKey, replayKey, userKey, `session:revoked:${sid}`).catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }
  });

  it('rotates, replays same operation atomically, renews user-set TTL, and returns identity on reuse', async () => {
    const session = {
      sessionId: sid,
      userId,
      authVersion: '1',
      refreshHash: 'old-hash',
      rotationSeq: 0,
      absoluteExpiry,
      idleExpiry: initialIdle,
      expiresAt: initialIdle,
      createdAt: new Date(nowMs).toISOString(),
    };
    await redis.set(sessionKey, JSON.stringify(session), 'EX', 10);
    await redis.sadd(userKey, sid);
    await redis.expire(userKey, 10);

    const first = await store.rotateRefresh(sid, 'old-hash', 'new-hash', 'ciphertext', 'operation-unique-1', nowMs);
    assert.equal(first.kind, 'OK');
    if (first.kind !== 'OK') return;
    assert.equal(first.record.sessionId, sid);
    assert.equal(first.replayCache.result.rotationSeq, 1);
    assert.equal(first.replayCache.result.idleExpiryEpochMs, Math.min(Date.parse(absoluteExpiry), nowMs + 7 * 24 * 60 * 60 * 1000));
    assert.equal((await redis.pttl(userKey)) > 10_000, true);

    const replay = await store.rotateRefresh(sid, 'old-hash', 'unused-hash', 'other-ciphertext', 'operation-unique-1', nowMs + 1);
    assert.equal(replay.kind, 'REPLAY');
    if (replay.kind === 'REPLAY') assert.equal(replay.replayCache.encryptedRefreshToken, 'ciphertext');
    assert.equal((await redis.get(sessionKey))?.includes('new-hash'), true);

    assert.equal((await redis.pttl(userKey)) > 10_000, true);

    const reuse = await store.rotateRefresh(sid, 'old-hash', 'unused-hash-2', 'other-ciphertext', 'operation-unique-2', nowMs + 2);
    assert.equal(reuse.kind, 'REUSE_DETECTED');
    if (reuse.kind === 'REUSE_DETECTED') {
      assert.equal(reuse.record.userId, userId);
      assert.equal(reuse.record.authVersion, '1');
    }
    assert.equal(await redis.get(sessionKey), null);
    assert.equal(await redis.sismember(userKey, sid), 0);
    assert.equal(await redis.get(`session:revoked:${sid}`), '1');
  });

  it('rejects expired sessions before rotating', async () => {
    const expiredSession = {
      sessionId: sid,
      userId,
      authVersion: '1',
      refreshHash: 'expired-hash',
      rotationSeq: 0,
      absoluteExpiry: new Date(nowMs - 1).toISOString(),
      idleExpiry: new Date(nowMs - 1).toISOString(),
      expiresAt: new Date(nowMs - 1).toISOString(),
      createdAt: new Date(nowMs - 1000).toISOString(),
    };
    await redis.set(sessionKey, JSON.stringify(expiredSession), 'EX', 10);
    const result = await store.rotateRefresh(sid, 'expired-hash', 'new-hash', 'ciphertext', 'operation-unique-3', nowMs);
    assert.equal(result.kind, 'EXPIRED');
  });
});
