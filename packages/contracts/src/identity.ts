import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';

export const IdentityErrorCode = {
  OK: 'OK',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  DEVICE_CREDENTIAL_MISSING: 'DEVICE_CREDENTIAL_MISSING',
  DEVICE_CREDENTIAL_REVOKED: 'DEVICE_CREDENTIAL_REVOKED',
  DEVICE_CREDENTIAL_EXPIRED: 'DEVICE_CREDENTIAL_EXPIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOTP_REQUIRED: 'TOTP_REQUIRED',
  TOTP_INVALID: 'TOTP_INVALID',
  RECOVERY_CREDENTIAL_INVALID: 'RECOVERY_CREDENTIAL_INVALID',
  RECOVERY_CREDENTIAL_REPLACED: 'RECOVERY_CREDENTIAL_REPLACED',
  RECOVERY_CREDENTIAL_NOT_FOUND: 'RECOVERY_CREDENTIAL_NOT_FOUND',
  RECOVERY_CREDENTIAL_PENDING_EXPIRED: 'RECOVERY_CREDENTIAL_PENDING_EXPIRED',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCESS_TOKEN_INVALID: 'ACCESS_TOKEN_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  REFRESH_INVALID: 'REFRESH_INVALID',
  REFRESH_REVOKED: 'REFRESH_REVOKED',
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
  IDENTIFIER_ALREADY_USED: 'IDENTIFIER_ALREADY_USED',
  REAUTHENTICATION_FAILED: 'REAUTHENTICATION_FAILED',
  PASSWORD_REUSE: 'PASSWORD_REUSE',
  USERNAME_INVALID: 'USERNAME_INVALID',
  VERIFICATION_CODE_INVALID: 'VERIFICATION_CODE_INVALID',
  CHALLENGE_NOT_FOUND: 'CHALLENGE_NOT_FOUND',
  CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
  TOTP_ALREADY_ENABLED: 'TOTP_ALREADY_ENABLED',
  TOTP_NOT_ENABLED: 'TOTP_NOT_ENABLED',
  SETUP_NOT_FOUND: 'SETUP_NOT_FOUND',
  SETUP_EXPIRED: 'SETUP_EXPIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDENTITY_STORAGE_UNAVAILABLE: 'IDENTITY_STORAGE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const BigIntIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
export const TotpOrRecoveryCodeSchema = Type.String({ pattern: '^(?:[0-9]{6}|[A-Fa-f0-9]{16})$' });
export const IsoDateTimeSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$' });
export const ApiSuccessSchema = <T extends TSchema>(data: T) => Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 64 }),
  code: Type.Literal(IdentityErrorCode.OK),
  message: Type.String({ maxLength: 256 }),
  data,
  serverNow: IsoDateTimeSchema,
}, { additionalProperties: false });

export const ApiFailureSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 64 }),
  code: Type.String({ minLength: 1, maxLength: 64 }),
  message: Type.String({ maxLength: 256 }),
  data: Type.Null(),
  serverNow: IsoDateTimeSchema,
  details: Type.Optional(Type.Array(Type.Object({
    field: Type.Optional(Type.String({ maxLength: 256 })),
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ maxLength: 256 }),
  }, { additionalProperties: false }), { maxItems: 32 })),
  retryable: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const DeviceSummarySchema = Type.Object({
  platform: Type.String({ minLength: 1, maxLength: 32 }),
  browser: Type.String({ minLength: 1, maxLength: 32 }),
}, { additionalProperties: false });

export const DeviceRegisterRequestSchema = Type.Object({
  fingerprintVersion: Type.String({ minLength: 1, maxLength: 16 }),
  deviceCode: Type.String({ minLength: 16, maxLength: 128 }),
  deviceSummary: DeviceSummarySchema,
}, { additionalProperties: false });

export const PasswordLoginRequestSchema = Type.Object({
  identifier: Type.String({ minLength: 1, maxLength: 128 }),
  password: Type.String({ minLength: 1, maxLength: 256 }),
  challengeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  totp: Type.Optional(TotpOrRecoveryCodeSchema),
}, { additionalProperties: false });

