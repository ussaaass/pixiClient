/**
 * 会话存储（Redis 是活动会话权威，JWT 设计 §3）。
 *
 * 领域所有者：identity 模块。
 * 对应 SDD 章节：JWT 登录与会话设计 §3 —— "Redis session 保存统一的 user_id、
 * principal_type、device_id、令牌家族、authVersion、到期/状态和 refresh token 摘要；
 * 只保留高熵刷新令牌的 keyed hash，不存明文。所有 Redis key 有 TTL。"
 *
 * 键约定（全部带 TTL，user:authversion 例外）：
 * - `session:{sid}`：JSON 序列化的 SessionRecord，TTL = 剩余寿命（绝对 30 天 − 已存活）；
 * - `session:user:{userId}`：Set（sid 成员），用于"改密/全设备退出"批量撤销与
 *   user 维度 authVersion 比对；TTL 取该用户现存会话中最长的剩余寿命（惰性刷新）；
 * - `user:authversion:{userId}`：用户维度安全版本镜像（改密/恢复/全设备退出时 +1），
 *   **无 TTL**（长期安全版本镜像，§3 唯一无 TTL 例外）。
 *
 * 会话寿命规则（§1）：空闲 7 天（刷新续期）与绝对 30 天（created_at + 30d）取先到。
 */

import type { RedisClient } from './client.js';

/** 会话主体类型：玩家与 Admin 共用同一 user.id（§3），principal_type 区分 audience。 */
export type PrincipalType = 'PLAYER' | 'ADMIN';

/** 活动会话记录（§3 字段清单；refreshHash 为 sha256 hex，明文不落盘）。 */
export interface SessionRecord {
  /** sid：Redis 会话定位键（user_security_event.session_key 原样记录，不是 MySQL 外键）。 */
  sessionId: string;
  /** 统一 user.id（十进制字符串 wire；Admin 同样使用该 ID）。 */
  userId: string;
  principalType: PrincipalType;
  /** 玩家会话归属 device.id（十进制字符串 wire）；Admin 会话为 null。 */
  deviceId: string | null;
  /** 令牌家族：同一次登录/恢复派生的 sid 序列共享一族，复用检测按族撤销。 */
  tokenFamily: string;
  /** 创建会话时从 user.auth_version 复制的账号安全版本（十进制字符串）。 */
  authVersion: string;
  /** 当前代 refresh token 的 sha256 hex（§3：只存摘要，不存明文）。 */
  refreshHash: string;
  /** 轮换序号：Lua 原子轮换每次 +1（§3）。 */
  rotationSeq: number;
  /** 会话绝对寿命上限（created_at + 30 天），ISO 8601 UTC。 */
  absoluteExpiry: string;
  /** 空闲到期（最近一次成功刷新 + 7 天），ISO 8601 UTC。 */
  idleExpiry: string;
  /** 生效到期 = min(absoluteExpiry, idleExpiry)，ISO 8601 UTC。 */
  expiresAt: string;
  /** 会话创建时间，ISO 8601 UTC。 */
  createdAt: string;
}

/** 会话记录内部 JSON 表示（与 Redis 中存储字节一致的投影，便于 TTL 计算）。 */
export type SessionRecordJson = Omit<SessionRecord, 'authVersion'> & { authVersion: string };

