import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const ConfigKeySchema = Type.String({ pattern: '^[a-z][a-z0-9_]{1,63}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' });

export const SystemConfigValueKind = {
  UNSIGNED_INTEGER: 'UNSIGNED_INTEGER',
  PERCENT_INTEGER: 'PERCENT_INTEGER',
  INTEGER_RATIO: 'INTEGER_RATIO',
} as const;

export const SystemConfigDraftStatus = {
  DRAFT: 1,
} as const;

export const SystemConfigEntryDtoSchema = Type.Object({
  configKey: ConfigKeySchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  configType: Type.String({ minLength: 1, maxLength: 48 }),
  valueKind: Type.Union([
    Type.Literal(SystemConfigValueKind.UNSIGNED_INTEGER),
    Type.Literal(SystemConfigValueKind.PERCENT_INTEGER),
    Type.Literal(SystemConfigValueKind.INTEGER_RATIO),
  ]),
  referenceValue: Type.String({ minLength: 1, maxLength: 128 }),
  unit: Type.String({ minLength: 1, maxLength: 32 }),
  description: Type.String({ minLength: 1, maxLength: 240 }),
}, { additionalProperties: false });

export const SystemConfigDraftDtoSchema = Type.Object({
  draftId: Type.String({ minLength: 1, maxLength: 64 }),
  requestKey: Type.String({ minLength: 1, maxLength: 64 }),
  configKey: ConfigKeySchema,
  baseValue: Type.String({ minLength: 1, maxLength: 128 }),
  proposedValue: Type.String({ minLength: 1, maxLength: 128 }),
  reason: Type.String({ minLength: 3, maxLength: 240 }),
  status: Type.Literal(SystemConfigDraftStatus.DRAFT),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const SystemConfigDraftRequestSchema = Type.Object({
  requestKey: Type.String({ minLength: 1, maxLength: 64 }),
  configKey: ConfigKeySchema,
  proposedValue: Type.String({ minLength: 1, maxLength: 128 }),
  reason: Type.String({ minLength: 3, maxLength: 240 }),
}, { additionalProperties: false });

export const SystemConfigQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ maxLength: 80 })),
  configType: Type.Optional(Type.String({ maxLength: 48 })),
}, { additionalProperties: false });

export type SystemConfigEntryDto = Static<typeof SystemConfigEntryDtoSchema>;
export type SystemConfigDraftDto = Static<typeof SystemConfigDraftDtoSchema>;
export type SystemConfigDraftRequestDto = Static<typeof SystemConfigDraftRequestSchema>;
export type SystemConfigQueryDto = Static<typeof SystemConfigQuerySchema>;
