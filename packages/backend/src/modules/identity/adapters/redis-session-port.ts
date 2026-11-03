/**
 * Redis 会话端口适配器（SessionPort / RefreshRotationPort / AuthRateLimitPort 实现）。
 *
 * 领域所有者：identity 模块（委托 infrastructure/redis/* 实现，用例不直接依赖 ioredis）。
 * 对应 SDD 章节：JWT 登录与会话设计 §3（Redis 权威会话 + Lua 轮换 + 30s 重放窗口）、
 * §4（AUTH_RATE_LIMITED）；后端实施 SDD §4（adapters/ 实现 ports/）。
 */

import type { RedisClient } from '../../../infrastructure/redis/client.js';
import { RedisSessionStore, SESSION_LIFETIME, type SessionRecord } from '../../../infrastructure/redis/session-store.js';
import { AuthRateLimiter } from '../../../infrastructure/redis/auth-rate-limit.js';
import { RefreshRotationStore, type ReplayCacheEntry, type ScriptOutcome } from '../../../infrastructure/redis/refresh-rotation.js';
import type { RateCheck } from '../../../infrastructure/redis/auth-rate-limit.js';
import type { AuthRateLimitPort, RefreshRotationPort } from '../ports/refresh-rotation-port.js';
import type { NewSessionRecordInput, SessionPort } from '../ports/session-port.js';
import type { ChallengeStore, LoginChallengeRecord, TotpSetupRecord } from '../ports/challenge-store-port.js';

/** 登录 challenge / TOTP setup / 联系方式挑战 TTL（§4/§5 "存 Redis 10min"）。 */
const CHALLENGE_TTL_SECONDS = 10 * 60;

const LOGIN_CHALLENGE_KEY = 'challenge:login-totp:';
const TOTP_SETUP_KEY = 'challenge:totp-setup:';

