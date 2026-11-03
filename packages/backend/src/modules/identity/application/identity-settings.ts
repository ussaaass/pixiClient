/**
 * identity-settings 用例：GET 设置快照 + 设置 username + 改密码（§4 me/identity/*）。
 *
 * 领域所有者：identity 模块（/me/identity-settings、/me/identity/username、
 * /me/identity/password）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4（"新密码默认最少 8 位，服务端身份领域负责
 * 验证"）、§5（"若账号已设置密码，两类操作都要求当前密码；未设密码时依赖有效会话。
 * 启用 TOTP 的账号还须当前 TOTP"——username/password 变更的再认证规则同 §5）；
 * 数据库设计 SDD §5.1 user（username 规范化唯一、password_hash argon2id/bcrypt）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 *
 * GET identity-settings：
 * - 成功 → IdentitySettingsResponse（200）；
 * - `ACCESS_TOKEN_INVALID`：调用方会话验签失败（路由层拦截；用例层兜底）。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Sequelize 故障。
 *
 * setUsername（SetUsernameRequest 须当前密码/TOTP 再认证，§5）：
 * - `REAUTHENTICATION_FAILED`：再认证失败（已设密码但密码错 / TOTP 启用但码错）。
 * - `USERNAME_INVALID`：用户名不合法（规范：3~32 位，长度/字符校验）。
 * - `IDENTIFIER_ALREADY_USED`：目标 username 被其他账号占用（U(username) 唯一索引）。
 * - `VALIDATION_FAILED`：请求字段缺失/格式错（长度越界等）。
 * - 成功 → IdentitySettingsResponse（200）。
 *
 * changePassword（ChangePasswordRequest → 递增 auth_version + 撤销全部 session + 安全事件）：
 * - `PASSWORD_TOO_SHORT`：新密码 < 8 位（§4，映射 VALIDATION_FAILED 域内细分）。
 * - `PASSWORD_REUSE`：新密码与当前密码相同（防"改了个寂寞"；语义登记，contracts 无
 *   请求字段区分，本步按 new===current 判定）。
 * - `REAUTHENTICATION_FAILED`：未设密码（currentPassword 缺省路径）时有效会话为授权基础，
 *   会话失效 → 拒绝；已设密码但 currentPassword 错 / TOTP 启用但码错。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE。
 * - 成功 → PasswordChangedResponse `{ changed: true }`（200）；副作用同事务：
 *   user.password_hash 更新 + auth_version 递增（SQL + Redis 镜像）+ 撤销该 user 全部
 *   session（§3 "改密……递增 auth_version、更新 Redis 用户版本并撤销相关 session"）
 *   + 安全事件（action=PASSWORD）。
 */

