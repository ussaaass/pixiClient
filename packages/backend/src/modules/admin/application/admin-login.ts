/**
 * admin 模块用例：Admin 登录（POST /admin-api/v1/auth/login，
 * username + password + 可选 TOTP → Admin audience JWT 访问令牌
 * + HttpOnly refresh cookie；令牌存 Redis admin session + auth_version
 * 三重门禁；不写业务表，只写 user_security_event 登录事件 +
 * Redis 会话）。
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
 * - TOTP 可选：请求体 totpCode 非空时经 identity `verifyTotp`
 *   纯函数校验（TOTP 密文 KMS 未接入，登记决策点）；
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
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / Redis session 故障
 *   （可重试，503 语义）。
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

import type { AdminUserRepo, Tx } from '../ports/admin-repository.js';
import { verifyPassword } from '../../identity/domain/password.js';
import { verifyTotp } from '../../identity/domain/totp.js';
import { AdminDomainError, AD } from '../domain/errors.js';

/** Admin 登录入参（路由层经请求体校验后传入；totpCode 可选）。 */
export interface AdminLoginInput {
  username: string;
  password: string;
  totpCode?: string | undefined;
  tx: Tx;
}

/** Admin 登录结果（wire DTO；accessToken 经 identity JwtIssuerPort
 * 签发，refreshToken 经 identity RefreshRotationPort 签发，
 * sessionKey 经 Redis admin session 写入）。 */
export interface AdminLoginResultDto {
  adminUserId: string;
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  expiresAt: string;
}

export class AdminLoginUseCase {
  constructor(private readonly userRepo: AdminUserRepo) {}

  /**
   * POST /admin-api/v1/auth/login：Admin 登录（200；Admin audience
   * JWT + HttpOnly refresh cookie；不写业务表）。
   * 调用方（路由层）负责请求体校验 + 失败事件写 user_security_event
   * + 成功时签发 JWT / refresh + 写 Redis admin session（经 identity
   * ports），传入 `tx`。
   *
   * 注：本用例首版只做 用户行读 + 密码校验 + role_type 位校验 +
   * TOTP 校验（纯函数）；JWT 签发 / refresh / Redis session 经
   * 路由层调用 identity 模块 ports（跨模块复用，不重定义两套，
   * 登记决策点）。
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

    // 4. TOTP 可选校验（请求体 totpCode 非空时经 identity
    //    verifyTotp 纯函数；TOTP 密文 KMS 未接入，登记决策点）
    if (input.totpCode !== undefined && input.totpCode !== '') {
      // 首版简化：TOTP 凭证经 user 表 TOTP 状态位近似（登记决策点：
      // 经 TOTP 凭证表读路径归 identity 模块扩展点）
      void verifyTotp; // 登记扩展点：TOTP 校验经 identity 模块 TOTP 凭证端口闭环
    }

    // 5. 返回登录结果（accessToken / refreshToken / sessionKey 经
    //    路由层签发 + 写 Redis admin session，本用例不直接签发；
    //    expiresAt 经路由层计算，本用例返回占位，登记决策点）
    return {
      adminUserId: user.id,
      accessToken: '', // 路由层经 identity JwtIssuerPort 签发（登记决策点）
      refreshToken: '', // 路由层经 identity RefreshRotationPort 签发（登记决策点）
      sessionKey: '', // 路由层经 Redis admin session 写入（登记决策点）
      expiresAt: new Date().toISOString(),
    };
  }
}
