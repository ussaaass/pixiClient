/**
 * 密码哈希（argon2id，native 失败回退 bcrypt，第三层兜底 node:crypto scrypt）。
 *
 * 领域所有者：identity 模块（user.password_hash）。
 * 对应 SDD 章节：后端实施 SDD §8（"argon2 原生绑定失败时回退 bcrypt，与 user 表注释
 * 一致"）；JWT 登录与会话设计 §4（"新密码默认最少 8 位，服务端身份领域负责验证"）。
 *
 * 三级实现策略（Lead 统一验证时登记）：
 * 1. `argon2`（^0.43，native binding）——首选，argon2id 参数 m=64MB/t=3/p=1；
 * 2. native 加载失败（Docker dev 容器 glibc 不匹配等）→ 回退 `bcrypt`（若已安装）；
 * 3. 两者都不可用 → `node:crypto.scrypt`（系统内置，无需 native 依赖）兜底。
 * 选择结果进程级缓存；hash 前缀（`argon2id`/`$2b$`/`scrypt$`）区分，verify 自动路由。
 */

import { scrypt, timingSafeEqual, randomBytes } from 'node:crypto';

/** 最小密码长度（§4 "新密码默认最少 8 位"）。 */
export const MIN_PASSWORD_LENGTH = 8;

/** hash 结果（前缀标识实现，verify 据此路由）。 */
export interface PasswordHashResult {
  /** 哈希字符串（含实现前缀，落 user.password_hash VARCHAR(255)）。 */
  hash: string;
  /** 实现标识：argon2id / bcrypt / scrypt（登记与审计用）。 */
  algo: 'argon2id' | 'bcrypt' | 'scrypt';
}

/** 校验最小长度（§4）；不满足抛 `PASSWORD_TOO_SHORT`（用例层映射 VALIDATION_FAILED）。 */
export function assertMinPasswordLength(plain: string): void {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw Object.assign(new Error('PASSWORD_TOO_SHORT'), { code: 'PASSWORD_TOO_SHORT' });
  }
}

/**
 * argon2 / bcrypt 动态导入（node 24 ESM：`import('argon2')` 在运行时才解析模块；
 * TypeScript 无法静态解析（未安装类型声明），故用 node:crypto 等价物 + `createRequire`
 * 的 CJS 加载路径——argon2/bcrypt 是 CJS 包，createRequire('x').resolve 可定位入口，
 * 再用 `node:fs` 同步读取入口文件并动态 `eval` 为 CJS 模块。
 *
 * 更简洁的做法（登记为决策点）：直接 `await import('argon2')` 在运行时 work（ESM
 * 支持 .ts/.js/.mjs/.cjs 互转），TS 报错仅因类型声明缺失；本处保留动态 import +
 * 运行时 catch 策略（native 失败 → 回退），类型用 `as unknown as` 断言隔离。
 */

import { createRequire } from 'node:module';
const requireForImports = createRequire(import.meta.url);

/** argon2 类型化句柄（Lead 并行安装 argon2 ^0.43；native 加载失败 → 回退）。 */
interface Argon2Lib {
  ARGON2ID?: string;
  hash(data: string | Buffer, options: unknown): Promise<string>;
  verify(hash: string, data: string | Buffer): Promise<boolean>;
}

/** argon2 模块单例（避免每次动态 import）。 */
let argon2Module: Argon2Lib | undefined;
async function loadArgon2(): Promise<Argon2Lib | undefined> {
  if (argon2Module !== undefined) return argon2Module;
  try {
    // CJS 加载（argon2 包为 CJS）：createRequire 入口路径解析 + require。
    const mod = requireForImports('argon2') as Argon2Lib;
    argon2Module = mod;
    return argon2Module;
  } catch {
    // native binding 加载失败：返回 undefined 触发回退（bcrypt → scrypt）。
    return undefined;
  }
}

/** bcrypt 动态导入（仅 argon2 不可用时尝试；CJS 包同 createRequire）。 */
interface BcryptLib {
  hash(s: string, cost: number): Promise<string>;
  compare(s: string, hash: string): Promise<boolean>;
}
let bcryptModule: BcryptLib | undefined;
async function loadBcrypt(): Promise<BcryptLib | undefined> {
  if (bcryptModule !== undefined) return bcryptModule;
  try {
    const mod = requireForImports('bcrypt') as BcryptLib;
    bcryptModule = mod;
    return bcryptModule;
  } catch {
    return undefined;
  }
}

