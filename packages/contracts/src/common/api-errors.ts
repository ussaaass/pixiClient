import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

/**
 * 稳定业务错误码与 HTTP 状态映射。
 *
 * 依据 `docs/02_architecture/HTTP接口与共享DTO协议SDD.md`：
 * - 错误码是「稳定常量字符串」，不是数字，因此不占用 0 哨兵值；
 * - 同一失败语义必须由本表固定映射到 HTTP status，禁止各 controller 自选；
 * - 领域错误码带领域前缀（WALLET_/ROOM_/IDENTITY_…），通用传输错误码不带前缀。
 *
 * 新增错误码必须同时补：① 本表条目；② HTTP status 映射；③ 对应的契约测试。
 */

/** 通用传输层错误码：与具体领域无关的协议级失败。 */
export const TransportErrorCode = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  REQUEST_VALIDATION_FAILED: 'REQUEST_VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE_CONTENT: 'UNPROCESSABLE_CONTENT',
  RATE_LIMITED: 'RATE_LIMITED',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
} as const;

/** 幂等冲突：同一幂等键复用于不同 payload。 */
export const IdempotencyErrorCode = {
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
} as const;

/** 游戏目录领域错误码。 */
export const GameErrorCode = {
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  GAME_DIFFICULTY_NOT_FOUND: 'GAME_DIFFICULTY_NOT_FOUND',
} as const;

/** rooms 领域稳定错误码。 */
export const RoomErrorCode = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_CLOSED: 'ROOM_CLOSED',
  ROUND_NOT_FOUND: 'ROUND_NOT_FOUND',
  ROUND_NOT_ACTIVE: 'ROUND_NOT_ACTIVE',
  ROUND_ALREADY_SETTLED: 'ROUND_ALREADY_SETTLED',
  GAME_ENTRY_NOT_FOUND: 'GAME_ENTRY_NOT_FOUND',
  GAME_ENTRY_EXPIRED: 'GAME_ENTRY_EXPIRED',
  WALLET_INSUFFICIENT: 'WALLET_INSUFFICIENT',
  FENCING_CONFLICT: 'FENCING_CONFLICT',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  ROUND_PLAYER_NOT_FOUND: 'ROUND_PLAYER_NOT_FOUND',
  INVALID_SUBMISSION: 'INVALID_SUBMISSION',
  ROUND_IN_PROGRESS: 'ROUND_IN_PROGRESS',
} as const;

/** 全部错误码的并集。新增领域错误码在此登记后才能被 HTTP 边界使用。 */
export const ApiErrorCode = {
  ...TransportErrorCode,
  ...IdempotencyErrorCode,
  ...GameErrorCode,
  ...RoomErrorCode,
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/**
 * 错误码到 HTTP status 的唯一映射表。
 *
 * 依据 SDD §5：HTTP status 表达传输/请求结果类别，envelope code 表达业务结果，
 * 两者必须一致，不能用 HTTP 200 包装失败。
 */
export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  [TransportErrorCode.INTERNAL_ERROR]: 500,
  [TransportErrorCode.REQUEST_VALIDATION_FAILED]: 400,
  [TransportErrorCode.UNAUTHORIZED]: 401,
  [TransportErrorCode.FORBIDDEN]: 403,
  [TransportErrorCode.NOT_FOUND]: 404,
  [TransportErrorCode.METHOD_NOT_ALLOWED]: 405,
  [TransportErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [TransportErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [TransportErrorCode.CONFLICT]: 409,
  [TransportErrorCode.UNPROCESSABLE_CONTENT]: 422,
  [TransportErrorCode.RATE_LIMITED]: 429,
  [TransportErrorCode.BAD_GATEWAY]: 502,
  [TransportErrorCode.SERVICE_UNAVAILABLE]: 503,
  [TransportErrorCode.GATEWAY_TIMEOUT]: 504,
  [IdempotencyErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [GameErrorCode.GAME_NOT_FOUND]: 404,
  [GameErrorCode.GAME_DIFFICULTY_NOT_FOUND]: 404,
  [RoomErrorCode.ROOM_NOT_FOUND]: 404,
  [RoomErrorCode.ROUND_NOT_FOUND]: 404,
  [RoomErrorCode.GAME_ENTRY_NOT_FOUND]: 404,
  [RoomErrorCode.ROUND_PLAYER_NOT_FOUND]: 403,
  [RoomErrorCode.ROOM_FULL]: 409,
  [RoomErrorCode.ROOM_CLOSED]: 409,
  [RoomErrorCode.ROUND_NOT_ACTIVE]: 409,
  [RoomErrorCode.ROUND_ALREADY_SETTLED]: 409,
  [RoomErrorCode.FENCING_CONFLICT]: 409,
  [RoomErrorCode.ROUND_IN_PROGRESS]: 409,
  [RoomErrorCode.GAME_ENTRY_EXPIRED]: 409,
  [RoomErrorCode.WALLET_INSUFFICIENT]: 422,
  [RoomErrorCode.INVALID_SUBMISSION]: 422,
  [RoomErrorCode.STORAGE_UNAVAILABLE]: 503,
};

/**
 * 可重试错误码集合：依赖暂时不可用，重试同一请求（同一幂等键）可能成功。
 * 其余错误重试无意义，客户端应提示用户或换参数。
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  TransportErrorCode.SERVICE_UNAVAILABLE,
  TransportErrorCode.GATEWAY_TIMEOUT,
  TransportErrorCode.BAD_GATEWAY,
  TransportErrorCode.RATE_LIMITED,
]);

/** 字段级校验错误细节。不回显密码、验证码、token、完整账户或支付 provider 数据。 */
export const ApiErrorDetailSchema = Type.Object(
  {
    field: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export type ApiErrorDetail = Static<typeof ApiErrorDetailSchema>;

/** 供 HTTP 边界判断"这是不是预期内的业务拒绝"。 */
export function isKnownErrorCode(value: string): value is ApiErrorCode {
  return Object.prototype.hasOwnProperty.call(API_ERROR_HTTP_STATUS, value);
}

/** 取错误码对应的 HTTP status；未登记的错误码一律按 500 处理，不泄漏为 4xx。 */
export function httpStatusForErrorCode(code: string): number {
  return isKnownErrorCode(code) ? API_ERROR_HTTP_STATUS[code] : API_ERROR_HTTP_STATUS[TransportErrorCode.INTERNAL_ERROR];
}

/** 错误码是否可重试；未登记的错误码视为不可重试的内部故障。 */
export function isRetryableErrorCode(code: string): boolean {
  return isKnownErrorCode(code) && RETRYABLE_ERROR_CODES.has(code);
}
