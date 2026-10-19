import { Value } from '@sinclair/typebox/value';
import {
  PlayerEntryOutcome,
  PlayerEntryResultDtoSchema,
  PlayerPasswordLoginRequestSchema,
  PlayerRecoveryRequestSchema,
  type PlayerEntryResultDto,
  type PlayerPasswordLoginRequestDto,
  type PlayerRecoveryRequestDto,
} from '@gameing/contracts/player-entry';
import { SetEmailContactRequestSchema, SetPhoneContactRequestSchema, type ChangePasswordRequestDto, type ConfirmContactChallengeRequestDto, type ContactChallengeResponseDto, type CreateContactChallengeRequestDto, type IdentitySettingsResponseDto, type RecoveryCredentialIssueResponseDto, type SetEmailContactRequestDto, type SetPhoneContactRequestDto, type SetUsernameRequestDto, type TotpConfirmRequestDto, type TotpDisableRequestDto, type TotpDisabledResponseDto, type TotpEnabledResponseDto, type TotpSetupRequestDto, type TotpSetupResponseDto, type TotpRecoveryCodesRotateRequestDto } from '@gameing/contracts/identity';

export type PrepareRecoveryCredentialRequest = { password: string; qrPassword: string; totp?: string };
export type PreparedRecoveryCredential = RecoveryCredentialIssueResponseDto & { qrPayload: string };

export type PlayerEntryFailureCode =
  | 'INVALID_REQUEST'
  | 'IDENTIFIER_REQUIRED'
  | 'PASSWORD_REQUIRED'
  | 'CREDENTIAL_REQUIRED'
  | 'TOTP_INVALID'
  | 'INVALID_CREDENTIALS'
  | 'RECOVERY_QR_INVALID'
  | 'IDENTITY_SERVICE_ERROR'
  | 'IDENTIFIER_ALREADY_USED'
  | 'CURRENT_PHONE_MISMATCH'
  | 'CURRENT_EMAIL_MISMATCH'
  | 'REAUTHENTICATION_FAILED'
  | 'USERNAME_INVALID'
  | 'PASSWORD_REUSE'
  | 'TOTP_REQUIRED'
  | 'SESSION_REVOKED'
  | 'TOTP_VERIFICATION_NOT_IMPLEMENTED';

export type PlayerEntryResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: PlayerEntryFailureCode };

export interface PlayerIdentityPort {
  checkCurrentDevice(): Promise<PlayerEntryResultDto>;
  passwordLogin(request: PlayerPasswordLoginRequestDto): Promise<PlayerEntryResultDto>;
  recoverAccount(request: PlayerRecoveryRequestDto): Promise<PlayerEntryResultDto>;
  logout(): Promise<void>;
  getIdentitySettings(): Promise<IdentitySettingsResponseDto>;
  setUsername(request: SetUsernameRequestDto): Promise<IdentitySettingsResponseDto>;
  changePassword(request: ChangePasswordRequestDto): Promise<{ changed: boolean }>;
  createContactChallenge(request: CreateContactChallengeRequestDto): Promise<ContactChallengeResponseDto>;
  setPhoneContact(request: SetPhoneContactRequestDto): Promise<IdentitySettingsResponseDto>;
  setEmailContact(request: SetEmailContactRequestDto): Promise<IdentitySettingsResponseDto>;
  confirmContactChallenge(challengeId: string, request: ConfirmContactChallengeRequestDto): Promise<IdentitySettingsResponseDto>;
  startTotpSetup(request: TotpSetupRequestDto): Promise<TotpSetupResponseDto>;
  confirmTotpSetup(request: TotpConfirmRequestDto): Promise<TotpEnabledResponseDto>;
  disableTotp(request: TotpDisableRequestDto): Promise<TotpDisabledResponseDto>;
  rotateTotpRecoveryCodes(request: TotpRecoveryCodesRotateRequestDto): Promise<TotpEnabledResponseDto>;
  prepareRecoveryCredential(request: PrepareRecoveryCredentialRequest): Promise<PreparedRecoveryCredential>;
  activateRecoveryCredential(credentialId: string): Promise<IdentitySettingsResponseDto>;
}

export interface PlayerEntryApplication {
  checkCurrentDevice(): Promise<PlayerEntryResult<PlayerEntryResultDto>>;
  passwordLogin(request: PlayerPasswordLoginRequestDto): Promise<PlayerEntryResult<PlayerEntryResultDto>>;
  recoverAccount(request: PlayerRecoveryRequestDto): Promise<PlayerEntryResult<PlayerEntryResultDto>>;
  logout(): Promise<PlayerEntryResult<void>>;
  getIdentitySettings(): Promise<PlayerEntryResult<IdentitySettingsResponseDto>>;
  setUsername(request: SetUsernameRequestDto): Promise<PlayerEntryResult<IdentitySettingsResponseDto>>;
  changePassword(request: ChangePasswordRequestDto): Promise<PlayerEntryResult<{ changed: boolean }>>;
  createContactChallenge(request: CreateContactChallengeRequestDto): Promise<PlayerEntryResult<ContactChallengeResponseDto>>;
  setPhoneContact(request: SetPhoneContactRequestDto): Promise<PlayerEntryResult<IdentitySettingsResponseDto>>;
  setEmailContact(request: SetEmailContactRequestDto): Promise<PlayerEntryResult<IdentitySettingsResponseDto>>;
  confirmContactChallenge(challengeId: string, request: ConfirmContactChallengeRequestDto): Promise<PlayerEntryResult<IdentitySettingsResponseDto>>;
  startTotpSetup(request: TotpSetupRequestDto): Promise<PlayerEntryResult<TotpSetupResponseDto>>;
  confirmTotpSetup(request: TotpConfirmRequestDto): Promise<PlayerEntryResult<TotpEnabledResponseDto>>;
  disableTotp(request: TotpDisableRequestDto): Promise<PlayerEntryResult<TotpDisabledResponseDto>>;
  rotateTotpRecoveryCodes(request: TotpRecoveryCodesRotateRequestDto): Promise<PlayerEntryResult<TotpEnabledResponseDto>>;
  prepareRecoveryCredential(request: PrepareRecoveryCredentialRequest): Promise<PlayerEntryResult<PreparedRecoveryCredential>>;
  activateRecoveryCredential(credentialId: string): Promise<PlayerEntryResult<IdentitySettingsResponseDto>>;
}

