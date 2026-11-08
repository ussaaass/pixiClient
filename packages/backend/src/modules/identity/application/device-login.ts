/**
 * device-login 用例：按 device 凭证登录（后续启动，不再次发奖，§4）。
 *
 * 领域所有者：identity 模块（auth.device-login）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4 —— "后续启动使用 device-login，不再次发奖。"
 * 数据库设计 SDD §5.1 device（"凭证轮换时更新本行摘要和状态；旧凭证因与当前摘要
 * 不符而拒绝"）。
 *
 * 约定：共享请求 body 必须为空；HTTP adapter 从 HttpOnly `device=<credentialKey>.<secret>`
 * cookie 解析 key 并计算 secret 的 SHA-256。`device_digest` 与 `credential_secret_hash`
 * 均存该摘要，use-case 分别做 timing-safe 比对；credential_key 只用于定位 device 行。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `DEVICE_CREDENTIAL_MISSING`：device 行 credential_key 为空（从未签发凭证）。
 * - `DEVICE_CREDENTIAL_REVOKED`：credential_status = REVOKED(2)。
 * - `DEVICE_CREDENTIAL_EXPIRED`：credential_status = EXPIRED(3) 或 credential_expires_at 已过。
 * - `INVALID_CREDENTIALS`：device_digest 与设备提交的 digest 不符（设备秘密不匹配）。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE。
 * - `AUTH_RATE_LIMITED`：限频窗口内计数超限。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis/Sequelize 故障。
 * - 成功 → `OK`（200，SessionResponse）。
 */

