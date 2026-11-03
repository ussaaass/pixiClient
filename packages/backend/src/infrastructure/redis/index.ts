/**
 * infrastructure/redis 入口（identity 会话基础设施：会话存储 / refresh 轮换 / 限频 /
 * 挑战暂存）。
 *
 * 领域所有者：identity 模块（JWT 设计 §3 "Redis 是活动会话与刷新轮换状态的权威存储"）。
 */

export { getRedis, closeRedis, readRedisConfig, REDIS_DEFAULTS, type RedisClient, type RedisConnectOptions } from './client.js';
export {
  RedisSessionStore,
  SESSION_LIFETIME,
  ACCESS_TOKEN_TTL_MS,
  effectiveExpiryMs,
  type PrincipalType,
  type SessionRecord,
} from './session-store.js';
export {
  RefreshRotationStore,
  REPLAY_WINDOW_MS,
  type RotationOk,
  type RotationReuse,
  type RotationResult,
  type ReplayCacheEntry,
  type ScriptOutcome,
  type SessionRecordSnapshot,
} from './refresh-rotation.js';
export { AuthRateLimiter, AUTH_RATE_LIMIT, type RateCheck } from './auth-rate-limit.js';
