/**
 * jose JWT 发行器适配器（JwtIssuerPort 实现）。
 *
 * 领域所有者：identity 模块（委托 infrastructure/jwt/jwt.ts，用例不直接依赖 jose）。
 * 对应 SDD 章节：JWT 登录与会话设计 §1（ES256 非对称、固定 claims）、§3（不透明
 * refresh token 摘要）；后端实施 SDD §4（adapters/ 实现 ports/）。
 */

import type { JwtIssuer, AccessTokenClaims, VerifyAccessTokenParams, VerifiedAccessToken } from '../../../infrastructure/jwt/jwt.js';
import type { JwtIssuerPort } from '../ports/jwt-port.js';
/**
 * JwtIssuerPort 适配器：把 JwtIssuer 包装为端口实现（签名/校验/refresh 工具）。
 * 验签异常统一转为领域错误消息（用例层映射 IdentityErrorCode.ACCESS_TOKEN_INVALID /
 * SESSION_REVOKED 等）。
 */
export class JoseJwtIssuerAdapter implements JwtIssuerPort {
  constructor(private readonly issuer: JwtIssuer) {}

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.issuer.signAccessToken(claims);
  }

  async verifyAccessToken(rawToken: string, params: VerifyAccessTokenParams = {}): Promise<VerifiedAccessToken> {
    // 验签异常统一转为领域错误消息（用例层映射 IdentityErrorCode.ACCESS_TOKEN_INVALID /
    // SESSION_REVOKED 等）：'AUTH_VERSION_MISMATCH' / 'JWT_INVALID_TOKEN_USE' /
    // 'JWT_CLAIMS_MALFORMED' / jose 验签失败（signature/audience/exp/nbf/alg）。
    return await this.issuer.verifyAccessToken(rawToken, params);
  }

  createRefreshToken(): string {
    return this.issuer.createRefreshToken();
  }

  hashRefreshToken(token: string): string {
    return this.issuer.hashRefreshToken(token);
  }
}