/** 进程级实现选择缓存（首次哈希时解析一次，避免每次动态 import）。 */
let resolvedImpl: 'argon2id' | 'bcrypt' | 'scrypt' | undefined;

async function resolveImplAsync(): Promise<'argon2id' | 'bcrypt' | 'scrypt'> {
  if (resolvedImpl !== undefined) return resolvedImpl;
  const argon = await loadArgon2();
  if (argon !== undefined) {
    resolvedImpl = 'argon2id';
  } else {
    const bcrypt = await loadBcrypt();
    resolvedImpl = bcrypt !== undefined ? 'bcrypt' : 'scrypt';
  }
  return resolvedImpl;
}

/** scrypt 参数（第三层兜底；N=16384/r=8/p=1，keylen=32，salt 16B 随机）。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;

/** scrypt 编码：`scrypt$<salt-hex>$<N>:<r>:<p>$<key-hex>`（前缀区分，verify 路由）。 */
function encodeScrypt(saltHex: string, keyHex: string): string {
  return `scrypt$${saltHex}$${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}$${keyHex}`;
}

/** scrypt 密钥派生（node:crypto 内置，无 native 依赖）。 */
function scryptKey(plain: string, saltHex: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, Buffer.from(saltHex, 'hex'), SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * 哈希明文密码。
 * @returns hash（含实现前缀）与 algo 标识。
 */
export async function hashPassword(plain: string): Promise<PasswordHashResult> {
  assertMinPasswordLength(plain);
  const impl = await resolveImplAsync();

  if (impl === 'argon2id') {
    const lib = await loadArgon2();
    if (lib !== undefined) {
      // argon2id：m=64MB/t=3/p=1（argon2 包默认即此参数，仅显式 type 登记）。
      const salt = randomBytes(16);
      const hash = await lib.hash(plain, { salt, type: lib.ARGON2ID });
      return { hash, algo: 'argon2id' };
    }
  }

  if (impl === 'bcrypt') {
    const lib = await loadBcrypt();
    if (lib !== undefined) {
      // cost 10（bcrypt 标准；user.password_hash VARCHAR(255) 容量足够）。
      const hash = await lib.hash(plain, 10);
      return { hash, algo: 'bcrypt' };
    }
  }

  // 第三层兜底：node:crypto scrypt（注释登记：argon2/bcrypt 均不可用时的安全下限，
  // 强度低于 argon2id，仅在依赖缺失的极端环境触发；正常 dev/prod 走 argon2id）。
  const saltHex = randomBytes(16).toString('hex');
  const key = await scryptKey(plain, saltHex);
  return { hash: encodeScrypt(saltHex, key.toString('hex')), algo: 'scrypt' };
}

/**
 * 校验明文密码（按 hash 前缀自动路由实现）。
 * @returns 是否匹配（恒不抛错：未知前缀/格式异常一律 false，不泄漏实现细节）。
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  // 按 hash 前缀路由（不依赖进程当前实现——历史 hash 可能由其他实现生成）。
  if (hash.startsWith('$argon2id$') || hash.startsWith('$argon2i$') || hash.startsWith('$argon2d$')) {
    const lib = await loadArgon2();
    if (lib === undefined) return false;
    try {
      return await lib.verify(hash, plain);
    } catch {
      return false;
    }
  }

  if (hash.startsWith('$2')) {
    const lib = await loadBcrypt();
    if (lib === undefined) return false;
    try {
      return await lib.compare(plain, hash);
    } catch {
      return false;
    }
  }

  if (hash.startsWith('scrypt$')) {
    const parts = hash.split('$');
    if (parts.length !== 4) return false;
    const saltHex = parts[1];
    const keyHex = parts[3];
    if (saltHex === undefined || keyHex === undefined) return false;
    const expected = await scryptKey(plain, saltHex);
    const candidate = Buffer.from(keyHex, 'hex');
    if (expected.length !== candidate.length) return false;
    return timingSafeEqual(expected, candidate);
  }

  // 未知前缀：不泄漏实现，一律 false。
  return false;
}

/** 取当前生效的哈希实现（装配日志/审计登记用；首次调用前为 scrypt 兜底标记）。 */
export function currentPasswordAlgo(): 'argon2id' | 'bcrypt' | 'scrypt' {
  return resolvedImpl ?? 'scrypt';
}