const failure = <T>(code: PlayerEntryFailureCode): PlayerEntryResult<T> => ({ ok: false, code });

function identityFailureCode(error: unknown): PlayerEntryFailureCode {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = error.code as PlayerEntryFailureCode;
    if (['IDENTIFIER_ALREADY_USED', 'CURRENT_PHONE_MISMATCH', 'REAUTHENTICATION_FAILED', 'USERNAME_INVALID', 'PASSWORD_REUSE', 'TOTP_REQUIRED', 'SESSION_REVOKED', 'TOTP_VERIFICATION_NOT_IMPLEMENTED', 'TOTP_INVALID', 'TOTP_ALREADY_ENABLED', 'TOTP_NOT_ENABLED', 'SETUP_NOT_FOUND', 'SETUP_EXPIRED', 'RECOVERY_CREDENTIAL_NOT_FOUND', 'RECOVERY_CREDENTIAL_PENDING_EXPIRED', 'VALIDATION_FAILED', 'VERIFICATION_CODE_INVALID', 'CHALLENGE_NOT_FOUND', 'CHALLENGE_EXPIRED', 'AUTH_RATE_LIMITED'].includes(code)) return code;
  }
  return 'IDENTITY_SERVICE_ERROR';
}

export function createPlayerEntryApplication(identity: PlayerIdentityPort): PlayerEntryApplication {
  return {
    async checkCurrentDevice() {
      const result = await identity.checkCurrentDevice();
      return Value.Check(PlayerEntryResultDtoSchema, result) ? { ok: true, value: result } : failure('INVALID_REQUEST');
    },

    async passwordLogin(request) {
      if (!Value.Check(PlayerPasswordLoginRequestSchema, request)) return failure('INVALID_REQUEST');
      if (!request.identifier.trim()) return failure('IDENTIFIER_REQUIRED');
      if (!request.password) return failure('PASSWORD_REQUIRED');
      const result = await identity.passwordLogin(request);
      return Value.Check(PlayerEntryResultDtoSchema, result) ? { ok: true, value: result } : failure('INVALID_REQUEST');
    },

    async recoverAccount(request) {
      if (!Value.Check(PlayerRecoveryRequestSchema, request)) return failure('INVALID_REQUEST');
      if (!request.credentialPayload.trim()) return failure('CREDENTIAL_REQUIRED');
      if (!request.credentialPassword) return failure('PASSWORD_REQUIRED');
      if (request.totp !== undefined && !/^\d{6}$/.test(request.totp)) return failure('TOTP_INVALID');
      const result = await identity.recoverAccount(request);
      return Value.Check(PlayerEntryResultDtoSchema, result) ? { ok: true, value: result } : failure('INVALID_REQUEST');
    },

    async logout() {
      try {
        await identity.logout();
        return { ok: true, value: undefined };
      } catch {
        return failure('IDENTITY_SERVICE_ERROR');
      }
    },

    async getIdentitySettings() {
      try {
        return { ok: true, value: await identity.getIdentitySettings() };
      } catch {
        return failure('IDENTITY_SERVICE_ERROR');
      }
    },

    async setUsername(request) {
      try { return { ok: true, value: await identity.setUsername(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async changePassword(request) {
      try { return { ok: true, value: await identity.changePassword(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async createContactChallenge(request) {
      try { return { ok: true, value: await identity.createContactChallenge(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async setPhoneContact(request) {
      if (!Value.Check(SetPhoneContactRequestSchema, request)) return failure('INVALID_REQUEST');
      try { return { ok: true, value: await identity.setPhoneContact(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async setEmailContact(request) {
      if (!Value.Check(SetEmailContactRequestSchema, request)) return failure('INVALID_REQUEST');
      try { return { ok: true, value: await identity.setEmailContact(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async confirmContactChallenge(challengeId, request) {
      try { return { ok: true, value: await identity.confirmContactChallenge(challengeId, request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async startTotpSetup(request) {
      try { return { ok: true, value: await identity.startTotpSetup(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async confirmTotpSetup(request) {
      try { return { ok: true, value: await identity.confirmTotpSetup(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async disableTotp(request) {
      try { return { ok: true, value: await identity.disableTotp(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async rotateTotpRecoveryCodes(request) {
      if (!/^\d{6}$/.test(request.code)) return failure('INVALID_REQUEST');
      try { return { ok: true, value: await identity.rotateTotpRecoveryCodes(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async prepareRecoveryCredential(request) {
      if (!request.password || request.qrPassword.length < 8 || request.qrPassword.length > 256 || (request.totp !== undefined && !/^(?:\d{6}|[A-Fa-f0-9]{16})$/.test(request.totp))) return failure('INVALID_REQUEST');
      try { return { ok: true, value: await identity.prepareRecoveryCredential(request) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },

    async activateRecoveryCredential(credentialId) {
      if (!/^[1-9][0-9]{0,19}$/.test(credentialId)) return failure('INVALID_REQUEST');
      try { return { ok: true, value: await identity.activateRecoveryCredential(credentialId) }; }
      catch (error) { return failure(identityFailureCode(error)); }
    },
  };
}

export { PlayerEntryOutcome };
