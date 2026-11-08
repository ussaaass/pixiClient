/**
 * device-register 用例：已解析 user/device 后登记设备并建立会话（§4 注册 workflow 幂等赠币）。
 *
 * 领域所有者：identity 模块（auth.device-register）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4 —— "首次访问没有设备凭证时创建用户、设备并建立会话；
 * 注册 workflow 按每个账号一次、幂等调用新用户赠币用例，不增加设备/IP 级额外限制，
 * 也不承诺识别同一自然人跨账号重复注册。后续启动使用 device-login，不再次发奖。"
 * 本用例消费已解析 user/device；当前 HTTP 路由尚未实现匿名首次建号，仅支持已存在用户登记设备。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis/Sequelize 故障或欢迎赠币服务未配置/调用失败。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE（DISABLED=2/CLOSED=3 不建会话）。
 * - 成功 → `OK`（201）。
 *
 * 赠币委托 wallet 的 `WelcomeGiftPort`，按 userId 保证一次发放；缺少端口或发放失败时注册失败关闭。
 */

import type { DeviceRegisterRequestSchema, Static } from '@gameing/contracts/identity';
import type { UserModel, DeviceModel } from '../../../infrastructure/database/models/identity.js';
import { CredentialStatus, UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { JwtIssuerPort } from '../ports/jwt-port.js';
import type { SessionPort } from '../ports/session-port.js';
import type { WelcomeGiftPort } from '../ports/welcome-gift-port.js';
import { randomId } from '../../../infrastructure/jwt/jwt.js';
import { ACCESS_TOKEN_TTL_MS } from '../../../infrastructure/redis/session-store.js';
import { buildNewSession } from '../adapters/redis-session-port.js';
import { toDeviceSession, toPlayerUser } from '../adapters/row-mappers.js';
import type { SessionResult } from './session-result.js';

export interface DeviceRegisterInput {
  request: Static<typeof DeviceRegisterRequestSchema>;
  /** 会话主体（玩家端固定 'PLAYER'；Admin 端走 admin 模块，本用例只处理玩家）。 */
  principalType: 'PLAYER' | 'ADMIN';
  /** 受众（player）。 */
  audience: string;
  /** 当前 user 行（当前 HTTP 路由仅支持已存在用户设备登记）。 */
  user: UserModel;
  /** 设备 device 行（由路由层 upsert 后传入）。 */
  device: DeviceModel;
}

export class DeviceRegisterUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly jwt: JwtIssuerPort,
    private readonly clock: Clock,
    private readonly welcomeGift: WelcomeGiftPort | null,
  ) {}

  async run(input: DeviceRegisterInput, tx: Tx): Promise<SessionResult> {
    const { user, device } = input;

    // 账号与设备状态门禁（不为已撤销/过期/未签发凭证设备建立新会话）。
    if (user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }
    if (
      device.userId !== user.id ||
      device.credentialKey === null ||
      device.credentialSecretHash === null ||
      device.deviceDigest === null ||
      device.deviceDigest.byteLength !== 32 ||
      device.credentialSecretHash.byteLength !== 32 ||
      device.credentialStatus !== CredentialStatus.ACTIVE ||
      (device.credentialExpiresAt !== null &&
        (!Number.isFinite(new Date(device.credentialExpiresAt).getTime()) ||
          new Date(device.credentialExpiresAt).getTime() <= this.clock.now().getTime()))
    ) {
      throw new DomainError(I.DEVICE_CREDENTIAL_MISSING, 'device credential is not active');
    }

    // 会话建立：sid 为 36 位随机 hex，匹配 user_security_event.session_key CHAR(36) 列宽；
    // tokenFamily 同 sid 序列。
    const sid = randomId(18); // 36 hex 字符 = session_key CHAR(36) 列宽
    const now = this.clock.now();
    const nowMs = now.getTime();

    // refresh token：高熵不透明（§3 "只保留 keyed hash，不存明文"）。
    const refreshToken = this.jwt.createRefreshToken();
    const refreshHash = this.jwt.hashRefreshToken(refreshToken);

    // auth_version：会话建立时从 SQL 复制（§3 "创建 session 时复制版本"）。
    // SQL user.auth_version 为权威长期版本（BIGINT，wire 十进制字符串）；Redis 镜像
    // user:authversion 仅用于高频比对门禁（改密时 bump），首建会话直接取 SQL 值，
    // 不 bump（bump 只在"改密/恢复/全设备退出"等安全变更时递增，§3）。
    const sessionAuthVersion = user.authVersion ?? '1';

    const record = buildNewSession({
      sessionId: sid,
      userId: user.id,
      principalType: input.principalType,
      deviceId: device.id,
      tokenFamily: sid, // 同一次登录派生共享一族（sid 作家族根）。
      authVersion: sessionAuthVersion,
      refreshHash,
      nowMs,
    });
    // 注册 workflow 要求按账号一次幂等赠币；依赖未配置时在产生任何副作用前失败关闭。
    if (this.welcomeGift === null) {
      throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'welcome gift service is unavailable');
    }

    // 签名先执行（无持久副作用），降低赠币成功后再遇签名故障的概率。
    const accessToken = await this.jwt.signAccessToken({
      userId: user.id,
      sid,
      deviceId: device.id,
      authVersion: sessionAuthVersion,
      audience: input.audience,
      now,
    });

    // 赠币自管 SQL 事务，按 userId 幂等；之后更新 last_login 使用调用方事务。
    await this.welcomeGift.grantWelcomeGift(user.id);
    await this.repo.updateUser(user.id, { lastLoginAt: now }, tx);

    // Redis 会话最后创建；失败时 SQL 赠币已提交，但 grant_key 幂等保证安全重试，
    // 这是跨存储恢复边界而非分布式事务。
    await this.sessions.createSession(record, nowMs);
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
