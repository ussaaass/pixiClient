import { randomUUID } from 'node:crypto';
import type { Middleware, ParameterizedContext } from 'koa';

/**
 * requestId 中间件。
 *
 * 依据 SDD §4：`requestId` 由服务端为每个 HTTP attempt 建立/确认，用于日志关联。
 * 客户端可用 `X-Request-Id` 提供符合格式的 trace hint，但服务端需防止冲突/伪造
 * 并回传最终值。因此这里的策略是：
 * - 只接受符合 UUID v4 形态的客户端 hint；
 * - 不合法或缺省时由服务端生成新的 UUID；
 * - 一律回传 `X-Request-Id` 响应头，让客户端知道最终值。
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Koa 扩展状态：把 requestId 放进 ctx.state，供下游 middleware 与 handler 读取。 */
export interface RequestContextState {
  requestId: string;
  /** 本次请求最终的业务结果码，由 handler 或错误边界写入，供访问日志读取。 */
  businessCode?: string;
}

/** 判断一个字符串是否是可接受的客户端 requestId hint。 */
export function isAcceptableRequestHint(value: string | undefined): value is string {
  return typeof value === 'string' && value.length <= 64 && UUID_V4_PATTERN.test(value);
}

/** requestId 中间件：建立/确认 requestId 并回传响应头。 */
export const requestIdMiddleware: Middleware<RequestContextState> = (ctx, next) => {
  const hint = ctx.get(REQUEST_ID_HEADER);
  const requestId = isAcceptableRequestHint(hint) ? hint.toLowerCase() : randomUUID();
  ctx.state.requestId = requestId;
  ctx.set(REQUEST_ID_HEADER, requestId);
  return next();
};

/** 读取当前请求的 requestId；未经过 requestIdMiddleware 时回退为新生成的 UUID。 */
export function getRequestId(ctx: ParameterizedContext<RequestContextState>): string {
  return ctx.state.requestId ?? randomUUID();
}
