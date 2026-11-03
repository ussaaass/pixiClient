/**
 * wallet 领域错误（携带稳定 `WalletErrorCode` 码，由 HTTP 边界映射 envelope）。
 *
 * 领域所有者：wallet 模块（全部 application 用例抛出，adapters/HTTP 边界消费）。
 * 对应 SDD 章节：contracts `WalletErrorCode`（24 码）+ 后端实施 SDD §10（资金命令
 * 幂等/同事务/失败可重查）；与 identity 模块 domain/errors.ts 同款纪律
 * （每个用例文件维护自己的错误码映射表，本文件只提供抛错工具）。
 */

import { WalletErrorCode } from '@gameing/contracts/wallet';

/** 携带 WalletErrorCode 的领域错误（HTTP 边界 `code` 字段直接取 `error.code`）。 */
export class WalletDomainError extends Error {
  /** 稳定业务错误码（WalletErrorCodeValue 或通用码字符串）。 */
  readonly code: string;
  /** 是否可重试（默认 false；WALLET_STORAGE_UNAVAILABLE 乐观冲突可重试）。 */
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'WalletDomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** wallet 错误码快捷引用（用例层 `WalletDomainError(W.INVALID_TRANSFER_AMOUNT, ...)`）。 */
export const W = WalletErrorCode;

/** 判断是否为 wallet 领域错误（用例/装配层捕获分支用）。 */
export function isWalletDomainError(err: unknown): err is WalletDomainError {
  return err instanceof WalletDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（ER_DUP_ENTRY）。
 * 资金幂等先抢 `asset_operation.operation_key` / `gift_grant.grant_key` 唯一约束
 * （SDD §4）：捕获此错误后区分"同键同内容重放"与"同键异内容"（IDEMPOTENCY_KEY_REUSED）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { name?: string; parent?: { code?: string; errno?: number } } | null;
  if (e === null || e === undefined) return false;
  if (typeof e.name === 'string' && e.name === 'SequelizeUniqueConstraintError') return true;
  const code = e.parent?.code;
  const errno = e.parent?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}
