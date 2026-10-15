import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  code: Type.Literal('OK'),
  message: Type.String(),
  data: Type.Object({
    status: Type.Literal('live'),
    service: Type.Literal('gameing-hall-api'),
  }),
  serverNow: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' }),
}, { additionalProperties: false });

export type HealthResponse = Static<typeof HealthResponseSchema>;
