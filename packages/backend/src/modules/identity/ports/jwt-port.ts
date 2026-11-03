/**
 * JWT 发行端口（抽象 jose 实现，用例不直接依赖 jose / ioredis）。
 *
 * 领域所有者：identity 模块（adapters/jose-jwt-issuer.ts 委托
 * infrastructure/jwt/jwt.ts 实现）。
 * 对应 SDD 章节：JWT 登录与会话设计 §1（ES256 非对称、固定 claims 清单）、§3
 * （随机不透明 refresh token，服务端只存摘要）。
 */

import type { AccessTokenClaims, VerifyAccessTokenParams, VerifiedAccessToken } from '../../../infrastructure/jwt/jwt.js';

/**
 * JwtIssuer 端口：签发/校验 access + 生成/摘要 refresh。
 * 用例层只依赖本接口（SDD §4 端口约定），不直接 import jose。
 */
export interface JwtIssuerPort {
  /** 签发 access token（§1 固定 claims；不含余额/联系方式/密码/设备秘密）。 */
  signAccessToken(claims: AccessTokenClaims): Promise<string>;
  /** 校验 access token（算法白名单只接受 ES256；iss/aud/sub/exp/nbf/tokenUse）。 */
  verifyAccessToken(rawToken: string, params?: VerifyAccessTokenParams): Promise<VerifiedAccessToken>;
  /** 生成高熵不透明 refresh token（§3，randomBytes(32)）。 */
  createRefreshToken(): string;
  /** refresh token 的 sha256 hex 摘要（§3 "只保留 keyed hash，不存明文"）。 */
  hashRefreshToken(token: string): string;
}
