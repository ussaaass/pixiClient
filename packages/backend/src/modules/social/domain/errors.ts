/**
 * social 模块领域错误（携带稳定业务错误码，由 HTTP 边界映射 envelope）。
 *
 * 领域所有者：social 模块（全部 application 用例抛出，adapters/HTTP 边界消费）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（社交与客服）、§5.4（social 端点）；
 * 与 rooms 模块 domain/errors.ts 同款纪律（每个用例文件维护自己的错误码映射表，
 * 本文件只提供抛错工具与统一错误码表）。
 *
 * 错误码表（S，social 模块专属；contracts 无既有 social 错误码，本表为本地登记）：
 * - SOCIAL_TOPIC_NOT_FOUND：social_topic 行缺失（post 引用的 topicKey 无对应行）。
 * - SOCIAL_POST_NOT_FOUND：social_post 行缺失。
 * - SOCIAL_REPLY_NOT_ALLOWED：parent reply 非一级回复（嵌套超过一层，模型 CHECK 兜底）。
 * - SOCIAL_CONVERSATION_CLOSED：会话 status = CLOSED=3，不可再追加消息。
 * - SOCIAL_NOT_CONVERSATION_MEMBER：发送者非会话 low/high 成员。
 * - FRIENDSHIP_PENDING：好友关系已 PENDING（同 pair 重复发起/接受/拒绝，幂等重放）。
 * - MESSAGE_DUPLICATE：client_message_id U(sender_user_id, client_message_id) 命中
 *   （同键异内容 → 错误；同键同内容 → 幂等返回既有行，非此码）。
 * - STORAGE_UNAVAILABLE：Sequelize 故障 / 行缺失（可重试）。
 */

/** social 模块错误码表（稳定业务码，HTTP 边界 `code` 字段直接取 `error.code`）。 */
export const S = {
  SOCIAL_TOPIC_NOT_FOUND: 'SOCIAL_TOPIC_NOT_FOUND',
  SOCIAL_POST_NOT_FOUND: 'SOCIAL_POST_NOT_FOUND',
  SOCIAL_REPLY_NOT_ALLOWED: 'SOCIAL_REPLY_NOT_ALLOWED',
  SOCIAL_CONVERSATION_CLOSED: 'SOCIAL_CONVERSATION_CLOSED',
  SOCIAL_NOT_CONVERSATION_MEMBER: 'SOCIAL_NOT_CONVERSATION_MEMBER',
  FRIENDSHIP_PENDING: 'FRIENDSHIP_PENDING',
  MESSAGE_DUPLICATE: 'MESSAGE_DUPLICATE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type SocialErrorCode = (typeof S)[keyof typeof S];

/** 携带 SocialErrorCode 的领域错误（HTTP 边界 `code` 字段直接取 `error.code`）。 */
export class SocialDomainError extends Error {
  /** 稳定业务错误码（SocialErrorCode 或通用码字符串）。 */
  readonly code: string;
  /** 是否可重试（默认 false；STORAGE_UNAVAILABLE 可重试）。 */
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'SocialDomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** 判断是否为 social 领域错误（用例/装配层捕获分支用）。 */
export function isSocialDomainError(err: unknown): err is SocialDomainError {
  return err instanceof SocialDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（ER_DUP_ENTRY）。
 * 与 rooms 模块 domain/errors.ts `isDuplicateKeyError` 同款语义，
 * social 模块独立维护（不跨模块 import 内部工具，保持模块内聚）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { name?: string; parent?: { code?: string; errno?: number } } | null;
  if (e === null || e === undefined) return false;
  if (typeof e.name === 'string' && e.name === 'SequelizeUniqueConstraintError') return true;
  const code = e.parent?.code;
  const errno = e.parent?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}
