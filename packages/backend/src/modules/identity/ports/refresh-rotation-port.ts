/**
 * 刷新轮换 + 弱网重放窗口 + 认证限频端口（抽象 infrastructure/redis 实现）。
 *
 * 领域所有者：identity 模块（adapters/redis-session-port.ts 委托
 * infrastructure/redis/refresh-rotation.ts 与 auth-rate-limit.ts 实现）。
 * 对应 SDD 章节：JWT 登录与会话设计 §3（Lua 原子轮换 + RFC 9700 复用检测 +
 * 30s 弱网重放窗口）、§4（AUTH_RATE_LIMITED 错误码）。
 */

import type { RotationResult, ScriptOutcome } from '../../../infrastructure/redis/refresh-rotation.js';
import type { RateCheck } from '../../../infrastructure/redis/auth-rate-limit.js';

/** 会话刷新轮换端口（Lua 原子轮换；用例不直接依赖 ioredis / 脚本细节）。 */
export interface RefreshRotationPort {
  /**
   * 原子轮换（Lua）：比较当前摘要 → 推进序号 → 写新摘要 → 缓存重放结果。
   * @param presentedHash 提交的 refresh token 的 sha256 hex。
   * @param newHash 新一代 refresh token 的 sha256 hex。
   * @param operationId 客户端单飞操作 ID（§2 多标签协调）。
   * @param nowMs 注入时钟（UTC 毫秒）。
   * @returns 脚本判定：OK（成功）/ REUSE_DETECTED（已消费凭证复用 → 撤销 session）/
   *          REPLAY（窗口内同凭证同 opId 重放 → 原结果）/ MISS（session 不存在）/
   *          EXPIRED（绝对寿命已过）。
   */
  rotateRefresh(
    sid: string,
    presentedHash: string,
    newHash: string,
    encryptedRefreshToken: string,
    operationId: string,
    nowMs: number,
  ): Promise<ScriptOutcome | { kind: 'MISS' } | { kind: 'EXPIRED' }>;
}

/** 认证限频端口（`rate:auth:{subject}` 60s 滑动窗口）。 */
export interface AuthRateLimitPort {
  /**
   * 记录一次认证尝试并判定是否限频（窗口内计数 ≥ 阈值 → 拒绝）。
   * @param subject userId（refresh）或 identifier（login）。
   * @param nowMs 注入时钟（UTC 毫秒）。
   */
  check(subject: string, nowMs: number): Promise<RateCheck>;
}

export type { RotationResult };
