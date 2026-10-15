import { IdentityErrorCode } from '@gameing/contracts/identity';
import { PlayerEntryOutcome, type PlayerIdentityPort } from '../player-entry/player-entry-application';
import type { PlayerEntryResultDto } from '@gameing/contracts/player-entry';
import { ApiRequestError, createApiClient, type ApiFetchPort } from '../http/api-client';
import type { SessionResponseDto } from '@gameing/contracts/identity';
import type { ContactChallengeResponseDto, IdentitySettingsResponseDto, TotpConfirmRequestDto, TotpDisableRequestDto, TotpDisabledResponseDto, TotpEnabledResponseDto, TotpSetupRequestDto, TotpSetupResponseDto } from '@gameing/contracts/identity';
import { decryptRecoveryQrPayload, encryptRecoveryQrPayload, randomToken } from './crypto';

export class BrowserPlayerIdentityAdapter implements PlayerIdentityPort {
  private session: SessionResponseDto | undefined;
  private refreshInFlight: Promise<SessionResponseDto> | undefined;
  private readonly api;

  constructor(fetchPort: ApiFetchPort, private readonly onSession?: (session: SessionResponseDto | undefined) => void) {
    this.api = createApiClient(fetchPort);
  }

  get currentSession(): SessionResponseDto | undefined { return this.session; }

  acceptSession(session: SessionResponseDto): void {
    this.session = session;
    localStorage.removeItem('gameing-hall.browser-device-login-suppressed');
    this.onSession?.(session);
  }

  async checkCurrentDevice(): Promise<PlayerEntryResultDto> {
    const credential = await this.api.deviceCredential();
    if (!credential.available) return { source: 'BROWSER_DEV', outcome: PlayerEntryOutcome.DEVICE_CREDENTIAL_MISSING };
    this.acceptSession(await this.api.deviceLogin());
    return { source: 'BROWSER_DEV', outcome: PlayerEntryOutcome.DEVICE_AUTHENTICATED };
  }

