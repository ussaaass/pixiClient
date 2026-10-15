import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const PlayerEntryOutcome = {
  DEVICE_CREDENTIAL_MISSING: 'DEVICE_CREDENTIAL_MISSING',
  IDENTITY_SERVICE_REQUIRED: 'IDENTITY_SERVICE_REQUIRED',
  DEVICE_AUTHENTICATED: 'DEVICE_AUTHENTICATED',
  PASSWORD_AUTHENTICATED: 'PASSWORD_AUTHENTICATED',
  TOTP_CHALLENGE_REQUIRED: 'TOTP_CHALLENGE_REQUIRED',
  RECOVERY_AUTHENTICATED: 'RECOVERY_AUTHENTICATED',
} as const;

const PasswordLoginRequestSchema = Type.Object({
  identifier: Type.String({ maxLength: 128 }),
  password: Type.String({ maxLength: 256 }),
  challengeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  totp: Type.Optional(Type.String({ pattern: '^(?:[0-9]{6}|[A-Fa-f0-9]{16})$' })),
}, { additionalProperties: false });

const RecoveryRequestSchema = Type.Object({
  credentialPayload: Type.String({ maxLength: 4096 }),
  credentialPassword: Type.String({ maxLength: 256 }),
  totp: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })),
}, { additionalProperties: false });

export const PlayerPasswordLoginRequestSchema = PasswordLoginRequestSchema;
export const PlayerRecoveryRequestSchema = RecoveryRequestSchema;
export const PlayerEntryResultDtoSchema = Type.Object({
  source: Type.Union([Type.Literal('LOCAL_DEMO'), Type.Literal('BROWSER_DEV')]),
  outcome: Type.Union(Object.values(PlayerEntryOutcome).map((outcome) => Type.Literal(outcome))),
  challengeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  expiresAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

export type PlayerPasswordLoginRequestDto = Static<typeof PlayerPasswordLoginRequestSchema>;
export type PlayerRecoveryRequestDto = Static<typeof PlayerRecoveryRequestSchema>;
export type PlayerEntryResultDto = Static<typeof PlayerEntryResultDtoSchema>;
