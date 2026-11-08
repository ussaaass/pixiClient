/**
 * admin 模块用例：Admin 登录（POST /admin-api/v1/auth/login，
 * username + password → Admin audience JWT access token
 * + HttpOnly refresh cookie; Redis Admin session + auth_version 三重门禁。
 * Admin TOTP challenge 暂未接入，传入 totpCode 时 fail closed。
 *
 * 领域所有者：admin 模块（user 表 admin 视角读 + password_hash
 * 校验；Redis admin session 经 identity 模块 SessionPort 扩展点
 * 登记；user_security_event 登录事件经 identity SecurityEventService
 * 扩展点登记；SDD §7.3 Admin audience 双轨切换）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports）、§7.1
 * （Admin 双轨切换：admin_users / admin_permissions 工作区 →
 * Admin audience 鉴权 + Redis admin session + auth_version）、
 * §7.3（/admin-api/v1 域端点清单）、§9 第 9 步（Admin 全量切换
 * 收口：Admin 登录端点，对齐 docs/04_domains/JWT登录与会话设计.md
 * §2 Admin audience 约定）；数据库设计 SDD §5.1（user 表
 * password_hash 列 argon2id 哈希 + role_type 位标记 ADMIN=4 位）。
 *
 * 用例语义：
 * - 按 username 读 user 行（缺行 → AD_USER_NOT_FOUND 401 语义；
 *   缺密码 → 同样 401，防用户名枚举攻击，docs 第 3 节红线）；
 * - role_type 位校验：含 ADMIN=4 位（role_type & 4 !== 0）经
 *   前置校验（不含 → AD_PERMISSION_DENIED 403 语义；
 *   首版 ADMIN 角色经 user.role_type 位标记，登记决策点：
 *   是否需独立 admin_user 表，Lead 确认）；
 * - 密码校验经 identity 模块 `verifyPassword` 纯函数
 *   （argon2id native 失败回退 bcrypt，第三层 scrypt 兜底；
 *   跨模块复用 identity domain 纯函数，不重定义两套，
 *   与 rooms / referral 模块复用 identity ports 同款纪律）；
 * - TOTP：启用 TOTP 的账号 fail closed，需等待 KMS + identity challenge 接入；
 *   用户提交非空 totpCode 同样拒绝；
 * - 成功 → 返回 `accessToken`（Admin audience JWT，`aud: 'admin'`，
 *   经 identity JwtIssuerPort 签发）+ `refreshToken`（经
 *   identity RefreshRotationPort 签发，HttpOnly cookie 经路由层
 *   设置）+ `sessionKey`（Redis admin session 定位值）；
 * - 失败 → 写 user_security_event LOGIN_FAILED 事件（经
 *   identity SecurityEventService 扩展点登记；脱敏 identifier，
 *   不含密码明文）；
 * - 本用例不写 admin_audit_event（登录事件经 user_security_event
 *   流水，审计事件经 POST /admin-api/v1/audit 独立端点写，
 *   登记决策点：登录是否需同事务写 admin_audit_event）。
 *
 * 错误码映射（AD → 触发条件）：
 * - `AD_USER_NOT_FOUND`：username 行缺失 / 无密码（401 语义，
 *   防枚举）。
 * - `AD_PERMISSION_DENIED`：role_type 不含 ADMIN=4 位 / 密码错误 /
 *   TOTP 校验失败（403/401 语义，不区分原因，防枚举）。
 * - `STORAGE_UNAVAILABLE`：Redis session 依赖未装配或写入失败（可重试，503 语义）。
 *
 * 登记决策点（Lead 确认）：
 * 1. Admin audience JWT 经 identity JwtIssuerPort 签发（aud 参数
 *    传 'admin'，签发密钥 KID 经 env var 注入，登记 KMS 未闭环）；
 *    首版与 player audience 共用同一 issuer 实例，区别仅 aud 参数；
 * 2. Redis admin session 经 identity SessionPort 扩展点登记
 *    （principal_type = 'ADMIN' 位标记，与 PLAYER 会话隔离，
 *    登记决策点：是否需独立 admin_session Redis key 前缀）；
 * 3. role_type ADMIN=4 位经 user 表位标记，首版不建独立
 *    admin_user 表（登记决策点：Lead 确认是否需 0018 迁移补
 *    admin_user 表或沿用 user.role_type 位标记）。
 */

import { randomUUID } from 'node:crypto';
import type { AdminUserRepo, Tx } from '../ports/admin-repository.js';
import type { JwtIssuerPort } from '../../identity/ports/jwt-port.js';
import type { SessionPort } from '../../identity/ports/session-port.js';
import { verifyPassword } from '../../identity/domain/password.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import { buildNewSession } from '../../identity/public.js';

