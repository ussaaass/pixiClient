import type { ParameterizedContext } from 'koa';
import { ApiSuccessEnvelopeSchema } from '@gameing/contracts/common/api-envelope';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { getRequestId, type RequestContextState } from './request-context.js';

/**
 * 成功响应助手。
 *
 * 统一 envelope 的构造入口，避免各 handler 手写 `{requestId, code, message, data, serverNow}`。
 * 构造后用契约 schema 自检，违反契约直接抛错（让开发期立刻暴露，而不是发出畸形响应）。
 */

/** 设置成功 envelope 到 ctx，并返回同一份 body。 */
export function setSuccess<T extends TSchema>(
  ctx: ParameterizedContext<RequestContextState>,
  options: { message: string; data: unknown; schema: T; status?: number },
): Record<string, unknown> {
  const body = {
    requestId: getRequestId(ctx),
    code: 'OK' as const,
    message: options.message,
    data: options.data,
    serverNow: new Date().toISOString(),
  };

  if (!Value.Check(ApiSuccessEnvelopeSchema(options.schema), body)) {
    throw new Error(`成功响应违反共享契约：${options.schema.Title ?? 'anonymous'}`);
  }

  ctx.status = options.status ?? 200;
  ctx.body = body;
  ctx.state.businessCode = 'OK';
  return body;
}
