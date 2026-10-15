import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const ClientPreferenceKey = {
  SOUND_ENABLED: 'SOUND_ENABLED',
  LOW_DATA_MODE: 'LOW_DATA_MODE',
} as const;

export const ClientPreferenceDtoSchema = Type.Object({
  soundEnabled: Type.Boolean(),
  lowDataMode: Type.Boolean(),
}, { additionalProperties: false });

export const UpdateClientPreferenceRequestSchema = Type.Object({
  key: Type.Union([
    Type.Literal(ClientPreferenceKey.SOUND_ENABLED),
    Type.Literal(ClientPreferenceKey.LOW_DATA_MODE),
  ]),
  value: Type.Boolean(),
}, { additionalProperties: false });

export type ClientPreferenceDto = Static<typeof ClientPreferenceDtoSchema>;
export type UpdateClientPreferenceRequestDto = Static<typeof UpdateClientPreferenceRequestSchema>;
