/**
 * support 模块领域错误（携带稳定业务错误码，由 HTTP 边界映射 envelope）。
 *
 * 领域所有者：support 模块（全部 application 用例抛出，adapters/HTTP 边界消费）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（社交与客服：坐席队列 + 消息
 * outbox→Socket 双端投递 + 断线补拉）、§5.4（support 端点）；
 * 与 social / rooms 模块 domain/errors.ts 同款纪律（每个用例文件维护
 * 自己的错误码映射表，本文件只提供抛错工具与统一错误码表）。
 *
 * 错误码表（SUP，support 模块专属；contracts 无既有 support 错误码，
 * 本表为本地登记）：
 * - SUPPORT_CONVERSATION_NOT_FOUND：support_conversation 行缺失。
 * - SUPPORT_CONVERSATION_CLOSED：会话 status = CLOSED=3 且 closed_at 已回填，
 *   不可再追加消息（§5.9 "closed_at 后不可继续追加消息"）。
 * - SUPPORT_NOT_CONVERSATION_OWNER：请求者非会话 user_id（用户端点）或
 *   非 assigned_admin_user_id（坐席端点，claim 后）。
 * - SUPPORT_NOT_ASSIGNED：坐席端点操作未 claim 的会话（assigned_admin_user_id
 *   仍 NULL，需先 POST /admin/support/conversations/:id/claim）。
 * - SUPPORT_IDEMPOTENCY_KEY_REUSED：claim 幂等键 `support:claim:{conversationId}:{adminUserId}`
 *   命中异 admin → 跨坐席领取冲突（幂等键 U 约束兜底，本码仅用于
 *   跨 admin 场景；同 admin 静默返回既有值，不产生第二笔）。
 * - STORAGE_UNAVAILABLE：Sequelize 故障 / 行缺失（可重试）。
 */

/** support 模块错误码表（稳定业务码，HTTP 边界 `code` 字段直接取 `error.code`）。 */
export const SUP = {
  SUPPORT_CONVERSATION_NOT_FOUND: 'SUPPORT_CONVERSATION_NOT_FOUND',
  SUPPORT_CONVERSATION_CLOSED: 'SUPPORT_CONVERSATION_CLOSED',
  SUPPORT_NOT_CONVERSATION_OWNER: 'SUPPORT_NOT_CONVERSATION_OWNER',
  SUPPORT_NOT_ASSIGNED: 'SUPPORT_NOT_ASSIGNED',
  SUPPORT_IDEMPOTENCY_KEY_REUSED: 'SUPPORT_IDEMPOTENCY_KEY_REUSED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type SupportErrorCode = (typeof SUP)[keyof typeof SUP];

/** 携带 SupportErrorCode 的领域错误（HTTP 边界 `code` 字段直接取 `error.code`）。 */
export class SupportDomainError extends Error {
  /** 稳定业务错误码（SupportErrorCode 或通用码字符串）。 */
  readonly code: string;
  /** 是否可重试（默认 false；STORAGE_UNAVAILABLE 可重试）。 */
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'SupportDomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** 判断是否为 support 领域错误（用例/装配层捕获分支用）。 */
export function isSupportDomainError(err: unknown): err is SupportDomainError {
  return err instanceof SupportDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（ER_DUP_ENTRY）。
 * 与 social 模块 domain/errors.ts `isDuplicateKeyError` 同款语义，
 * support 模块独立维护（不跨模块 import 内部工具，保持模块内聚）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { name?: string; parent?: { code?: string; errno?: number } } | null;
  if (e === null || e === undefined) return false;
  if (typeof e.name === 'string' && e.name === 'SequelizeUniqueConstraintError') return true;
  const code = e.parent?.code;
  const errno = e.parent?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}