export const AccountRecoveryRequestSchema = Type.Object({
  credentialId: BigIntIdSchema,
  recoverySecret: Type.String({ minLength: 32, maxLength: 128 }),
  totp: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })),
}, { additionalProperties: false });

export const PlayerUserSchema = Type.Object({
  userId: BigIntIdSchema,
  displayName: Type.String({ minLength: 1, maxLength: 64 }),
  roleType: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const DeviceSessionSchema = Type.Object({
  deviceId: BigIntIdSchema,
  trusted: Type.Boolean(),
}, { additionalProperties: false });

export const SessionResponseSchema = Type.Object({
  accessToken: Type.String({ minLength: 1, maxLength: 4096 }),
  tokenType: Type.Literal('Bearer'),
  expiresAt: IsoDateTimeSchema,
  user: PlayerUserSchema,
  device: DeviceSessionSchema,
}, { additionalProperties: false });

export const LoginChallengeResponseSchema = Type.Object({
  challengeId: Type.String({ minLength: 1, maxLength: 128 }),
  challengeType: Type.Literal('TOTP'),
  expiresAt: IsoDateTimeSchema,
}, { additionalProperties: false });

export const DeviceCredentialResponseSchema = Type.Object({ available: Type.Boolean() }, { additionalProperties: false });
export const LogoutResponseSchema = Type.Object({ loggedOut: Type.Boolean() }, { additionalProperties: false });
export const IdentitySettingsResponseSchema = Type.Object({
  username: Type.Union([Type.String({ minLength: 3, maxLength: 32 }), Type.Null()]),
  email: Type.Union([Type.Object({ maskedValue: Type.String({ maxLength: 128 }), verified: Type.Boolean() }, { additionalProperties: false }), Type.Null()]),
  phone: Type.Union([Type.Object({ maskedValue: Type.String({ maxLength: 32 }), verified: Type.Boolean() }, { additionalProperties: false }), Type.Null()]),
  passwordConfigured: Type.Boolean(),
  totpEnabled: Type.Boolean(),
  recoveryCredential: Type.Object({ available: Type.Boolean(), expiresAt: Type.Union([IsoDateTimeSchema, Type.Null()]) }, { additionalProperties: false }),
}, { additionalProperties: false });
export const SetUsernameRequestSchema = Type.Object({ username: Type.String({ minLength: 3, maxLength: 32 }), password: Type.String({ minLength: 1, maxLength: 256 }), totp: Type.Optional(TotpOrRecoveryCodeSchema) }, { additionalProperties: false });
export const ChangePasswordRequestSchema = Type.Object({ currentPassword: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), newPassword: Type.String({ minLength: 8, maxLength: 256 }), totp: Type.Optional(TotpOrRecoveryCodeSchema) }, { additionalProperties: false });
export const PasswordChangedResponseSchema = Type.Object({ changed: Type.Boolean() }, { additionalProperties: false });
export const IdentityContactType = { EMAIL: 'EMAIL', PHONE: 'PHONE' } as const;
export const CreateContactChallengeRequestSchema = Type.Object({
  contactType: Type.Union([Type.Literal(IdentityContactType.EMAIL), Type.Literal(IdentityContactType.PHONE)]),
  contactValue: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 1, maxLength: 256 }),
  totp: Type.Optional(TotpOrRecoveryCodeSchema),
}, { additionalProperties: false });
export const ContactChallengeResponseSchema = Type.Object({ challengeId: Type.String({ minLength: 1, maxLength: 128 }), expiresAt: IsoDateTimeSchema }, { additionalProperties: false });
export const ConfirmContactChallengeRequestSchema = Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) }, { additionalProperties: false });
export const TotpSetupRequestSchema = Type.Object({ password: Type.String({ minLength: 1, maxLength: 256 }), totp: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })) }, { additionalProperties: false });
export const TotpSetupResponseSchema = Type.Object({ setupId: Type.String({ minLength: 1, maxLength: 128 }), otpauthUri: Type.String({ minLength: 1, maxLength: 2048 }), expiresAt: IsoDateTimeSchema }, { additionalProperties: false });
export const TotpConfirmRequestSchema = Type.Object({ setupId: Type.String({ minLength: 1, maxLength: 128 }), code: Type.String({ pattern: '^[0-9]{6}$' }) }, { additionalProperties: false });
export const TotpEnabledResponseSchema = Type.Object({ enabled: Type.Literal(true), recoveryCodes: Type.Array(Type.String({ pattern: '^[A-F0-9]{16}$' }), { minItems: 10, maxItems: 10 }) }, { additionalProperties: false });
export const TotpDisableRequestSchema = Type.Object({ password: Type.String({ minLength: 1, maxLength: 256 }), code: Type.String({ pattern: '^[0-9]{6}$' }) }, { additionalProperties: false });
export const TotpDisabledResponseSchema = Type.Object({ enabled: Type.Literal(false) }, { additionalProperties: false });
export const TotpRecoveryCodesRotateRequestSchema = Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) }, { additionalProperties: false });
export const RecoveryCredentialPrepareRequestSchema = Type.Object({
  password: Type.String({ minLength: 1, maxLength: 256 }),
  totp: Type.Optional(TotpOrRecoveryCodeSchema),
  recoverySecret: Type.String({ minLength: 32, maxLength: 128 }),
}, { additionalProperties: false });
export const RecoveryCredentialIssueResponseSchema = Type.Object({ credentialId: BigIntIdSchema, expiresAt: IsoDateTimeSchema }, { additionalProperties: false });
export const RecoveryCredentialActivateRequestSchema = Type.Object({}, { additionalProperties: false });

