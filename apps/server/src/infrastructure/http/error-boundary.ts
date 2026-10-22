import type { Middleware, Next, ParameterizedContext } from 'koa';
import { ApiErrorCode, TransportErrorCode, httpStatusForErrorCode, isRetryableErrorCode } from '@gameing/contracts/common/api-errors';
import { ApiErrorDetailSchema } from '@gameing/contracts/common/api-errors';
import type { ApiErrorDetail } from '@gameing/contracts/common/api-errors';
import type { Logger } from '../logging/logger.js';
import { getRequestId, type RequestContextState } from './request-context.js';

/**
 * 错误边界：把任何未捕获异常映射为统一失败 envelope。
 *
 * 依据 SDD §5 与 §11：
 * - HTTP status 与 envelope code 必须一致，不能用 HTTP 200 包装失败；
 * - `message` 是安全兜底文本，不依赖异常原文，不回显堆栈/SQL/provider 原文/令牌；
 * - 完整 stack 与 cause 只进服务端日志并关联 requestId。
 */

/** 领域层抛出的、带有稳定错误码的异常。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: ApiErrorDetail[] | undefined;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { status?: number; details?: ApiErrorDetail[]; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? httpStatusForErrorCode(code);
    this.details = options.details;
    this.retryable = options.retryable ?? isRetryableErrorCode(code);
  }
}

/** 404 兜底：路径存在但没有匹配到路由。 */
export class NotFoundError extends ApiError {
  constructor(message = '请求的资源不存在。') {
    super(TransportErrorCode.NOT_FOUND, message);
    this.name = 'NotFoundError';
  }
}

/** 构造失败 envelope 的 body。 */
export function buildFailureBody(
  requestId: string,
  code: string,
  message: string,
  options: { details?: ApiErrorDetail[] | undefined; retryable?: boolean | undefined } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    requestId,
    code,
    message,
    data: null,
    serverNow: new Date().toISOString(),
  };
  if (options.details && options.details.length > 0) body.details = options.details;
  if (options.retryable !== undefined) body.retryable = options.retryable;
  return body;
}

/**
 * 错误边界 middleware。
 *
 * 放在所有业务 middleware 之后、路由之前：任何 handler 抛出的异常都会被捕获，
 * 转成统一失败 envelope。未知异常一律按 `INTERNAL_ERROR` / 500 处理。
 */
export function createErrorBoundaryMiddleware(logger: Logger): Middleware<RequestContextState> {
  return async (ctx: ParameterizedContext<RequestContextState>, next: Next) => {
    try {
      await next();
    } catch (error) {
      const requestId = getRequestId(ctx);

      if (error instanceof ApiError) {
        logger.warn('请求以业务错误码结束', {
          requestId,
          route: ctx.route?.path ?? ctx.path,
          method: ctx.method,
          status: error.status,
          code: error.code,
          retryable: error.retryable,
          errorCode: error.code,
        });
        ctx.status = error.status;
        ctx.state.businessCode = error.code;
        ctx.body = buildFailureBody(requestId, error.code, error.message, {
          details: error.details,
          retryable: error.retryable,
        });
        return;
      }

      // 未知异常：记录完整原因到服务端日志，客户端只拿到通用错误与 requestId。
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      logger.error('未分类异常，已按内部错误返回', {
        requestId,
        route: ctx.route?.path ?? ctx.path,
        method: ctx.method,
        status: 500,
        code: TransportErrorCode.INTERNAL_ERROR,
        errorCode: errorName,
        cause: error instanceof Error ? error.stack : String(error),
      });
      ctx.status = 500;
      ctx.state.businessCode = TransportErrorCode.INTERNAL_ERROR;
      ctx.body = buildFailureBody(requestId, TransportErrorCode.INTERNAL_ERROR, '服务暂时不可用，请稍后重试。', {
        retryable: true,
      });
    }
  };
}

export { ApiErrorCode, ApiErrorDetailSchema };
