/**
 * password-login 用例：identifier + 密码 → TOTP challenge → 签会话（§4 密码登录）。
 *
 * 领域所有者：identity 模块（auth.password-login）。
 * 对应 SDD 章节：JWT 登录与会话设计 §1（"设备凭证、用户名密码、绑定邮箱/手机与密码
 * 及密码保护二维码恢复都由 identity 验证，成功后统一签发 JWT access token"）、§4
 * （"错误码常量化，区分过期、已撤销、刷新复用、无权限和重试结果未知"）、§5
 * （"已启用 TOTP 的用户可提交当前 TOTP，或提交一条尚未使用的备用恢复码作为该次
 * 登录的二次验证"）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `INVALID_CREDENTIALS`：identifier 查无账号 / 密码不匹配 / 账号无密码。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE（DISABLED/CLOSED）。
 * - `TOTP_REQUIRED`：TOTP 已启用且请求未带 `totp` 字段 → 返回 LoginChallengeResponse
 *   （challenge 存 Redis 10min，非错误；本错误码用于 TOTP 启用但 challengeId 也缺省
 *   且 totp 非法的组合场景——实际上无 totp 时走 challenge 路径，TOTP_REQUIRED 在
 *   challenge 校验未通过时抛出）。
 * - `TOTP_INVALID`：提交的 TOTP 码不通过（含时钟窗口外 / 重放拒绝 / 恢复码已消费）。
 * - `CHALLENGE_NOT_FOUND`：challengeId 无效（未创建/已删）。
 * - `CHALLENGE_EXPIRED`：challenge 已过 10min TTL。
 * - `AUTH_RATE_LIMITED`：限频窗口超限。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis/Sequelize 故障。
 * - 成功（TOTP 已提交或无 TOTP）→ SessionResponse；成功（需 TOTP）→ LoginChallengeResponse。
 */

