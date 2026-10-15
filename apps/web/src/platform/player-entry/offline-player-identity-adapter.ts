import { PlayerEntryOutcome, type PlayerIdentityPort } from './player-entry-application';
import type { PlayerEntryResultDto } from '@gameing/contracts/player-entry';
import type { IdentitySettingsResponseDto } from '@gameing/contracts/identity';

/** LOCAL_DEMO identity boundary: no credentials are retained or authenticated. */
export class OfflinePlayerIdentityAdapter implements PlayerIdentityPort {
  async checkCurrentDevice(): Promise<PlayerEntryResultDto> {
    return { source: 'LOCAL_DEMO', outcome: PlayerEntryOutcome.DEVICE_CREDENTIAL_MISSING };
  }

  async passwordLogin(_request: Parameters<PlayerIdentityPort['passwordLogin']>[0]): Promise<PlayerEntryResultDto> {
    return { source: 'LOCAL_DEMO', outcome: PlayerEntryOutcome.IDENTITY_SERVICE_REQUIRED };
  }

  async recoverAccount(_request: Parameters<PlayerIdentityPort['recoverAccount']>[0]): Promise<PlayerEntryResultDto> {
    return { source: 'LOCAL_DEMO', outcome: PlayerEntryOutcome.IDENTITY_SERVICE_REQUIRED };
  }

  async logout(): Promise<void> {}

  async getIdentitySettings(): Promise<IdentitySettingsResponseDto> {
    throw new Error('IDENTITY_SERVICE_REQUIRED');
  }

  async setUsername(): Promise<IdentitySettingsResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }

  async changePassword(): Promise<{ changed: boolean }> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }

  async createContactChallenge(): Promise<import('@gameing/contracts/identity').ContactChallengeResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }

  async confirmContactChallenge(): Promise<IdentitySettingsResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }

  async startTotpSetup(): Promise<import('@gameing/contracts/identity').TotpSetupResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }

  async confirmTotpSetup(): Promise<import('@gameing/contracts/identity').TotpEnabledResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }

  async disableTotp(): Promise<import('@gameing/contracts/identity').TotpDisabledResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }
  async rotateTotpRecoveryCodes(): Promise<import('@gameing/contracts/identity').TotpEnabledResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }
  async prepareRecoveryCredential(): Promise<import('./player-entry-application').PreparedRecoveryCredential> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }
  async activateRecoveryCredential(): Promise<import('@gameing/contracts/identity').IdentitySettingsResponseDto> { throw new Error('IDENTITY_SERVICE_REQUIRED'); }
}
