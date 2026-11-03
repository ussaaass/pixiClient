/**
 * 登录/刷新限频（`AUTH_RATE_LIMITED`）。
 *
 * 领域所有者：identity 模块。
 * 对应 SDD 章节：JWT 登录与会话设计 §4（"错误码常量化，区分过期、已撤销、刷新复用、
 * 无权限和重试结果未知"——限频作为独立 AUTH_RATE_LIMITED 码）；数据库设计SDD §5.8
 * user_security_event（限频计数本身不落 SQL，只记安全事件）。
 *
 * 键约定（带 TTL，§3）：`rate:auth:{userId|identifier}` 为 60s 滑动窗口计数
 * （ZSET：member = 事件时间戳毫秒，score = 同毫秒，按时间戳裁剪）。窗口内计数
 * ≥ 阈值（默认 5 次/分钟）时判定限频。
 *
 * 触发口径：登录（device-login / password-login 首次提交，不含 TOTP challenge 二次
 * 提交与 refresh）按 identifier 计数；refresh 按 userId 计数。
 */

import type { RedisClient } from './client.js';

/** 限频常量（可配置默认值；窗口 60s / 5 次，压测后调整，§4 "时长和缓存窗口通过压测调整"）。 */
export const AUTH_RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxAttempts: 5,
} as const;

const RATE_KEY_PREFIX = 'rate:auth:';

/** 限频结果。 */
export interface RateCheck {
  /** 是否被限（窗口内计数 ≥ 阈值，本次请求被拒绝）。 */
  limited: boolean;
  /** 窗口内已有次数（含本次已计入）。 */
  count: number;
  /** 距下次允许（秒）；limited=true 时 > 0。 */
  retryAfterSeconds: number;
}

export class AuthRateLimiter {
  private constructor(private readonly redis: RedisClient) {}

  static create(redis: RedisClient): AuthRateLimiter {
    return new AuthRateLimiter(redis);
  }

  /**
   * 记录一次认证尝试并判定是否限频（原子：按 windowMs 裁剪历史 + 计数 + TTL 续窗）。
   * @param subject userId（refresh）或 identifier（login）——用方传规范化标识。
   * @param nowMs 注入时钟（UTC 毫秒）。
   */
  async check(subject: string, nowMs: number): Promise<RateCheck> {
    const key = `${RATE_KEY_PREFIX}${subject}`;
    const windowStart = nowMs - AUTH_RATE_LIMIT.windowMs;

    const multi = this.redis.multi();
    multi.zremrangebyscore(key, 0, windowStart); // 清出窗外旧计数
    multi.zadd(key, String(nowMs), `${nowMs}:${Math.random()}`);
    multi.expire(key, Math.ceil(AUTH_RATE_LIMIT.windowMs / 1000));
    const results = (await multi.exec()) as Array<[Error | null, number] | null> | null;

    if (results === null) {
      // 部分失败（Redis 故障）：fail-open 让业务层报 IDENTITY_STORAGE_UNAVAILABLE。
      throw new Error('rate limit check failed');
    }
    const count = results[1] !== null && results[1] !== undefined ? (results[1][1] ?? 0) : 0;
    const limited = count > AUTH_RATE_LIMIT.maxAttempts;
    const retryAfterSeconds = limited ? Math.ceil(AUTH_RATE_LIMIT.windowMs / 1000) : 0;
    return { limited, count, retryAfterSeconds };
  }
}