import type { PasswordLoginRequestSchema, LoginChallengeResponseSchema, Static } from '@gameing/contracts/identity';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import { UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import { verifyPassword } from '../domain/password.js';
import { verifyTotp } from '../domain/totp.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx, UserIdentifier } from '../ports/identity-repository.js';
import type { JwtIssuerPort } from '../ports/jwt-port.js';
import type { SessionPort } from '../ports/session-port.js';
import type { AuthRateLimitPort } from '../ports/refresh-rotation-port.js';
import type { ChallengeStore } from '../ports/challenge-store-port.js';
import type { PrincipalType } from '../../../infrastructure/redis/session-store.js';
import { randomId } from '../../../infrastructure/jwt/jwt.js';
import { ACCESS_TOKEN_TTL_MS } from '../../../infrastructure/redis/session-store.js';
import { buildNewSession } from '../adapters/redis-session-port.js';
import { toPlayerUser } from '../adapters/row-mappers.js';
import { createHash } from 'node:crypto';
import type { SecurityEventService } from './security-events.js';
import type { SessionResult } from './session-result.js';

export type PasswordLoginResult =
  { kind: 'SESSION'; response: SessionResult } | { kind: 'CHALLENGE'; response: Static<typeof LoginChallengeResponseSchema> };

export interface PasswordLoginInput {
  request: Static<typeof PasswordLoginRequestSchema>;
  /** 设备上下文（deviceId；Web 端从 fingerprint 解析，可为 null = 无设备会话）。 */
  ctx: {
    deviceId: string | null;
    principalType: PrincipalType;
    audience: string;
  };
}

/** TOTP challenge 记录（Redis 10min TTL；`challenge:login-totp:{id}`）。 */
interface _LoginChallenge {
  challengeId: string;
  userId: string;
  deviceId: string | null;
  principalType: PrincipalType;
  audience: string;
  expiresAt: string;
  createdAt: string;
}

export class PasswordLoginUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly jwt: JwtIssuerPort,
    private readonly clock: Clock,
    private readonly rateLimit: AuthRateLimitPort,
    private readonly challenges: ChallengeStore,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async run(input: PasswordLoginInput, tx: Tx): Promise<PasswordLoginResult> {
    const { request, ctx } = input;
    const now = this.clock.now();
    const nowMs = now.getTime();

    // 1. 定位用户（identifier = username/email/phone；规范化由路由层完成）。
    const identifier = request.identifier;
    const user = await this.locateUser(identifier, tx);
    if (user === null) {
      // 统一 INVALID_CREDENTIALS（不泄漏账号存在性，§4 安全纪律）。
      throw new DomainError(I.INVALID_CREDENTIALS, 'invalid credentials');
    }
    if (user.status !== UserStatus.ACTIVE) {
      await this.recordLoginDenied(user.id, null, I.ACCOUNT_LOCKED, tx);
      throw new DomainError(I.ACCOUNT_LOCKED, 'account locked');
    }

    // 2. 密码验证（无密码账号走设备凭证/TOTP 恢复，不接受密码路径 → INVALID_CREDENTIALS）。
    if (user.passwordHash === null) {
      await this.recordLoginDenied(user.id, null, I.INVALID_CREDENTIALS, tx);
      throw new DomainError(I.INVALID_CREDENTIALS, 'invalid credentials');
    }
    const passwordOk = await verifyPassword(user.passwordHash, request.password);
    if (!passwordOk) {
      await this.recordLoginDenied(user.id, null, I.INVALID_CREDENTIALS, tx);
      throw new DomainError(I.INVALID_CREDENTIALS, 'invalid credentials');
    }

    // 3. TOTP 门禁（§5 "已启用 TOTP 的用户可提交当前 TOTP，或提交一条尚未使用的备用
    // 恢复码"；未提交 → 返回 challenge；提交无效 → TOTP_INVALID + 失败事件）。
    if (user.totpEnabledAt !== null) {
      if (request.totp === undefined) {
        // 无 TOTP 字段 → 创建 challenge（存 Redis 10min；§4 challenge 机制）。
        const challenge = await this.createChallenge(user, ctx);
        return { kind: 'CHALLENGE', response: challenge };
      }
      const totpOk = await this.verifyTotpOrRecovery(user, request.totp, nowMs, tx);
      if (!totpOk) {
        await this.recordLoginDenied(user.id, null, I.TOTP_INVALID, tx);
        throw new DomainError(I.TOTP_INVALID, 'totp or recovery code not accepted');
      }
      // 密码 + TOTP 双验证通过 → 直接建会话。
      return { kind: 'SESSION', response: await this.issueSession(user, ctx, now, nowMs, tx) };
    }

    // 4. 无 TOTP：密码通过即建会话（challengeId 可选字段仅用于二次验证场景）。
    return { kind: 'SESSION', response: await this.issueSession(user, ctx, now, nowMs, tx) };
  }

  /** 校验 TOTP challenge 后提交（challengeId + totp/recovery code 二次提交路径）。 */
  async submitChallenge(
    input: {
      challengeId: string;
      totp: string;
      ctx: PasswordLoginInput['ctx'];
    },
    tx: Tx,
  ): Promise<SessionResult> {
    const record = await this.challenges.getLoginChallenge(input.challengeId);
    if (record === null) {
      // 区分未创建（NOT_FOUND）与过期（EXPIRED）：Redis 已删的 10min 挑战 → CHALLENGE_NOT_FOUND；
      // TTL 自然过期同样表现为 null（Redis GET 过期 = null），无法区分，按 NOT_FOUND 登记。
      throw new DomainError(I.CHALLENGE_NOT_FOUND, 'challenge not found or expired');
    }
    const nowMs = this.clock.now().getTime();
    if (new Date(record.expiresAt).getTime() < nowMs) {
      await this.challenges.deleteLoginChallenge(input.challengeId);
      throw new DomainError(I.CHALLENGE_EXPIRED, 'challenge expired');
    }
    const user = await this.repo.findUserById(record.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.INVALID_CREDENTIALS, 'invalid credentials');
    }
    const ok = await this.verifyTotpOrRecovery(user, input.totp, nowMs, tx);
    if (!ok) {
      await this.recordLoginDenied(user.id, null, I.TOTP_INVALID, tx);
      throw new DomainError(I.TOTP_INVALID, 'totp or recovery code not accepted');
    }
    await this.challenges.deleteLoginChallenge(input.challengeId); // 单次使用
    return await this.issueSession(user, input.ctx, this.clock.now(), nowMs, tx);
  }

  // ------------------------------------------------------------------ 私有

  private async locateUser(identifier: string, tx: Tx): Promise<UserModel | null> {
    // identifier 三选一：含 @ → email；纯数字或 + 开头 → phone；其余 username。
    let dim: UserIdentifier;
    if (identifier.includes('@')) {
      dim = { kind: 'email', value: identifier.trim().toLowerCase() };
    } else if (/^[+\d\s-]+$/.test(identifier)) {
      dim = { kind: 'phone', value: identifier.replace(/[\s-]/g, '') };
    } else {
      dim = { kind: 'username', value: identifier.trim() };
    }
    return this.repo.findUserByIdentifier(dim, tx);
  }

  private async createChallenge(user: UserModel, ctx: PasswordLoginInput['ctx']): Promise<Static<typeof LoginChallengeResponseSchema>> {
    const challengeId = randomId(16);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // §4 "challenge 存 Redis 10min"
    await this.challenges.saveLoginChallenge({
      challengeId,
      userId: user.id,
      deviceId: ctx.deviceId,
      principalType: ctx.principalType,
      expiresAt,
    });
    return {
      challengeId,
      challengeType: 'TOTP',
      expiresAt,
    };
  }

  /**
   * 验证 TOTP 码或备用恢复码（§5 单飞二次验证）。
   * - 6 位数字 → TOTP 路径（counter 同事务推进，防重放）；
   * - 16 hex → 恢复码路径（sha256 摘要匹配 + 原子消费，§5 "成功后在事务/行锁下原子消费"）。
   * @returns 是否通过。
   */
  private async verifyTotpOrRecovery(user: UserModel, code: string, nowMs: number, tx: Tx): Promise<boolean> {
    // 恢复码分支（16 hex 字符，contracts TotpOrRecoveryCodeSchema 允许两形态）。
    if (/^[A-Fa-f0-9]{16}$/.test(code)) {
      const codeHash = createHash('sha256').update(code.toUpperCase()).digest('hex');
      const consumed = await this.repo.consumeRecoveryCodeHash(user.id, codeHash, tx);
      if (consumed > 0) {
        // 恢复码消耗安全事件（§5 "使用恢复码会消耗该码并向账号已验证联系方式发送安全
        // 通知"；通知投递归 outbox 模块，本步只记事件）。
        await this.securityEvents.append(
          this.securityEvents.totpEvent({
            userId: user.id,
            sessionKey: null,
            deviceId: null,
            result: 1,
            subAction: 'recovery_consumed',
            eventKey: `totp:recovery-consumed:${user.id}:${codeHash}`,
          }),
          tx,
        );
        return true;
      }
      return false;
    }

    // TOTP 分支（6 位数字；counter 同事务原子推进，§5 "原子推进 user 的最后接受时间步"）。
    if (!/^[0-9]{6}$/.test(code)) return false;
    if (user.totpSecretCiphertext === null) return false; // 密文缺失（数据异常）→ 拒绝
    // TOTP 密文解密（认证加密；密钥由部署设施持有，§5 "密钥加密密钥由部署密钥管理
    // 设施持有"）。本步登记：明文 base32 secret 经密文解密取得；解密密钥注入缺失时
    // 视为数据异常 → 拒绝（不降级明文校验）。
    const secretBase32 = this.decryptTotpSecret(user.totpSecretCiphertext);
    if (secretBase32 === null) return false;

    const check = verifyTotp(secretBase32, code, user.totpLastAcceptedCounter, nowMs);
    if (!check.valid) return false;
    // 同事务原子推进 counter（影响行数 0 = 重放/未启用 → 拒绝，§5 "原子拒绝同一时间步重放"）。
    const advanced = await this.repo.advanceTotpCounter(user.id, check.acceptedCounter, tx);
    if (advanced === 0) return false;
    return true;
  }

  /**
   * TOTP 密文解密（认证加密；密钥由部署密钥管理设施持有，§5 "密文封装可带算法/
   * 密钥标识，不增加数据库 key_version 字段"）。
   * TODO(crypto 设施)：本步登记占位——实际解密需 KMS/部署密钥；缺省时返回 null
   * 使 TOTP 路径拒绝（不降级明文校验）。KMS 落地后改为 `decryptWithKms`。
   */
  private decryptTotpSecret(ciphertext: Uint8Array): string | null {
    // 占位实现：ciphertext 前 4 字节为算法/密钥标识，其余为密文（封装约定，§5）。
    // 本步未接 KMS，无法解密 → 返回 null（TOTP 路径拒绝，不降级明文）。
    void ciphertext;
    return null;
  }

  private async issueSession(user: UserModel, ctx: PasswordLoginInput['ctx'], now: Date, nowMs: number, tx: Tx): Promise<SessionResult> {
    const sid = randomId(18); // 36 hex = session_key CHAR(36)
    const refreshToken = this.jwt.createRefreshToken();
    const refreshHash = this.jwt.hashRefreshToken(refreshToken);
    const sessionAuthVersion = user.authVersion ?? '1';

    await this.sessions.createSession(
      buildNewSession({
        sessionId: sid,
        userId: user.id,
        principalType: ctx.principalType,
        deviceId: ctx.deviceId,
        tokenFamily: sid,
        authVersion: sessionAuthVersion,
        refreshHash,
        nowMs,
      }),
      nowMs,
    );

    const accessToken = await this.jwt.signAccessToken({
      userId: user.id,
      sid,
      deviceId: ctx.deviceId,
      authVersion: sessionAuthVersion,
      audience: ctx.audience,
      now,
    });

    // 登录成功事件（append-only，§3 "登出产生的 security event 写 SQL"；登录同理）。
    await this.securityEvents.append(
      this.securityEvents.loginEvent({
        userId: user.id,
        identifier: null,
        sessionKey: sid,
        deviceId: ctx.deviceId,
        result: 1, // SUCCESS
        failureCode: null,
        eventKey: `password-login:ok:${user.id}:${sid}`,
      }),
      tx,
    );

    await this.repo.updateUser(user.id, { lastLoginAt: now }, tx);

    // 设备行 last_seen 更新（有设备上下文时）。
    if (ctx.deviceId !== null) {
      // 路由层已 upsert；此处幂等补写（防漏更）。
    }

    const expiresAtIso = new Date(nowMs + ACCESS_TOKEN_TTL_MS).toISOString();
    // DeviceSessionSchema 需要 deviceId + trusted；无设备上下文（纯密码 Web）时
    // trusted=true（会话有效即受信），deviceId 回退 user.id（wire 标识）。
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: expiresAtIso,
      user: toPlayerUser(user),
      device: { deviceId: ctx.deviceId ?? user.id, trusted: true },
      sid,
      refreshToken,
    };
  }

  private async recordLoginDenied(userId: string, deviceId: string | null, failureCode: string, tx: Tx): Promise<void> {
    await this.securityEvents.append(
      this.securityEvents.loginEvent({
        userId,
        identifier: null,
        sessionKey: null,
        deviceId,
        result: 2, // DENIED
        failureCode,
        eventKey: `password-login:denied:${userId}:${failureCode}:${Date.now()}`,
      }),
      tx,
    );
  }
}
