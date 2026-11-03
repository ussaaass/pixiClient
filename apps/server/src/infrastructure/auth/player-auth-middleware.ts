/**
 * 玩家端 JWT 认证中间件（SDD §5.2）。
 *
 * 依据 `docs/04_domains/JWT登录与会话设计.md` §2：
 * - 玩家：`Authorization: Bearer <access>` → 验签 + Redis session 仍 ACTIVE
 *   + `auth_version` 一致。
 * - 失败映射：401 缺/无效/过期/撤销；envelope `code` 与 IdentityErrorCode 对齐。
 *
 * 中间件在 `createIdentityModule` 完成后调用，把 `IdentityModule` 注入 ctx.state
 * 供下游 handler 读取。
 */

import type { Middleware, ParameterizedContext, Next } from 'koa';
import { ApiError } from '../http/error-boundary.js';
import type { RequestContextState } from '../http/request-context.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';

/** 扩展 Koa 状态：认证成功后写入的 principal 上下文。 */
export interface AuthState extends RequestContextState {
  /** 已认证的 user.id（十进制字符串）。 */
  userId?: string;
  /** 会话 sid。 */
  sid?: string;
  /** 设备 device.id（可能 null = 无设备会话）。 */
  deviceId?: string | null;
  /** 会话 version（auth_version）。 */
  authVersion?: string;
  /** identity 模块实例（供 handler 直接调用用例）。 */
  identityModule?: IdentityModule;
}

/** 创建玩家端 JWT 认证中间件（单路由用法，不写日志——由调用方外层日志中间件覆盖）。 */
export function createPlayerAuthMiddleware(module: IdentityModule): Middleware<AuthState> {
  return async (ctx: ParameterizedContext<AuthState>, next: Next) => {
    ctx.state.identityModule = module;

    const header = ctx.get('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      throw new ApiError('UNAUTHORIZED', '缺少 Bearer access token。', { status: 401 });
    }

    let verified;
    try {
      verified = await module.jwtIssuer.verifyAccessToken(token, {
        audience: 'player',
      });
    } catch {
      throw new ApiError('ACCESS_TOKEN_INVALID', 'access token 无效或已过期。', {
        status: 401,
      });
    }

    // 检查 Redis session 仍有效且 auth_version 一致（§3 撤销门禁）。
    const session = await module.sessionPort.getSession(verified.sid);
    if (session === null) {
      throw new ApiError('SESSION_REVOKED', '会话已失效，请重新登录。', {
        status: 401,
      });
    }
    if (session.authVersion !== verified.authVersion) {
      throw new ApiError('REFRESH_REVOKED', '安全版本变更，请重新登录。', {
        status: 401,
      });
    }

    ctx.state.userId = verified.userId;
    ctx.state.sid = verified.sid;
    ctx.state.deviceId = verified.deviceId;
    ctx.state.authVersion = verified.authVersion;

    await next();
  };
}