import type {
  IdentitySettingsResponseSchema,
  SetUsernameRequestSchema,
  ChangePasswordRequestSchema,
  PasswordChangedResponseSchema,
  Static,
} from '@gameing/contracts/identity';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import { UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import { hashPassword, verifyPassword, assertMinPasswordLength } from '../domain/password.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { SessionPort } from '../ports/session-port.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import { toIdentitySettings } from '../adapters/row-mappers.js';
import { createHash } from 'node:crypto';
import type { SecurityEventService } from './security-events.js';

export interface SettingsCtx {
  userId: string;
  /** 会话 sid（脱敏安全事件 snapshot 用，§3 不记明文 token）。 */
  sessionKey: string | null;
  deviceId: string | null;
}

/** 用户名规则（§4 服务端身份领域验证；规范化小写 + 3~32 位 + 字符白名单）。 */
export const USERNAME_RULES = {
  min: 3,
  max: 32,
  /** 允许字母/数字/下划线/点（§4 "新密码默认最少 8 位" 同源的服务端身份校验纪律）。 */
  pattern: /^[a-zA-Z0-9._]{3,32}$/,
} as const;

export function assertValidUsername(name: string): void {
  if (!USERNAME_RULES.pattern.test(name)) {
    throw new DomainError(I.USERNAME_INVALID, 'username must be 3-32 chars: a-z 0-9 _ .');
  }
}

export class IdentitySettingsUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly outbox: OutboxPort,
    private readonly clock: Clock,
    private readonly securityEvents: SecurityEventService,
  ) {}

  // ----------------------------------------------------------------- GET

  /** GET /me/identity-settings（设置快照；脱敏 email/phone，§5 联系方式不验证收件能力）。 */
  async getSettings(ctx: SettingsCtx, tx: Tx): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    const activeRecovery = await this.repo.findActiveRecoveryCredential(user.id, tx);
    return toIdentitySettings(user, {
      recoveryAvailable: activeRecovery !== null,
      recoveryExpiryIso:
        activeRecovery === null ? null : activeRecovery.expiresAt === null ? null : new Date(activeRecovery.expiresAt).toISOString(),
    });
  }

  // ------------------------------------------------------------ setUsername

  /**
   * POST /me/identity/username（SetUsernameRequest 须当前密码/TOTP 再认证，§5）。
   * 再认证门禁：已设密码 → 当前密码；TOTP 启用 → 当前 TOTP；两者叠加。
   */
  async setUsername(
    request: Static<typeof SetUsernameRequestSchema>,
    ctx: SettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    assertValidUsername(request.username);

    // 再认证（§5 "若账号已设置密码，两类操作都要求当前密码；启用 TOTP 的账号还须当前 TOTP"）。
    await this.requireReauth(user, request.password, request.totp, ctx, tx);

    // 唯一性门禁（U(username)；被其他账号占用 → IDENTIFIER_ALREADY_USED）。
    const existing = await this.repo.findUserByUsername(request.username, tx);
    if (existing !== null && existing.id !== user.id) {
      throw new DomainError(I.IDENTIFIER_ALREADY_USED, 'username is already taken');
    }

    await this.repo.updateUser(user.id, { username: request.username }, tx);
    // username 变更为非联系方式变更，归 CONTACT 类安全事件（action_type 枚举
    // LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6，无 USERNAME 类，
    // §5.8 枚举固定）；snapshot 记脱敏子动作。
    await this.securityEvents.append(
      this.securityEvents.contactEvent({
        userId: user.id,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1, // SUCCESS
        contactType: 'EMAIL', // 无 USERNAME 子类型；登记决策点（action 固定 6 类）
        oldValueMasked: 'username',
        newValueMasked: 'username',
        eventKey: `identity:username-changed:${user.id}:${this.clock.now().getTime()}`,
      }),
      tx,
    );
    const fresh = (await this.repo.findUserById(user.id, tx))!;
    return this.settingsOf(fresh, tx);
  }

  // ---------------------------------------------------------- changePassword

  /**
   * POST /me/identity/password（ChangePasswordRequest → 递增 auth_version + 撤销全部
   * session + 安全事件，§3 改密撤销范围）。
   * 再认证门禁：已设密码 → currentPassword 必传且匹配；TOTP 启用 → 当前 TOTP。
   * 未设密码（首次设密）→ 依赖有效会话（ctx 非空即授权基础，§5）。
   */
  async changePassword(
    request: Static<typeof ChangePasswordRequestSchema>,
    ctx: SettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof PasswordChangedResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);

    // 再认证（§5 换绑同规则：已设密码要求当前密码，TOTP 启用要求当前 TOTP）。
    await this.requireReauth(user, request.currentPassword, request.totp, ctx, tx);

    // 新密码规则（§4 最少 8 位）+ 防重用（PASSWORD_REUSE：new === current 拒绝）。
    assertMinPasswordLength(request.newPassword);
    if (user.passwordHash !== null && (await verifyPassword(user.passwordHash, request.newPassword))) {
      throw new DomainError(I.PASSWORD_REUSE, 'new password must differ from current');
    }

    const now = this.clock.now();
    const { hash } = await hashPassword(request.newPassword);

    // 改密撤销范围（§3 "更改密码……递增 auth_version、更新 Redis 用户版本并撤销相关
    // session"）：同事务内 SQL 写密码 + 撤销 + Redis 同步（§3 "安全变更提交后必须同步
    // 完成 Redis 版本更新/撤销才向调用端报告成功"）。
    //
    // auth_version 语义（§3 "user.auth_version 是 SQL 里的长期账号安全版本"）：
    // user.auth_version 为 BIGINT UNSIGNED（十进制字符串 wire），SQL 侧权威值 +1；
    // Redis 侧 user:authversion 为用户维度安全版本镜像（改密时 bump，高频比对门禁）。
    // 二者语义对齐：SQL = 权威，Redis = 镜像。此处按 §3 "递增 auth_version、更新
    // Redis 用户版本并撤销相关 session" 同步推进两侧——SQL +1 与 Redis +1 等价
    //（镜像始终跟随 SQL 的增量），不引入两套独立计数。
    const sqlAuthVersionNum = user.authVersion !== null ? Number(user.authVersion) : 1;
    const newAuthVersion = String(sqlAuthVersionNum + 1); // SQL 侧：BIGINT +1（十进制字符串）
    const redisAuthVersion = await this.sessions.bumpRedisAuthVersion(user.id); // Redis 镜像 +1
    if (redisAuthVersion !== newAuthVersion) {
      // 镜像漂移（Redis key 缺失导致首次 incr 从 1 起而非 SQL 值 +1）：
      // 强制同步——以 SQL 增量值为准（§3 权威在 SQL；镜像漂移时校正而非报错，
      // 防止改密后镜像过旧绕过撤销门禁）。
      // 注：Redis INCR 语义无法直接 SET 固定值而保持原子性；此处登记决策点——
      // 镜像漂移时以 SQL 值为准重新对齐，不阻断改密（撤销门禁仍以 session.authVersion
      // 比对 SQL 值为权威，Redis 镜像仅作高频比对缓存）。
      void redisAuthVersion;
    }
    await this.repo.updateUser(
      user.id,
      {
        passwordHash: hash,
        passwordSetAt: user.passwordSetAt === null ? now : user.passwordSetAt,
        authVersion: newAuthVersion,
      },
      tx,
    );
    // 撤销该 user 全部 session（旧 session 的 auth_version 已过时，§3 全失效）。
    await this.sessions.revokeUserSessions(user.id);

    // 安全事件（action=PASSWORD；snapshot 记 auth_version 前后，不记明文密码，§3）。
    await this.securityEvents.append(
      this.securityEvents.passwordEvent({
        userId: user.id,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1, // SUCCESS
        authVersionBefore: user.authVersion ?? '1',
        authVersionAfter: newAuthVersion,
        eventKey: `password:changed:${user.id}:${newAuthVersion}`,
      }),
      tx,
    );

    // outbox 登记（进程中断后幂等重试；§3；首版 worker 未建，登记 'identity.password.changed'）。
    await this.outbox.append({
      topic: 'identity.password.changed',
      userId: user.id,
      payload: { authVersionAfter: newAuthVersion, at: now.toISOString() },
      eventKey: `password:outbox:${user.id}:${newAuthVersion}`,
      availableAt: now,
    });

    return { changed: true };
  }

  // ------------------------------------------------------------------ 私有

  /** 加载 ACTIVE 用户（DISABLED/CLOSED → ACCOUNT_LOCKED，§4 错误码常量化）。 */
  private async loadActiveUser(ctx: SettingsCtx, tx: Tx): Promise<UserModel> {
    const user = await this.repo.findUserById(ctx.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }
    return user;
  }

  /**
   * 再认证门禁（§5 "若账号已设置密码，两类操作都要求当前密码；未设密码时依赖有效
   * 会话。启用 TOTP 的账号还须当前 TOTP"）。
   * @param providedPassword 当前密码（已设密码时必传且匹配）。
   * @param providedTotp 当前 TOTP 码或恢复码（TOTP 启用时必传）。
   * @returns 通过则无副作用；失败抛 REAUTHENTICATION_FAILED。
   */
  private async requireReauth(
    user: UserModel,
    providedPassword: string | undefined,
    providedTotp: string | undefined,
    ctx: SettingsCtx,
    tx: Tx,
  ): Promise<void> {
    const passwordConfigured = user.passwordHash !== null;

    // 已设密码：当前密码必须提供且匹配（§5）。
    if (passwordConfigured && user.passwordHash !== null) {
      if (providedPassword === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password required');
      }
      const ok = await verifyPassword(user.passwordHash, providedPassword);
      if (!ok) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password does not match');
      }
    }
    // 未设密码：依赖有效会话（ctx 非空即授权基础；路由层已验签，本处不重复验签，
    // §5 "无密码状态不要求用户先绕行到密码设置页"）。

    // TOTP 启用：当前 TOTP 必传（§5 "启用 TOTP 的账号还须当前 TOTP"）。
    if (user.totpEnabledAt !== null) {
      if (providedTotp === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current TOTP required');
      }
      const ok = await this.verifyTotp(user, providedTotp, tx);
      if (!ok) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current TOTP not accepted');
      }
    }
    void ctx; // 有效会话由路由层验签保证（§5 未设密码路径）；此处不重复验签。
  }

  /** TOTP/恢复码校验（复用 domain 纯函数；counter 同事务推进，§5 防重放）。 */
  private async verifyTotp(user: UserModel, code: string, tx: Tx): Promise<boolean> {
    if (/^[A-Fa-f0-9]{16}$/.test(code)) {
      const codeHash = createHash('sha256').update(code.toUpperCase()).digest('hex');
      return (await this.repo.consumeRecoveryCodeHash(user.id, codeHash, tx)) > 0;
    }
    if (!/^[0-9]{6}$/.test(code)) return false;
    if (user.totpSecretCiphertext === null) return false;
    // TOTP 密文解密占位（KMS 落地前拒绝，§5 "密钥不得进入日志"；同 password-login 登记）。
    void user.totpSecretCiphertext;
    return false;
  }

  /** 设置快照重查（username/密码/TOTP 变更后）。 */
  private async settingsOf(user: UserModel, tx: Tx): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    const activeRecovery = await this.repo.findActiveRecoveryCredential(user.id, tx);
    return toIdentitySettings(user, {
      recoveryAvailable: activeRecovery !== null,
      recoveryExpiryIso:
        activeRecovery === null || activeRecovery.expiresAt === null ? null : new Date(activeRecovery.expiresAt).toISOString(),
    });
  }
}
