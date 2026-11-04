/**
 * Admin 端 JWT 认证中间件（SDD §7.1 Admin 双轨切换 + §5.3 /admin-api/v1 前缀）。
 *
 * 依据 `docs/04_domains/JWT登录与会话设计.md` §2 Admin audience 约定：
 * - Admin：`Authorization: Bearer <access>`（`aud: 'admin'`）→ 验签 +
 *   Redis admin session 仍 ACTIVE + `auth_version` 一致（三重门禁，
 *   与 player 中间件同款纪律）。
 * - 失败映射：401 缺 / 无效 / 过期 / 撤销；envelope `code` 与
 *   AD_ADMIN_UNAUTHORIZED 对齐。
 *
 * 与 player 中间件（player-auth-middleware.ts）同款纪律，区别仅
 * audience='admin'；中间件在 `createIdentityModule` +
 * `createAdminModule` 完成后调用，把 `AdminModule` 注入 ctx.state
 * 供下游 handler 读取。
 *
 * 领域所有者：admin 模块（apps/server 路由层基础设施；
 * Admin audience 鉴权门禁；§9 第 9 步 Admin 全量切换收口）。
 * 对应 SDD 章节：后端实施 SDD §7.1（Admin 双轨切换：Admin
 * audience JWT + Redis admin session + auth_version 三重门禁）、
 * §5.3（Admin API 前缀 /admin-api/v1）、§9 第 9 步（Admin 路由
 * 挂载条件 identityModule + adminModule + sequelize 均就绪）。
 *
 * 登记决策点（Lead 确认）：
 * 1. Admin audience JWT 经 identity JwtIssuerPort 签发 / 验签
 *    （aud 参数传 'admin'，KID 经 env var 注入；KMS 密钥设施
 *    未闭环，登记扩展点）；
 * 2. Redis admin session 经 identity SessionPort 扩展点登记
 *    （principal_type='ADMIN' 位标记，与 PLAYER 会话隔离；
 *    登记决策点：是否需独立 admin_session Redis key 前缀）。
 */

import type { Middleware, ParameterizedContext, Next } from 'koa';
import { ApiError } from '../http/error-boundary.js';
import type { RequestContextState } from '../http/request-context.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { AdminModule } from '@gameing/backend/modules/admin/public';

/** 扩展 Koa 状态：Admin 认证成功后写入的 principal 上下文。 */
export interface AdminAuthState extends RequestContextState {
  /** 已认证的 admin user.id（十进制字符串）。 */
  adminUserId?: string;
  /** 会话 sid。 */
  sid?: string;
  /** 会话 version（auth_version）。 */
  authVersion?: string;
  /** identity 模块实例（供 handler 直接调用用例）。 */
  identityModule?: IdentityModule;
  /** admin 模块实例（供 handler 直接调用用例）。 */
  adminModule?: AdminModule;
}

/**
 * 创建 Admin 端 JWT 认证中间件（单路由用法，不写日志——由调用方
 * 外层日志中间件覆盖；与 player 中间件同款三重门禁纪律，
 * 区别仅 audience='admin'）。
 *
 * @param identityModule 用于验签 + 读 Redis session（Admin audience
 *   JWT 经 identity JwtIssuerPort 签发 / 验签；Redis admin session
 *   经 identity SessionPort 登记，登记决策点）。
 * @param adminModule 注入 ctx.state 供下游 handler 调用 Admin 用例。
 */
export function createAdminAuthMiddleware(
  identityModule: IdentityModule,
  adminModule: AdminModule,
): Middleware<AdminAuthState> {
  return async (ctx: ParameterizedContext<AdminAuthState>, next: Next) => {
    ctx.state.identityModule = identityModule;
    ctx.state.adminModule = adminModule;

    const header = ctx.get('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      throw new ApiError('AD_ADMIN_UNAUTHORIZED', '缺少 Bearer access token。', { status: 401 });
    }

    let verified;
    try {
      verified = await identityModule.jwtIssuer.verifyAccessToken(token, {
        audience: 'admin',
      });
    } catch {
      throw new ApiError('AD_ADMIN_UNAUTHORIZED', 'access token 无效或已过期。', {
        status: 401,
      });
    }

    // 检查 Redis admin session 仍有效且 auth_version 一致（§3 撤销门禁；
    // 与 player 中间件同款纪律）。
    const session = await identityModule.sessionPort.getSession(verified.sid);
    if (session === null) {
      throw new ApiError('AD_ADMIN_UNAUTHORIZED', 'Admin 会话已失效，请重新登录。', {
        status: 401,
      });
    }
    if (session.authVersion !== verified.authVersion) {
      throw new ApiError('AD_ADMIN_UNAUTHORIZED', '安全版本变更，请重新登录。', {
        status: 401,
      });
    }

    ctx.state.adminUserId = verified.userId;
    ctx.state.sid = verified.sid;
    ctx.state.authVersion = verified.authVersion;

    await next();
  };
}