export type IdentityErrorCodeValue = typeof IdentityErrorCode[keyof typeof IdentityErrorCode];
export type ApiFailureDto = Static<typeof ApiFailureSchema>;
export type DeviceRegisterRequestDto = Static<typeof DeviceRegisterRequestSchema>;
export type PasswordLoginRequestDto = Static<typeof PasswordLoginRequestSchema>;
export type AccountRecoveryRequestDto = Static<typeof AccountRecoveryRequestSchema>;
export type SessionResponseDto = Static<typeof SessionResponseSchema>;
export type LoginChallengeResponseDto = Static<typeof LoginChallengeResponseSchema>;
export type DeviceCredentialResponseDto = Static<typeof DeviceCredentialResponseSchema>;
export type LogoutResponseDto = Static<typeof LogoutResponseSchema>;
export type IdentitySettingsResponseDto = Static<typeof IdentitySettingsResponseSchema>;
export type SetUsernameRequestDto = Static<typeof SetUsernameRequestSchema>;
export type ChangePasswordRequestDto = Static<typeof ChangePasswordRequestSchema>;
export type PasswordChangedResponseDto = Static<typeof PasswordChangedResponseSchema>;
export type CreateContactChallengeRequestDto = Static<typeof CreateContactChallengeRequestSchema>;
export type ContactChallengeResponseDto = Static<typeof ContactChallengeResponseSchema>;
export type ConfirmContactChallengeRequestDto = Static<typeof ConfirmContactChallengeRequestSchema>;
export type TotpSetupRequestDto = Static<typeof TotpSetupRequestSchema>;
export type TotpSetupResponseDto = Static<typeof TotpSetupResponseSchema>;
export type TotpConfirmRequestDto = Static<typeof TotpConfirmRequestSchema>;
export type TotpEnabledResponseDto = Static<typeof TotpEnabledResponseSchema>;
export type TotpDisableRequestDto = Static<typeof TotpDisableRequestSchema>;
export type TotpDisabledResponseDto = Static<typeof TotpDisabledResponseSchema>;
export type TotpRecoveryCodesRotateRequestDto = Static<typeof TotpRecoveryCodesRotateRequestSchema>;
export type RecoveryCredentialPrepareRequestDto = Static<typeof RecoveryCredentialPrepareRequestSchema>;
export type RecoveryCredentialIssueResponseDto = Static<typeof RecoveryCredentialIssueResponseSchema>;
export type RecoveryCredentialActivateRequestDto = Static<typeof RecoveryCredentialActivateRequestSchema>;

