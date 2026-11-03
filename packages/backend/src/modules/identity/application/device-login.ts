/**
 * device-login 用例：按 device 凭证登录（后续启动，不再次发奖，§4）。
 *
 * 领域所有者：identity 模块（auth.device-login）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4 —— "后续启动使用 device-login，不再次发奖。"
 * 数据库设计 SDD §5.1 device（"凭证轮换时更新本行摘要和状态；旧凭证因与当前摘要
 * 不符而拒绝"）。
 *
 * 约定：device-login 请求体为空对象（contracts `IdentityEndpoint.deviceLogin.request`
 * = `Type.Object({}, ...)`），设备凭证（device_digest + credential_key）由传输层
 * 从设备本地持久存储读取后经路由层注入 `ctx`（App 平台安全存储策略，§2），用例
 * 不读 body。
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

import type { SessionResponseSchema, Static } from '@gameing/contracts/identity';
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

export interface DeviceLoginInput {
  /** 传输层注入的设备上下文（device_digest 由 App 本地持久化的设备秘密现算摘要）。 */
  ctx: {
    userId: string;
    /** 设备提交值 sha256 hex（与 device.device_digest BINARY(32) 比对）。 */
    deviceDigestHex: string;
    credentialKey: string;
    principalType: 'PLAYER' | 'ADMIN';
    audience: string;
  };
  /** 限频 subject（userId，§4 刷新按 userId 计数；设备登录按设备归属 userId）。 */
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

  async run(input: DeviceLoginInput, tx: Tx): Promise<Static<typeof SessionResponseSchema>> {
    const now = this.clock.now();
    const nowMs = now.getTime();

    // 限频（§4 AUTH_RATE_LIMITED；设备登录按 userId 计数）。
    const rate = await this.rateLimit.check(input.rateLimitSubject ?? input.ctx.userId, nowMs);
    if (rate.limited) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: input.ctx.userId,
          identifier: null,
          sessionKey: null,
          deviceId: null,
          result: 2, // DENIED
          failureCode: I.AUTH_RATE_LIMITED,
          eventKey: `device-login:limited:${input.ctx.userId}:${nowMs}`,
        }),
        tx,
      );
      throw new DomainError(I.AUTH_RATE_LIMITED, 'rate limit exceeded', { retryable: true });
    }

    // 设备凭证门禁（§4 错误码常量化，区分过期/已撤销/无凭证）。
    const device = await this.repo.findDeviceByCredentialKey(input.ctx.credentialKey, tx);
    if (device === null || device.credentialKey !== input.ctx.credentialKey) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: input.ctx.userId,
          identifier: null,
          sessionKey: null,
          deviceId: null,
          result: 2,
          failureCode: I.DEVICE_CREDENTIAL_MISSING,
          eventKey: `device-login:missing:${input.ctx.credentialKey}`,
        }),
        tx,
      );
      throw new DomainError(I.DEVICE_CREDENTIAL_MISSING, 'device credential not found');
    }
    if (device.userId !== input.ctx.userId) {
      // 设备归属校验：credential_key 指向的设备不属于该用户（防止跨用户凭证使用）。
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: input.ctx.userId,
          identifier: null,
          sessionKey: null,
          deviceId: device.id,
          result: 2,
          failureCode: I.INVALID_CREDENTIALS,
          eventKey: `device-login:mismatch:${device.id}`,
        }),
        tx,
      );
      throw new DomainError(I.INVALID_CREDENTIALS, 'device does not belong to user');
    }
    if (device.credentialStatus === CredentialStatus.REVOKED) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: input.ctx.userId,
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
      (device.credentialExpiresAt !== null && new Date(device.credentialExpiresAt).getTime() < nowMs)
    ) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: input.ctx.userId,
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

    // device_digest 比对（§device 实体规则 "旧凭证因与当前摘要不符而拒绝"；
    // device_digest 为 BINARY(32) 摘要列，hex 字符串比对）。
    const rowDigestHex = Buffer.from(device.deviceDigest ?? new Uint8Array()).toString('hex');
    if (rowDigestHex !== input.ctx.deviceDigestHex) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: input.ctx.userId,
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
    const user = await this.repo.findUserById(input.ctx.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      await this.securityEvents.append(
        this.securityEvents.loginEvent({
          userId: input.ctx.userId,
          identifier: null,
          sessionKey: null,
          deviceId: device.id,
          result: 2,
          failureCode: I.ACCOUNT_LOCKED,
          eventKey: `device-login:locked:${input.ctx.userId}`,
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
    };
  }
}

/** 36 字符 sid（user_security_event.session_key CHAR(36) 列宽匹配；UUID-like 随机）。 */
function toSessionId36(): string {
  return randomId(18); // 36 hex = 36 字符（randomId 默认 16 hex=32，此取 18）
}