/** 会话寿命常量（§1 建议值；空闲 7 天 / 绝对 30 天，经配置管理，此处为默认建议值）。 */
export const SESSION_LIFETIME = {
  idleMs: 7 * 24 * 60 * 60 * 1000,
  absoluteMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/** access 令牌寿命（§1 建议 10 分钟；签发端用，校验端不依赖）。 */
export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;

const SESSION_KEY_PREFIX = 'session:';
const SESSION_USER_KEY_PREFIX = 'session:user:';
const AUTH_VERSION_KEY_PREFIX = 'user:authversion:';

function sessionKey(sid: string): string {
  return `${SESSION_KEY_PREFIX}${sid}`;
}

function sessionUserKey(userId: string): string {
  return `${SESSION_USER_KEY_PREFIX}${userId}`;
}

function authVersionKey(userId: string): string {
  return `${AUTH_VERSION_KEY_PREFIX}${userId}`;
}

/** 计算生效到期：min(绝对寿命, 空闲寿命)。 */
export function effectiveExpiryMs(createdAtMs: number, idleRefreshMs: number | null): number {
  const absolute = createdAtMs + SESSION_LIFETIME.absoluteMs;
  if (idleRefreshMs === null) return absolute;
  return Math.min(absolute, idleRefreshMs + SESSION_LIFETIME.idleMs);
}

/**
 * 会话存储实现。由 `modules/identity/adapters/redis-session-port.ts` 委托，
 * 用例不直接依赖 ioredis（SDD §4 端口约定）。
 */
export class RedisSessionStore {
  private constructor(private readonly redis: RedisClient) {}

  /** 用既有 ioredis 实例构建（装配工厂注入，避免跨模块单例耦合）。 */
  static create(redis: RedisClient): RedisSessionStore {
    return new RedisSessionStore(redis);
  }

  /**
   * 创建会话：写 `session:{sid}`（TTL = 绝对剩余寿命，后续刷新由调用方续 idle 窗口）
   * 并注册到 `session:user:{userId}` Set。
   * @param nowMs 注入时钟（UTC 毫秒），测试可传固定值。
   */
  async createSession(record: SessionRecord, nowMs: number): Promise<void> {
    const key = sessionKey(record.sessionId);
    const userKey = sessionUserKey(record.userId);
    const remainingMs = Math.max(1, effectiveExpiryMs(nowMs, null) - nowMs);

    const multi = this.redis.multi();
    multi.set(key, JSON.stringify(record), 'EX', Math.ceil(remainingMs / 1000));
    multi.sadd(userKey, record.sessionId);
    multi.expire(userKey, Math.ceil(remainingMs / 1000));
    await multi.exec();
  }

  /** 读取会话；过期/撤销/未知返回 null（§3：Redis 丢失即全部会话失效）。 */
  async getSession(sid: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(sessionKey(sid));
    return raw === null ? null : (JSON.parse(raw) as SessionRecordJson);
  }

  /** 列出用户全部活动 sid（Set 内自然按成员枚举；被 TTL 清掉的不再出现）。 */
  async getSessionsByUser(userId: string): Promise<string[]> {
    return this.redis.smembers(sessionUserKey(userId));
  }

  /** 撤销单个 sid：删会话记录、从用户 Set 摘除成员。 */
  async revokeSession(sid: string, userId: string | null): Promise<void> {
    const record = userId === null ? await this.getSession(sid) : null;
    const owner = userId ?? record?.userId;
    if (owner === undefined) return;
    const multi = this.redis.multi();
    multi.del(sessionKey(sid));
    if (owner !== null) multi.srem(sessionUserKey(owner), sid);
    await multi.exec();
  }

  /**
   * 撤销用户全部会话（改密/全设备退出，§3"更新 Redis 用户版本并撤销相关 session"）。
   * 逐个 del 会话 key 并清空 user Set；user Set 的 TTL 一并移除（下次 createSession 重建）。
   */
  async revokeUserSessions(userId: string): Promise<void> {
    const sids = await this.getSessionsByUser(userId);
    if (sids.length === 0) return;
    const multi = this.redis.multi();
    for (const sid of sids) {
      multi.del(sessionKey(sid));
    }
    multi.del(sessionUserKey(userId));
    await multi.exec();
  }

  /**
   * 读取用户维度 Redis 安全版本镜像；key 不存在（首次改密前）返回 SQL 默认 1。
   * 该 key 无 TTL（§3 唯一例外，长期安全版本镜像）。
   */
  async getRedisAuthVersion(userId: string): Promise<string> {
    const raw = await this.redis.get(authVersionKey(userId));
    return raw === null ? '1' : raw;
  }

  /**
   * 用户维度安全版本 +1（改密/恢复/全设备退出后调用，§3"递增 auth_version、
   * 更新 Redis 用户版本并撤销相关 session"）。返回新版本（十进制字符串）。
   * 无 TTL：长期镜像，防止 Redis 重启后版本倒退绕过撤销门禁。
   */
  async bumpRedisAuthVersion(userId: string): Promise<string> {
    const next = await this.redis.incr(authVersionKey(userId));
    return String(next);
  }

  /** 续期会话空闲寿命（刷新成功后调用）：重算 TTL 并重设 user Set TTL。 */
  async touchSessionIdle(sid: string, userId: string, idleExpiryMs: number, nowMs: number): Promise<void> {
    const remainingMs = Math.max(1, idleExpiryMs - nowMs);
    const multi = this.redis.multi();
    multi.expire(sessionKey(sid), Math.ceil(remainingMs / 1000));
    multi.expire(sessionUserKey(userId), Math.ceil(remainingMs / 1000));
    await multi.exec();
  }

  /** 用户 Set 中 sid 的当前 TTL（秒，Redis 原始语义；-1 永不过期 / -2 不存在）。 */
  async sessionTtlSeconds(sid: string): Promise<number> {
    return this.redis.ttl(sessionKey(sid));
  }
}
