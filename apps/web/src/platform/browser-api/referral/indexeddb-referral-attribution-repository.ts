import type { BrowserDevelopmentDatabase, LocalReferralBinding } from '../database';
import type { ReferralAttributionRepository, ReferralBinding, ReferralCandidate, ReferralInviter } from '../../../referral/referral-attribution-application';

const REFERRAL_CANDIDATE_KEY = 'referral:ip-candidate:browser-development-source';
const REFERRAL_TTL_CONFIG_KEY = 'system_config:referral.attribution.candidate_ttl_seconds';

export class IndexedDbReferralAttributionRepository implements ReferralAttributionRepository {
  constructor(private readonly database: BrowserDevelopmentDatabase) {}

  async candidateTtlConfig(): Promise<string | undefined> {
    const setting = await this.database.get('settings', REFERRAL_TTL_CONFIG_KEY);
    return typeof setting?.value === 'string' ? setting.value : undefined;
  }

  async findInviter(inviteCode: string): Promise<ReferralInviter | undefined> {
    const user = await this.database.getFromIndex('users', 'by-invite-code', inviteCode);
    return user ? { userId: user.userId, ...(user.inviteCodeExpiresAt ? { inviteCodeExpiresAt: user.inviteCodeExpiresAt } : {}) } : undefined;
  }

  async saveCandidate(candidate: ReferralCandidate): Promise<void> {
    await this.database.put('settings', { key: REFERRAL_CANDIDATE_KEY, value: candidate });
  }

  async findCandidate(): Promise<ReferralCandidate | undefined> {
    const setting = await this.database.get('settings', REFERRAL_CANDIDATE_KEY);
    const value = setting?.value as ReferralCandidate | undefined;
    return value?.inviteCode && value.expiresAt ? value : undefined;
  }

  findBinding(userId: string): Promise<LocalReferralBinding | undefined> {
    return this.database.get('referral_bindings', userId);
  }

  async saveBinding(binding: ReferralBinding): Promise<void> {
    await this.database.put('referral_bindings', binding as LocalReferralBinding);
  }
}
