import type { Middleware, Next, ParameterizedContext } from 'koa';
import type { Logger } from '../logging/logger.js';
import { getRequestId, type RequestContextState } from './request-context.js';

/**
 * 访问日志 middleware。
 *
 * 依据 SDD §11：记录 requestId、route template、HTTP status、业务 code 与耗时。
 * 使用 route template（`/api/v1/games/:gameKey/experience`）而非原始路径，
 * 避免高基数路径撑爆日志索引。
 *
 * 注意：业务 code 由 handler 写在 `ctx.state.businessCode`，
 * 未设置时按 HTTP status 推断（2xx → OK）。
 */
export const BUSINESS_CODE_STATE_KEY = 'businessCode';

export function createRequestLoggingMiddleware(logger: Logger): Middleware<RequestContextState> {
  return async (ctx: ParameterizedContext<RequestContextState>, next: Next) => {
    const startedAt = process.hrtime.bigint();
    try {
      await next();
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = ctx.status;
      const code = ctx.state.businessCode ?? (status >= 200 && status < 300 ? 'OK' : 'ERROR');
      logger.info('http_request', {
        requestId: getRequestId(ctx),
        route: ctx.route?.path ?? ctx.path,
        method: ctx.method,
        status,
        code,
        durationMs: Math.round(durationMs * 1000) / 1000,
      });
    }
  };
}
