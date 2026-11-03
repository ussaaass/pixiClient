/**
 * JWT 签发/校验（jose，ES256）与 refresh token 工具。
 *
 * 领域所有者：identity 模块。
 * 对应 SDD 章节：JWT 登录与会话设计 §1 —— "建议采用 ES256 非对称签名，私钥只在发行端；
 * 访问 claims 建议 {iss,aud,sub,sid,did,jti,iat,nbf,exp,sessionVersion,tokenUse}；
 * 不包含余额、邮箱手机号、登录密码、设备秘密或长期生效的代理权限。" §3 ——
 * "刷新凭证建议采用随机不透明令牌，服务端存验证摘要和轮换状态；只保留 keyed hash，
 * 不存明文。"
 *
 * 密钥：环境变量 JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM（PEM ES256 密钥对）。
 * dev 缺省时用 `generateKeyPair('ES', {crv:'P-256'})` 内存生成并 warn 日志，不写盘
 * （生产必须提供 PEM，否则每次进程重启会话验签失败）。
 *
 * 验签算法白名单：只接受 ES256（§1 "JWT 必须校验固定允许的签名算法"）。
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, generateKeyPair, exportJWK } from 'jose';
import type { JWK, JWTVerifyResult } from 'jose';

/**
 * jose 6.x 的 key 类型：`CryptoKey`（WebCrypto）或 `JWK`（JSON Web Key 对象）。
 * jose 6 不再导出 `KeyLike`/`JsonWebKey`，改用 `JWK`（类型）+ `CryptoKey`（全局 WebCrypto）。
 */
type JoseKey = CryptoKey | JWK;

/** 注入用的 JWT 配置。 */
export interface JwtConfig {
  /** 签发者标识（player / admin 两套 audience 之外的 iss）。 */
  issuer: string;
  /** 校验的 audience 白名单（player=player / admin=admin，§1 "玩家和 Admin 使用不同 audience"）。 */
  allowedAudiences: string[];
  /** 访问令牌寿命（秒；§1 建议 10min）。 */
  accessTtlSeconds: number;
}

/** access 令牌载荷（§1 固定 claims 清单 + tokenUse）。 */
export interface AccessTokenClaims {
  /** sub：user.id（十进制字符串）。 */
  userId: string;
  /** sid：Redis 会话定位键（§3，user_security_event.session_key 对应值）。 */
  sid: string;
  /** did：device.id（十进制字符串；Admin 会话为 null 时传 undefined）。 */
  deviceId?: string | null;
  /** sessionVersion：签发时从 user.auth_version 复制（§3 比对门禁）。 */
  authVersion: string;
  /** 受众：player / admin。 */
  audience: string;
  /** 签发时钟（UTC），注入以便测试。 */
  now: Date;
}

/** 校验参数。 */
export interface VerifyAccessTokenParams {
  /** 期望 audience（缺省校验 config.allowedAudiences 全部）。 */
  audience?: string;
  /** 期望 sessionVersion（auth_version）；提供时不一致抛错。 */
  expectedAuthVersion?: string;
}

export interface VerifiedAccessToken {
  /** sub：user.id。 */
  userId: string;
  /** sid。 */
  sid: string;
  /** did（可能为 null）。 */
  deviceId: string | null;
  /** sessionVersion。 */
  authVersion: string;
  /** 令牌类型（固定 'access'）。 */
  tokenUse: string;
  /** exp（UTC）。 */
  expiresAt: Date;
}

/** 内存生成的 dev 密钥对标记（Lead 统一验证时 warn 日志一次）。 */
export class JwtKeys {
  private constructor(
    private readonly privateJwk: JWK,
    private readonly publicJwk: JWK,
  ) {}

  /** 由 PEM 密钥对构建（生产路径）：kid 仅索引预配置可信密钥（§1，不能按令牌内地址下载任意密钥）。
   *  PEM 经 node:crypto createPrivateKey/createPublicKey → CryptoKey，再 exportJWK 为 JWK。 */
  /** 由 PEM 密钥对构建（生产路径）：kid 仅索引预配置可信密钥（§1，不能按令牌内地址下载任意密钥）。
   *  PEM 经 node:crypto createPrivateKey/createPublicKey → JWK（node 22+ 原生支持 JWK 导出）。 */
  static async fromPem(privatePem: string, publicPem: string, kid: string): Promise<JwtKeys> {
    const { createPrivateKey, createPublicKey } = await import('node:crypto');
    const privKeyObj = createPrivateKey(privatePem);
    const pubKeyObj = createPublicKey(publicPem);
    // node 22+ 的 KeyObject.exportJwk() 直接返回 JWK，无需 WebCrypto round-trip。
    const privJwk = privKeyObj.export({ format: 'jwk' }) as JWK;
    const pubJwk = pubKeyObj.export({ format: 'jwk' }) as JWK;
    privJwk.kid = kid;
    pubJwk.kid = kid;
    return new JwtKeys(privJwk, pubJwk);
  }

  /** dev 缺省：内存生成 ES256 P-256 密钥对（不写盘；warn 由调用方负责）。 */
  static async generateInMemory(kid: string): Promise<JwtKeys> {
    const { publicKey, privateKey } = await generateKeyPair('ES', { crv: 'P-256' });
    const privJwk = await exportJWK(privateKey);
    const pubJwk = await exportJWK(publicKey);
    privJwk.kid = kid;
    pubJwk.kid = kid;
    return new JwtKeys(privJwk as JWK, pubJwk as JWK);
  }

  get privateKey(): JoseKey {
    return this.privateJwk;
  }

  get publicKey(): JoseKey {
    return this.publicJwk;
  }

  get keyId(): string {
    return this.privateJwk.kid ?? 'default';
  }
}

