/**
 * 挑战存储端口（TOTP 登录 challenge / TOTP setup 待确认密钥 / 联系方式待确认挑战，
 * 均存 Redis 带 TTL，§5）。
 *
 * 领域所有者：identity 模块（adapters/redis-session-port.ts 扩展或独立适配器实现）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4（TOTP 启用时 password-login 返回
 * LoginChallengeResponse，challenge 存 Redis 10min）、§5（TOTP 启用流程"先在 Redis
 * 短暂保存待确认密钥，展示一次性 otpauth QR"）。
 *
 * 键约定（全部带 TTL，§3）：
 * - `challenge:login-totp:{challengeId}`：TOTP 登录 challenge，10min TTL，
 *   存 { userId, deviceId, createdAt, expiresAt }；
 * - `challenge:totp-setup:{setupId}`：TOTP setup 待确认密钥，10min TTL，
 *   存 { userId, secretBase32, otpauthUri, createdAt, expiresAt }（密钥短 TTL 暂存，
 *   确认后加密落库、清 Redis，§5）；
 * - `challenge:contact:{challengeId}`：联系方式变更挑战，10min TTL。
 */

import type { PrincipalType } from '../../../infrastructure/redis/session-store.js';

/** 登录 TOTP challenge 记录。 */
export interface LoginChallengeRecord {
  challengeId: string;
  userId: string;
  deviceId: string | null;
  principalType: PrincipalType;
  /** challenge 过期时间（ISO UTC）。 */
  expiresAt: string;
}

/** TOTP setup 待确认密钥（10min TTL；明文密钥只在此短 TTL 窗口 + QR 展示，§5 "密钥不得
 * 进入日志/分析/普通账号恢复 QR 或客户端持久存储"；确认后加密落 user 表并清本记录）。 */
export interface TotpSetupRecord {
  setupId: string;
  userId: string;
  /** base32 编码的 TOTP 共享密钥（短 TTL 暂存；落库前认证加密）。 */
  secretBase32: string;
  /** otpauth:// URI（一次性 QR 展示）。 */
  otpauthUri: string;
  expiresAt: string;
}

export interface ChallengeStore {
  /** 存 TOTP 登录 challenge（10min TTL）。 */
  saveLoginChallenge(record: LoginChallengeRecord): Promise<void>;
  getLoginChallenge(challengeId: string): Promise<LoginChallengeRecord | null>;
  deleteLoginChallenge(challengeId: string): Promise<void>;

  /** 存 TOTP setup 待确认密钥（10min TTL）。 */
  saveTotpSetup(record: TotpSetupRecord): Promise<void>;
  getTotpSetup(setupId: string): Promise<TotpSetupRecord | null>;
  deleteTotpSetup(setupId: string): Promise<void>;
}
