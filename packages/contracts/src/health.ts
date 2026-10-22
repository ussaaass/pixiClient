import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { ApiSuccessEnvelopeSchema } from './common/api-envelope.js';

/**
 * 健康检查契约。
 *
 * `HealthDataSchema` 是探针返回的 data 部分；
 * `HealthResponseSchema` 是包好统一 envelope 的完整响应（保留原导出名，兼容既有调用方）。
 */

export const HealthDataSchema = Type.Object(
  {
    status: Type.Literal('live'),
    service: Type.Literal('gameing-hall-api'),
  },
  { additionalProperties: false },
);

export const HealthResponseSchema = ApiSuccessEnvelopeSchema(HealthDataSchema);

export type HealthData = Static<typeof HealthDataSchema>;
export type HealthResponse = Static<typeof HealthResponseSchema>;
