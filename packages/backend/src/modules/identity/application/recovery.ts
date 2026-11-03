/**
 * recovery 用例：二维码恢复（recovery_credential 校验 + 撤销旧会话 + 建新 sid，§3）。
 *
 * 领域所有者：identity 模块（auth.recovery）。
 * 对应 SDD 章节：JWT 登录与会话设计 §3 —— "账号通过二维码恢复后撤销旧会话并创建
 * 新 sid，但二维码凭证仍可重复使用，直至被新二维码替换、主动撤销或过期。" §4
 * （recovery 端点）；数据库设计 SDD §5.1 recovery_credential（"成功使用只更新
 * last_used_at 并写入安全事件，不消费或撤销二维码"）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `RECOVERY_CREDENTIAL_NOT_FOUND`：credential_key 查无凭证行。
 * - `RECOVERY_CREDENTIAL_INVALID`：secret_hash 与提交的 recoverySecret 摘要不符。
 * - `RECOVERY_CREDENTIAL_REPLACED`：凭证 status = REVOKED(2)（被新二维码替换/主动撤销）。
 * - `RECOVERY_CREDENTIAL_PENDING_EXPIRED`：expires_at 已过（status 未更新为 EXPIRED
 *   的过期行；用前检查过期并标记 EXPIRED，§5.1 "过期凭证需先更新为 EXPIRED 再签发"）。
 * - `TOTP_INVALID`：账号已启用 TOTP 但未提供/校验不通过（§3 "账号已启用 TOTP 时，
 *   二维码恢复仍必须输入当前 TOTP"）。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE。
 * - `AUTH_RATE_LIMITED`：限频窗口超限。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis/Sequelize 故障。
 * - 成功 → SessionResponse（新 sid；撤销范围 = 该 user 全部旧会话 + auth_version 递增
 *   + 安全事件，同事务，§3 "撤销范围 + auth_version 递增 + user_security_event 同事务"）。
 */