/** 组装会话记录（SessionPort 入参 → 内部 SessionRecord，绝对/空闲寿命计算）。 */
function buildRecord(input: NewSessionRecordInput): SessionRecord {
  const createdAtMs = input.nowMs;
  const absoluteExpiry = new Date(createdAtMs + SESSION_LIFETIME.absoluteMs).toISOString();
  const idleExpiry = new Date(createdAtMs + SESSION_LIFETIME.idleMs).toISOString();
  const expiresAt = new Date(Math.min(createdAtMs + SESSION_LIFETIME.absoluteMs, createdAtMs + SESSION_LIFETIME.idleMs)).toISOString();
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    principalType: input.principalType,
    deviceId: input.deviceId,
    tokenFamily: input.tokenFamily,
    authVersion: input.authVersion,
    refreshHash: input.refreshHash,
    rotationSeq: 0,
    absoluteExpiry,
    idleExpiry,
    expiresAt,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

/** SessionPort 适配器：委托 RedisSessionStore（用例不直接 import ioredis，SDD §4）。 */
export class RedisSessionPortAdapter implements SessionPort {
  private readonly store: RedisSessionStore;
  constructor(private readonly redis: RedisClient) {
    this.store = RedisSessionStore.create(redis);
  }

  async createSession(record: SessionRecord, nowMs: number): Promise<void> {
    await this.store.createSession(record, nowMs);
  }
  async getSession(sid: string): Promise<SessionRecord | null> {
    return this.store.getSession(sid);
  }
  async getSessionsByUser(userId: string): Promise<string[]> {
    return this.store.getSessionsByUser(userId);
  }
  async revokeSession(sid: string, userId: string | null): Promise<void> {
    await this.store.revokeSession(sid, userId);
  }
  async revokeUserSessions(userId: string): Promise<void> {
    await this.store.revokeUserSessions(userId);
  }
  async getRedisAuthVersion(userId: string): Promise<string> {
    return this.store.getRedisAuthVersion(userId);
  }
  async bumpRedisAuthVersion(userId: string): Promise<string> {
    return this.store.bumpRedisAuthVersion(userId);
  }
  async touchSessionIdle(sid: string, userId: string, idleExpiryMs: number, nowMs: number): Promise<void> {
    await this.store.touchSessionIdle(sid, userId, idleExpiryMs, nowMs);
  }
}

/** 构造会话记录的助手（与 SessionPort 配套；用例组装 SessionRecord 用）。 */
export function buildNewSession(input: NewSessionRecordInput): SessionRecord {
  return buildRecord(input);
}

/** RefreshRotationPort 适配器：委托 RefreshRotationStore（Lua 脚本 + 重放缓存）。 */
export class RedisRefreshRotationPortAdapter implements RefreshRotationPort {
  private readonly store: RefreshRotationStore;
  constructor(redis: RedisClient) {
    this.store = new RefreshRotationStore(redis);
  }
  async load(): Promise<void> {
    await this.store.load();
  }
  async rotateRefresh(
    sid: string,
    presentedHash: string,
    newHash: string,
    operationId: string,
    nowMs: number,
  ): Promise<ScriptOutcome | { kind: 'MISS' } | { kind: 'EXPIRED' }> {
    return this.store.rotateRefresh(sid, presentedHash, newHash, operationId, nowMs);
  }
  async isReplayHit(sid: string, presentedHash: string, operationId: string, nowMs: number): Promise<ReplayCacheEntry | null> {
    return this.store.isReplayHit(sid, presentedHash, operationId, nowMs);
  }
}

/** AuthRateLimitPort 适配器：委托 AuthRateLimiter（滑动窗口 ZSET）。 */
export class RedisAuthRateLimitPortAdapter implements AuthRateLimitPort {
  private readonly limiter: AuthRateLimiter;
  constructor(redis: RedisClient) {
    this.limiter = AuthRateLimiter.create(redis);
  }
  async check(subject: string, nowMs: number): Promise<RateCheck> {
    return this.limiter.check(subject, nowMs);
  }
}

/**
 * ChallengeStore 适配器（Redis 实现，TTL 全部带，§3）：
 * TOTP 登录 challenge / TOTP setup 待确认密钥 / 联系方式变更挑战。
 * 键 `challenge:login-totp:{id}` / `challenge:totp-setup:{id}`，JSON 序列化。
 */
export class RedisChallengeStoreAdapter implements ChallengeStore {
  constructor(private readonly redis: RedisClient) {}

  async saveLoginChallenge(record: LoginChallengeRecord): Promise<void> {
    await this.redis.set(`${LOGIN_CHALLENGE_KEY}${record.challengeId}`, JSON.stringify(record), 'EX', CHALLENGE_TTL_SECONDS);
  }
  async getLoginChallenge(challengeId: string): Promise<LoginChallengeRecord | null> {
    const raw = await this.redis.get(`${LOGIN_CHALLENGE_KEY}${challengeId}`);
    return raw === null ? null : (JSON.parse(raw) as LoginChallengeRecord);
  }
  async deleteLoginChallenge(challengeId: string): Promise<void> {
    await this.redis.del(`${LOGIN_CHALLENGE_KEY}${challengeId}`);
  }

  async saveTotpSetup(record: TotpSetupRecord): Promise<void> {
    // §5 "先在 Redis 短暂保存待确认密钥"；密钥短 TTL 暂存，确认后加密落库并清本记录。
    await this.redis.set(`${TOTP_SETUP_KEY}${record.setupId}`, JSON.stringify(record), 'EX', CHALLENGE_TTL_SECONDS);
  }
  async getTotpSetup(setupId: string): Promise<TotpSetupRecord | null> {
    const raw = await this.redis.get(`${TOTP_SETUP_KEY}${setupId}`);
    return raw === null ? null : (JSON.parse(raw) as TotpSetupRecord);
  }
  async deleteTotpSetup(setupId: string): Promise<void> {
    await this.redis.del(`${TOTP_SETUP_KEY}${setupId}`);
  }
}