  async passwordLogin(request: Parameters<PlayerIdentityPort['passwordLogin']>[0]): Promise<PlayerEntryResultDto> {
    try {
      const response = await this.api.passwordLogin(request);
      if ('challengeType' in response) return { source: 'BROWSER_DEV', outcome: PlayerEntryOutcome.TOTP_CHALLENGE_REQUIRED, challengeId: response.challengeId, expiresAt: response.expiresAt };
      this.acceptSession(response);
      return { source: 'BROWSER_DEV', outcome: PlayerEntryOutcome.PASSWORD_AUTHENTICATED };
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === IdentityErrorCode.INVALID_CREDENTIALS) throw error;
      throw error;
    }
  }

  async recoverAccount(request: Parameters<PlayerIdentityPort['recoverAccount']>[0]): Promise<PlayerEntryResultDto> {
    let credential: Awaited<ReturnType<typeof decryptRecoveryQrPayload>>;
    try {
      credential = await decryptRecoveryQrPayload(request.credentialPayload, request.credentialPassword);
    } catch {
      throw new ApiRequestError(400, 'RECOVERY_QR_INVALID', 'The local recovery QR could not be decrypted.');
    }
    try {
      this.acceptSession(await this.api.recovery({
        credentialId: credential.credentialId,
        recoverySecret: credential.recoverySecret,
        ...(request.totp ? { totp: request.totp } : {}),
      }));
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      throw error;
    }
    return { source: 'BROWSER_DEV', outcome: PlayerEntryOutcome.RECOVERY_AUTHENTICATED };
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this.session = undefined;
    this.onSession?.(undefined);
    localStorage.setItem('gameing-hall.browser-device-login-suppressed', 'true');
  }

  async getIdentitySettings(): Promise<IdentitySettingsResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.identitySettings(accessToken));
  }

  async setUsername(request: Parameters<PlayerIdentityPort['setUsername']>[0]): Promise<IdentitySettingsResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.setUsername(request, accessToken));
  }

  async changePassword(request: Parameters<PlayerIdentityPort['changePassword']>[0]): Promise<{ changed: boolean }> {
    return this.withValidAccessToken((accessToken) => this.api.changePassword(request, accessToken));
  }

  async createContactChallenge(request: Parameters<PlayerIdentityPort['createContactChallenge']>[0]): Promise<ContactChallengeResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.createContactChallenge(request, accessToken));
  }

  async confirmContactChallenge(challengeId: string, request: Parameters<PlayerIdentityPort['confirmContactChallenge']>[1]): Promise<IdentitySettingsResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.confirmContactChallenge(challengeId, request, accessToken));
  }

  async startTotpSetup(request: TotpSetupRequestDto): Promise<TotpSetupResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.startTotpSetup(request, accessToken));
  }

  async confirmTotpSetup(request: TotpConfirmRequestDto): Promise<TotpEnabledResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.confirmTotpSetup(request, accessToken));
  }

  async disableTotp(request: TotpDisableRequestDto): Promise<TotpDisabledResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.disableTotp(request, accessToken));
  }

  async rotateTotpRecoveryCodes(request: Parameters<PlayerIdentityPort['rotateTotpRecoveryCodes']>[0]): Promise<TotpEnabledResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.rotateTotpRecoveryCodes(request, accessToken));
  }

  async prepareRecoveryCredential(request: Parameters<PlayerIdentityPort['prepareRecoveryCredential']>[0]): Promise<Awaited<ReturnType<PlayerIdentityPort['prepareRecoveryCredential']>>> {
    const recoverySecret = randomToken(32);
    const issued = await this.withValidAccessToken((accessToken) => this.api.prepareRecoveryCredential({ password: request.password, recoverySecret, ...(request.totp ? { totp: request.totp } : {}) }, accessToken));
    const qrPayload = await encryptRecoveryQrPayload({ formatVersion: 1, credentialId: issued.credentialId, recoverySecret, expiresAt: issued.expiresAt }, request.qrPassword);
    return { ...issued, qrPayload };
  }

  async activateRecoveryCredential(credentialId: string): Promise<IdentitySettingsResponseDto> {
    return this.withValidAccessToken((accessToken) => this.api.activateRecoveryCredential(credentialId, accessToken));
  }

  async withValidAccessToken<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    if (!this.session) throw new ApiRequestError(401, 'ACCESS_TOKEN_INVALID', 'Sign in is required.');
    const failedSession = this.session;
    try {
      return await operation(this.session.accessToken);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401 && error.code === 'SESSION_REVOKED') {
        this.invalidateSession();
        throw error;
      }
      if (!(error instanceof ApiRequestError) || error.status !== 401 || error.code !== 'ACCESS_TOKEN_INVALID') throw error;
    }

    let refreshed: SessionResponseDto;
    try {
      this.refreshInFlight ??= this.api.refresh().then((session) => {
        this.acceptSession(session);
        return session;
      }).finally(() => { this.refreshInFlight = undefined; });
      refreshed = await this.refreshInFlight;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        if (this.session === failedSession) this.invalidateSession();
        if (this.session) return operation(this.session.accessToken);
        throw new ApiRequestError(401, 'SESSION_REVOKED', 'Your session expired. Sign in again to continue.', error.requestId);
      }
      throw error;
    }
    try {
      return await operation(refreshed.accessToken);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401 && error.code === 'SESSION_REVOKED') this.invalidateSession();
      throw error;
    }
  }

  private invalidateSession(): void {
    this.session = undefined;
    this.onSession?.(undefined);
    localStorage.setItem('gameing-hall.browser-device-login-suppressed', 'true');
  }

  async createTestAccount(): Promise<{ userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }> {
    const { createDevelopmentTestAccount } = await import('./dispatcher');
    return createDevelopmentTestAccount();
  }
}