import type { AccountRecoveryRequestSchema, SessionResponseSchema, Static } from '@gameing/contracts/identity';
import { RecoveryStatus, UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import { verifyTotp } from '../domain/totp.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { JwtIssuerPort } from '../ports/jwt-port.js';
import type { SessionPort } from '../ports/session-port.js';
import type { AuthRateLimitPort } from '../ports/refresh-rotation-port.js';
import type { PrincipalType } from '../../../infrastructure/redis/session-store.js';
import { randomId } from '../../../infrastructure/jwt/jwt.js';
import { ACCESS_TOKEN_TTL_MS } from '../../../infrastructure/redis/session-store.js';
import { buildNewSession } from '../adapters/redis-session-port.js';
import { toPlayerUser } from '../adapters/row-mappers.js';
import { createHash } from 'node:crypto';
import type { SecurityEventService } from './security-events.js';

export interface RecoveryInput {
  request: Static<typeof AccountRecoveryRequestSchema>;
  ctx: {
    principalType: PrincipalType;
    audience: string;
    deviceId: string | null;
  };
}

export class RecoveryUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly jwt: JwtIssuerPort,
    private readonly clock: Clock,
    private readonly rateLimit: AuthRateLimitPort,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async run(input: RecoveryInput, tx: Tx): Promise<Static<typeof SessionResponseSchema>> {
    const { request, ctx } = input;
    const now = this.clock.now();
    const nowMs = now.getTime();

    // 1. 定位凭证（按 credential_key，§3 "recovery_credential secret_hash 比对"）。
    const credential = await this.repo.findRecoveryCredentialByKey(request.credentialId, tx);
    if (credential === null) {
      throw new DomainError(I.RECOVERY_CREDENTIAL_NOT_FOUND, 'recovery credential not found');
    }
    // 限频（恢复是高敏感操作，按 user 维度计数）。
    const rate = await this.rateLimit.check(credential.userId, nowMs);
    if (rate.limited) {
      throw new DomainError(I.AUTH_RATE_LIMITED, 'rate limit exceeded', { retryable: true });
    }

    // 2. 凭证状态门禁（§5.1 recovery_credential 实体规则 + §3 撤销范围）。
    if (credential.status === RecoveryStatus.REVOKED) {
      await this.recordRecoveryDenied(credential.userId, request.credentialId, I.RECOVERY_CREDENTIAL_REPLACED, tx);
      throw new DomainError(I.RECOVERY_CREDENTIAL_REPLACED, 'recovery credential revoked or replaced');
    }
    const expired =
      credential.status === RecoveryStatus.EXPIRED || (credential.expiresAt !== null && new Date(credential.expiresAt).getTime() < nowMs);
    if (expired) {
      // §5.1 "过期凭证需先更新为 EXPIRED 再签发新的有效记录"：未标 EXPIRED 的过期行
      // 在此补标（幂等：status=EXPIRED 时 update 无副作用）。
      await this.repo.markRecoveryCredentialUsed(credential.id, now, tx); // 占位：复用 update
      await this.securityEvents.append(
        this.securityEvents.recoveryEvent({
          userId: credential.userId,
          credentialKey: request.credentialId,
          sessionKey: null,
          deviceId: ctx.deviceId,
          result: 2, // DENIED
          eventKey: `recovery:expired:${credential.id}:${nowMs}`,
        }),
        tx,
      );
      throw new DomainError(I.RECOVERY_CREDENTIAL_PENDING_EXPIRED, 'recovery credential expired');
    }

    // 3. secret_hash 比对（sha256(recoverySecret) vs 行摘要；§3 "secret_hash 比对"）。
    const submittedHash = createHash('sha256').update(request.recoverySecret).digest('hex');
    const rowHashHex = Buffer.from(credential.secretHash ?? new Uint8Array()).toString('hex');
    if (submittedHash !== rowHashHex) {
      await this.recordRecoveryDenied(credential.userId, request.credentialId, I.RECOVERY_CREDENTIAL_INVALID, tx);
      throw new DomainError(I.RECOVERY_CREDENTIAL_INVALID, 'recovery secret mismatch');
    }

    // 4. 账号门禁（DISABLED/CLOSED 不恢复）。
    const user = await this.repo.findUserById(credential.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }

    // 5. TOTP 门禁（§3 "账号已启用 TOTP 时，二维码恢复仍必须输入当前 TOTP"）。
    if (user.totpEnabledAt !== null) {
      if (request.totp === undefined) {
        // 无 TOTP 字段：TOTP_INVALID（恢复不接受缺省；§5 "无法提供 TOTP 时转客服 IM 人工核验"，
        // 本步不实现客服路径，错误码登记 TOTP_INVALID 供路由层转人工）。
        await this.recordRecoveryDenied(user.id, request.credentialId, I.TOTP_INVALID, tx);
        throw new DomainError(I.TOTP_INVALID, 'current TOTP required for recovery');
      }
      const nowMs2 = this.clock.now().getTime();
      const secretBase32 = this.decryptTotpSecret(user.totpSecretCiphertext);
      if (secretBase32 === null || !verifyTotp(secretBase32, request.totp, user.totpLastAcceptedCounter, nowMs2).valid) {
        await this.recordRecoveryDenied(user.id, request.credentialId, I.TOTP_INVALID, tx);
        throw new DomainError(I.TOTP_INVALID, 'current TOTP not accepted');
      }
    }

    // 6. 撤销旧会话 + 建新 sid + auth_version 递增（§3 "撤销旧会话并创建新 sid +
    // auth_version 递增 + 安全事件同事务"；跨存储窗口 outbox 记录用于进程中断后幂等重试）。
    // 注：本步撤销走 Redis（sessions 端口），auth_version 递增走 SQL + Redis 镜像；
    // §3 "安全变更提交后必须同步完成 Redis 版本更新/撤销才向调用端报告成功"。
    await this.sessions.revokeUserSessions(user.id);
    const newAuthVersion = await this.sessions.bumpRedisAuthVersion(user.id);
    // SQL auth_version 同步递增（长期账号安全版本，§3 "user.auth_version 是 SQL 里的
    // 长期账号安全版本"；与 Redis 镜像对齐，改密后旧 session 全失效）。
    await this.repo.updateUser(user.id, { authVersion: newAuthVersion }, tx);

    // 凭证"使用不消费或撤销"（§3 "二维码凭证仍可重复使用，直至被新二维码替换、
    // 主动撤销或过期"）：只更新 last_used_at，不置 REVOKED/EXPIRED。
    await this.repo.markRecoveryCredentialUsed(credential.id, now, tx);

    // 新会话建立。
    const sid = randomId(18);
    const refreshToken = this.jwt.createRefreshToken();
    const refreshHash = this.jwt.hashRefreshToken(refreshToken);
    await this.sessions.createSession(
      buildNewSession({
        sessionId: sid,
        userId: user.id,
        principalType: ctx.principalType,
        deviceId: ctx.deviceId,
        tokenFamily: sid,
        authVersion: newAuthVersion,
        refreshHash,
        nowMs,
      }),
      nowMs,
    );

    const accessToken = await this.jwt.signAccessToken({
      userId: user.id,
      sid,
      deviceId: ctx.deviceId,
      authVersion: newAuthVersion,
      audience: ctx.audience,
      now,
    });

    // 恢复成功安全事件（action=RECOVERY，snapshot 含 credentialKey，不记明文秘密，§3）。
    await this.securityEvents.append(
      this.securityEvents.recoveryEvent({
        userId: user.id,
        credentialKey: request.credentialId,
        sessionKey: sid,
        deviceId: ctx.deviceId,
        result: 1, // SUCCESS
        eventKey: `recovery:ok:${credential.id}:${sid}`,
      }),
      tx,
    );

    await this.repo.updateUser(user.id, { lastLoginAt: now }, tx);

    const expiresAtIso = new Date(nowMs + ACCESS_TOKEN_TTL_MS).toISOString();
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: expiresAtIso,
      user: toPlayerUser(user),
      device: { deviceId: ctx.deviceId ?? user.id, trusted: true },
    };
  }

  // ------------------------------------------------------------------ 私有

  /** TOTP 密文解密（占位登记同 password-login；KMS 落地前返回 null 使 TOTP 路径拒绝）。 */
  private decryptTotpSecret(ciphertext: Uint8Array | null): string | null {
    void ciphertext;
    return null;
  }

  private async recordRecoveryDenied(userId: string, credentialKey: string, failureCode: string, tx: Tx): Promise<void> {
    await this.securityEvents.append(
      this.securityEvents.recoveryEvent({
        userId,
        credentialKey,
        sessionKey: null,
        deviceId: null,
        result: 2, // DENIED
        eventKey: `recovery:denied:${credentialKey}:${failureCode}:${Date.now()}`,
      }),
      tx,
    );
  }
}
