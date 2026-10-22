import { describe, expect, test } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import {
  ApiErrorCode,
  API_ERROR_HTTP_STATUS,
  GameErrorCode,
  TransportErrorCode,
  httpStatusForErrorCode,
  isKnownErrorCode,
  isRetryableErrorCode,
} from './api-errors';
import { ApiFailureEnvelopeSchema, ApiSuccessEnvelopeSchema } from './api-envelope';
import {
  BigIntIdSchema,
  CnyAmountSchema,
  NonNegativeIntegerStringSchema,
  PositiveIntegerStringSchema,
  SignedIntegerStringSchema,
  UuidSchema,
} from './primitives';

/**
 * 公共 schema 与错误注册表的回归测试。
 *
 * 这两块是 HTTP 边界的地基：错误码 → HTTP status 的映射决定了客户端看到的
 * 状态码，注册表一旦被"顺手"改写，所有 endpoint 的失败语义会静默漂移。
 */

describe('错误码注册表', () => {
  test('每个登记的错误码都有明确的 HTTP status 映射', () => {
    for (const code of Object.values(ApiErrorCode)) {
      expect(isKnownErrorCode(code)).toBe(true);
      const status = API_ERROR_HTTP_STATUS[code];
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  test('未登记的错误码按 500 处理，不泄漏为 4xx', () => {
    expect(isKnownErrorCode('SOMETHING_UNKNOWN')).toBe(false);
    expect(httpStatusForErrorCode('SOMETHING_UNKNOWN')).toBe(500);
    expect(isRetryableErrorCode('SOMETHING_UNKNOWN')).toBe(false);
  });

  test('错误码映射符合 SDD 的 HTTP status 语义', () => {
    expect(httpStatusForErrorCode(TransportErrorCode.REQUEST_VALIDATION_FAILED)).toBe(400);
    expect(httpStatusForErrorCode(TransportErrorCode.UNAUTHORIZED)).toBe(401);
    expect(httpStatusForErrorCode(TransportErrorCode.FORBIDDEN)).toBe(403);
    expect(httpStatusForErrorCode(TransportErrorCode.NOT_FOUND)).toBe(404);
    expect(httpStatusForErrorCode(TransportErrorCode.METHOD_NOT_ALLOWED)).toBe(405);
    expect(httpStatusForErrorCode(TransportErrorCode.PAYLOAD_TOO_LARGE)).toBe(413);
    expect(httpStatusForErrorCode(TransportErrorCode.UNSUPPORTED_MEDIA_TYPE)).toBe(415);
    expect(httpStatusForErrorCode(TransportErrorCode.CONFLICT)).toBe(409);
    expect(httpStatusForErrorCode(TransportErrorCode.UNPROCESSABLE_CONTENT)).toBe(422);
    expect(httpStatusForErrorCode(TransportErrorCode.RATE_LIMITED)).toBe(429);
    expect(httpStatusForErrorCode(TransportErrorCode.INTERNAL_ERROR)).toBe(500);
    expect(httpStatusForErrorCode(TransportErrorCode.BAD_GATEWAY)).toBe(502);
    expect(httpStatusForErrorCode(TransportErrorCode.SERVICE_UNAVAILABLE)).toBe(503);
    expect(httpStatusForErrorCode(TransportErrorCode.GATEWAY_TIMEOUT)).toBe(504);
    expect(httpStatusForErrorCode(GameErrorCode.GAME_NOT_FOUND)).toBe(404);
  });

  test('只有依赖类故障被标记为可重试', () => {
    expect(isRetryableErrorCode(TransportErrorCode.SERVICE_UNAVAILABLE)).toBe(true);
    expect(isRetryableErrorCode(TransportErrorCode.GATEWAY_TIMEOUT)).toBe(true);
    expect(isRetryableErrorCode(TransportErrorCode.RATE_LIMITED)).toBe(true);
    expect(isRetryableErrorCode(TransportErrorCode.NOT_FOUND)).toBe(false);
    expect(isRetryableErrorCode(TransportErrorCode.CONFLICT)).toBe(false);
    expect(isRetryableErrorCode(TransportErrorCode.INTERNAL_ERROR)).toBe(false);
  });

  test('错误码是稳定字符串常量，不使用数字哨兵', () => {
    for (const code of Object.values(ApiErrorCode)) {
      expect(typeof code).toBe('string');
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('统一响应 envelope', () => {
  const success = {
    requestId: '0c6dca6b-c1b9-4c9d-b9d3-1b39d3d302e4',
    code: 'OK',
    message: '服务进程正常',
    data: { status: 'live' },
    serverNow: '2026-10-21T09:30:00.000Z',
  };

  test('成功 envelope 字段固定', () => {
    const schema = ApiSuccessEnvelopeSchema(Type.Object({ status: Type.Literal('live') }, { additionalProperties: false }));
    expect(Value.Check(schema, success)).toBe(true);
    expect(Value.Check(schema, { ...success, extra: 1 })).toBe(false);
    expect(Value.Check(schema, { ...success, code: 'FAILED' })).toBe(false);
    expect(Value.Check(schema, { ...success, serverNow: '2026-10-21T09:30:00X000Z' })).toBe(false);
  });

  test('失败 envelope 的 data 固定为 null', () => {
    const failure = {
      requestId: '0c6dca6b-c1b9-4c9d-b9d3-1b39d3d302e4',
      code: 'NOT_FOUND',
      message: '请求的资源不存在。',
      data: null,
      serverNow: '2026-10-21T09:30:00.000Z',
    };
    expect(Value.Check(ApiFailureEnvelopeSchema, failure)).toBe(true);
    expect(Value.Check(ApiFailureEnvelopeSchema, { ...failure, data: { status: 'live' } })).toBe(false);
  });

  test('失败 envelope 可携带字段级 details 与 retryable 标记', () => {
    const failure = {
      requestId: '0c6dca6b-c1b9-4c9d-b9d3-1b39d3d302e4',
      code: 'REQUEST_VALIDATION_FAILED',
      message: '请求信息有误，请检查后重试',
      data: null,
      serverNow: '2026-10-21T09:30:00.000Z',
      details: [{ field: '/amountCoins', code: 'POSITIVE_INTEGER_STRING_REQUIRED', message: '请输入有效的金币数量' }],
      retryable: false,
    };
    expect(Value.Check(ApiFailureEnvelopeSchema, failure)).toBe(true);
    expect(Value.Check(ApiFailureEnvelopeSchema, { ...failure, details: [{ field: '/x', code: 'C' }] })).toBe(false);
  });

  test('失败 envelope 不会回显堆栈或 cause', () => {
    const failure = {
      requestId: 'r-1',
      code: 'INTERNAL_ERROR',
      message: '服务暂时不可用，请稍后重试。',
      data: null,
      serverNow: '2026-10-21T09:30:00.000Z',
    };
    expect(Value.Check(ApiFailureEnvelopeSchema, { ...failure, stack: 'Error: boom' })).toBe(false);
    expect(Value.Check(ApiFailureEnvelopeSchema, { ...failure, cause: 'SELECT * FROM users' })).toBe(false);
  });
});

describe('共享基础标量 schema', () => {
  test('BIGINT ID 用字符串传输且拒绝前导零', () => {
    expect(Value.Check(BigIntIdSchema, '1001')).toBe(true);
    expect(Value.Check(BigIntIdSchema, '01001')).toBe(false);
    expect(Value.Check(BigIntIdSchema, '0')).toBe(false);
    expect(Value.Check(BigIntIdSchema, 1001)).toBe(false);
  });

  test('金额与数量字符串的精度口径', () => {
    expect(Value.Check(CnyAmountSchema, '10.00')).toBe(true);
    expect(Value.Check(CnyAmountSchema, '10.000')).toBe(false);
    expect(Value.Check(CnyAmountSchema, '10X00')).toBe(false);
    expect(Value.Check(PositiveIntegerStringSchema, '1')).toBe(true);
    expect(Value.Check(PositiveIntegerStringSchema, '0')).toBe(false);
    expect(Value.Check(NonNegativeIntegerStringSchema, '0')).toBe(true);
    expect(Value.Check(SignedIntegerStringSchema, '-500')).toBe(true);
    expect(Value.Check(SignedIntegerStringSchema, '-0')).toBe(false);
  });

  test('幂等键必须是 UUID v4 形态', () => {
    expect(Value.Check(UuidSchema, '5d585db2-14fe-4e18-9e66-1597d65c3a56')).toBe(true);
    expect(Value.Check(UuidSchema, 'not-a-uuid')).toBe(false);
    expect(Value.Check(UuidSchema, '5d585db2-14fe-1e18-9e66-1597d65c3a56')).toBe(false);
  });
});
