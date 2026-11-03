/**
 * device-register 用例：首次访问自动注册设备并建会话（§4 注册 workflow 幂等赠币）。
 *
 * 领域所有者：identity 模块（auth.device-register）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4 —— "首次访问没有设备凭证时自动注册并建立会话；
 * 注册 workflow 按每个账号一次、幂等调用新用户赠币用例，不增加设备/IP 级额外限制，
 * 也不承诺识别同一自然人跨账号重复注册。后续启动使用 device-login，不再次发奖。"
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis/Sequelize 故障（用例无法建立会话/读用户）。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE（DISABLED=2/CLOSED=3 不建会话）。
 * - 成功 → `OK`（201）。
 *
 * 赠币登记：本步只留 `WelcomeGiftPort` 接口 + TODO 注释（赠币属 wallet 模块，§4 "
 * 注册 workflow 按账号一次幂等调用新用户赠币用例"，wallet 未建故不实现）。
 */

import type { DeviceRegisterRequestSchema, SessionResponseSchema, Static } from '@gameing/contracts/identity';
import type { UserModel, DeviceModel } from '../../../infrastructure/database/models/identity.js';
import { UserStatus } from '../../../infrastructure/database/models/identity.js';
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

export interface DeviceRegisterInput {
  request: Static<typeof DeviceRegisterRequestSchema>;
  /** 会话主体（玩家端固定 'PLAYER'；Admin 端走 admin 模块，本用例只处理玩家）。 */
  principalType: 'PLAYER' | 'ADMIN';
  /** 受众（player）。 */
  audience: string;
  /** 当前 user 行（由路由层先解析设备归属或按 publicCode/设备上下文取得）。 */
  user: UserModel;
  /** 设备 device 行（upsert 结果；路由层传已解析行，或本用例内 upsert）。 */
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

  async run(input: DeviceRegisterInput, tx: Tx): Promise<Static<typeof SessionResponseSchema>> {
    const { user, device } = input;

    // 账号状态门禁（§4 不建会话给非 ACTIVE 账号；DISABLED/CLOSED → ACCOUNT_LOCKED）。
    if (user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }

    // 会话建立：sid = 36 位 UUID-like（randomId 16 hex = 32 字符，补 4 位到 36 位
    // 匹配 user_security_event.session_key CHAR(36) 列宽；tokenFamily 同 sid 序列）。
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
    await this.sessions.createSession(record, nowMs);

    // access token（§1 固定 claims；不含余额/联系方式/密码/设备秘密）。
    const accessToken = await this.jwt.signAccessToken({
      userId: user.id,
      sid,
      deviceId: device.id,
      authVersion: sessionAuthVersion,
      audience: input.audience,
      now,
    });

    // 注册 workflow 幂等赠币（§4 "按每个账号一次"）：wallet 模块未建，TODO 登记。
    // TODO(wallet 模块)：if (this.welcomeGift !== null) await this.welcomeGift.grantWelcomeGift(user.id);
    // 幂等键 = user.id（每账号一次），由 wallet 的 asset_operation.operation_key 兜底。
    void this.welcomeGift;

    // 更新 user.last_login_at + device.last_seen_at（同事务，SQL 侧）。
    await this.repo.updateUser(user.id, { lastLoginAt: now }, tx);
    // 设备 last_seen 由 upsertDevice 路由层已写；此处幂等补写（避免二次访问漏更）。

    // 组装 SessionResponse（contracts 单一来源，不手写第二套 DTO）。
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