/** Admin 登录入参（路由层经请求体校验后传入；totpCode 可选）。 */
export interface AdminLoginInput {
  username: string;
  password: string;
  totpCode?: string | undefined;
  tx: Tx;
}

/** Admin 登录结果（wire DTO；accessToken 经 identity JwtIssuerPort 签发，
 * refreshToken 经 identity RefreshRotationPort 签发，
 * sessionKey 经 Redis admin session 写入）。 */
export interface AdminLoginResultDto {
  adminUserId: string;
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  expiresAt: string;
  /** 访问令牌有效期（秒；路由层计算 + 响应体返回，客户端本地计时）。 */
  expiresInSecs: number;
}

export interface AdminLoginDeps {
  /** identity 模块 JwtIssuerPort（signAccessToken / createRefreshToken / hashRefreshToken）。 */
  jwtIssuer: JwtIssuerPort;
  /** identity 模块 SessionPort（createSession，principalType='ADMIN' 与 PLAYER 会话隔离）。 */
  sessionPort: SessionPort;
}

export class AdminLoginUseCase {
  constructor(
    private readonly userRepo: AdminUserRepo,
    private readonly deps?: AdminLoginDeps,
  ) {}

  /**
   * POST /admin-api/v1/auth/login：Admin 登录（200；Admin audience
   * JWT + HttpOnly refresh cookie；不写业务表）。
   * 注：本用例负责用户行读取、密码/role_type 校验、Admin JWT + refresh 令牌签发，
   * 并通过 identity SessionPort 建 Redis Admin session；Admin TOTP 尚未支持。
   */
  async run(input: AdminLoginInput): Promise<AdminLoginResultDto> {
    // 1. 按 username 读 user 行（缺行 / 无密码 → 统一 401 语义，防枚举）
    const user = await this.userRepo.findUserByUsername(input.username, input.tx);
    if (user === null || user.passwordHash === null) {
      throw new AdminDomainError(AD.AD_USER_NOT_FOUND, '用户名或密码错误。');
    }

    // 2. role_type 位校验：含 ADMIN=4 位（role_type & 4 !== 0）
    //    首版 ADMIN 角色经 user.role_type 位标记（登记决策点：
    //    是否需独立 admin_user 表，Lead 确认）
    const roleType: number = user.roleType;
    if ((roleType & 4) === 0) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '该账号无 Admin 权限。', {
        retryable: false,
      });
    }

    // 3. 密码校验（identity 模块 verifyPassword 纯函数；
    //    argon2id native 失败回退 bcrypt，第三层 scrypt 兜底）
    const passwordOk = await verifyPassword(input.password, user.passwordHash);
    if (!passwordOk) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '用户名或密码错误。');
    }

    // Admin TOTP is fail-closed: enabled accounts cannot bypass the factor;
    // validation awaits KMS-backed identity challenge integration.
    if (user.totpEnabledAt !== null) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '此 Admin 账号启用了 TOTP，但当前登录暂未接入二次验证。', { retryable: false });
    }
    if (input.totpCode !== undefined && input.totpCode !== '') {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, 'TOTP 登录验证暂不可用，请联系管理员。', {
        retryable: false,
      });
    }

    // 5. 签发 Admin audience JWT + 写 Redis admin session（identity 端口）
    const sid = randomUUID();
    const sessionKey = sid;

    if (this.deps === undefined) {
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, 'Admin 登录鉴权依赖未装配。', {
        retryable: true,
      });
    }
    const { jwtIssuer, sessionPort } = this.deps;
    const now = new Date();
    const accessLifetimeSecs = 900; // 15 min 访问令牌（Admin 短寿命，登记决策点）

    // 签发 Admin audience JWT（aud='admin'，经 identity JwtIssuerPort）
    const signedToken = await jwtIssuer.signAccessToken({
      userId: user.id,
      sid,
      authVersion: user.authVersion ?? '1',
      audience: 'admin',
      now,
    });

    // 生成高熵 refresh token（randomBytes(32)）
    const rawRefresh = jwtIssuer.createRefreshToken();

    // 写 Redis admin session（principalType='ADMIN'，与 PLAYER 会话隔离）
    const refreshHash = jwtIssuer.hashRefreshToken(rawRefresh);
    await sessionPort.createSession(
      buildNewSession({
        sessionId: sid,
        userId: user.id,
        principalType: 'ADMIN',
        deviceId: null,
        tokenFamily: sid,
        authVersion: user.authVersion ?? '1',
        refreshHash,
        nowMs: now.getTime(),
      }),
      now.getTime(),
    );

    return {
      adminUserId: user.id,
      accessToken: signedToken,
      refreshToken: rawRefresh,
      sessionKey,
      expiresAt: new Date(now.getTime() + accessLifetimeSecs * 1000).toISOString(),
      expiresInSecs: accessLifetimeSecs,
    };
  }
}