export type ApiSuccessDto<T> = {
  requestId: string;
  code: typeof IdentityErrorCode.OK;
  message: string;
  data: T;
  serverNow: string;
};

export type IdentitySuccessData = SessionResponseDto | LoginChallengeResponseDto | DeviceCredentialResponseDto | LogoutResponseDto | IdentitySettingsResponseDto | PasswordChangedResponseDto | ContactChallengeResponseDto | TotpSetupResponseDto | TotpEnabledResponseDto | TotpDisabledResponseDto | RecoveryCredentialIssueResponseDto;

export const IdentityEndpoint = {
  deviceRegister: { method: 'POST', path: '/api/v1/auth/device-register', request: DeviceRegisterRequestSchema, response: SessionResponseSchema, successStatus: 201 },
  deviceLogin: { method: 'POST', path: '/api/v1/auth/device-login', request: Type.Object({}, { additionalProperties: false }), response: SessionResponseSchema, successStatus: 200 },
  deviceCredential: { method: 'GET', path: '/api/v1/auth/device-credential', response: DeviceCredentialResponseSchema, successStatus: 200 },
  passwordLogin: { method: 'POST', path: '/api/v1/auth/password-login', request: PasswordLoginRequestSchema, response: Type.Union([SessionResponseSchema, LoginChallengeResponseSchema]), successStatus: 200 },
  recovery: { method: 'POST', path: '/api/v1/auth/recovery', request: AccountRecoveryRequestSchema, response: SessionResponseSchema, successStatus: 200 },
  refresh: { method: 'POST', path: '/api/v1/auth/refresh', request: Type.Object({}, { additionalProperties: false }), response: SessionResponseSchema, successStatus: 200 },
  logout: { method: 'POST', path: '/api/v1/auth/logout', request: Type.Object({}, { additionalProperties: false }), response: LogoutResponseSchema, successStatus: 200 },
  identitySettings: { method: 'GET', path: '/api/v1/me/identity-settings', response: IdentitySettingsResponseSchema, successStatus: 200 },
  setUsername: { method: 'POST', path: '/api/v1/me/identity/username', request: SetUsernameRequestSchema, response: IdentitySettingsResponseSchema, successStatus: 200 },
  changePassword: { method: 'POST', path: '/api/v1/me/identity/password', request: ChangePasswordRequestSchema, response: PasswordChangedResponseSchema, successStatus: 200 },
  createContactChallenge: { method: 'POST', path: '/api/v1/me/identity/contact-challenges', request: CreateContactChallengeRequestSchema, response: ContactChallengeResponseSchema, successStatus: 201 },
  confirmContactChallenge: { method: 'POST', path: '/api/v1/me/identity/contact-challenges/:challengeId/confirm', request: ConfirmContactChallengeRequestSchema, response: IdentitySettingsResponseSchema, successStatus: 200 },
  totpSetup: { method: 'POST', path: '/api/v1/me/security/totp/setup', request: TotpSetupRequestSchema, response: TotpSetupResponseSchema, successStatus: 201 },
  totpConfirm: { method: 'POST', path: '/api/v1/me/security/totp/confirm', request: TotpConfirmRequestSchema, response: TotpEnabledResponseSchema, successStatus: 200 },
  totpDisable: { method: 'POST', path: '/api/v1/me/security/totp/disable', request: TotpDisableRequestSchema, response: TotpDisabledResponseSchema, successStatus: 200 },
  totpRecoveryCodesRotate: { method: 'POST', path: '/api/v1/me/security/totp/recovery-codes/rotate', request: TotpRecoveryCodesRotateRequestSchema, response: TotpEnabledResponseSchema, successStatus: 200 },
  recoveryCredentialPrepare: { method: 'POST', path: '/api/v1/me/security/recovery-credentials/prepare', request: RecoveryCredentialPrepareRequestSchema, response: RecoveryCredentialIssueResponseSchema, successStatus: 201 },
  recoveryCredentialActivate: { method: 'POST', path: '/api/v1/me/security/recovery-credentials/:credentialId/activate', request: RecoveryCredentialActivateRequestSchema, response: IdentitySettingsResponseSchema, successStatus: 200 },
} as const;
