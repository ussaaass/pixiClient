/**
 * Admin 登录鉴权基础设施（sessionStorage accessToken 注入链路）。
 *
 * 对应 SDD §7.1 双轨切换：19 个工作区 composition.ts 的 getToken()
 * 统一读 sessionStorage('admin.accessToken')；本文件负责
 * - 写入：login() 成功后 setItem + 写 sessionKey；
 * - 读出：currentToken() / currentSessionKey() 供 getToken() 注入；
 * - 清理：logout() 清除 sessionStorage（不删除服务端 session，
 *   服务端经 revokeSession 独立端点；首版本地登出只清前端）。
 *
 * 注：Admin audience JWT 由 /admin-api/v1/auth/login 经 identity
 * JwtIssuerPort（aud='admin'）签发；refresh cookie HttpOnly 由服务端
 * 设置（不存 sessionStorage，防 XSS 窃取）；accessToken 经 sessionStorage
 * 注入 Bearer 请求头（SDD §7.1 双轨切换约定）。
 */

const ACCESS_TOKEN_KEY = 'admin.accessToken';
const SESSION_KEY_STORAGE = 'admin.sessionKey';
const USER_ID_STORAGE = 'admin.userId';

/** 登录成功后调用（经 /admin-api/v1/auth/login 返回体）。 */
export function saveAdminSession(data: { accessToken: string; sessionKey: string; adminUserId: string }): void {
  sessionStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
  sessionStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
  sessionStorage.setItem(SESSION_KEY_STORAGE, data.sessionKey);
  sessionStorage.setItem(USER_ID_STORAGE, data.adminUserId);
}

/** 读当前 accessToken（供 AdminApiClient getToken() 注入 Bearer 头）。 */
export function currentAdminToken(): string | null {
  return sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

/** 读当前 sessionKey（供 onUnauthorized 判断 session 有效性）。 */
export function currentAdminSessionKey(): string | null {
  return sessionStorage.getItem(SESSION_KEY_STORAGE);
}

/** 读当前 adminUserId（供展示 / 审计归属）。 */
export function currentAdminUserId(): string | null {
  return sessionStorage.getItem(USER_ID_STORAGE);
}

/** 本地登出（清 sessionStorage；服务端 session 经独立端点撤销，登记决策点）。 */
export function clearAdminSession(): void {
  sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_KEY_STORAGE);
  sessionStorage.removeItem(USER_ID_STORAGE);
}

/** 是否已有有效 session（accessToken 非空）。 */
export function hasAdminSession(): boolean {
  return sessionStorage.getItem(ACCESS_TOKEN_KEY) !== null;
}