/** 验签算法白名单（§1 固定允许；只接受 ES256）。 */
const ALGORITHM_WHITELIST = ['ES256'] as const;

/**
 * JWT 发行器。`signAccessToken` / `verifyAccessToken` / `createRefreshToken` /
 * `hashRefreshToken` 由 `modules/identity/adapters/jose-jwt-issuer.ts` 委托。
 */
export class JwtIssuer {
  private readonly config: JwtConfig;
  private readonly keys: JwtKeys;
  /** 原始密钥对象（CryptoKey 或 JWK），避免 JWK round-trip 丢失 crv 导致验签失败。 */
  private readonly signKey: JoseKey;
  private readonly verifyKey: JoseKey;

  constructor(config: JwtConfig, keys: JwtKeys) {
    this.config = config;
    this.keys = keys;
    this.signKey = keys.privateKey;
    this.verifyKey = keys.publicKey;
  }

  /**
   * 签发 access token（§1 固定 claims）。
   * 不含余额/联系方式/密码/设备秘密/长期代理权限。
   */
  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    const nowSec = Math.floor(claims.now.getTime() / 1000);
    const expSec = nowSec + this.config.accessTtlSeconds;
    const jti = randomBytes(16).toString('hex');

    return await new SignJWT({
      sid: claims.sid,
      did: claims.deviceId ?? null,
      sessionVersion: claims.authVersion,
      tokenUse: 'access',
    })
      .setProtectedHeader({
        alg: 'ES256',
        kid: this.keys.keyId,
      })
      .setSubject(claims.userId)
      .setIssuer(this.config.issuer)
      .setAudience(claims.audience)
      .setJti(jti)
      .setIssuedAt(nowSec)
      .setNotBefore(nowSec)
      .setExpirationTime(expSec)
      .sign(this.signKey);
  }

  /**
   * 校验 access token（§1 "JWT 必须校验固定允许的签名算法、签名、iss/aud/sub、exp/nbf、
   * 令牌类型及对应 key"）。
   * @throws 验签失败 / audience 不符 / tokenUse≠'access' / 过期 / 未来 nbf /
   *         expectedAuthVersion 不一致。
   */
  async verifyAccessToken(rawToken: string, params: VerifyAccessTokenParams = {}): Promise<VerifiedAccessToken> {
    const expectedAud = params.audience ?? this.config.allowedAudiences[0];
    if (expectedAud === undefined) {
      throw new Error('JwtIssuer: no audience configured and no fallback in JwtConfig.allowedAudiences');
    }

    const result: JWTVerifyResult<Record<string, unknown>> = await jwtVerify<Record<string, unknown>>(rawToken, this.verifyKey, {
      algorithms: [...ALGORITHM_WHITELIST],
      issuer: this.config.issuer,
      audience: expectedAud,
      requiredClaims: ['exp', 'nbf', 'tokenUse', 'sid', 'sessionVersion'],
    });

    const payload: Record<string, unknown> = result.payload as Record<string, unknown>;
    const tokenUse = payload.tokenUse;
    if (tokenUse !== 'access') {
      throw new Error('JWT_INVALID_TOKEN_USE');
    }
    const sid = payload.sid;
    const sessionVersion = payload.sessionVersion;
    const did = payload.did;
    if (typeof sid !== 'string' || typeof sessionVersion !== 'string') {
      throw new Error('JWT_CLAIMS_MALFORMED');
    }
    if (params.expectedAuthVersion !== undefined && params.expectedAuthVersion !== sessionVersion) {
      throw new Error('AUTH_VERSION_MISMATCH');
    }

    return {
      userId: String(payload.sub),
      sid,
      deviceId: typeof did === 'string' ? did : null,
      authVersion: sessionVersion,
      tokenUse: 'access',
      expiresAt: new Date(Number(payload.exp) * 1000),
    };
  }

  /** 生成高熵不透明 refresh token（§3 "随机不透明令牌，服务端存验证摘要"）。 */
  createRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** refresh token 的 sha256 hex 摘要（§3 "只保留 keyed hash，不存明文"）。 */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// 密钥 PEM 工具（装配层使用）
// ---------------------------------------------------------------------------

/**
 * 从环境变量加载 PEM 密钥对；缺省时 dev 内存生成（不写盘，调用方 warn 日志）。
 * 生产环境必须提供 JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM，否则跨进程验签失败。
 */
export async function loadJwtKeys(kid: string): Promise<JwtKeys> {
  const privPem = process.env.JWT_PRIVATE_KEY_PEM;
  const pubPem = process.env.JWT_PUBLIC_KEY_PEM;
  if (privPem && pubPem) {
    return await JwtKeys.fromPem(privPem, pubPem, kid);
  }
  // dev 缺省：内存生成 + warn（Lead 统一验证时检查日志）。
  console.warn('[jwt] JWT_PRIVATE_KEY_PEM/JWT_PUBLIC_KEY_PEM 未配置，dev 内存生成 ES256 密钥对（不写盘；生产必须配置 PEM）');
  return await JwtKeys.generateInMemory(kid);
}

/** 随机 ID 生成器（sid/tokenFamily/challengeId 复用）。 */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/** HMAC-SHA1（TOTP 域使用；此处导出避免重复实现，domain/totp.ts 直接依赖 node:crypto）。 */
export function hmacSha1Hex(key: Uint8Array, data: string): string {
  return createHmac('sha1', key).update(data).digest('hex');
}

/** base32 编码（RFC 4648，无填充；TOTP 密钥用）。 */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/** base32 解码（校验用；忽略填充与大小写）。 */
export function fromBase32(text: string): Uint8Array {
  const cleaned = text
    .replace(/=+$/g, '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue; // 非法字符忽略（规范化输入；登记为防御性处理）
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
