import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { ApiErrorDetailSchema } from './api-errors.js';

/**
 * 统一 HTTP 响应 envelope。
 *
 * 依据 `docs/02_architecture/HTTP接口与共享DTO协议SDD.md` §4：
 * 除显式 binary endpoint 外，所有 JSON API 成功与失败响应使用同一 envelope；
 * 不使用 204，保证 requestId、业务 code、message 与 server time 始终可读。
 */

/** 服务端 UTC 时间戳。严格 ISO 8601（含毫秒），与契约包的其余时间字段同口径。 */
export const ServerTimestampSchema = Type.String({
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
});

/**
 * 成功 envelope 的 schema 工厂。
 *
 * `data` 用泛型参数承载具体 DTO schema，这样每个 endpoint 都能导出
 * 「完整响应 schema」用于运行时校验与 OpenAPI 生成，而不需要第二份 DTO。
 */
export function ApiSuccessEnvelopeSchema<T extends TSchema>(data: T) {
  return Type.Object(
    {
      requestId: Type.String({ minLength: 1, maxLength: 64 }),
      code: Type.Literal('OK'),
      message: Type.String({ minLength: 1, maxLength: 512 }),
      data,
      serverNow: ServerTimestampSchema,
    },
    { additionalProperties: false },
  );
}

/** 失败 envelope。`data` 固定为 null，字段级问题放 `details`。 */
export const ApiFailureEnvelopeSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1, maxLength: 64 }),
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ minLength: 1, maxLength: 512 }),
    data: Type.Null(),
    serverNow: ServerTimestampSchema,
    details: Type.Optional(Type.Array(ApiErrorDetailSchema, { maxItems: 32 })),
    retryable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** 成功 envelope 的静态类型。 */
export type ApiSuccess<TData> = {
  requestId: string;
  code: 'OK';
  message: string;
  data: TData;
  serverNow: string;
};

/** 失败 envelope 的静态类型。 */
export type ApiFailure = Static<typeof ApiFailureEnvelopeSchema>;
