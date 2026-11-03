/**
 * identity 领域错误（携带稳定 `IdentityErrorCode` 码，由 HTTP 边界映射 envelope）。
 *
 * 领域所有者：identity 模块（全部 application 用例抛出，adapters/HTTP 边界消费）。
 * 对应 SDD 章节：contracts `IdentityErrorCode`（41 码）+ `common/api-errors.ts`
 * （code/status/retryable 约定，"同一失败语义必须由本表固定映射到 HTTP status"）。
 *
 * 约定（AGENTS.md 常量纪律）：错误码为稳定字符串常量，不进 0 哨兵；每个用例文件
 * 维护自己的错误码映射表（见各用例头注释 + 完成报告），本模块只提供抛错工具。
 */

import { IdentityErrorCode } from '@gameing/contracts/identity';

/** 携带 IdentityErrorCode 的领域错误（HTTP 边界 `code` 字段直接取 `error.code`）。 */
export class DomainError extends Error {
  /** 稳定业务错误码（IdentityErrorCodeValue 或通用码字符串）。 */
  readonly code: string;
  /** 是否可重试（默认 false；AUTH_RATE_LIMITED 等为 true，由调用方覆盖）。 */
  readonly retryable: boolean;
  /** 字段级细节（可选；不回显密码/验证码/token，common/api-errors.ts 纪律）。 */
  readonly details?: Array<{ field?: string; code: string; message: string }>;

  constructor(code: string, message: string, options: { retryable?: boolean; details?: DomainError['details'] } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** identity 错误码快捷引用（用例层 `DomainError(C.INVALID_CREDENTIALS, ...)`）。 */
export const I = IdentityErrorCode;

/**
 * 重导出 `Static`（typebox 工具类型）。
 * 原因：backend 包 NodeNext 下不直接依赖 @sinclair/typebox（TS2307 不穿透
 * contracts 的 transitive 类型）；用例层统一经 @gameing/contracts/identity 取
 * `Static`（已在 contracts 重导出），保持 "不手写第二套 DTO" 的契约单一来源纪律。
 */
export type { Static } from '@gameing/contracts/identity';

/** 快捷抛错（用例层惯用写法 `throw err(I.TOTP_INVALID, 'TOTP code not accepted')`）。 */
export function err(code: string, message: string, options?: { retryable?: boolean; details?: DomainError['details'] }): never {
  throw new DomainError(code, message, options);
}