import { timingSafeEqual } from 'node:crypto';
import { CredentialStatus, UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { JwtIssuerPort } from '../ports/jwt-port.js';
import type { SessionPort } from '../ports/session-port.js';
import type { AuthRateLimitPort } from '../ports/refresh-rotation-port.js';
import { randomId } from '../../../infrastructure/jwt/jwt.js';
import { ACCESS_TOKEN_TTL_MS } from '../../../infrastructure/redis/session-store.js';
import { buildNewSession } from '../adapters/redis-session-port.js';
import { toDeviceSession, toPlayerUser } from '../adapters/row-mappers.js';
import type { SecurityEventService } from './security-events.js';
import type { SessionResult } from './session-result.js';

export function matchesDeviceDigest(stored: Uint8Array | null, suppliedHex: string): boolean {
  if (stored === null || !/^[a-fA-F0-9]{64}$/.test(suppliedHex) || stored.byteLength !== 32) return false;
  const storedBuffer = Buffer.from(stored);
  const suppliedBuffer = Buffer.from(suppliedHex, 'hex');
  return suppliedBuffer.byteLength === 32 && timingSafeEqual(storedBuffer, suppliedBuffer);
}

export interface DeviceLoginInput {
  /** 由 HttpOnly `credentialKey.secret` cookie 解析出的凭证材料；secret 本身不会传入用例或事件。 */
  ctx: {
    deviceDigestHex: string;
    credentialKey: string;
    principalType: 'PLAYER' | 'ADMIN';
    audience: string;
  };
  /** 匿名凭证查找前的限频 subject，HTTP 层传 credentialKey。 */
  rateLimitSubject?: string;
}

export class DeviceLoginUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly jwt: JwtIssuerPort,
    private readonly clock: Clock,
    private readonly rateLimit: AuthRateLimitPort,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async run(input: DeviceLoginInput, tx: Tx): Promise<SessionResult> {
    const now = this.clock.now();
    const nowMs = now.getTime();

    // Cookie credentials are unauthenticated input until matched; rate-limit on the opaque key first.
    const rate = await this.rateLimit.check(input.rateLimitSubject ?? input.ctx.credentialKey, nowMs);
    if (rate.limited) throw new DomainError(I.AUTH_RATE_LIMITED, 'rate limit exceeded', { retryable: true });

    // Cookie key selects the stored device; the corresponding user identity comes only from this row.
    const device = await this.repo.findDeviceByCredentialKey(input.ctx.credentialKey, tx);
    if (device === null || device.credentialKey !== input.ctx.credentialKey) {
      throw new DomainError(I.DEVICE_CREDENTIAL_MISSING, 'device credential not found');
    }
    if (device.credentialStatus === CredentialStatus.REVOKED) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: device.userId,
          identifier: null,
          sessionKey: null,
          deviceId: device.id,
          result: 2,
          failureCode: I.DEVICE_CREDENTIAL_REVOKED,
          eventKey: `device-login:revoked:${device.id}`,
        }),
        tx,
      );
      throw new DomainError(I.DEVICE_CREDENTIAL_REVOKED, 'device credential revoked');
    }
    if (
      device.credentialStatus === CredentialStatus.EXPIRED ||
      (device.credentialExpiresAt !== null &&
        (!Number.isFinite(new Date(device.credentialExpiresAt).getTime()) || new Date(device.credentialExpiresAt).getTime() <= nowMs))
    ) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: device.userId,
          identifier: null,
          sessionKey: null,
          deviceId: device.id,
          result: 2,
          failureCode: I.DEVICE_CREDENTIAL_EXPIRED,
          eventKey: `device-login:expired:${device.id}`,
        }),
        tx,
      );
      throw new DomainError(I.DEVICE_CREDENTIAL_EXPIRED, 'device credential expired');
    }

    // Cookie secret 的 SHA-256 必须同时匹配当前设备摘要；只接受激活且保存了 hash 的凭证。
    const hasActiveStoredCredential =
      device.credentialStatus === CredentialStatus.ACTIVE &&
      device.credentialKey !== null &&
      device.credentialSecretHash !== null &&
      device.credentialSecretHash.byteLength === 32;
    // Evaluate both stored-hash comparisons independently rather than short-circuiting after the first mismatch.
    const deviceDigestMatches = matchesDeviceDigest(device.deviceDigest, input.ctx.deviceDigestHex);
    const credentialSecretHashMatches = matchesDeviceDigest(device.credentialSecretHash, input.ctx.deviceDigestHex);
    if (!hasActiveStoredCredential || !deviceDigestMatches || !credentialSecretHashMatches) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: device.userId,
          identifier: null,
          sessionKey: null,
          deviceId: device.id,
          result: 2,
          failureCode: I.INVALID_CREDENTIALS,
          eventKey: `device-login:digest:${device.id}:${nowMs}`,
        }),
        tx,
      );
      throw new DomainError(I.INVALID_CREDENTIALS, 'device digest mismatch');
    }

    // 账号状态门禁（§4 不建会话给非 ACTIVE）。
    const user = await this.repo.findUserById(device.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: device.userId,
          identifier: null,
          sessionKey: null,
          deviceId: device.id,
          result: 2,
          failureCode: I.ACCOUNT_LOCKED,
          eventKey: `device-login:locked:${device.userId}`,
        }),
        tx,
      );
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }

    // 会话建立（同 device-register 路径：sid + refresh 摘要 + access 签发）。
    const sid = toSessionId36();
    const refreshToken = this.jwt.createRefreshToken();
    const refreshHash = this.jwt.hashRefreshToken(refreshToken);
    const sessionAuthVersion = user.authVersion ?? '1';

    await this.sessions.createSession(
      buildNewSession({
        sessionId: sid,
        userId: user.id,
        principalType: input.ctx.principalType,
        deviceId: device.id,
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
      deviceId: device.id,
      authVersion: sessionAuthVersion,
      audience: input.ctx.audience,
      now,
    });

    // 登录成功安全事件（append-only，§3 登出/登录事件写 SQL）。
    await this.securityEvents.append(
      this.securityEvents.loginEvent({
        userId: user.id,
        identifier: null,
        sessionKey: sid,
        deviceId: device.id,
        result: 1, // SUCCESS
        failureCode: null,
        eventKey: `device-login:ok:${user.id}:${sid}`,
      }),
      tx,
    );

    // 更新 last_login_at / last_seen_at（同事务）。
    await this.repo.updateUser(user.id, { lastLoginAt: now }, tx);

    const expiresAtIso = new Date(nowMs + ACCESS_TOKEN_TTL_MS).toISOString();
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: expiresAtIso,
      user: toPlayerUser(user),
      device: toDeviceSession(device),
      sid,
      refreshToken,
    };
  }
}

/** 36 字符 sid（user_security_event.session_key CHAR(36) 列宽匹配；UUID-like 随机）。 */
function toSessionId36(): string {
  return randomId(18); // 36 hex = 36 字符（randomId 默认 16 hex=32，此取 18）
}
